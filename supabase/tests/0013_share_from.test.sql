-- Checks for 0013_share_from.sql. Run as begin; <0013>; <this file>; rollback.  Nothing survives.
-- Pure function calls only: no rows are written and no DDL touches an existing table.

do $$
declare r text; f text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if has_function_privilege(r, 'overflight_private.event_props(text, jsonb)', 'execute') then
      raise exception 'grants: % can call event_props', r;
    end if;
  end loop;
  foreach f in array array['headline', 'hero', 'viewer', 'pass'] loop
    if overflight_private.event_props('share_open', jsonb_build_object('kind', 'pass', 'from', f)) ->> 'from' is distinct from f then
      raise exception 'event_props: share_open from % not kept', f;
    end if;
    if overflight_private.event_props('share_action', jsonb_build_object('action', 'native', 'from', f)) ->> 'from' is distinct from f then
      raise exception 'event_props: share_action from % not kept', f;
    end if;
  end loop;
  if overflight_private.event_props('share_open', '{"kind": "summary", "from": "banner"}') ? 'from' then
    raise exception 'event_props: an unknown from was kept';
  end if;
  if overflight_private.event_props('share_open', '{"kind": "summary", "from": "headline"}') ->> 'kind' is distinct from 'summary' then
    raise exception 'event_props: share_open kind was lost';
  end if;
  if overflight_private.event_props('share_action', '{"action": "copy_link", "norad": 62261}') is distinct from '{"action": "copy_link", "norad": 62261}'::jsonb then
    raise exception 'event_props: a share_action without from changed';
  end if;
  if overflight_private.event_props('share_action', '{"from": "viewer"}') is not null then
    raise exception 'event_props: a share_action without an action was kept';
  end if;
  if overflight_private.event_props('pass_open', '{"norad": 62261, "from": "viewer"}') ? 'from' then
    raise exception 'event_props: from leaked into pass_open';
  end if;
  if overflight_private.event_props('search', '{"source": "surprise"}') ->> 'source' is distinct from 'surprise'
     or overflight_private.event_props('search', '{"source": "pin"}') ->> 'source' is distinct from 'pin' then
    raise exception 'event_props: an earlier search source was lost';
  end if;
end
$$;
