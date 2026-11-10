-- 0009: /admin reads precomputed stats. admin_stats is ~2.4 s for 24h at today's volume (15-20k events/hour) and grows
-- with traffic, so a cold first load could still pass the authenticated role's 8 s statement_timeout.
--   * overflight_private.admin_stats_compute(range): 0008's admin_stats_core body without the is_admin check. Called only
--     by admin_stats_core, public.admin_stats and refresh_admin_stats; no grants to anon or authenticated.
--   * overflight_private.admin_stats_cache(range, data, computed_at): one row per range.
--   * overflight_private.refresh_admin_stats(): recomputes all four ranges and upserts them; pg_cron 'watched-admin-stats'
--     every 5 minutes. A range that fails is skipped (the others still land) and keeps its previous row.
--   * public.admin_stats(range): same is_admin check, then the cached row (+ maintLastAt, rolledThrough, read now, and
--     cachedAt). Computes live (and stores the result) only when the row is missing or older than 15 minutes; if that
--     live run fails and a stale row exists, the stale row is returned (cachedAt tells the page how old it is).
-- Output shape: identical to 0008's plus cachedAt (ms).
-- Idempotent: create table if not exists, create or replace of this project's functions, cron job unscheduled then scheduled.

create or replace function overflight_private.admin_stats_compute(p_range text DEFAULT '7d'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
 SET "TimeZone" TO 'UTC'
AS $function$
declare
  v_now   timestamptz := now();
  v_today timestamptz := date_trunc('day', now() at time zone 'utc') at time zone 'utc';
  v_from  timestamptz;
  v_raw_from timestamptz;
  v_split timestamptz;
  v_hourly boolean;
  v_out   jsonb;
begin
  -- No admin check here: only admin_stats_core (checked), public.admin_stats (checked) and the cron refresh call this.
  if p_range is null or p_range not in ('24h', '7d', '30d', 'all') then p_range := '7d'; end if;

  v_from := case p_range
    when '24h' then v_now - interval '24 hours'
    when '7d'  then v_now - interval '7 days'
    when '30d' then v_now - interval '30 days'
    else '-infinity'::timestamptz end;
  v_hourly := p_range in ('24h', '7d');
  -- The raw-event window for the series, percentiles and recent lists (what 0004's raw CTE covered).
  v_raw_from := greatest(v_from, v_now - interval '90 days');

  create temp table if not exists _agg (day date, type text, dim text, val text, n bigint) on commit drop;
  truncate _agg;
  if p_range = 'all' then
    -- Rolled days from the rollup; every later day (yesterday before the cron got to it, today) from raw events.
    v_split := coalesce((select (max(day) + 1)::timestamp at time zone 'utc' from public.event_rolled), '-infinity'::timestamptz);
    insert into _agg select d.day, d.type, d.dim, d.val, d.n from public.event_days d where d.day < (v_split at time zone 'utc')::date;
    insert into _agg select * from overflight_private.event_aggregates(v_split, v_now + interval '1 minute');
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
  res as (select (props ->> 'ms')::float8 ms, (props ->> 'partial')::boolean partial, (props ->> 'archive_failed')::boolean af
          from public.events where type = 'results' and created_at >= v_raw_from),
  vit as (select (props ->> 'lcp')::float8 lcp, (props ->> 'inp')::float8 inp, (props ->> 'cls')::float8 cls
          from public.events where type = 'vitals' and created_at >= v_raw_from),
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
    from public.events where v_hourly and created_at >= v_raw_from group by 1
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
               'country', r.props ->> 'country', 'source', r.props ->> 'source', 'cell', r.props ->> 'cell', 'device', s.device) order by r.created_at desc, r.id desc)
      from (select * from public.events where type = 'search' and created_at >= v_raw_from order by created_at desc, id desc limit 40) r
      left join public.event_sessions s on s.sid = r.sid), '[]'::jsonb),
    'recentErrors', coalesce((
      select jsonb_agg(jsonb_build_object('t', (extract(epoch from r.created_at) * 1000)::bigint, 'where', r.props ->> 'where', 'msg', r.props ->> 'msg') order by r.created_at desc, r.id desc)
      from (select * from public.events where type = 'error' and created_at >= v_raw_from order by created_at desc, id desc limit 30) r), '[]'::jsonb)
  ) into v_out;
  return v_out;
