-- ════════════════════════════════════════════════════════════════════════════════════════════
-- 0004: in-app events + the admin stats RPC
--
-- What is stored (and what is not)
--   * event_sessions: one row per browser TAB (a random id kept in sessionStorage, never a cookie,
--     gone when the tab closes): device class (phone / tablet / desktop), the country Vercel's edge
--     derives from the request (the IP itself is never seen here), the referrer HOST, UTM tags,
--     the app version. Nothing links two visits, and nothing identifies a person.
--   * events: what happened in that tab, each type with an allow-listed set of fields, built
--     server-side (the client payload is never stored as given). Searches carry a city-level label
--     ("Waterloo, Ontario, Canada") and the 0.1° (~10 km) cell, never coordinates.
--   * Raw events are kept 90 days; closed UTC days are rolled up into event_days (kept for good).
--
-- Access
--   * log_events(batch)   anon: validates, caps, rate-limits, inserts. Fire-and-forget.
--   * admin_stats(range)  authenticated ONLY, and only for an email in overflight_private.admins
--                         (checked against the JWT inside the function). anon has no grant.
--   * Tables: RLS on, every privilege revoked. Helpers in overflight_private.
--
-- No pg_cron: the rollup and the 90-day prune run lazily, at most once an hour from log_events,
-- and on every admin_stats call (both idempotent, both guarded by an advisory lock).
--
-- Idempotent and additive: create … if not exists / create or replace (only functions this file owns).
-- ════════════════════════════════════════════════════════════════════════════════════════════

-- ── Tables ──────────────────────────────────────────────────────────────────────────────────

create table if not exists public.event_sessions (
  sid           text primary key,                -- random per tab, 16–32 url-safe chars
  first_at      timestamptz not null default now(),
  last_at       timestamptz not null default now(),
  device        text,                            -- phone | tablet | desktop
  country       text,                            -- ISO alpha-2 lowercase, from the edge
  ref_host      text,                            -- referrer host only, e.g. 't.co'
  utm           text,                            -- 'source / medium / campaign'
  app_version   text,
  n             int not null default 0           -- events accepted for this tab
);

create table if not exists public.events (
  id            bigserial primary key,
  created_at    timestamptz not null default now(),
  sid           text not null,
  type          text not null,
  props         jsonb not null default '{}'::jsonb
);

-- Closed UTC days, aggregated (see overflight_private.event_aggregates for the dims).
create table if not exists public.event_days (
  day           date not null,
  type          text not null,
  dim           text not null default '',
  val           text not null default '',
  n             bigint not null default 0,
  primary key (day, type, dim, val)
);

create table if not exists public.event_rolled (
  day           date primary key,
  rolled_at     timestamptz not null default now()
);

create table if not exists public.event_maint (
  id            smallint primary key check (id = 1),
  last_at       timestamptz not null
);
insert into public.event_maint (id, last_at) values (1, '-infinity') on conflict (id) do nothing;

create table if not exists overflight_private.admins (
  email         text primary key check (email = lower(email))
);
insert into overflight_private.admins (email) values ('a585gupt@uwaterloo.ca') on conflict do nothing;

create index if not exists events_created_at_idx      on public.events (created_at);
create index if not exists events_type_created_at_idx on public.events (type, created_at);
create index if not exists events_sid_created_at_idx  on public.events (sid, created_at);
create index if not exists event_sessions_last_at_idx on public.event_sessions (last_at);

alter table public.event_sessions enable row level security;
alter table public.events         enable row level security;
alter table public.event_days     enable row level security;
alter table public.event_rolled   enable row level security;
alter table public.event_maint    enable row level security;
alter table overflight_private.admins enable row level security;

revoke all on table public.event_sessions, public.events, public.event_days, public.event_rolled, public.event_maint
  from public, anon, authenticated;
revoke all on table overflight_private.admins from public, anon, authenticated;
revoke all on sequence public.events_id_seq from public, anon, authenticated;

-- ── Field helpers ───────────────────────────────────────────────────────────────────────────

