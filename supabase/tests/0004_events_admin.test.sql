-- Checks for 0004_events_admin.sql. scripts/backend-sql-test.sh runs it as
--   begin; <migration>; <this file>; rollback;
-- through the Management API, so nothing it writes survives. Any failed check raises, which aborts
-- the transaction and makes the API call fail.

-- ── anon: log_events accepts, allow-lists and coarsens ──────────────────────────────────────
set local role anon;
select public.log_events($j${
  "sid": "test_sid_aaaaaaaaaaaaaaaa",
  "ctx": {"device": "phone", "ref": "T.CO", "utm_source": "x", "utm_medium": "social", "v": "abc1234", "country": "ca", "ip": "1.2.3.4"},
  "events": [
    {"type": "view", "p": {"entry": "landing"}},
    {"type": "search", "dt": 1500, "p": {"source": "search", "label": "Waterloo, Ontario, Canada", "cell": "43.47,-80.54", "country": "ca", "lat": 43.4723, "lon": -80.5449}},
    {"type": "results", "p": {"sats": 31, "photos": 12, "passes": 140, "ms": 2100, "partial": true, "archive_failed": false, "extra": "x"}},
    {"type": "pass_open", "p": {"verdict": "imaged", "norad": 60989, "sat": "Sentinel-2C", "collection": "sentinel-2-l2a"}},
    {"type": "lightbox_open", "p": {"norad": 60989}},
    {"type": "share_open", "p": {"kind": "pass", "norad": 60989}},
    {"type": "share_action", "p": {"action": "x", "norad": 60989, "sat": "Sentinel-2C"}},
    {"type": "share_action", "p": {"action": "pwn"}},
    {"type": "about_open"},
    {"type": "error", "p": {"where": "window", "msg": "Failed at https://x.example/?q=43.4723,-80.5449 near 43.4723 -80.5449"}},
    {"type": "vitals", "p": {"lcp": 1800, "inp": 120, "cls": 0.02}},
    {"type": "nope", "p": {}},
    "junk"
  ]}$j$::jsonb);
reset role;

do $$
declare
  s public.event_sessions;
  p jsonb;
begin
  select * into s from public.event_sessions where sid = 'test_sid_aaaaaaaaaaaaaaaa';
  if s.device <> 'phone' or s.ref_host <> 't.co' or s.country <> 'ca' or s.utm <> 'x / social' or s.app_version <> 'abc1234' then
    raise exception 'session context wrong: %', row_to_json(s);
  end if;
  if s.n <> 10 then raise exception 'expected 10 accepted events, got %', s.n; end if;

  select props into p from public.events where sid = s.sid and type = 'search';
  if p <> '{"source": "search", "label": "Waterloo, Ontario, Canada", "cell": "43.5,-80.5", "country": "ca"}'::jsonb then
    raise exception 'search props wrong (coords must be dropped, cell re-rounded): %', p;
  end if;
  if (select created_at from public.events where sid = s.sid and type = 'search') <> now() - interval '1.5 seconds' then
    raise exception 'dt back-dating wrong';
  end if;
  select props into p from public.events where sid = s.sid and type = 'results';
  if p ? 'extra' or (p ->> 'sats')::int <> 31 or (p ->> 'partial')::boolean is not true then raise exception 'results props wrong: %', p; end if;
  if (select count(*) from public.events where sid = s.sid and type = 'share_action') <> 1 then raise exception 'invalid share action stored'; end if;
  select props into p from public.events where sid = s.sid and type = 'error';
  if p ->> 'msg' ~ '\d+\.\d+' or p ->> 'msg' ~ 'https?:' then raise exception 'error message not defanged: %', p; end if;
  if exists (select 1 from public.events where sid = s.sid and (props::text ~ '43\.47' or props::text ~ '80\.54')) then
    raise exception 'exact coordinates were stored';
  end if;
end
$$;

-- ── anon: envelope validation raises ────────────────────────────────────────────────────────
set local role anon;
do $$
begin
  begin
    perform public.log_events('{"sid": "short", "events": [{"type": "view"}]}'::jsonb);
    raise exception 'bad sid accepted';
  exception when sqlstate '22023' then null;
  end;
  begin
    perform public.log_events(jsonb_build_object('sid', 'test_sid_bbbbbbbbbbbbbbbb',
      'events', (select jsonb_agg(jsonb_build_object('type', 'about_open')) from generate_series(1, 51))));
    raise exception '51 events accepted';
  exception when sqlstate '22023' then null;
  end;
  begin
    perform public.log_events(jsonb_build_object('sid', 'test_sid_bbbbbbbbbbbbbbbb', 'events', '[]'::jsonb, 'pad', repeat('a', 17000)));
    raise exception 'oversized batch accepted';
  exception when sqlstate '22023' then null;
  end;
end
$$;

-- Rate limit: 120 per tab per minute.
select public.log_events(jsonb_build_object('sid', 'test_sid_cccccccccccccccc',
  'events', (select jsonb_agg(jsonb_build_object('type', 'about_open')) from generate_series(1, 50))))
