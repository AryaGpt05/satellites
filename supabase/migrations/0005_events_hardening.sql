-- ════════════════════════════════════════════════════════════════════════════════════════════
-- 0005: hardening of 0004 (in-app events + admin stats), after review
--
--   * Rate limits count INSERTION time (events.inserted_at), not the client-back-dated created_at, and
--     new tabs count toward the global per-minute budget (DB-1).
--   * A tab row is only created once at least one event in the batch is accepted; a missing `events`
--     or `sid` key raises instead of slipping through a NULL comparison (DB-3).
--   * The no-coordinates / no-addresses rule is enforced here too: labels with digits are dropped,
--     decimals masked in satellite names and UTM tags, the referrer must be a hostname with an
--     alphabetic TLD, the app version a short sha, a semver or 'dev' (DB-4). Error messages lose
--     invisible characters BEFORE URLs and decimals are masked (DB-5).
--   * is_admin needs a confirmed, non-anonymous auth.users row (by auth.uid()) whose email is on the
--     admin list; the JWT email claim alone is not enough (DB-6).
--   * Maintenance is off the request path: pg_cron runs overflight_private.maintain_events() every
--     hour, rolling at most 7 closed days per run (walking forward from the last rolled day, so
--     event_rolled stays contiguous) and pruning in bounded batches. log_events and admin_stats no
--     longer call it (DB-2). admin_stats('all') reads event_days for rolled days and raw events for
--     every day after the last rolled one, so nothing drops out around midnight (DB-7).
--
-- Idempotent and additive: add column if not exists, create or replace of functions 0004 created,
-- cron.schedule upserts the job by name.
-- ════════════════════════════════════════════════════════════════════════════════════════════

create extension if not exists pg_cron;

alter table public.events add column if not exists inserted_at timestamptz not null default now();
create index if not exists events_inserted_at_idx     on public.events (inserted_at);
create index if not exists events_sid_inserted_at_idx on public.events (sid, inserted_at);
create index if not exists event_sessions_first_at_idx on public.event_sessions (first_at);

-- ── Field helpers ───────────────────────────────────────────────────────────────────────────

-- Control and invisible format characters (bidi, zero-width) removed, nothing else changed.
create or replace function overflight_private.strip_invisible(s text)
returns text
language sql immutable
set search_path = public
as $$
  select regexp_replace(regexp_replace(s, '[[:cntrl:]]', '', 'g'), '[​-‏‪-‮⁠-⁩﻿­]', '', 'g')
$$;

-- Free text with decimal numbers masked (they could be coordinates), cleaned, ≤ max_len.
create or replace function overflight_private.clean_masked(s text, max_len int)
returns text
language sql immutable
set search_path = public
as $$
  select overflight_private.clean_text(
    left(regexp_replace(overflight_private.strip_invisible(s), '-?\d+[.,]\d+', '#', 'g'), max_len), max_len)
$$;

-- A city / region label: cleaned, and dropped entirely when it carries any digit (house numbers,
-- postcodes, coordinates).
create or replace function overflight_private.clean_label(s text)
returns text
language sql immutable
set search_path = public
as $$
  select case when t ~ '\d' then null else t end
  from (select overflight_private.clean_text(overflight_private.strip_invisible(s), 120) as t) x
$$;

-- An error message: invisible characters out FIRST, then URLs and decimals masked, then truncated.
create or replace function overflight_private.clean_msg(s text)
returns text
language sql immutable
set search_path = public
as $$
  select overflight_private.clean_text(
    left(regexp_replace(regexp_replace(overflight_private.strip_invisible(s), '[a-z][a-z0-9+.-]*://\S+', '[url]', 'gi'), '-?\d+\.\d+', '#', 'g'), 200),
    200)
$$;

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
        'label',   overflight_private.clean_label(p ->> 'label'),
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
        'sat',        overflight_private.clean_masked(p ->> 'sat', 60),
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

-- ── log_events ──────────────────────────────────────────────────────────────────────────────

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
  v_known  boolean;
  v_room   int;
  v_ref    text;
  ev       jsonb;
  v_type   text[] := '{}';
  v_props  jsonb[] := '{}';
  v_dts    bigint[] := '{}';
  v_p      jsonb;
  i        int;
