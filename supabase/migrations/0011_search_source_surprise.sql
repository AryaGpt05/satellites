-- 0011: search events may say they came from the landing's "Surprise me" chip: source 'surprise'.
--
-- Until now a Surprise me pick reported source 'example', the same as the example chips, so the admin page could not
-- tell the two apart. Two parts:
--  1. event_props as in 0010, with 'surprise' added to the search sources; nothing else changes. Until this is
--     applied, a Surprise me search from the new client is still recorded, with no source (jenum drops values it
--     doesn't know).
--  2. reclassify_surprise_searches() moves the Surprise me searches already recorded to source 'surprise', in the raw
--     events and in the daily rollup (event_days) of any day already closed. It is run once below, and is safe to run
--     again (it only moves what is still misfiled): tabs opened before the new client shipped keep reporting a pick
--     as 'example' until they reload.
--
-- Which searches were Surprise me: the chip shipped on 2026-11-11 at 00:47:48 UTC (commit 9d35c15). From then on, an
-- 'example' search whose label is none of the launch's five example chips can only be a Surprise me pick. Uluru and
-- Palm Jumeirah are in the Surprise me pool but were chips until that morning, so a search for either stays an example
-- chip: a stale tab's chip and a Surprise pick look the same. A search with no source since then is a new client's
-- 'surprise' that arrived before part 1 (every other source the client sends was already allowed).

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
        'source',  overflight_private.jenum(p, 'source', array['search', 'example', 'surprise', 'near_me', 'pin', 'deep_link', 'share_link', 'retry']),
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

revoke all on function overflight_private.event_props(text, jsonb) from public, anon, authenticated;

-- ── Searches already recorded ───────────────────────────────────────────────────────────────

-- Returns how many searches it moved. Rewrites only the source of each one (no row is deleted), and moves the same
-- number from 'example' to 'surprise' in event_days for a day that is already rolled up (a search recorded with no
-- source was never counted there, so it only adds to 'surprise'). Holds maintain_events' lock, so a day can't be
-- rolled up from the old sources halfway through (maintain_events skips that run).
create or replace function overflight_private.reclassify_surprise_searches()
returns int
language plpgsql
set search_path = public
as $$
declare
  v_launch constant timestamptz := '2026-11-11 00:47:48+00';
  -- The five example chips at launch, as their searches are labelled (src/ui/landing/places.ts; Area 51's label is
  -- its settlement). Since Surprise me, three remain.
  v_chips constant text[] := array[
    'Groom Lake, Nevada, United States',
    'Central Park, New York, United States',
    'Pyramids of Giza, Giza, Egypt',
    'Uluru, Northern Territory, Australia',
    'Palm Jumeirah, Dubai, United Arab Emirates'];
  v_moved int;
begin
  perform pg_advisory_xact_lock(hashtext('overflight.events.maintain'));

  with m as (
    select ev.id, ev.props ->> 'source' as old
    from public.events ev
    where ev.type = 'search'
      and ev.created_at >= v_launch
      and ((ev.props ->> 'source' = 'example' and ev.props ->> 'label' is not null and not (ev.props ->> 'label' = any (v_chips)))
           or not (ev.props ? 'source'))
  ),
  moved as (
    update public.events ev
    set props = ev.props || jsonb_build_object('source', 'surprise')
    from m
    where ev.id = m.id
    returning (ev.created_at at time zone 'utc')::date as day, m.old
  ),
  per_day as (
    select moved.day, count(*) filter (where moved.old = 'example') as ex, count(*) as n
    from moved
    where moved.day in (select r.day from public.event_rolled r)
    group by moved.day
  ),
  dec as (
    update public.event_days d
    set n = d.n - p.ex
    from per_day p
    where p.ex > 0 and d.day = p.day and d.type = 'search' and d.dim = 'source' and d.val = 'example'
  ),
  inc as (
    insert into public.event_days (day, type, dim, val, n)
    select p.day, 'search', 'source', 'surprise', p.n from per_day p
    on conflict (day, type, dim, val) do update set n = public.event_days.n + excluded.n
  )
  select count(*) into v_moved from moved;

  return v_moved;
end
$$;

revoke all on function overflight_private.reclassify_surprise_searches() from public, anon, authenticated;

select overflight_private.reclassify_surprise_searches() as surprise_searches_moved;
