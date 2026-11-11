-- Checks for 0012_share_radar.sql. Run as begin; <0012>; <this file>; rollback.  Nothing survives.
-- Row writes only (three test shares, at a point in the South Atlantic no real share uses); no DDL on existing tables.

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
    'placeLabel', 'Test 0012', 'lat', -54.32, 'lon', 3.41, 'satName', 'Sentinel-1D',
    'pass', jsonb_build_object('norad', 66315, 'verdict', 'imaged', 'tClosest', t, 'offNadirDeg', 37.2),
    'capture', jsonb_build_object(
      'collection', 'sentinel-1-rtc', 'itemId', 'S1D_IW_GRDH_1SDV_20261110T170617_20261110T170642_005408_00A516_rtc',
      'provider', 'planetary-computer', 'platform', 'sentinel-1d', 'datetime', t - 10000, 'gsdM', 20));

  -- A radar image is kept, as sent.
  id1 := public.create_share(pay);
  select capture into cap from public.shares where id = id1;
  if cap ->> 'collection' is distinct from 'sentinel-1-rtc'
     or cap ->> 'itemId' is distinct from 'S1D_IW_GRDH_1SDV_20261110T170617_20261110T170642_005408_00A516_rtc'
     or (cap ->> 'gsdM')::numeric is distinct from 20 then
    raise exception 'radar capture not kept: %', cap;
  end if;

  -- A Sentinel-2 photo is kept as before.
  id2 := public.create_share(jsonb_set(jsonb_set(pay, '{capture,collection}', '"sentinel-2-l2a"'),
                                       '{capture,itemId}', '"S2C_MSIL2A_20261110T101321_R022_T32TQR_20261110T140003"'));
  select capture into cap from public.shares where id = id2;
  if cap ->> 'collection' is distinct from 'sentinel-2-l2a' then
    raise exception 'sentinel-2 capture lost: %', cap;
  end if;

  -- A collection nobody allowed is still dropped, and the share is still made.
  id3 := public.create_share(jsonb_set(pay, '{capture,collection}', '"sentinel-9-x"'));
  select capture into cap from public.shares where id = id3;
  if id3 is null or cap is not null then
    raise exception 'unknown collection kept: %', cap;
  end if;

  -- An id outside the safe charset is dropped too.
  id3 := public.create_share(jsonb_set(pay, '{capture,itemId}', '"S1D <script>"'));
  select capture into cap from public.shares where id = id3;
  if cap is not null then
    raise exception 'unsafe item id kept: %', cap;
  end if;

  raise notice '0012 ok';
end
$$;