begin
  if batch is null or jsonb_typeof(batch) is distinct from 'object' or octet_length(batch::text) > 16384 then
    raise exception 'invalid batch' using errcode = '22023';
  end if;
  v_sid := batch ->> 'sid';
  if jsonb_typeof(batch -> 'sid') is distinct from 'string' or v_sid !~ '^[A-Za-z0-9_-]{16,32}$' then
    raise exception 'invalid session' using errcode = '22023';
  end if;
  v_events := batch -> 'events';
  if jsonb_typeof(v_events) is distinct from 'array' then raise exception 'invalid events' using errcode = '22023'; end if;
  v_n := jsonb_array_length(v_events);
  if v_n = 0 then return; end if;
  if v_n > 50 then raise exception 'too many events' using errcode = '22023'; end if;
  v_ctx := case when jsonb_typeof(batch -> 'ctx') = 'object' then batch -> 'ctx' else '{}'::jsonb end;

  -- Validate first: nothing (not even the tab row) is written unless some event is acceptable.
  for ev in select value from jsonb_array_elements(v_events) loop
    continue when jsonb_typeof(ev) is distinct from 'object' or jsonb_typeof(ev -> 'type') is distinct from 'string';
    v_p := overflight_private.event_props(ev ->> 'type', ev -> 'p');
    continue when v_p is null;
    v_type := array_append(v_type, ev ->> 'type');
    v_props := array_append(v_props, v_p);
    v_dts := array_append(v_dts, coalesce(overflight_private.jint(ev, 'dt', 0, 600000), 0));
  end loop;
  if cardinality(v_type) = 0 then return; end if;

  -- Limits, all on insertion time (created_at may be back-dated by dt): 2000 events per tab overall,
  -- 120 per tab per minute, 20000 events + new tabs per minute overall.
  select * into v_ses from public.event_sessions where sid = v_sid;
  v_known := found;
  if v_known and v_ses.n >= 2000 then return; end if;
  v_room := least(120 - (select count(*) from public.events where sid = v_sid and inserted_at > now() - interval '1 minute')::int,
                  2000 - coalesce(v_ses.n, 0));
  if v_room <= 0 then return; end if;
  if (select count(*) from public.events where inserted_at > now() - interval '1 minute')
     + (select count(*) from public.event_sessions where first_at > now() - interval '1 minute') >= 20000 then
    return;
  end if;

  if not v_known then
    v_ref := lower(v_ctx ->> 'ref');
    if jsonb_typeof(v_ctx -> 'ref') is distinct from 'string' or char_length(v_ref) > 100 or v_ref !~ '^([a-z0-9-]+\.)+[a-z]{2,}$' then
      v_ref := null;
    end if;
    insert into public.event_sessions (sid, device, country, ref_host, utm, app_version)
    values (
      v_sid,
      overflight_private.jenum(v_ctx, 'device', array['phone', 'tablet', 'desktop']),
      overflight_private.jmatch(v_ctx, 'country', '^[a-z]{2}$', 2),
      v_ref,
      nullif(concat_ws(' / ',
        overflight_private.clean_masked(v_ctx ->> 'utm_source', 40),
        overflight_private.clean_masked(v_ctx ->> 'utm_medium', 40),
        overflight_private.clean_masked(v_ctx ->> 'utm_campaign', 60)), ''),
      overflight_private.jmatch(v_ctx, 'v', '^([0-9a-f]{7}|\d{1,4}\.\d{1,4}\.\d{1,4}|dev)$', 24))
    on conflict (sid) do nothing;
  end if;

  for i in 1 .. least(cardinality(v_type), v_room) loop
    insert into public.events (created_at, sid, type, props)
    values (now() - make_interval(secs => v_dts[i] / 1000.0), v_sid, v_type[i], v_props[i]);
  end loop;

  update public.event_sessions set last_at = now(), n = n + least(cardinality(v_type), v_room) where sid = v_sid;
end
$$;

-- ── Maintenance (pg_cron, hourly) ───────────────────────────────────────────────────────────