from generate_series(1, 3);
reset role;
do $$
begin
  if (select count(*) from public.events where sid = 'test_sid_cccccccccccccccc') <> 120 then
    raise exception 'rate limit: expected 120, got %', (select count(*) from public.events where sid = 'test_sid_cccccccccccccccc');
  end if;
end
$$;

-- ── anon: no table access, no admin_stats ───────────────────────────────────────────────────
set local role anon;
do $$
begin
  begin
    perform 1 from public.events limit 1;
    raise exception 'anon can read events';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from public.event_sessions limit 1;
    raise exception 'anon can read event_sessions';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.admin_stats('7d');
    raise exception 'anon can call admin_stats';
  exception when insufficient_privilege then null;
  end;
end
$$;
reset role;

-- ── authenticated, not the admin: refused ───────────────────────────────────────────────────
select set_config('request.jwt.claims', '{"role": "authenticated", "email": "someone@example.com", "sub": "00000000-0000-0000-0000-000000000001"}', true);
set local role authenticated;
do $$
begin
  begin
    perform public.admin_stats('7d');
    raise exception 'non-admin got admin_stats';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from overflight_private.admins;
    raise exception 'authenticated can read admins';
  exception when insufficient_privilege then null;
  end;
end
$$;
reset role;

-- ── rollup + prune ──────────────────────────────────────────────────────────────────────────
insert into public.event_sessions (sid, first_at, last_at, device, country) values
  ('test_sid_dddddddddddddddd', now() - interval '3 days', now() - interval '3 days', 'desktop', 'jp'),
  ('test_sid_eeeeeeeeeeeeeeee', now() - interval '91 days', now() - interval '91 days', 'desktop', 'jp');
insert into public.events (created_at, sid, type, props) values
  (now() - interval '3 days', 'test_sid_dddddddddddddddd', 'search', '{"source": "example", "label": "Tokyo, Japan", "cell": "35.7,139.7", "country": "jp"}'),
  (now() - interval '3 days', 'test_sid_dddddddddddddddd', 'search', '{"source": "example", "label": "Tokyo, Japan", "cell": "35.7,139.7", "country": "jp"}'),
  (now() - interval '91 days', 'test_sid_eeeeeeeeeeeeeeee', 'search', '{"source": "search", "label": "Old, Place", "cell": "1.0,1.0"}');
update public.event_maint set last_at = '-infinity';
select overflight_private.maintain_events();
do $$
declare d date := ((now() - interval '3 days') at time zone 'utc')::date;
begin
  if (select n from public.event_days where day = d and type = 'search' and dim = 'label' and val = 'Tokyo, Japan') <> 2 then
    raise exception 'rollup missing Tokyo';
  end if;
  if not exists (select 1 from public.event_rolled where day = d) then raise exception 'day not marked rolled'; end if;
  if exists (select 1 from public.events where sid = 'test_sid_eeeeeeeeeeeeeeee') then raise exception '91-day-old event not pruned'; end if;
  if exists (select 1 from public.event_sessions where sid = 'test_sid_eeeeeeeeeeeeeeee') then raise exception '91-day-old session not pruned'; end if;
end
$$;

-- ── the admin ───────────────────────────────────────────────────────────────────────────────
reset role;
insert into overflight_private.admins (email) values ('admin@example.com') on conflict do nothing;
select set_config('request.jwt.claims', '{"role": "authenticated", "email": "ADMIN@example.com", "sub": "00000000-0000-0000-0000-000000000002"}', true);
set local role authenticated;
do $$
declare
  j jsonb := public.admin_stats('24h');
  a jsonb := public.admin_stats('all');
  w jsonb := public.admin_stats('7d');
  m jsonb := public.admin_stats('30d');
begin
  if (j #>> '{totals,search}')::int < 1 then raise exception 'admin_stats 24h has no search: %', j -> 'totals'; end if;
  if (j #>> '{funnel,share_action}')::int < 1 then raise exception 'funnel missing share: %', j -> 'funnel'; end if;
  if jsonb_array_length(j -> 'series') not between 24 and 26 then raise exception '24h series length %', jsonb_array_length(j -> 'series'); end if;
  if not (j -> 'top' -> 'search.label') @> '[["Waterloo, Ontario, Canada", 1]]' then raise exception 'top labels: %', j -> 'top'; end if;
  if (j -> 'recentSearches' -> 0 ->> 'label') <> 'Waterloo, Ontario, Canada' then raise exception 'recent searches: %', j -> 'recentSearches'; end if;
  if jsonb_array_length(j -> 'recentErrors') < 1 then raise exception 'recent errors empty'; end if;
  if not (a -> 'top' -> 'search.label') @> '[["Tokyo, Japan", 2]]' then raise exception 'all-time misses the rollup: %', a -> 'top'; end if;
  if (w -> 'top' -> 'search.label') @> '[["Old, Place", 1]]' then raise exception 'pruned event still counted'; end if;
  if jsonb_array_length(m -> 'series') < 3 then raise exception '30d series: %', m -> 'series'; end if;
  raise notice 'admin_stats 24h: %', left(j::text, 400);
end
$$;
reset role;

select 'all 0004 checks passed' as result;
