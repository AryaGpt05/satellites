-- ════════════════════════════════════════════════════════════════════════════════════════════
-- Overflight: initial schema
--
-- Access model
--   * The browser holds only the publishable key, so it runs as `anon`.
--   * `anon` / `authenticated` have NO privileges on any table: RLS is enabled with no policies
--     and every table privilege is revoked. A direct `GET /rest/v1/<table>` is denied.
--   * All access goes through four SECURITY DEFINER functions in `public` (exposed as PostgREST
--     RPCs). They validate and coarsen input, rate-limit writes, and return only what is meant to
--     be public. Helpers live in the unexposed `overflight_private` schema.
--
-- Privacy
--   * Lookups are stored as a ~10 km grid cell (0.1°), never the exact point, plus a city-level
--     label. No IPs, user agents or identifiers are stored.
--   * Shares are public by intent, but coordinates are rounded to 0.01° (~1 km) and the pass
--     geometry is rounded to the same order, so the exact spot cannot be back-solved from it.
--   * Labelled "popular places" require at least 3 lookups in the cell (k-anonymity floor).
--
-- Idempotent: safe to run repeatedly (create … if not exists / create or replace).
-- ════════════════════════════════════════════════════════════════════════════════════════════

create extension if not exists pgcrypto with schema extensions;

create schema if not exists overflight_private;
revoke all on schema overflight_private from public, anon, authenticated;

-- ── Tables ──────────────────────────────────────────────────────────────────────────────────

-- One row per report computed by someone (not for deep links, which are re-opens).
create table if not exists public.lookups (
  id            bigserial primary key,
  created_at    timestamptz not null default now(),
  cell          text not null,                   -- 0.1° grid id, 'lat,lon', e.g. '43.5,-80.5'
  country_code  text,                            -- ISO 3166-1 alpha-2, lowercase
  place_label   text                             -- city-level label only
);

-- All-time aggregate per cell, maintained by record_lookup. Keeps get_stats O(cells), not
-- O(lookups), and lets raw lookups be pruned later without losing the heatmap.
create table if not exists public.lookup_cells (
  cell          text primary key,
  lat           numeric(4,1) not null,
  lon           numeric(4,1) not null,
  n             bigint not null default 0,
  last_at       timestamptz not null default now()
);

-- A shared pass. Public by intent; read back via get_share(id).
create table if not exists public.shares (
  id            text primary key,                -- 8 chars, [0-9a-z] minus 1/i/l/o
  created_at    timestamptz not null default now(),
  place_label   text not null,
  lat           numeric(7,3) not null,           -- rounded to 0.01° in create_share
  lon           numeric(8,3) not null,
  norad         int,
  sat_name      text,
  verdict       text,
  t_closest     timestamptz,
  capture       jsonb,                           -- {collection,itemId,platform,datetime,cloudCoverPct,gsdM,provider}
  pass          jsonb,                           -- Pass without `track`, coarsened
  views         int not null default 0
);

-- Single-row cache for get_stats (recomputed at most once a minute).
create table if not exists public.stats_cache (
  id            smallint primary key check (id = 1),
  computed_at   timestamptz not null,
  data          jsonb not null
);

create index if not exists lookups_created_at_idx      on public.lookups (created_at);
create index if not exists lookups_cell_created_at_idx on public.lookups (cell, created_at);
create index if not exists lookup_cells_n_idx          on public.lookup_cells (n desc);
create index if not exists shares_created_at_idx       on public.shares (created_at);

-- ── Lock the tables down ────────────────────────────────────────────────────────────────────

alter table public.lookups      enable row level security;
alter table public.lookup_cells enable row level security;
alter table public.shares       enable row level security;
alter table public.stats_cache  enable row level security;

revoke all on table public.lookups, public.lookup_cells, public.shares, public.stats_cache
  from public, anon, authenticated;
revoke all on sequence public.lookups_id_seq from public, anon, authenticated;

-- ── Private helpers ─────────────────────────────────────────────────────────────────────────

-- A JSON number at key k, or null (strings, booleans, NaN-ish junk are rejected, not cast).
create or replace function overflight_private.num(j jsonb, k text)
returns numeric
language sql immutable
set search_path = public
as $$
  select case when jsonb_typeof(j -> k) = 'number' then (j ->> k)::numeric end
$$;

-- Trim, drop control characters, collapse whitespace. Empty → null. Longer than max → null.
create or replace function overflight_private.clean_text(s text, max_len int)
returns text
language sql immutable
set search_path = public
as $$
  select case
    when t is null or t = '' or char_length(t) > max_len then null
    else t
  end
  from (select btrim(regexp_replace(regexp_replace(s, '[[:cntrl:]]', '', 'g'), '\s+', ' ', 'g')) as t) x
