/**
 * imagery — real pictures of a place from public archives, and the place itself.
 *
 * Contract (docs/ARCHITECTURE.md):
 *   searchCaptures   Sentinel-2 + Landsat scenes (Planetary Computer STAC; Earth Search fallback)
 *   searchClearScenes nearly cloud-free Sentinel-2 + Landsat scenes, newest first (the clear cover)
 *   weatherCaptures  NASA GIBS daily VIIRS/MODIS mosaics for daytime weather-LEO passes (pixel-verified)
 *   geoImageUrl      GOES-East/West GeoColor or Himawari frame at a time (GIBS)
 *   latestGeoFrame   the newest frame of a geostationary watcher: GOES, Himawari (GIBS) and Meteosat (EUMETSAT)
 *   spotCloud        cloud / shadow / clear at the exact pixel (SCL or QA_PIXEL)
 *   searchPlaces, reversePlace, locateMe, timeZoneAt (after ensureTz)
 *   preloadImage     fetch + decode, LRU-cached
 *
 * Extras are exported for the UI and engine where they help (detailed search with degradation
 * notes, the newest verified geostationary frame and GIBS's published frame list, URL builders,
 * classifiers, the fetch helper).
 */
export { searchCaptures, searchCapturesDetailed, searchClearScenes, sentinel2PlanCovers, normalizePlatform, noradForPlatform, PLATFORM_NORAD } from './stac'
export type { CaptureSearchResult } from './stac'

export { weatherCaptures, weatherCandidates, verifyWeatherCapture, geoImageUrl, latestGeoImage, geoFrames, geoFrameCandidates, geoFrameTime, utcDate, GIBS_LAYERS, GIBS_DAILY_BY_NORAD, GEO_SAFE_LAG_MS, isGibsCollection } from './gibs'
export type { GibsCollection, GibsLayer } from './gibs'

export { latestGeoFrame, GEO_FRAMES, isEumetsatSource } from './geoFrames'
export type { GeoFrame, GeoFrameBand } from './geoFrames'

export { spotCloud, spotCheck, classifyScl, classifySclArea, classifyQaPixel, type SpotCheck } from './cloud'
export type { SpotCloud } from './cloud'

export { searchPlaces, reversePlace, locateMe, timeZoneAt, ensureTz, tzReady, nauticalZone, coordinateLabel, parseCoordinates, LocateError } from './geocode'
export type { LocateErrorCode } from './geocode'

export { preloadImage, isImageCached, probeImage, decodeImagePixels, EmptyImageError, tonedImageBlob } from './image'
export type { ImageProbe } from './image'

export { gibsWmsUrl, gibsDomainsUrl, worldviewUrl, pcItemMapUrl } from './endpoints'
export { pcCropUrl, isTonedUrl } from './pcCrop'
export { panSharpUrl, isPanSharpUrl } from './panUrl'
export type { CropOpts } from './endpoints'

export { fetchJson, withRetry, HttpError, TimeoutError, isAbortError } from './net'
export type { RetryOptions, FetchJsonOptions } from './net'

export { Lru } from './lru'