-- Integer at key k within [lo, hi], else null (dropped, never clamped).
create or replace function overflight_private.jint(j jsonb, k text, lo numeric, hi numeric)
returns bigint
language sql immutable
set search_path = public
as $$
  select trunc(overflight_private.num_in(j, k, lo, hi))::bigint
$$;

-- String at key k if it is one of `allowed`, else null.
create or replace function overflight_private.jenum(j jsonb, k text, allowed text[])
returns text
language sql immutable
set search_path = public
as $$
  select case when jsonb_typeof(j -> k) = 'string' and (j ->> k) = any(allowed) then j ->> k end
$$;

create or replace function overflight_private.jbool(j jsonb, k text)
returns boolean
language sql immutable
set search_path = public
as $$
  select case when jsonb_typeof(j -> k) = 'boolean' then (j ->> k)::boolean end
$$;

-- String at key k matching `re` (and at most max_len chars), else null.
create or replace function overflight_private.jmatch(j jsonb, k text, re text, max_len int)
returns text
language sql immutable
set search_path = public
as $$
  select case when jsonb_typeof(j -> k) = 'string' and char_length(j ->> k) <= max_len and (j ->> k) ~ re then j ->> k end
$$;

-- A 0.1° cell id 'lat,lon' re-normalised to record_lookup's format ('43.5,-80.5'), else null.
create or replace function overflight_private.clean_cell(s text)
returns text
language plpgsql immutable
set search_path = public
as $$
declare
  v_lat numeric(4,1);
  v_lon numeric(4,1);
begin
  if s is null or s !~ '^-?\d{1,3}(\.\d{1,8})?,-?\d{1,3}(\.\d{1,8})?$' then return null; end if;
  v_lat := round(split_part(s, ',', 1)::numeric, 1);
  v_lon := round(split_part(s, ',', 2)::numeric, 1);
  if v_lat not between -90 and 90 or v_lon not between -180 and 180 then return null; end if;
  if v_lon = -180 then v_lon := 180; end if;
  return v_lat::text || ',' || v_lon::text;
end
$$;

-- An error message, defanged: URLs and decimal numbers (which could be coordinates) are masked.
create or replace function overflight_private.clean_msg(s text)
returns text
language sql immutable
set search_path = public
as $$
  select overflight_private.clean_text(
    left(regexp_replace(regexp_replace(s, '[a-z][a-z0-9+.-]*://\S+', '[url]', 'gi'), '-?\d+\.\d+', '#', 'g'), 200),
    200)
$$;

-- The allow-listed props of one event, or null when the event is not acceptable.
create or replace function overflight_private.event_props(p_type text, p jsonb)
returns jsonb
language plpgsql immutable
set search_path = public
as $$
declare
  verdicts constant text[] := array['imaged', 'likely', 'could', 'overhead'];
  coll_re  constant text := '^[a-z0-9-]{1,40}$';
  v jsonb;