create or replace function overflight_private.maintain_events()
returns void
language plpgsql
set search_path = public
as $$
declare
  -- Events can be back-dated by at most 10 minutes (log_events' dt), so a day is closed 15 minutes after midnight.
  v_closed date := ((now() - interval '15 minutes') at time zone 'utc')::date;
  v_next   date;
  v_last   date;
  v_rolled int := 0;
  v_gone   int;
begin
  if not pg_try_advisory_xact_lock(hashtext('overflight.events.maintain')) then return; end if;

  -- Roll forward from the day after the last rolled one (or the first event's day), marking every day,
  -- empty or not, so event_rolled stays contiguous. At most 7 days per run.
  select max(day) + 1 into v_next from public.event_rolled;
  if v_next is null then
    select (min(created_at) at time zone 'utc')::date into v_next from public.events;
  end if;
  while v_next is not null and v_next < v_closed and v_rolled < 7 loop
    insert into public.event_days (day, type, dim, val, n)
    select a.day, a.type, a.dim, a.val, a.n
    from overflight_private.event_aggregates(v_next::timestamp at time zone 'utc', (v_next + 1)::timestamp at time zone 'utc') a
    on conflict (day, type, dim, val) do nothing;
    insert into public.event_rolled (day) values (v_next) on conflict do nothing;
    v_next := v_next + 1;
    v_rolled := v_rolled + 1;
  end loop;

  -- Prune raw rows past 90 days, but only days already rolled up, in batches of 10k (≤ 20 batches a run).
  select max(day) into v_last from public.event_rolled;
  if v_last is not null then
    for i in 1 .. 20 loop
      delete from public.events where id in (
        select id from public.events
        where created_at < least(now() - interval '90 days', (v_last + 1)::timestamp at time zone 'utc')
        order by created_at limit 10000);
      get diagnostics v_gone = row_count;
      exit when v_gone < 10000;
    end loop;
    for i in 1 .. 20 loop
      delete from public.event_sessions where sid in (
        select sid from public.event_sessions where last_at < now() - interval '90 days' order by last_at limit 10000);
      get diagnostics v_gone = row_count;
      exit when v_gone < 10000;
    end loop;
  end if;
  update public.event_maint set last_at = now() where id = 1;
end
$$;

select cron.schedule('watched-events-maintain', '17 * * * *', 'select overflight_private.maintain_events()');

-- ── Admin ───────────────────────────────────────────────────────────────────────────────────

-- A signed-in, email-confirmed, non-anonymous auth user whose own email (from auth.users, by the JWT's
-- subject) is on the admin list. The email claim in the token is not trusted on its own.
create or replace function overflight_private.is_admin()
returns boolean
language sql stable
security definer
set search_path = public
as $$
  select coalesce(
    auth.role() = 'authenticated'
    and exists (
      select 1
      from auth.users u
      join overflight_private.admins a on a.email = lower(u.email)
      where u.id = auth.uid()
        and u.email_confirmed_at is not null
        and not coalesce(u.is_anonymous, false)
        and lower(u.email) = lower(auth.jwt() ->> 'email')),
    false)
$$;

-- Same output as 0004; no maintenance on the read path, and 'all' never loses an unrolled day.
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
  v_raw_from timestamptz;
  v_hourly boolean;
  v_out   jsonb;
begin
  if not overflight_private.is_admin() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_range is null or p_range not in ('24h', '7d', '30d', 'all') then p_range := '7d'; end if;

  v_from := case p_range
    when '24h' then v_now - interval '24 hours'
    when '7d'  then v_now - interval '7 days'
    when '30d' then v_now - interval '30 days'
    else '-infinity'::timestamptz end;
  v_hourly := p_range in ('24h', '7d');

  create temp table if not exists _agg (day date, type text, dim text, val text, n bigint) on commit drop;
  truncate _agg;
  if p_range = 'all' then
    -- Rolled days from the rollup; every later day (yesterday before the cron got to it, today) from raw events.
    v_raw_from := coalesce((select (max(day) + 1)::timestamp at time zone 'utc' from public.event_rolled), '-infinity'::timestamptz);
    insert into _agg select d.day, d.type, d.dim, d.val, d.n from public.event_days d where d.day < (v_raw_from at time zone 'utc')::date;
    insert into _agg select * from overflight_private.event_aggregates(v_raw_from, v_now + interval '1 minute');
  else
    insert into _agg select * from overflight_private.event_aggregates(v_from, v_now + interval '1 minute');
  end if;

  with
  tot as (select type, sum(n)::bigint n from _agg where dim = '' group by type),
  top as (
    select type, dim, val, sum(n)::bigint n, row_number() over (partition by type, dim order by sum(n) desc, val) rk
    from _agg where dim <> '' and type <> 'funnel' group by type, dim, val
  ),
  dimtot as (select type || '.' || dim k, sum(n)::bigint n from _agg where dim <> '' and type <> 'funnel' group by type, dim),
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
    'dimTotals', coalesce((select jsonb_object_agg(k, n) from dimtot), '{}'::jsonb),
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

-- ── Grants (unchanged surface) ──────────────────────────────────────────────────────────────

revoke all on all functions in schema overflight_private from public, anon, authenticated;
revoke all on function public.log_events(jsonb) from public, anon, authenticated;
revoke all on function public.admin_stats(text) from public, anon, authenticated;
grant execute on function public.log_events(jsonb) to anon, authenticated;
grant execute on function public.admin_stats(text) to authenticated;
