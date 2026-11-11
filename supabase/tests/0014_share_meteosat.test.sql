-- Checks for 0014_share_meteosat.sql. Run as begin; <0014>; <this file>; rollback.  Nothing survives.
-- Row writes only (test shares, at a point in the South Atlantic no real share uses); no DDL on existing tables.

do $$
declare
  t   numeric := round(extract(epoch from now()) * 1000) - 3600000;
  pay jsonb;
  id1 text;
  id2 text;
  id3 text;
  cap jsonb;
begin
  pay := jsonb_build_object(
    'placeLabel', 'Test 0014', 'lat', -54.32, 'lon', 3.41, 'satName', 'Meteosat-12',
    'pass', jsonb_build_object('norad', 54743, 'verdict', 'imaged', 'tClosest', t, 'altitudeKm', 35777, 'offNadirDeg', 8.1),
    'capture', jsonb_build_object(
      'collection', 'eumetsat-meteosat-0deg', 'itemId', 'mtg_fd:rgb_geocolour@2026-11-11T06:50:00Z',
      'provider', 'eumetsat', 'platform', 'meteosat-0deg', 'datetime', t - 400000, 'gsdM', 2000));

  -- A Meteosat frame is kept, as sent, with its provider.
  id1 := public.create_share(pay);
  select capture into cap from public.shares where id = id1;
  if cap ->> 'collection' is distinct from 'eumetsat-meteosat-0deg'
     or cap ->> 'itemId' is distinct from 'mtg_fd:rgb_geocolour@2026-11-11T06:50:00Z'
     or cap ->> 'provider' is distinct from 'eumetsat'
     or (cap ->> 'gsdM')::numeric is distinct from 2000 then
    raise exception 'meteosat capture not kept: %', cap;
  end if;

  -- So is Meteosat-9's infrared frame over the Indian Ocean.
  id2 := public.create_share(jsonb_set(jsonb_set(pay, '{capture,collection}', '"eumetsat-meteosat-iodc"'),
                                       '{capture,itemId}', '"msg_iodc:ir108@2026-11-11T06:45:00Z"'));
  select capture into cap from public.shares where id = id2;
  if cap ->> 'collection' is distinct from 'eumetsat-meteosat-iodc' or cap ->> 'itemId' is distinct from 'msg_iodc:ir108@2026-11-11T06:45:00Z' then
    raise exception 'meteosat-9 capture not kept: %', cap;
  end if;

  -- A radar image and a Sentinel-2 photo are kept as before.
  id2 := public.create_share(jsonb_set(jsonb_set(jsonb_set(pay, '{capture,collection}', '"sentinel-1-rtc"'),
                                       '{capture,itemId}', '"S1D_IW_GRDH_1SDV_20261110T170617_20261110T170642_005408_00A516_rtc"'),
                                       '{capture,provider}', '"planetary-computer"'));
  select capture into cap from public.shares where id = id2;
  if cap ->> 'collection' is distinct from 'sentinel-1-rtc' or cap ->> 'provider' is distinct from 'planetary-computer' then
    raise exception 'radar capture lost: %', cap;
  end if;

  -- A collection nobody allowed is still dropped, and the share is still made.
  id3 := public.create_share(jsonb_set(pay, '{capture,collection}', '"eumetsat-meteosat-99"'));
  select capture into cap from public.shares where id = id3;
  if id3 is null or cap is not null then
    raise exception 'unknown collection kept: %', cap;
  end if;

  -- An id outside the safe charset is dropped too.
  id3 := public.create_share(jsonb_set(pay, '{capture,itemId}', '"mtg_fd <script>"'));
  select capture into cap from public.shares where id = id3;
  if cap is not null then
    raise exception 'unsafe item id kept: %', cap;
  end if;

  raise notice '0014 ok';
end
$$;
