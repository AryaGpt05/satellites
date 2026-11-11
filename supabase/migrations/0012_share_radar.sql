-- 0012: a share may keep a Sentinel-1 radar image (collection 'sentinel-1-rtc'), so a shared radar pass's link opens
-- on its image and its preview card shows it.
--
-- create_share as in 0003 with that one collection added to the capture allow-list; nothing else changes. The item id
-- charset rule already admits RTC ids (S1D_IW_GRDH_1SDV_20261109T051629_20261109T051654_005386_00A455_rtc). Until
-- this is applied, a radar pass is still shared, without its image: create_share drops a collection it doesn't know
-- and keeps the rest of the share.
create or replace function public.create_share(payload jsonb)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  p         jsonb;
  c         jsonb;
  v_label   text;
  v_sat     text;
  v_lat     numeric;
  v_lon     numeric;
  v_norad   numeric;
  v_verdict text;
  v_tc      numeric;
  v_pass    jsonb;
  v_capture jsonb;
  v_id      text;
  v_coll    text;
  v_item    text;
begin
  if payload is null or jsonb_typeof(payload) <> 'object' then
    raise exception 'invalid payload' using errcode = '22023';
  end if;
  if octet_length(payload::text) >= 8192 then
    raise exception 'payload too large' using errcode = '22023';
  end if;

  -- Place
  if jsonb_typeof(payload -> 'placeLabel') <> 'string' or char_length(payload ->> 'placeLabel') > 120 then
    raise exception 'invalid placeLabel' using errcode = '22023';
  end if;
  v_label := overflight_private.clean_text(payload ->> 'placeLabel', 120);
  if v_label is null then
    raise exception 'invalid placeLabel' using errcode = '22023';
  end if;
  v_lat := overflight_private.num(payload, 'lat');
  v_lon := overflight_private.num(payload, 'lon');
  if v_lat is null or v_lon is null or v_lat not between -90 and 90 or v_lon not between -180 and 180 then
    raise exception 'invalid coordinates' using errcode = '22023';
  end if;
  v_lat := round(v_lat, 2);
  v_lon := round(v_lon, 2);
  v_sat := overflight_private.clean_text(payload ->> 'satName', 80);

  -- Pass (required)
  p := payload -> 'pass';
  if p is null or jsonb_typeof(p) <> 'object' then
    raise exception 'invalid pass' using errcode = '22023';
  end if;
  v_norad := overflight_private.num(p, 'norad');
  if v_norad is null or v_norad <> trunc(v_norad) or v_norad not between 1 and 999999999 then
    raise exception 'invalid norad' using errcode = '22023';
  end if;
  v_verdict := p ->> 'verdict';
  if v_verdict is null or v_verdict not in ('imaged', 'likely', 'could', 'overhead') then
    raise exception 'invalid verdict' using errcode = '22023';
  end if;
  v_tc := overflight_private.num(p, 'tClosest');
  if v_tc is null
     or to_timestamp(v_tc / 1000) not between now() - interval '400 days' and now() + interval '2 days' then
    raise exception 'invalid tClosest' using errcode = '22023';
  end if;

  -- Rebuild the pass from an allow-list, coarsened (times to the second, distances to ~1 km).
  -- `track` is dropped: it is large, and it is re-derived from the catalog when the link opens.
  -- Every number must be physically plausible, or it is dropped (never clamped into a fake value).
  v_pass := jsonb_strip_nulls(jsonb_build_object(
    'id',               overflight_private.clean_text(p ->> 'id', 40),
    'norad',            v_norad::int,
    'tClosest',         round(v_tc / 1000) * 1000,
    'tStart',           round(overflight_private.num_in(p, 'tStart', v_tc - 86400000, v_tc) / 1000) * 1000,
    'tEnd',             round(overflight_private.num_in(p, 'tEnd', v_tc, v_tc + 86400000) / 1000) * 1000,
    'groundDistanceKm', round(overflight_private.num_in(p, 'groundDistanceKm', 0, 20100), 0),
    'offNadirDeg',      round(overflight_private.num_in(p, 'offNadirDeg', 0, 90), 1),
    'elevationDeg',     round(overflight_private.num_in(p, 'elevationDeg', -90, 90), 0),
    'azimuthDeg',       round(overflight_private.num_in(p, 'azimuthDeg', 0, 360), 0),
    'altitudeKm',       round(overflight_private.num_in(p, 'altitudeKm', 100, 400000), 0),
    'groundSpeedKmS',   round(overflight_private.num_in(p, 'groundSpeedKmS', 0, 12), 2),
    'headingDeg',       round(overflight_private.num_in(p, 'headingDeg', 0, 360), 0),
    'node',             case when p ->> 'node' in ('ascending', 'descending') then p ->> 'node' end,
    'sunElevationDeg',  round(overflight_private.num_in(p, 'sunElevationDeg', -90, 90), 0),
    'inSwath',          case when jsonb_typeof(p -> 'inSwath') = 'boolean' then p -> 'inSwath' end,
    'inFieldOfRegard',  case when jsonb_typeof(p -> 'inFieldOfRegard') = 'boolean' then p -> 'inFieldOfRegard' end,
    'verdict',          v_verdict,
    'captureId',        overflight_private.clean_text(p ->> 'captureId', 160),
    'weekSatellites',   round(overflight_private.num_in(p, 'weekSatellites', 0, 100000), 0)
  ));

  -- Capture (optional). Only real-archive collections; ids restricted to a safe charset since the
  -- OG renderer turns them into archive URLs.
  c := payload -> 'capture';
  if c is not null and jsonb_typeof(c) = 'object' then
    v_coll := c ->> 'collection';
    v_item := c ->> 'itemId';
    if v_coll in ('sentinel-2-l2a', 'landsat-c2-l2', 'gibs-viirs-noaa20', 'gibs-viirs-noaa21', 'gibs-viirs-snpp',
                  'gibs-modis-terra', 'gibs-modis-aqua', 'gibs-goes-east', 'gibs-goes-west', 'gibs-himawari',
                  'sentinel-1-rtc')
       and v_item ~ '^[A-Za-z0-9_.:@-]{1,160}$' then
      v_capture := jsonb_strip_nulls(jsonb_build_object(
        'collection',    v_coll,
        'itemId',        v_item,
        'provider',      case when c ->> 'provider' in ('earth-search', 'planetary-computer', 'gibs') then c ->> 'provider' end,
        'platform',      overflight_private.clean_text(c ->> 'platform', 40),
        -- Acquired within a day of closest approach (GIBS daily mosaics are dated at 00:00 UTC).
        'datetime',      round(overflight_private.num_in(c, 'datetime', v_tc - 2 * 86400000, v_tc + 2 * 86400000) / 1000) * 1000,
        -- Missing stays missing. (least/greatest skip NULLs, so clamping here once turned an
        -- unknown cloud cover into a fabricated 0%.)
        'cloudCoverPct', round(overflight_private.num_in(c, 'cloudCoverPct', 0, 100), 1),
        'gsdM',          round(overflight_private.num_in(c, 'gsdM', 0.1, 100000), 1),
        -- Classification at the place (drives the clouded card variant)
        'spot',          case when c ->> 'spot' in ('clear', 'cirrus', 'cloud', 'shadow', 'unknown') then c ->> 'spot' end
      ));
    end if;
  end if;

  -- Abuse limits: 10 / minute from one 0.1° cell, 300 / minute overall. The per-cell advisory
  -- lock serialises concurrent creates from one cell so a parallel burst can't race the count.
  perform pg_advisory_xact_lock(hashtext('overflight.share:' || round(v_lat, 1)::text || ',' || round(v_lon, 1)::text));
  if (select count(*) from public.shares
       where created_at > now() - interval '1 minute'
         and round(lat, 1) = round(v_lat, 1) and round(lon, 1) = round(v_lon, 1)) >= 10
     or (select count(*) from public.shares where created_at > now() - interval '1 minute') >= 300 then
    raise exception 'rate limited' using errcode = 'P0001', hint = 'retry in a minute';
  end if;

  -- Insert with a fresh id; retry on the (astronomically unlikely) collision.
  for attempt in 1..5 loop
    v_id := overflight_private.new_share_id();
    begin
      insert into public.shares (id, place_label, lat, lon, norad, sat_name, verdict, t_closest, capture, pass)
      values (v_id, v_label, v_lat, v_lon, v_norad::int, v_sat, v_verdict, to_timestamp(round(v_tc / 1000)),
              v_capture, v_pass);
      return v_id;
    exception when unique_violation then
      if attempt = 5 then raise; end if;
    end;
  end loop;
  return null;
end
$$;

grant execute on function public.create_share(jsonb) to anon;