begin
  if p is null or jsonb_typeof(p) <> 'object' then p := '{}'::jsonb; end if;
  case p_type
    when 'view' then
      v := jsonb_build_object('entry', overflight_private.jenum(p, 'entry', array['landing', 'deep_link', 'share_link']));
    when 'search' then
      v := jsonb_build_object(
        'source',  overflight_private.jenum(p, 'source', array['search', 'example', 'near_me', 'deep_link', 'share_link', 'retry']),
        'label',   overflight_private.clean_text(p ->> 'label', 120),
        'cell',    overflight_private.clean_cell(p ->> 'cell'),
        'country', overflight_private.jmatch(p, 'country', '^[a-z]{2}$', 2));
    when 'results', 'results_final' then
      v := jsonb_build_object(
        'sats',           overflight_private.jint(p, 'sats', 0, 100000),
        'photos',         overflight_private.jint(p, 'photos', 0, 100000),
        'passes',         overflight_private.jint(p, 'passes', 0, 1000000),
        'ms',             overflight_private.jint(p, 'ms', 0, 600000),
        'partial',        overflight_private.jbool(p, 'partial'),
        'archive_failed', overflight_private.jbool(p, 'archive_failed'));
    when 'pass_open', 'lightbox_open', 'share_open', 'share_action' then
      v := jsonb_build_object(
        'norad',      overflight_private.jint(p, 'norad', 1, 999999),
        'sat',        overflight_private.clean_text(p ->> 'sat', 60),
        'verdict',    overflight_private.jenum(p, 'verdict', verdicts),
        'collection', overflight_private.jmatch(p, 'collection', coll_re, 40));
      if p_type = 'share_open' then
        v := v || jsonb_build_object('kind', overflight_private.jenum(p, 'kind', array['pass', 'summary']));
      elsif p_type = 'share_action' then
        v := v || jsonb_build_object('action', overflight_private.jenum(p, 'action', array['x', 'copy_link', 'copy_image', 'save_png', 'native']));
        if v ->> 'action' is null then return null; end if;
      end if;
    when 'about_open' then
      v := '{}'::jsonb;
    when 'error' then
      v := jsonb_build_object(
        'where', overflight_private.jenum(p, 'where', array['phase', 'window', 'promise']),
        'msg',   overflight_private.clean_msg(p ->> 'msg'));
      if v ->> 'msg' is null then return null; end if;
    when 'vitals' then
      v := jsonb_build_object(
        'lcp', overflight_private.jint(p, 'lcp', 0, 120000),
        'fcp', overflight_private.jint(p, 'fcp', 0, 120000),
        'inp', overflight_private.jint(p, 'inp', 0, 60000),
        'cls', round(overflight_private.num_in(p, 'cls', 0, 100), 4));
    else
      return null;
  end case;
  return jsonb_strip_nulls(v);
end
$$;

-- ── Aggregates (shared by the rollup and admin_stats) ───────────────────────────────────────
-- One row per (UTC day, type, dim, val). Distinct-session counts are per day.

create or replace function overflight_private.event_aggregates(p_from timestamptz, p_to timestamptz)
returns table (day date, type text, dim text, val text, n bigint)
language sql stable
set search_path = public
as $$
  with e as (
    select (ev.created_at at time zone 'utc')::date as day, ev.type, ev.sid, ev.props,
           coalesce(s.device, '') as device, coalesce(s.country, '') as country,
           coalesce(s.ref_host, '') as ref_host, coalesce(s.utm, '') as utm
    from public.events ev
    left join public.event_sessions s on s.sid = ev.sid
    where ev.created_at >= p_from and ev.created_at < p_to
  ),
  ses as (select distinct e.day, e.sid, e.device, e.country, e.ref_host, e.utm from e)
  select e.day, e.type, '', '', count(*) from e group by 1, 2
  union all select ses.day, 'session', '', '', count(*) from ses group by 1
  union all select ses.day, 'session', 'device', ses.device, count(*) from ses group by 1, 4
  union all select ses.day, 'session', 'country', ses.country, count(*) from ses group by 1, 4
  union all select ses.day, 'session', 'ref', ses.ref_host, count(*) from ses where ses.ref_host <> '' group by 1, 4
  union all select ses.day, 'session', 'utm', ses.utm, count(*) from ses where ses.utm <> '' group by 1, 4
  union all select e.day, 'search', 'label', e.props ->> 'label', count(*) from e where e.type = 'search' and e.props ? 'label' group by 1, 4
  union all select e.day, 'search', 'country', e.props ->> 'country', count(*) from e where e.type = 'search' and e.props ? 'country' group by 1, 4
  union all select e.day, 'search', 'source', e.props ->> 'source', count(*) from e where e.type = 'search' and e.props ? 'source' group by 1, 4
  union all select e.day, 'search', 'cell', e.props ->> 'cell', count(*) from e where e.type = 'search' and e.props ? 'cell' group by 1, 4
  union all select e.day, e.type, 'sat', coalesce(e.props ->> 'sat', 'NORAD ' || (e.props ->> 'norad')), count(*)
    from e where e.type in ('pass_open', 'share_action') and (e.props ? 'sat' or e.props ? 'norad') group by 1, 2, 4
  union all select e.day, 'pass_open', 'verdict', e.props ->> 'verdict', count(*) from e where e.type = 'pass_open' and e.props ? 'verdict' group by 1, 4
  union all select e.day, 'share_action', 'action', e.props ->> 'action', count(*) from e where e.type = 'share_action' group by 1, 4
  union all select e.day, 'funnel', 'stage', e.type, count(distinct e.sid)
    from e where e.type in ('search', 'results', 'pass_open', 'lightbox_open', 'share_open', 'share_action') group by 1, 4
