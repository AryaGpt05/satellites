-- Checks for 0009_admin_stats_cache.sql. Safe on the live database: row writes only (test users, a test admin, test
-- events, cache rows), inside begin; <0009>; <this file>; rollback.  Nothing survives.
-- (No DDL on existing tables: the 0004 test's pattern needs table locks and deadlocks against live traffic.)

-- ── Grants: nothing private is reachable by anon or authenticated ───────────────────────────
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if has_table_privilege(r, 'overflight_private.admin_stats_cache', 'select')
       or has_table_privilege(r, 'overflight_private.admin_stats_cache', 'insert')
       or has_table_privilege(r, 'overflight_private.admin_stats_cache', 'update') then
      raise exception 'grants: % can touch admin_stats_cache', r;
    end if;
    if has_function_privilege(r, 'overflight_private.admin_stats_compute(text)', 'execute')
       or has_function_privilege(r, 'overflight_private.refresh_admin_stats()', 'execute')
       or has_function_privilege(r, 'overflight_private.store_admin_stats(text, jsonb, timestamptz)', 'execute') then
      raise exception 'grants: % can call the unchecked stats functions', r;
    end if;
  end loop;
  if has_function_privilege('anon', 'public.admin_stats(text)', 'execute') then raise exception 'grants: anon can call admin_stats'; end if;
  if not has_function_privilege('authenticated', 'public.admin_stats(text)', 'execute') then raise exception 'grants: authenticated lost admin_stats'; end if;
  if not exists (select 1 from cron.job where jobname = 'watched-admin-stats' and schedule = '*/5 * * * *' and command like '%refresh_admin_stats%') then
    raise exception 'cron: watched-admin-stats not scheduled every 5 minutes';
  end if;
  if (select count(*) from cron.job where jobname = 'watched-admin-stats') <> 1 then raise exception 'cron: job scheduled twice'; end if;
end
$$;

-- ── Users: a test admin and a non-admin ─────────────────────────────────────────────────────
-- A test-only admin (the real admin's account may exist: a second row with that email would collide).
insert into overflight_private.admins (email) values ('test-admin@watched.invalid');
insert into auth.users (id, email, email_confirmed_at, aud, role, is_anonymous) values
  ('00000000-0000-0000-0000-00000000a001', 'test-admin@watched.invalid', now(), 'authenticated', 'authenticated', false),
  ('00000000-0000-0000-0000-00000000a002', 'someone@example.com',   now(), 'authenticated', 'authenticated', false);

create or replace function pg_temp.as_user(sub text, email text) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', sub, 'email', email)::text, true)
$$;

insert into public.event_sessions (sid, first_at, last_at, device) values ('test9_sid_aaaaaaaaaaaaaa', now() - interval '1 hour', now(), 'desktop');
insert into public.events (created_at, sid, type, props) values
  (now() - interval '1 hour', 'test9_sid_aaaaaaaaaaaaaa', 'search', '{"label": "Cache, Test"}'),
  (now() - interval '1 hour', 'test9_sid_aaaaaaaaaaaaaa', 'view', '{}');

-- ── Refresh writes all four ranges ──────────────────────────────────────────────────────────
-- now() is the transaction's start, so rows this test writes have computed_at = now() (the live cron's rows are older).
do $$
declare n int := overflight_private.refresh_admin_stats();
begin
  if n <> 4 then raise exception 'refresh: % of 4 ranges computed', n; end if;
  if (select count(*) from overflight_private.admin_stats_cache where computed_at = now()) <> 4 then
    raise exception 'refresh: wrote % of 4 rows', (select count(*) from overflight_private.admin_stats_cache where computed_at = now());
  end if;
  if exists (select 1 from overflight_private.admin_stats_cache c where c.computed_at = now() and c.data ->> 'range' <> c.range) then
    raise exception 'refresh: a row holds another range''s stats';
  end if;
  if (select (data #>> '{totals,search}')::int from overflight_private.admin_stats_cache where range = '24h') < 1 then
    raise exception 'refresh: 24h row misses the test search';
  end if;
  -- an older computation never replaces a newer row
  perform overflight_private.store_admin_stats('24h', '{"range": "24h", "older": true}', now() - interval '1 minute');
  if (select data ? 'older' from overflight_private.admin_stats_cache where range = '24h') then raise exception 'store: older run overwrote a newer row'; end if;
end
$$;

-- ── A non-admin is refused, even with a fresh cache row ─────────────────────────────────────
select pg_temp.as_user('00000000-0000-0000-0000-00000000a002', 'someone@example.com');
set local role authenticated;
do $$ begin
  perform public.admin_stats('24h');
  raise exception 'non-admin got cached stats';
exception when insufficient_privilege then null; end $$;
do $$ begin
  perform 1 from overflight_private.admin_stats_cache;
  raise exception 'non-admin read the cache table';
exception when insufficient_privilege then null; end $$;
reset role;

-- a non-admin claiming the admin's email
select pg_temp.as_user('00000000-0000-0000-0000-00000000a002', 'test-admin@watched.invalid');
set local role authenticated;
do $$ begin
  perform public.admin_stats('24h');
  raise exception 'forged email claim got cached stats';
exception when insufficient_privilege then null; end $$;
reset role;

-- ── The admin gets the cached JSON ──────────────────────────────────────────────────────────
-- A recognisable fresh row: if admin_stats computed live instead, the marker would be missing.
update overflight_private.admin_stats_cache
  set data = data || '{"testMarker": "cached"}', computed_at = now() - interval '4 minutes' where range = '24h';
select pg_temp.as_user('00000000-0000-0000-0000-00000000a001', 'test-admin@watched.invalid');
set local role authenticated;
do $$
declare s jsonb := public.admin_stats('24h');
begin
  if s ->> 'testMarker' is distinct from 'cached' then raise exception 'admin: fresh cache row not used'; end if;
  if (s ->> 'cachedAt')::bigint <> (extract(epoch from now() - interval '4 minutes') * 1000)::bigint then
    raise exception 'admin: cachedAt % is not the row''s computed_at', s ->> 'cachedAt';
  end if;
  if not (s ? 'maintLastAt' and s ? 'rolledThrough') then raise exception 'admin: maintLastAt / rolledThrough missing'; end if;
  if s ->> 'range' <> '24h' or not (s ? 'totals' and s ? 'series' and s ? 'top' and s ? 'recentSearches' and s ? 'generatedAt') then
    raise exception 'admin: output shape changed: %', (select array_agg(k) from jsonb_object_keys(s) k);
  end if;
end
$$;
reset role;

-- ── Stale or missing rows fall back to a live computation, which is stored ──────────────────
update overflight_private.admin_stats_cache
  set data = data || '{"testMarker": "stale"}', computed_at = now() - interval '20 minutes' where range = '7d';
delete from overflight_private.admin_stats_cache where range = '30d';
select pg_temp.as_user('00000000-0000-0000-0000-00000000a001', 'test-admin@watched.invalid');
set local role authenticated;
do $$
declare
  st jsonb := public.admin_stats('7d');
  mi jsonb := public.admin_stats('30d');
  bad jsonb := public.admin_stats('nonsense');
begin
  if st ? 'testMarker' then raise exception 'stale: 20-minute-old row returned instead of a live run'; end if;
  if (st ->> 'cachedAt')::bigint <> (extract(epoch from now()) * 1000)::bigint then raise exception 'stale: cachedAt is not now'; end if;
  if (st #>> '{totals,search}')::int < 1 then raise exception 'stale: live run misses the test search'; end if;
  if mi ->> 'range' <> '30d' or (mi #>> '{totals,search}')::int < 1 then raise exception 'missing: no live 30d stats'; end if;
  if bad ->> 'range' <> '7d' then raise exception 'an unknown range should read as 7d, got %', bad ->> 'range'; end if;
end
$$;
reset role;
do $$
begin
  if (select computed_at from overflight_private.admin_stats_cache where range = '7d') <> now()
     or (select data ? 'testMarker' from overflight_private.admin_stats_cache where range = '7d') then
    raise exception 'stale: live result not stored';
  end if;
  if (select computed_at from overflight_private.admin_stats_cache where range = '30d') is distinct from now() then
    raise exception 'missing: live result not stored';
  end if;
end
$$;

select 'all 0009 checks passed' as result;
