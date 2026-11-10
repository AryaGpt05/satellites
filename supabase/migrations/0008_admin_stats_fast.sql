-- 0008: admin_stats fast at launch volume. On launch day (~210k raw events in 18 h) admin_stats('24h') took ~9.6 s,
-- past the authenticated role's 8 s statement_timeout, so /admin showed "canceling statement due to statement timeout".
--   * event_aggregates reads the few props each dimension needs once per event (not the whole props per use) and joins
--     session attributes once per session-day (not once per event). Same rows.
--   * admin_stats_core no longer materialises every raw event's props in one shared CTE: the series, percentiles and
--     recent lists each read public.events directly (the recent lists through the (type, created_at) index).
--   * The recent lists break created_at ties by id, so their order is stable.
-- Measured on the live data in one repeatable-read snapshot (rolled back): 24h 6.8-9.6 s -> 2.4 s, 7d 7.4 -> 2.2 s,
-- 30d 3.6 -> 1.7 s, all 1.3 -> 0.6 s; every key identical except recentErrors' order among equal timestamps.
-- Idempotent: create or replace of functions this project owns; grants are unchanged (admin_stats still wraps the core).

create or replace function overflight_private.event_aggregates(p_from timestamp with time zone, p_to timestamp with time zone)
 returns table(day date, type text, dim text, val text, n bigint)
 language sql
 stable
 set search_path to 'public'
as $function$
  -- 0008: the few props each dimension needs are read once per event (not the whole props per use), and session
  -- attributes are joined once per session-day (not once per event). Same rows as 0004's version.
  with e as materialized (
    select (ev.created_at at time zone 'utc')::date as day, ev.type, ev.sid,
           ev.type = 'search' and ev.props ? 'label'   as has_label,   case when ev.type = 'search' then ev.props ->> 'label' end   as label,
           ev.type = 'search' and ev.props ? 'country' as has_country, case when ev.type = 'search' then ev.props ->> 'country' end as s_country,
           ev.type = 'search' and ev.props ? 'source'  as has_source,  case when ev.type = 'search' then ev.props ->> 'source' end  as source,
           ev.type = 'search' and ev.props ? 'cell'    as has_cell,    case when ev.type = 'search' then ev.props ->> 'cell' end    as cell,
           ev.type in ('pass_open', 'share_action') and (ev.props ? 'sat' or ev.props ? 'norad') as has_sat,
           case when ev.type in ('pass_open', 'share_action') then coalesce(ev.props ->> 'sat', 'NORAD ' || (ev.props ->> 'norad')) end as sat,
           ev.type = 'pass_open' and ev.props ? 'verdict' as has_verdict, case when ev.type = 'pass_open' then ev.props ->> 'verdict' end as verdict,
           case when ev.type = 'share_action' then ev.props ->> 'action' end as action
    from public.events ev
    where ev.created_at >= p_from and ev.created_at < p_to
  ),
  ses as materialized (
    select d.day, d.sid, coalesce(s.device, '') as device, coalesce(s.country, '') as country,
           coalesce(s.ref_host, '') as ref_host, coalesce(s.utm, '') as utm
    from (select distinct e.day, e.sid from e) d
    left join public.event_sessions s on s.sid = d.sid
  )
  select e.day, e.type, '', '', count(*) from e group by 1, 2
  union all select ses.day, 'session', '', '', count(*) from ses group by 1
  union all select ses.day, 'session', 'device', ses.device, count(*) from ses group by 1, 4
  union all select ses.day, 'session', 'country', ses.country, count(*) from ses group by 1, 4
  union all select ses.day, 'session', 'ref', ses.ref_host, count(*) from ses where ses.ref_host <> '' group by 1, 4
  union all select ses.day, 'session', 'utm', ses.utm, count(*) from ses where ses.utm <> '' group by 1, 4
  union all select e.day, 'search', 'label', e.label, count(*) from e where e.has_label group by 1, 4
  union all select e.day, 'search', 'country', e.s_country, count(*) from e where e.has_country group by 1, 4
  union all select e.day, 'search', 'source', e.source, count(*) from e where e.has_source group by 1, 4
  union all select e.day, 'search', 'cell', e.cell, count(*) from e where e.has_cell group by 1, 4
  union all select e.day, e.type, 'sat', e.sat, count(*) from e where e.has_sat group by 1, 2, 4
  union all select e.day, 'pass_open', 'verdict', e.verdict, count(*) from e where e.has_verdict group by 1, 4
  union all select e.day, 'share_action', 'action', e.action, count(*) from e where e.type = 'share_action' group by 1, 4
  union all select e.day, 'funnel', 'stage', e.type, count(distinct e.sid)
    from e where e.type in ('search', 'results', 'pass_open', 'lightbox_open', 'share_open', 'share_action') group by 1, 4
$function$;

create or replace function overflight_private.admin_stats_core(p_range text DEFAULT '7d'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
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
