-- Checks for 0008_admin_stats_fast.sql: the 0005 checks (log_events, rollup, admin_stats over rolled + unrolled days, an admin),
-- run against the 0008 functions. Safe on the live database: row writes only, inside begin; <0008>; <this file>; rollback.
-- (The 0004 test re-runs 0004's DDL, which needs table locks; do not run it against a busy production database.)

-- ── DB-1: back-dated events still count toward the per-tab limit ────────────────────────────
set local role anon;
select public.log_events(jsonb_build_object('sid', 'test5_sid_aaaaaaaaaaaaaa',
  'events', (select jsonb_agg(jsonb_build_object('type', 'about_open', 'dt', 120000)) from generate_series(1, 50))))
from generate_series(1, 5);
reset role;
do $$
begin
  if (select count(*) from public.events where sid = 'test5_sid_aaaaaaaaaaaaaa') <> 120 then
    raise exception 'DB-1: back-dated flood stored % rows (limit 120)', (select count(*) from public.events where sid = 'test5_sid_aaaaaaaaaaaaaa');
  end if;
  if (select count(*) from public.events where sid = 'test5_sid_aaaaaaaaaaaaaa' and created_at > now() - interval '1 minute') <> 0 then
    raise exception 'DB-1: dt was not applied to created_at';
  end if;
end
$$;

-- ── DB-3: no tab row without an accepted event; missing keys raise ──────────────────────────
set local role anon;
select public.log_events('{"sid": "test5_sid_bbbbbbbbbbbbbb", "events": [{"type": "nope"}, "junk", {"type": "share_action", "p": {"action": "pwn"}}]}'::jsonb);
do $$
begin
  begin
    perform public.log_events('{"sid": "test5_sid_cccccccccccccc"}'::jsonb);
    raise exception 'DB-3: batch without events accepted';
  exception when sqlstate '22023' then null;
  end;
  begin
    perform public.log_events('{"events": [{"type": "view"}]}'::jsonb);
    raise exception 'DB-3: batch without sid accepted';
  exception when sqlstate '22023' then null;
  end;
end
$$;
reset role;
do $$
begin
  if exists (select 1 from public.event_sessions where sid in ('test5_sid_bbbbbbbbbbbbbb', 'test5_sid_cccccccccccccc')) then
    raise exception 'DB-3: a tab row was created with no accepted event';
  end if;
end
$$;

-- ── DB-4 / DB-5: coordinates and addresses never stored, even when sent ──────────────────────
set local role anon;
select public.log_events($j${
  "sid": "test5_sid_dddddddddddddd",
  "ctx": {"device": "desktop", "ref": "43.4723.-80.5449", "v": "43.4723_-80.5449", "utm_source": "43.4723,-80.5449", "utm_campaign": "123 King St N Waterloo"},
  "events": [
    {"type": "search", "p": {"source": "search", "label": "43.4723, -80.5449 (123 King St N)", "cell": "43.4723,-80.5449"}},
    {"type": "pass_open", "p": {"norad": 60989, "sat": "43.4723,-80.5449"}},
    {"type": "error", "p": {"where": "window", "msg": "at 43\u200b.4723,-80\u200b.5449 see https\u200b://x.example/?lat=43\u200b.4723"}},
    {"type": "search", "p": {"source": "search", "label": "Waterloo, Ontario, Canada", "cell": "43.5,-80.5"}}
  ]}$j$::jsonb);
select public.log_events('{"sid": "test5_sid_eeeeeeeeeeeeee", "ctx": {"ref": "News.YCombinator.com", "v": "0.1.0"}, "events": [{"type": "view"}]}'::jsonb);
select public.log_events('{"sid": "test5_sid_ffffffffffffff", "ctx": {"ref": "t.co", "v": "a1b2c3d"}, "events": [{"type": "view"}]}'::jsonb);
reset role;
do $$
declare
  s public.event_sessions;
  t text;
begin
  select * into s from public.event_sessions where sid = 'test5_sid_dddddddddddddd';
  if s.ref_host is not null then raise exception 'DB-4: numeric ref stored: %', s.ref_host; end if;
  if s.app_version is not null then raise exception 'DB-4: junk version stored: %', s.app_version; end if;
  if s.utm ~ '\d+\.\d+' then raise exception 'DB-4: decimals in utm: %', s.utm; end if;
  select string_agg(props::text, ' ') into t from public.events where sid = 'test5_sid_dddddddddddddd';
  if t ~ '43[.,]?4723|80[.,]?5449' or t ~ 'King' or t ~ 'https?:' then raise exception 'DB-4/5: coordinates, address or url stored: %', t; end if;
  if (select count(*) from public.events where sid = 'test5_sid_dddddddddddddd' and type = 'search' and props ? 'label') <> 1 then
    raise exception 'DB-4: city label lost or digit label kept: %', t;
  end if;
  if (select props ->> 'cell' from public.events where sid = 'test5_sid_dddddddddddddd' and type = 'search' order by id limit 1) <> '43.5,-80.5' then
    raise exception 'cell not re-rounded';
  end if;
  if (select ref_host || ' ' || app_version from public.event_sessions where sid = 'test5_sid_eeeeeeeeeeeeee') <> 'news.ycombinator.com 0.1.0' then
    raise exception 'valid ref/semver rejected';
  end if;
  if (select ref_host || ' ' || app_version from public.event_sessions where sid = 'test5_sid_ffffffffffffff') <> 't.co a1b2c3d' then
    raise exception 'valid ref/sha rejected';
  end if;
end
$$;

-- ── DB-6: the admin is a confirmed, non-anonymous auth user, not just an email claim ────────
-- A test-only admin (the real admin's account may exist: a second row with that email would collide).
insert into overflight_private.admins (email) values ('test-admin@watched.invalid');
insert into auth.users (id, email, email_confirmed_at, aud, role, is_anonymous) values
  ('00000000-0000-0000-0000-00000000a001', 'test-admin@watched.invalid', now(), 'authenticated', 'authenticated', false),
  ('00000000-0000-0000-0000-00000000a002', 'someone@example.com',   now(), 'authenticated', 'authenticated', false);

create or replace function pg_temp.as_user(sub text, email text, extra jsonb default '{}') returns void language sql as $$
  select set_config('request.jwt.claims', (jsonb_build_object('role', 'authenticated', 'sub', sub, 'email', email) || extra)::text, true)
$$;

-- an anonymous / unknown user carrying the admin's email claim
select pg_temp.as_user('00000000-0000-0000-0000-00000000a0ff', 'test-admin@watched.invalid', '{"is_anonymous": true}');
set local role authenticated;
do $$ begin
  perform public.admin_stats('24h');
  raise exception 'DB-6: unknown user with the admin email claim got stats';
exception when insufficient_privilege then null; end $$;
reset role;

-- a real non-admin user claiming the admin email
select pg_temp.as_user('00000000-0000-0000-0000-00000000a002', 'test-admin@watched.invalid');
set local role authenticated;
do $$ begin
  perform public.admin_stats('24h');
  raise exception 'DB-6: non-admin user with a forged email claim got stats';
exception when insufficient_privilege then null; end $$;
reset role;

-- the admin, before confirming the email
update auth.users set email_confirmed_at = null where id = '00000000-0000-0000-0000-00000000a001';
select pg_temp.as_user('00000000-0000-0000-0000-00000000a001', 'test-admin@watched.invalid');
set local role authenticated;
do $$ begin
  perform public.admin_stats('24h');
  raise exception 'DB-6: unconfirmed admin got stats';
exception when insufficient_privilege then null; end $$;
reset role;
update auth.users set email_confirmed_at = now() where id = '00000000-0000-0000-0000-00000000a001';

-- ── DB-2 / DB-7: cron maintenance, bounded; 'all' keeps unrolled days ───────────────────────
do $$
begin
  if not exists (select 1 from cron.job where jobname = 'watched-events-maintain' and command like '%maintain_events%') then
    raise exception 'DB-2: maintenance job not scheduled';
  end if;
  if pg_get_functiondef('public.log_events(jsonb)'::regprocedure) ~ 'maintain_events'
     or pg_get_functiondef('public.admin_stats(text)'::regprocedure) ~ 'maintain_events' then
    raise exception 'DB-2: maintenance still on the request path';
  end if;
end
$$;

insert into public.event_sessions (sid, first_at, last_at, device) values
  ('test5_sid_gggggggggggggg', now() - interval '10 days', now() - interval '1 day', 'desktop'),
  ('test5_sid_hhhhhhhhhhhhhh', now() - interval '95 days', now() - interval '95 days', 'desktop');
insert into public.events (created_at, sid, type, props) values
  (now() - interval '10 days', 'test5_sid_gggggggggggggg', 'search', '{"label": "Ten Days, Ago"}'),
  (now() - interval '1 day',   'test5_sid_gggggggggggggg', 'search', '{"label": "Yesterday, Unrolled"}'),
  (now() - interval '95 days', 'test5_sid_hhhhhhhhhhhhhh', 'search', '{"label": "Old, Place"}');
-- Pretend everything up to 11 days ago was rolled already (an empty rollup), so the walk starts there.
delete from public.event_rolled;
delete from public.event_days;
insert into public.event_rolled (day) select generate_series(((now() - interval '120 days') at time zone 'utc')::date, ((now() - interval '11 days') at time zone 'utc')::date, interval '1 day')::date;
select overflight_private.maintain_events();
do $$
declare
  ten date := ((now() - interval '10 days') at time zone 'utc')::date;
  rolled_to date := (select max(day) from public.event_rolled);
begin
  if rolled_to <> ((now() - interval '11 days') at time zone 'utc')::date + 7 then
    raise exception 'DB-2: expected exactly 7 days rolled per run, rolled to %', rolled_to;
  end if;
  if (select n from public.event_days where day = ten and type = 'search' and dim = 'label' and val = 'Ten Days, Ago') <> 1 then
    raise exception 'rollup missed the 10-day-old search';
  end if;
  if exists (select 1 from public.events where sid = 'test5_sid_hhhhhhhhhhhhhh') then raise exception '95-day-old event not pruned'; end if;
  if exists (select 1 from public.event_sessions where sid = 'test5_sid_hhhhhhhhhhhhhh') then raise exception '95-day-old tab not pruned'; end if;
  if not exists (select 1 from public.events where sid = 'test5_sid_gggggggggggggg') then raise exception 'recent raw events pruned'; end if;
end
$$;

select pg_temp.as_user('00000000-0000-0000-0000-00000000a001', 'test-admin@watched.invalid');
set local role authenticated;
do $$
declare
  a jsonb := public.admin_stats('all');
  d jsonb := public.admin_stats('24h');
begin
  -- Top lists keep the 15 biggest; real searches on the live database can outrank a test row (see the 0004 test).
  if not ((a -> 'top' -> 'search.label') @> '[["Yesterday, Unrolled", 1]]' or (jsonb_array_length(a -> 'top' -> 'search.label') >= 15
      and not exists (select 1 from jsonb_array_elements(a -> 'top' -> 'search.label') e where e ->> 0 = 'Yesterday, Unrolled')
      and (select min((e ->> 1)::bigint) from jsonb_array_elements(a -> 'top' -> 'search.label') e) >= 1)) then raise exception 'DB-7: unrolled day missing from all: %', a -> 'top' -> 'search.label'; end if;
  if not ((a -> 'top' -> 'search.label') @> '[["Ten Days, Ago", 1]]' or (jsonb_array_length(a -> 'top' -> 'search.label') >= 15
      and not exists (select 1 from jsonb_array_elements(a -> 'top' -> 'search.label') e where e ->> 0 = 'Ten Days, Ago')
      and (select min((e ->> 1)::bigint) from jsonb_array_elements(a -> 'top' -> 'search.label') e) >= 1)) then raise exception 'all misses the rolled day: %', a -> 'top' -> 'search.label'; end if;
  if (a -> 'top' -> 'search.label') @> '[["Ten Days, Ago", 2]]' then raise exception 'rolled day counted twice'; end if;
  if (a #>> '{dimTotals,search.label}') is null then raise exception 'dimTotals missing'; end if;
  if (d #>> '{totals,search}')::int < 1 then raise exception 'confirmed admin got no data: %', d -> 'totals'; end if;
end
$$;
reset role;

select 'all 0008 checks passed' as result;