$$;

-- 8-char id from a 32-symbol alphabet (no 1/i/l/o). 32 divides 256, so `byte & 31` is unbiased.
create or replace function overflight_private.new_share_id()
returns text
language plpgsql volatile
set search_path = public
as $$
declare
  alphabet constant text := '023456789abcdefghjkmnpqrstuvwxyz';
  b bytea := extensions.gen_random_bytes(8);
  out text := '';
begin
  for i in 0..7 loop
    out := out || substr(alphabet, (get_byte(b, i) & 31) + 1, 1);
  end loop;
  return out;
end
$$;

revoke all on all functions in schema overflight_private from public, anon, authenticated;

-- ── record_lookup ───────────────────────────────────────────────────────────────────────────
-- Called once per computed report. Coarsens to 0.1°, validates, and silently drops writes over
-- the rate limits (the caller never needs to know: it is fire-and-forget telemetry).

create or replace function public.record_lookup(
  p_lat float8,
  p_lon float8,
  p_country text default null,
  p_label text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lat     numeric(4,1);
  v_lon     numeric(4,1);
  v_cell    text;
  v_country text;
  v_label   text;
begin
  -- NaN compares greater than everything in Postgres, so it fails these range checks too.
  if p_lat is null or p_lon is null
     or not (p_lat between -90 and 90) or not (p_lon between -180 and 180) then
    raise exception 'invalid coordinates' using errcode = '22023';
  end if;
  if p_label is not null and char_length(p_label) > 120 then
    raise exception 'label too long' using errcode = '22023';
  end if;

  v_lat := round(p_lat::numeric, 1);
  v_lon := round(p_lon::numeric, 1);
  if v_lon = -180 then v_lon := 180; end if;       -- one cell on the antimeridian
  v_cell := v_lat::text || ',' || v_lon::text;

  v_country := lower(btrim(p_country));
  if v_country !~ '^[a-z]{2}$' then v_country := null; end if;
  v_label := overflight_private.clean_text(p_label, 80);

  -- Abuse limits: 60 / minute for one cell, 6000 / minute overall.
  if (select count(*) from public.lookups
       where cell = v_cell and created_at > now() - interval '1 minute') >= 60 then
    return;
  end if;
  if (select count(*) from public.lookups
       where created_at > now() - interval '1 minute') >= 6000 then
    return;
  end if;

  insert into public.lookups (cell, country_code, place_label)
  values (v_cell, v_country, v_label);

  insert into public.lookup_cells as c (cell, lat, lon, n, last_at)
  values (v_cell, v_lat, v_lon, 1, now())
  on conflict (cell) do update set n = c.n + 1, last_at = excluded.last_at;
end
$$;

-- ── create_share ────────────────────────────────────────────────────────────────────────────
-- payload: { placeLabel, lat, lon, satName?, pass: Pass (track ignored), capture?: {...} }
-- Returns the new share id. Raises (→ HTTP 400) on invalid input or when rate-limited.

create or replace function public.create_share(payload jsonb)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  p         jsonb;
  c         jsonb;
  v_label   text;
  v_sat     text;
  v_lat     numeric;
  v_lon     numeric;
  v_norad   numeric;
  v_verdict text;
  v_tc      numeric;
  v_pass    jsonb;
  v_capture jsonb;
  v_id      text;
  v_coll    text;
  v_item    text;
begin
  if payload is null or jsonb_typeof(payload) <> 'object' then
    raise exception 'invalid payload' using errcode = '22023';
  end if;
  if octet_length(payload::text) >= 8192 then
    raise exception 'payload too large' using errcode = '22023';
  end if;

  -- Place
  if jsonb_typeof(payload -> 'placeLabel') <> 'string' or char_length(payload ->> 'placeLabel') > 120 then
    raise exception 'invalid placeLabel' using errcode = '22023';
  end if;
  v_label := overflight_private.clean_text(payload ->> 'placeLabel', 120);
  if v_label is null then
    raise exception 'invalid placeLabel' using errcode = '22023';
  end if;
  v_lat := overflight_private.num(payload, 'lat');
  v_lon := overflight_private.num(payload, 'lon');
  if v_lat is null or v_lon is null or v_lat not between -90 and 90 or v_lon not between -180 and 180 then
    raise exception 'invalid coordinates' using errcode = '22023';
  end if;
  v_lat := round(v_lat, 2);
  v_lon := round(v_lon, 2);
  v_sat := overflight_private.clean_text(payload ->> 'satName', 80);

  -- Pass (required)
  p := payload -> 'pass';
  if p is null or jsonb_typeof(p) <> 'object' then
    raise exception 'invalid pass' using errcode = '22023';
  end if;
  v_norad := overflight_private.num(p, 'norad');
  if v_norad is null or v_norad <> trunc(v_norad) or v_norad not between 1 and 999999999 then
    raise exception 'invalid norad' using errcode = '22023';
  end if;
  v_verdict := p ->> 'verdict';
  if v_verdict is null or v_verdict not in ('imaged', 'likely', 'could', 'overhead') then
    raise exception 'invalid verdict' using errcode = '22023';
  end if;
  v_tc := overflight_private.num(p, 'tClosest');
  if v_tc is null
     or to_timestamp(v_tc / 1000) not between now() - interval '400 days' and now() + interval '2 days' then
    raise exception 'invalid tClosest' using errcode = '22023';
  end if;

  -- Rebuild the pass from an allow-list, coarsened (times to the second, distances to ~1 km).
  -- `track` is dropped: it is large, and it is re-derived from the catalog when the link opens.
  v_pass := jsonb_strip_nulls(jsonb_build_object(
    'id',               overflight_private.clean_text(p ->> 'id', 40),
    'norad',            v_norad::int,
    'tClosest',         round(v_tc / 1000) * 1000,
    'tStart',           round(overflight_private.num(p, 'tStart') / 1000) * 1000,
    'tEnd',             round(overflight_private.num(p, 'tEnd') / 1000) * 1000,
    'groundDistanceKm', round(overflight_private.num(p, 'groundDistanceKm'), 0),
    'offNadirDeg',      round(overflight_private.num(p, 'offNadirDeg'), 1),
    'elevationDeg',     round(overflight_private.num(p, 'elevationDeg'), 0),
    'azimuthDeg',       round(overflight_private.num(p, 'azimuthDeg'), 0),
    'altitudeKm',       round(overflight_private.num(p, 'altitudeKm'), 0),
    'groundSpeedKmS',   round(overflight_private.num(p, 'groundSpeedKmS'), 2),
    'headingDeg',       round(overflight_private.num(p, 'headingDeg'), 0),
    'node',             case when p ->> 'node' in ('ascending', 'descending') then p ->> 'node' end,
    'sunElevationDeg',  round(overflight_private.num(p, 'sunElevationDeg'), 0),
    'inSwath',          case when jsonb_typeof(p -> 'inSwath') = 'boolean' then p -> 'inSwath' end,
    'inFieldOfRegard',  case when jsonb_typeof(p -> 'inFieldOfRegard') = 'boolean' then p -> 'inFieldOfRegard' end,
    'verdict',          v_verdict,
    'captureId',        overflight_private.clean_text(p ->> 'captureId', 160)
  ));

  -- Capture (optional). Only real-archive collections; ids restricted to a safe charset since the
  -- OG renderer turns them into archive URLs.
  c := payload -> 'capture';
  if c is not null and jsonb_typeof(c) = 'object' then
    v_coll := c ->> 'collection';
    v_item := c ->> 'itemId';
    if v_coll in ('sentinel-2-l2a', 'landsat-c2-l2', 'gibs-viirs-noaa20', 'gibs-viirs-noaa21', 'gibs-viirs-snpp',
                  'gibs-modis-terra', 'gibs-modis-aqua', 'gibs-goes-east', 'gibs-goes-west', 'gibs-himawari')
       and v_item ~ '^[A-Za-z0-9_.:@-]{1,160}$' then
      v_capture := jsonb_strip_nulls(jsonb_build_object(
        'collection',    v_coll,
        'itemId',        v_item,
        'provider',      case when c ->> 'provider' in ('earth-search', 'planetary-computer', 'gibs') then c ->> 'provider' end,
        'platform',      overflight_private.clean_text(c ->> 'platform', 40),
        'datetime',      round(overflight_private.num(c, 'datetime') / 1000) * 1000,
        'cloudCoverPct', round(least(100, greatest(0, overflight_private.num(c, 'cloudCoverPct'))), 1),
        'gsdM',          round(overflight_private.num(c, 'gsdM'), 1)
      ));
    end if;
  end if;

  -- Abuse limits: 10 / minute from one 0.1° cell, 300 / minute overall.
  if (select count(*) from public.shares
       where created_at > now() - interval '1 minute'
         and round(lat, 1) = round(v_lat, 1) and round(lon, 1) = round(v_lon, 1)) >= 10
     or (select count(*) from public.shares where created_at > now() - interval '1 minute') >= 300 then
    raise exception 'rate limited' using errcode = 'P0001', hint = 'retry in a minute';
  end if;

  -- Insert with a fresh id; retry on the (astronomically unlikely) collision.
  for attempt in 1..5 loop
    v_id := overflight_private.new_share_id();
    begin
      insert into public.shares (id, place_label, lat, lon, norad, sat_name, verdict, t_closest, capture, pass)
      values (v_id, v_label, v_lat, v_lon, v_norad::int, v_sat, v_verdict, to_timestamp(round(v_tc / 1000)),
              v_capture, v_pass);
      return v_id;
    exception when unique_violation then
      if attempt = 5 then raise; end if;
    end;
  end loop;
  return null;
end
$$;

-- ── get_share ───────────────────────────────────────────────────────────────────────────────
-- Returns the share as camelCase JSON (times as epoch ms), or null. Counts a view unless
-- p_view = false (the OG image and share-page functions pass false so crawlers don't count).

create or replace function public.get_share(p_id text, p_view boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.shares%rowtype;
begin
  if p_id is null or p_id !~ '^[0-9a-z]{8}$' then
    return null;
  end if;
  if coalesce(p_view, true) then
    update public.shares set views = views + 1 where id = p_id returning * into r;
  else
    select * into r from public.shares where id = p_id;
  end if;
  if not found then
    return null;
  end if;
  return jsonb_strip_nulls(jsonb_build_object(
    'id',         r.id,
    'createdAt',  floor(extract(epoch from r.created_at) * 1000),
    'placeLabel', r.place_label,
    'lat',        r.lat,
    'lon',        r.lon,
    'norad',      r.norad,
    'satName',    r.sat_name,
    'verdict',    r.verdict,
    'tClosest',   floor(extract(epoch from r.t_closest) * 1000),
    'capture',    r.capture,
    'pass',       r.pass,
    'views',      r.views
  ));
end
$$;

-- ── get_stats ───────────────────────────────────────────────────────────────────────────────
-- { total, last24h, places: top 12 cells of the last 7 days (≥ 3 lookups), cells: up to 2000
--   [lat, lon, count] all-time for a heatmap, computedAt }. Cached for 60 s; concurrent callers
-- during a recompute get the previous value instead of piling on.

create or replace function public.get_stats()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cached jsonb;
  v_at     timestamptz;
  v_data   jsonb;
begin
  select data, computed_at into v_cached, v_at from public.stats_cache where id = 1;
  if v_cached is not null and v_at > now() - interval '60 seconds' then
    return v_cached;
  end if;
  if not pg_try_advisory_xact_lock(hashtext('overflight.get_stats')) and v_cached is not null then
    return v_cached;
  end if;

  select jsonb_build_object(
    'total',   (select coalesce(sum(n), 0) from public.lookup_cells),
    'last24h', (select count(*) from public.lookups where created_at > now() - interval '24 hours'),
    'places',  (
      select coalesce(jsonb_agg(jsonb_build_object(
               'cell', t.cell, 'lat', t.lat, 'lon', t.lon, 'label', t.label,
               'countryCode', t.cc, 'count', t.n) order by t.n desc, t.cell), '[]'::jsonb)
      from (
        select l.cell,
               split_part(l.cell, ',', 1)::numeric as lat,
               split_part(l.cell, ',', 2)::numeric as lon,
               mode() within group (order by l.place_label) as label,
               mode() within group (order by l.country_code) as cc,
               count(*) as n
        from public.lookups l
        where l.created_at > now() - interval '7 days'
        group by l.cell
        having count(*) >= 3
        order by n desc, l.cell
        limit 12
      ) t
    ),
    'cells',   (
      select coalesce(jsonb_agg(jsonb_build_array(c.lat, c.lon, c.n) order by c.n desc, c.cell), '[]'::jsonb)
      from (select cell, lat, lon, n from public.lookup_cells order by n desc, cell limit 2000) c
    ),
    'computedAt', floor(extract(epoch from now()) * 1000)
  ) into v_data;

  insert into public.stats_cache (id, computed_at, data) values (1, now(), v_data)
  on conflict (id) do update set computed_at = excluded.computed_at, data = excluded.data;
  return v_data;
end
$$;

-- ── Grants ──────────────────────────────────────────────────────────────────────────────────

revoke all on function public.record_lookup(float8, float8, text, text) from public;
revoke all on function public.create_share(jsonb) from public;
revoke all on function public.get_share(text, boolean) from public;
revoke all on function public.get_stats() from public;

grant execute on function public.record_lookup(float8, float8, text, text) to anon, authenticated;
grant execute on function public.create_share(jsonb) to anon, authenticated;
grant execute on function public.get_share(text, boolean) to anon, authenticated;
grant execute on function public.get_stats() to anon, authenticated;

-- PostgREST: pick up the new functions now.
notify pgrst, 'reload schema';