end
$function$;

-- 0008's checked entry point, kept for anything that calls it directly.
create or replace function overflight_private.admin_stats_core(p_range text default '7d')
returns jsonb
language plpgsql
security definer
set search_path = public
set timezone = 'UTC'
as $$
begin
  if not overflight_private.is_admin() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return overflight_private.admin_stats_compute(p_range);
end
$$;

-- ── Cache ───────────────────────────────────────────────────────────────────────────────────

create table if not exists overflight_private.admin_stats_cache (
  range       text primary key check (range in ('24h', '7d', '30d', 'all')),
  data        jsonb not null,
  computed_at timestamptz not null
);
alter table overflight_private.admin_stats_cache enable row level security;
revoke all on table overflight_private.admin_stats_cache from public, anon, authenticated;

create or replace function overflight_private.store_admin_stats(p_range text, p_data jsonb, p_at timestamptz)
returns void
language sql
set search_path = public
as $$
  insert into overflight_private.admin_stats_cache as c (range, data, computed_at) values (p_range, p_data, p_at)
  on conflict (range) do update set data = excluded.data, computed_at = excluded.computed_at
  where c.computed_at <= excluded.computed_at;  -- never replace a newer row with an older computation
$$;

create or replace function overflight_private.refresh_admin_stats()
returns int
language plpgsql
set search_path = public
set timezone = 'UTC'
as $$
declare
  r text;
  v_done int := 0;
begin
  -- One run at a time: a run that overlaps the next tick skips it.
  if not pg_try_advisory_xact_lock(hashtext('overflight.admin_stats.refresh')) then return 0; end if;
  foreach r in array array['24h', '7d', '30d', 'all'] loop
    begin
      perform overflight_private.store_admin_stats(r, overflight_private.admin_stats_compute(r), now());
      v_done := v_done + 1;
    exception when query_canceled or others then  -- OTHERS alone does not catch a statement timeout
      raise warning 'refresh_admin_stats(%): %', r, sqlerrm;  -- keep the previous row; the other ranges still refresh
    end;
  end loop;
  return v_done;
end
$$;

-- ── Entry point ─────────────────────────────────────────────────────────────────────────────

create or replace function public.admin_stats(p_range text default '7d')
returns jsonb
language plpgsql
security definer
set search_path = public
set timezone = 'UTC'
as $$
declare
  v_last  timestamptz := (select last_at from public.event_maint where id = 1);
  v_data  jsonb;
  v_at    timestamptz;
begin
  if not overflight_private.is_admin() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_range is null or p_range not in ('24h', '7d', '30d', 'all') then p_range := '7d'; end if;

  select c.data, c.computed_at into v_data, v_at from overflight_private.admin_stats_cache c where c.range = p_range;
  if v_data is null or v_at < now() - interval '15 minutes' then
    -- Missing or stale (the cron job is behind): compute now and store it for the next load.
    begin
      v_data := overflight_private.admin_stats_compute(p_range);
      v_at := now();
      perform overflight_private.store_admin_stats(p_range, v_data, v_at);
    exception when query_canceled or others then  -- OTHERS alone does not catch a statement timeout
      if v_data is null then raise; end if;  -- nothing cached to fall back on: the page shows the error
      -- else: the stale row, with its own cachedAt
    end;
  end if;

  return v_data || jsonb_build_object(
    'cachedAt', (extract(epoch from v_at) * 1000)::bigint,
    'maintLastAt', case when isfinite(v_last) then (extract(epoch from v_last) * 1000)::bigint end,
    'rolledThrough', (select max(day)::text from public.event_rolled));
end
$$;

revoke all on all functions in schema overflight_private from public, anon, authenticated;
revoke all on function public.admin_stats(text) from public, anon, authenticated;
grant execute on function public.admin_stats(text) to authenticated;

-- ── Schedule ────────────────────────────────────────────────────────────────────────────────

select cron.unschedule(jobid) from cron.job where jobname = 'watched-admin-stats';
select cron.schedule('watched-admin-stats', '*/5 * * * *', 'select overflight_private.refresh_admin_stats()');
