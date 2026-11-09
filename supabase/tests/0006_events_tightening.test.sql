-- Checks for 0006_events_tightening.sql (0004 + 0005 are applied in the database).
-- scripts/backend-sql-test.sh runs: begin; <0006>; <this file>; rollback;  Nothing survives.

-- ── normalisation: non-ASCII digits, more invisible characters, comma decimals ──────────────
do $$
begin
  if overflight_private.clean_label('Waterloo ٤٣') is not null then raise exception 'Arabic-Indic digits kept in a label'; end if;
  if overflight_private.clean_label('Waterloo ４３') is not null then raise exception 'full-width digits kept in a label'; end if;
  if overflight_private.clean_label('Waterloo, Ontario, Canada') <> 'Waterloo, Ontario, Canada' then raise exception 'a plain label changed'; end if;
  if overflight_private.clean_msg('at ٤٣.٤٧٢٣, -٨٠.٥٤٤٩') ~ '\d+[.,]\d+' then raise exception 'non-ASCII decimals not masked: %', overflight_private.clean_msg('at ٤٣.٤٧٢٣, -٨٠.٥٤٤٩'); end if;
  if overflight_private.clean_msg('lat 43,4723 lon -80,5449') <> 'lat # lon #' then raise exception 'comma decimals not masked: %', overflight_private.clean_msg('lat 43,4723 lon -80,5449'); end if;
  if overflight_private.clean_msg('43' || U&'\+0E0001' || '.4723 ' || U&'\FE0F' || 'x' || U&'\061C' || U&'\180E') <> '# x' then
    raise exception 'tag / variation / bidi characters not stripped: %', overflight_private.clean_msg('43' || U&'\+0E0001' || '.4723 ' || U&'\FE0F' || 'x' || U&'\061C' || U&'\180E');
  end if;
  if overflight_private.clean_masked('Sentinel-2C ٤٣.٤٧', 60) <> 'Sentinel-2C #' then raise exception 'masked field: %', overflight_private.clean_masked('Sentinel-2C ٤٣.٤٧', 60); end if;
  if exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'events_sid_created_at_idx') then raise exception 'unused index still there'; end if;
end
$$;

-- ── the global budget: 3000 a minute, checked before anything is written ───────────────────
insert into public.events (sid, type, props) select 'test6_sid_filler_aaaaaa', 'about_open', '{}' from generate_series(1, 3000);
set local role anon;
select public.log_events('{"sid": "test6_sid_bbbbbbbbbbbbbb", "events": [{"type": "view"}]}'::jsonb);
reset role;
do $$
begin
  if exists (select 1 from public.event_sessions where sid = 'test6_sid_bbbbbbbbbbbbbb') or exists (select 1 from public.events where sid = 'test6_sid_bbbbbbbbbbbbbb') then
    raise exception 'global budget of 3000/min not enforced';
  end if;
end
$$;
delete from public.events where sid = 'test6_sid_filler_aaaaaa';
set local role anon;
select public.log_events('{"sid": "test6_sid_cccccccccccccc", "events": [{"type": "view"}, {"type": "search", "p": {"label": "Waterloo ٤", "cell": "43.5,-80.5"}}]}'::jsonb);
reset role;
do $$
begin
  if (select count(*) from public.events where sid = 'test6_sid_cccccccccccccc') <> 2 then raise exception 'under budget, events refused'; end if;
  if exists (select 1 from public.events where sid = 'test6_sid_cccccccccccccc' and props ? 'label') then raise exception 'label with non-ASCII digit stored'; end if;
end
$$;

-- ── admin_stats: same output + maintenance status; still admin-only ────────────────────────
insert into overflight_private.admins (email) values ('test-admin@watched.invalid');
insert into auth.users (id, email, email_confirmed_at, aud, role, is_anonymous) values
  ('00000000-0000-0000-0000-00000000b001', 'test-admin@watched.invalid', now(), 'authenticated', 'authenticated', false),
  ('00000000-0000-0000-0000-00000000b002', 'someone@watched.invalid', now(), 'authenticated', 'authenticated', false);
update public.event_maint set last_at = now() - interval '3 hours';
select set_config('request.jwt.claims', '{"role": "authenticated", "sub": "00000000-0000-0000-0000-00000000b001", "email": "test-admin@watched.invalid"}', true);
set local role authenticated;
do $$
declare j jsonb := public.admin_stats('24h');
begin
  if not (j ? 'maintLastAt' and j ? 'rolledThrough' and j ? 'totals' and j ? 'series') then raise exception 'admin_stats shape: %', left(j::text, 300); end if;
  if (j ->> 'maintLastAt')::bigint > (extract(epoch from now() - interval '2 hours') * 1000)::bigint then raise exception 'maintLastAt wrong'; end if;
  if (j #>> '{totals,search}')::int < 1 then raise exception 'no data'; end if;
end
$$;
reset role;
select set_config('request.jwt.claims', '{"role": "authenticated", "sub": "00000000-0000-0000-0000-00000000b002", "email": "someone@watched.invalid"}', true);
set local role authenticated;
do $$ begin
  perform public.admin_stats('24h');
  raise exception 'non-admin got stats';
exception when insufficient_privilege then null; end $$;
do $$ begin
  perform overflight_private.admin_stats_core('24h');
  raise exception 'the private core is callable';
exception when insufficient_privilege then null; end $$;
reset role;
set local role anon;
do $$ begin
  perform public.admin_stats('24h');
  raise exception 'anon got stats';
exception when insufficient_privilege then null; end $$;
reset role;

select 'all 0006 checks passed' as result;