$$;

-- Roll closed UTC days into event_days, prune raw events / sessions past 90 days.
create or replace function overflight_private.maintain_events()
returns void
language plpgsql
set search_path = public
as $$
declare
  -- Events can be back-dated by at most 10 minutes (log_events' dt), so a day is closed 15 minutes after midnight.
  v_closed date := ((now() - interval '15 minutes') at time zone 'utc')::date;
  d date;
begin
  if not pg_try_advisory_xact_lock(hashtext('overflight.events.maintain')) then return; end if;
  for d in
    select distinct (created_at at time zone 'utc')::date from public.events
    where created_at < (v_closed::timestamp at time zone 'utc')
    except select day from public.event_rolled
    order by 1
  loop
    insert into public.event_days (day, type, dim, val, n)
    select a.day, a.type, a.dim, a.val, a.n
    from overflight_private.event_aggregates(d::timestamp at time zone 'utc', (d + 1)::timestamp at time zone 'utc') a
    on conflict (day, type, dim, val) do nothing;
    insert into public.event_rolled (day) values (d) on conflict do nothing;
  end loop;
  delete from public.events where created_at < now() - interval '90 days';
  delete from public.event_sessions where last_at < now() - interval '90 days';
  update public.event_maint set last_at = now() where id = 1;
end
$$;

-- ── log_events ──────────────────────────────────────────────────────────────────────────────
-- batch: { sid, ctx: { device?, ref?, utm_source?, utm_medium?, utm_campaign?, v?, country? },
--          events: [{ type, dt?, p? }] }   dt = ms ago (0…600000), p = the type's fields.
-- Raises (→ 400) on a malformed envelope; silently drops unknown events and anything over the limits.

create or replace function public.log_events(batch jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sid    text;
  v_ctx    jsonb;
  v_events jsonb;
  v_n      int;
  v_ses    public.event_sessions;
  v_utm    text;
  ev       jsonb;
  v_type   text;
  v_props  jsonb;
  v_dt     bigint;
  v_room   int;
  v_added  int := 0;
  v_known  boolean;
begin
  if batch is null or jsonb_typeof(batch) <> 'object' or octet_length(batch::text) > 16384 then
    raise exception 'invalid batch' using errcode = '22023';
  end if;
  v_sid := batch ->> 'sid';
  if jsonb_typeof(batch -> 'sid') <> 'string' or v_sid !~ '^[A-Za-z0-9_-]{16,32}$' then
    raise exception 'invalid session' using errcode = '22023';
  end if;
  v_events := batch -> 'events';
  if jsonb_typeof(v_events) <> 'array' then raise exception 'invalid events' using errcode = '22023'; end if;
  v_n := jsonb_array_length(v_events);
  if v_n = 0 then return; end if;
  if v_n > 50 then raise exception 'too many events' using errcode = '22023'; end if;
  v_ctx := case when jsonb_typeof(batch -> 'ctx') = 'object' then batch -> 'ctx' else '{}'::jsonb end;

  -- Limits: 2000 events per tab overall, 120 per tab per minute, 20000 per minute overall.
  select * into v_ses from public.event_sessions where sid = v_sid;
  v_known := found;
  if v_known and v_ses.n >= 2000 then return; end if;
  v_room := 120 - (select count(*) from public.events where sid = v_sid and created_at > now() - interval '1 minute')::int;
  if v_room <= 0 then return; end if;
  if (select count(*) from public.events where created_at > now() - interval '1 minute') >= 20000 then return; end if;

  if not v_known then
    v_utm := nullif(concat_ws(' / ',
      overflight_private.clean_text(v_ctx ->> 'utm_source', 40),
      overflight_private.clean_text(v_ctx ->> 'utm_medium', 40),
      overflight_private.clean_text(v_ctx ->> 'utm_campaign', 60)), '');
    insert into public.event_sessions (sid, device, country, ref_host, utm, app_version)
    values (
      v_sid,
      overflight_private.jenum(v_ctx, 'device', array['phone', 'tablet', 'desktop']),
      overflight_private.jmatch(v_ctx, 'country', '^[a-z]{2}$', 2),
      lower(overflight_private.jmatch(v_ctx, 'ref', '^[A-Za-z0-9.-]{1,100}$', 100)),
      v_utm,
      overflight_private.jmatch(v_ctx, 'v', '^[A-Za-z0-9._-]{1,24}$', 24))
    on conflict (sid) do nothing;
  end if;

  for ev in select value from jsonb_array_elements(v_events) loop
    exit when v_added >= v_room;
    continue when jsonb_typeof(ev) <> 'object' or jsonb_typeof(ev -> 'type') <> 'string';
    v_type := ev ->> 'type';
    v_props := overflight_private.event_props(v_type, ev -> 'p');
    continue when v_props is null;
    v_dt := coalesce(overflight_private.jint(ev, 'dt', 0, 600000), 0);
    insert into public.events (created_at, sid, type, props)
    values (now() - make_interval(secs => v_dt / 1000.0), v_sid, v_type, v_props);
    v_added := v_added + 1;
  end loop;

  update public.event_sessions set last_at = now(), n = n + v_added where sid = v_sid;

  if (select last_at from public.event_maint where id = 1) < now() - interval '1 hour' then
    perform overflight_private.maintain_events();
  end if;
end
$$;

-- ── Admin ───────────────────────────────────────────────────────────────────────────────────

-- True only for a signed-in user (role authenticated) whose JWT email is in overflight_private.admins.
create or replace function overflight_private.is_admin()
returns boolean
language sql stable
security definer
set search_path = public
as $$
  select coalesce(
    auth.role() = 'authenticated'
    and exists (select 1 from overflight_private.admins a where a.email = lower(auth.jwt() ->> 'email')),
    false)
$$;

-- Everything the admin page shows, for one range: '24h' | '7d' | '30d' | 'all'.
create or replace function public.admin_stats(p_range text default '7d')
returns jsonb
language plpgsql
security definer
set search_path = public
set timezone = 'UTC'
as $$
declare
  v_now   timestamptz := now();
  v_today timestamptz := date_trunc('day', now() at time zone 'utc') at time zone 'utc';
  v_from  timestamptz;
  v_hourly boolean;
  v_out   jsonb;
begin
  if not overflight_private.is_admin() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_range not in ('24h', '7d', '30d', 'all') then p_range := '7d'; end if;
  perform overflight_private.maintain_events();

  v_from := case p_range
    when '24h' then v_now - interval '24 hours'
    when '7d'  then v_now - interval '7 days'
    when '30d' then v_now - interval '30 days'
    else '-infinity'::timestamptz end;
  v_hourly := p_range in ('24h', '7d');

  create temp table if not exists _agg (day date, type text, dim text, val text, n bigint) on commit drop;
  truncate _agg;
  if p_range = 'all' then
    insert into _agg select d.day, d.type, d.dim, d.val, d.n from public.event_days d where d.day < v_today::date;
    insert into _agg select * from overflight_private.event_aggregates(v_today, v_now + interval '1 minute');
  else
    insert into _agg select * from overflight_private.event_aggregates(v_from, v_now + interval '1 minute');
  end if;

  with
  tot as (select type, sum(n)::bigint n from _agg where dim = '' group by type),
  top as (
    select type, dim, val, sum(n)::bigint n, row_number() over (partition by type, dim order by sum(n) desc, val) rk
    from _agg where dim <> '' and type <> 'funnel' group by type, dim, val
  ),
  raw as (select * from public.events where created_at >= greatest(v_from, v_now - interval '90 days')),
  res as (select (props ->> 'ms')::float8 ms, (props ->> 'partial')::boolean partial, (props ->> 'archive_failed')::boolean af
          from raw where type = 'results'),
  vit as (select (props ->> 'lcp')::float8 lcp, (props ->> 'inp')::float8 inp, (props ->> 'cls')::float8 cls from raw where type = 'vitals'),
  buckets as (
    select b from generate_series(
      case when v_hourly then date_trunc('hour', greatest(v_from, v_now - interval '7 days'))
           else coalesce((select min(day) from _agg)::timestamp at time zone 'utc', v_today) end,
      v_now,
      case when v_hourly then interval '1 hour' else interval '1 day' end) b
  ),
  hourly as (
    select date_trunc('hour', created_at) b, count(*) filter (where type = 'search') s,
           count(*) filter (where type = 'share_action') sh, count(distinct sid) se
    from raw where v_hourly group by 1
  ),
  daily as (
    select day::timestamp at time zone 'utc' b, sum(n) filter (where type = 'search') s,
           sum(n) filter (where type = 'share_action') sh, sum(n) filter (where type = 'session') se
    from _agg where not v_hourly and dim = '' group by day
  ),
  series as (
    select k.b, coalesce(x.s, 0) s, coalesce(x.sh, 0) sh, coalesce(x.se, 0) se
    from buckets k
    left join (select * from hourly union all select * from daily) x on x.b = k.b
  )
  select jsonb_build_object(
    'range', p_range,
    'generatedAt', (extract(epoch from v_now) * 1000)::bigint,
    'bucket', case when v_hourly then 'hour' else 'day' end,
    'totals', coalesce((select jsonb_object_agg(type, n) from tot), '{}'::jsonb),
    'funnel', coalesce((select jsonb_object_agg(val, s) from (select val, sum(n)::bigint s from _agg where type = 'funnel' group by val) f), '{}'::jsonb),
    'series', coalesce((select jsonb_agg(jsonb_build_array((extract(epoch from b) * 1000)::bigint, s, sh, se) order by b) from series), '[]'::jsonb),
    'top', coalesce((
      select jsonb_object_agg(k, rows) from (
        select type || '.' || dim k, jsonb_agg(jsonb_build_array(val, n) order by rk) rows
        from top where rk <= case when dim = 'cell' then 3000 else 15 end group by type, dim
      ) t), '{}'::jsonb),
    'results', (select jsonb_build_object(
        'n', count(*),
        'p50Ms', percentile_cont(0.5) within group (order by ms),
        'p90Ms', percentile_cont(0.9) within group (order by ms),
        'partial', count(*) filter (where partial),
        'archiveFailed', count(*) filter (where af)) from res),
    'vitals', (select jsonb_build_object(
        'n', count(*),
        'lcp', percentile_cont(0.75) within group (order by lcp),
        'inp', percentile_cont(0.75) within group (order by inp),
        'cls', percentile_cont(0.75) within group (order by cls)) from vit),
    'recentSearches', coalesce((
      select jsonb_agg(jsonb_build_object('t', (extract(epoch from r.created_at) * 1000)::bigint, 'label', r.props ->> 'label',
               'country', r.props ->> 'country', 'source', r.props ->> 'source', 'cell', r.props ->> 'cell', 'device', s.device) order by r.created_at desc)
      from (select * from raw where type = 'search' order by created_at desc limit 40) r
      left join public.event_sessions s on s.sid = r.sid), '[]'::jsonb),
    'recentErrors', coalesce((
      select jsonb_agg(jsonb_build_object('t', (extract(epoch from r.created_at) * 1000)::bigint, 'where', r.props ->> 'where', 'msg', r.props ->> 'msg') order by r.created_at desc)
      from (select * from raw where type = 'error' order by created_at desc limit 30) r), '[]'::jsonb)
  ) into v_out;
  return v_out;
end
$$;

-- ── Grants ──────────────────────────────────────────────────────────────────────────────────

revoke all on all functions in schema overflight_private from public, anon, authenticated;
revoke all on function public.log_events(jsonb) from public, anon, authenticated;
revoke all on function public.admin_stats(text) from public, anon, authenticated;
grant execute on function public.log_events(jsonb) to anon, authenticated;
grant execute on function public.admin_stats(text) to authenticated;
