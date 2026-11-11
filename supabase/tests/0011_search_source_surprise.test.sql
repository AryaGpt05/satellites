-- Checks for 0011_search_source_surprise.sql. Run as begin; <0011>; <this file>; rollback.  Nothing survives.
-- Row writes only (test events and a test day's rollup, on 2099-01-01 so no real day's counts are involved); no DDL on
-- existing tables. 0011's own reclassification of real rows is rolled back with everything else.

-- ── Grants and the allowed source ───────────────────────────────────────────────────────────
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if has_function_privilege(r, 'overflight_private.reclassify_surprise_searches()', 'execute') then
      raise exception 'grants: % can call reclassify_surprise_searches', r;
    end if;
    if has_function_privilege(r, 'overflight_private.event_props(text, jsonb)', 'execute') then
      raise exception 'grants: % can call event_props', r;
    end if;
  end loop;
  if overflight_private.event_props('search', '{"source": "surprise", "label": "Grand Canyon"}') ->> 'source' is distinct from 'surprise' then
    raise exception 'event_props: surprise not kept';
  end if;
  if overflight_private.event_props('search', '{"source": "pin"}') ->> 'source' is distinct from 'pin'
     or overflight_private.event_props('search', '{"source": "example"}') ->> 'source' is distinct from 'example' then
    raise exception 'event_props: an earlier source was lost';
  end if;
  if overflight_private.event_props('search', '{"source": "lucky"}') ? 'source' then
    raise exception 'event_props: an unknown source was kept';
  end if;
end
$$;

-- ── Reclassification ────────────────────────────────────────────────────────────────────────
-- t1: Surprise me pick filed as an example            → surprise
-- t2: an example chip still on the page (Central Park)  → stays example
-- t3: Uluru, a chip until launch (ambiguous)           → stays example
-- t4: a new client's 'surprise' before 0011 (no source) → surprise
-- t5: an off-list example before launch                → stays example
-- t6: a typed search                                    → stays search
-- t7: Surprise me pick on a day already rolled up       → surprise, and the rollup moves one from example to surprise
-- t8: example chip on that rolled day                   → stays example
-- t9: no-source search on that rolled day               → surprise, and the rollup gains one surprise only
insert into public.events (created_at, sid, type, props) values
  ('2026-11-11 01:00+00', 'test0011aaaaaaaaaaaaaaaa', 'search', '{"source": "example", "label": "Grand Canyon, Arizona, United States", "t": 1}'),
  ('2026-11-11 01:00+00', 'test0011aaaaaaaaaaaaaaaa', 'search', '{"source": "example", "label": "Central Park, New York, United States", "t": 2}'),
  ('2026-11-11 01:00+00', 'test0011aaaaaaaaaaaaaaaa', 'search', '{"source": "example", "label": "Uluru, Northern Territory, Australia", "t": 3}'),
  ('2026-11-11 01:00+00', 'test0011aaaaaaaaaaaaaaaa', 'search', '{"label": "Mount Fuji, Shizuoka, Japan", "t": 4}'),
  ('2026-11-11 00:40+00', 'test0011aaaaaaaaaaaaaaaa', 'search', '{"source": "example", "label": "Grand Canyon, Arizona, United States", "t": 5}'),
  ('2026-11-11 01:00+00', 'test0011aaaaaaaaaaaaaaaa', 'search', '{"source": "search", "label": "Waterloo, Ontario, Canada", "t": 6}'),
  ('2099-01-01 12:00+00', 'test0011aaaaaaaaaaaaaaaa', 'search', '{"source": "example", "label": "Venice, Veneto, Italy", "t": 7}'),
  ('2099-01-01 12:00+00', 'test0011aaaaaaaaaaaaaaaa', 'search', '{"source": "example", "label": "Pyramids of Giza, Giza, Egypt", "t": 8}'),
  ('2099-01-01 12:00+00', 'test0011aaaaaaaaaaaaaaaa', 'search', '{"label": "Tokyo, Japan", "t": 9}');
insert into public.event_rolled (day) values ('2099-01-01');
insert into public.event_days (day, type, dim, val, n) values ('2099-01-01', 'search', 'source', 'example', 2);

do $$
declare
  v_moved int;
  v_got text;
begin
  v_moved := overflight_private.reclassify_surprise_searches();
  for v_got in
    select string_agg((props ->> 't') || '=' || coalesce(props ->> 'source', '-'), ' ' order by (props ->> 't')::int)
    from public.events where sid = 'test0011aaaaaaaaaaaaaaaa'
  loop
    if v_got <> '1=surprise 2=example 3=example 4=surprise 5=example 6=search 7=surprise 8=example 9=surprise' then
      raise exception 'reclassify: got %', v_got;
    end if;
  end loop;
  if (select n from public.event_days where day = '2099-01-01' and type = 'search' and dim = 'source' and val = 'example') <> 1
     or (select n from public.event_days where day = '2099-01-01' and type = 'search' and dim = 'source' and val = 'surprise') <> 2 then
    raise exception 'reclassify: rollup not moved (example %, surprise %)',
      (select n from public.event_days where day = '2099-01-01' and dim = 'source' and val = 'example'),
      (select n from public.event_days where day = '2099-01-01' and dim = 'source' and val = 'surprise');
  end if;
  -- Labels and everything else in props are untouched.
  if exists (select 1 from public.events where sid = 'test0011aaaaaaaaaaaaaaaa' and props ->> 't' = '1'
             and props <> '{"source": "surprise", "label": "Grand Canyon, Arizona, United States", "t": 1}'::jsonb) then
    raise exception 'reclassify: changed more than the source';
  end if;

  -- A second run moves nothing more.
  if overflight_private.reclassify_surprise_searches() <> 0 then raise exception 'reclassify: second run moved rows'; end if;
  if (select n from public.event_days where day = '2099-01-01' and dim = 'source' and val = 'surprise') <> 2 then
    raise exception 'reclassify: second run changed the rollup';
  end if;
end
$$;

select '0011 checks passed' as result;
