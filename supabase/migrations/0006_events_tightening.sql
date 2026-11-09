-- ════════════════════════════════════════════════════════════════════════════════════════════
-- 0006: last tightening of the in-app events (review round 3)
--
--   * Text normalisation before any digit / decimal check: non-ASCII digits (Arabic-Indic, Persian,
--     Devanagari, Bengali, Thai, full-width, …) become ASCII, and more invisible characters go (U+061C,
--     U+180E, variation selectors U+FE00–FE0F, tags U+E0000–E007F). Error messages mask comma
--     decimals too.
--   * log_events: the cheap limit checks run before the per-event validation; the global budget is
--     3000 events + new tabs a minute (≤ 180k an hour, which the hourly prune of ≤ 200k can keep up with).
--   * events_sid_created_at_idx (0004) is unused since 0005 counts on inserted_at: dropped.
--   * admin_stats also returns maintLastAt and rolledThrough, so the page can say when the hourly
--     maintenance is behind.
--
-- Idempotent: create or replace of functions 0004/0005 created, drop index if exists.
-- ════════════════════════════════════════════════════════════════════════════════════════════

drop index if exists public.events_sid_created_at_idx;

-- ASCII digits for every other decimal-digit script in common use (so '\d' checks and masks see them).
create or replace function overflight_private.ascii_digits(s text)
returns text
language sql immutable
set search_path = public
as $$
  select translate(s,
    '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹०१२३४५६७८९০১২৩৪৫৬৭৮৯੦੧੨੩੪੫੬੭੮੯૦૧૨૩૪૫૬૭૮૯௦௧௨௩௪௫௬௭௮௯౦౧౨౩౪౫౬౭౮౯೦೧೨೩೪೫೬೭೮೯൦൧൨൩൪൫൬൭൮൯๐๑๒๓๔๕๖๗๘๙໐໑໒໓໔໕໖໗໘໙༠༡༢༣༤༥༦༧༨༩၀၁၂၃၄၅၆၇၈၉០១២៣៤៥៦៧៨៩᠐᠑᠒᠓᠔᠕᠖᠗᠘᠙０１２３４５６７８９',
    repeat('0123456789', 17))
$$;

-- Control and invisible format characters removed, digits made ASCII. Everything that checks for digits
-- or decimals runs on this first.
create or replace function overflight_private.strip_invisible(s text)
returns text
language sql immutable
set search_path = public
as $$
  select overflight_private.ascii_digits(regexp_replace(regexp_replace(s, '[[:cntrl:]]', '', 'g'),
    '[­؜᠎​-‏‪-‮⁠-⁩︀-️﻿\U000e0000-\U000e007f]', '', 'g'))
$$;

create or replace function overflight_private.clean_msg(s text)
returns text
language sql immutable
set search_path = public
as $$
  select overflight_private.clean_text(
    left(regexp_replace(regexp_replace(overflight_private.strip_invisible(s), '[a-z][a-z0-9+.-]*://\S+', '[url]', 'gi'), '-?\d+[.,]\d+', '#', 'g'), 200),
    200)
$$;

-- ── log_events: limits first ────────────────────────────────────────────────────────────────

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
  v_take   int;
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

  -- Limits (on insertion time), before any per-event work: 2000 events per tab overall, 120 per tab per
  -- minute, 3000 events + new tabs per minute overall.
  select * into v_ses from public.event_sessions where sid = v_sid;
  v_known := found;
  if v_known and v_ses.n >= 2000 then return; end if;
  v_room := least(120 - (select count(*) from public.events where sid = v_sid and inserted_at > now() - interval '1 minute')::int,
                  2000 - coalesce(v_ses.n, 0));
  if v_room <= 0 then return; end if;
  if (select count(*) from public.events where inserted_at > now() - interval '1 minute')
     + (select count(*) from public.event_sessions where first_at > now() - interval '1 minute') >= 3000 then
    return;
  end if;

  v_ctx := case when jsonb_typeof(batch -> 'ctx') = 'object' then batch -> 'ctx' else '{}'::jsonb end;
  for ev in select value from jsonb_array_elements(v_events) loop
    exit when cardinality(v_type) >= v_room;
    continue when jsonb_typeof(ev) is distinct from 'object' or jsonb_typeof(ev -> 'type') is distinct from 'string';
    v_p := overflight_private.event_props(ev ->> 'type', ev -> 'p');
    continue when v_p is null;
    v_type := array_append(v_type, ev ->> 'type');
    v_props := array_append(v_props, v_p);
    v_dts := array_append(v_dts, coalesce(overflight_private.jint(ev, 'dt', 0, 600000), 0));
  end loop;
  v_take := cardinality(v_type);
  if v_take = 0 then return; end if; -- nothing acceptable: no tab row either

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

  for i in 1 .. v_take loop
    insert into public.events (created_at, sid, type, props)
    values (now() - make_interval(secs => v_dts[i] / 1000.0), v_sid, v_type[i], v_props[i]);
  end loop;

  update public.event_sessions set last_at = now(), n = n + v_take where sid = v_sid;
end
$$;

-- ── admin_stats: + maintenance status ───────────────────────────────────────────────────────
-- The 0005 body, wrapped: the same JSON plus maintLastAt (ms, or null before the first run) and
-- rolledThrough ('YYYY-MM-DD', or null). The 0005 function is kept under a private name.

do $$
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'overflight_private' and p.proname = 'admin_stats_core') then
    alter function public.admin_stats(text) set schema overflight_private;
    alter function overflight_private.admin_stats(text) rename to admin_stats_core;
  end if;
end
$$;

create or replace function public.admin_stats(p_range text default '7d')
returns jsonb
language plpgsql
security definer
set search_path = public
set timezone = 'UTC'
as $$
declare
  v_last timestamptz := (select last_at from public.event_maint where id = 1);
begin
  -- admin_stats_core checks is_admin itself; checked here too so nothing runs for anyone else.
  if not overflight_private.is_admin() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return overflight_private.admin_stats_core(p_range) || jsonb_build_object(
    'maintLastAt', case when isfinite(v_last) then (extract(epoch from v_last) * 1000)::bigint end,
    'rolledThrough', (select max(day)::text from public.event_rolled));
end
$$;

revoke all on all functions in schema overflight_private from public, anon, authenticated;
revoke all on function public.admin_stats(text) from public, anon, authenticated;
grant execute on function public.admin_stats(text) to authenticated;
revoke all on function public.log_events(jsonb) from public, anon, authenticated;
grant execute on function public.log_events(jsonb) to anon, authenticated;
