/**
 * The newest frame of each geostationary weather satellite, around a place: one entry point over the two public
 * map services that carry them.
 *
 *   goes-east, goes-west   NASA GIBS GeoColor (true colour by day, city lights and cloud at night)
 *   himawari               NASA GIBS: the red visible band by day; the infrared window band when that is dark
 *   meteosat-0deg          EUMETSAT GeoColour from Meteosat-12, the same day-and-night product as GOES's
 *   meteosat-iodc          EUMETSAT, Meteosat-9 over the Indian Ocean: natural colour by day, infrared by night
 *
 * A source lists its layers in order of preference and the first that has a frame wins, so a daylight product gives
 * way to infrared only when it has nothing to show (its frames are skipped in the dark without a request). A layer
 * with another behind it is only asked for its newest few frames, taken with the sun well up (`DAYLIGHT_MIN_SUN_DEG`):
 * after sunset the fresh infrared frame shows, not a two-hour-old picture of dusk (measured 2026-11-11, Honolulu:
 * Himawari's visible band two hours on was a black square). Infrared is cloud-top temperature, colder is lighter, on
 * both services (GIBS's is redrawn in grey first: ./infrared.ts), and the frame says which band it is, so the screen
 * can label it.
 *
 * `gridKm` is the pixel the service draws the layer on, measured on its own renders (2026-11-11), not the
 * instrument's best: what the label next to the picture must say.
 *
 * The newest frame is also a capture of the report (`geoCapture`): one image per watcher, in the gallery and the
 * timeline, with the scan that took it as its pass (engine/geostationary.ts). Its id is "<layer>@<frame time>", so a
 * shared one can be had again from the id alone (`geoCaptureFromItem`): the layer says which service and which band.
 */
import type { Capture, CaptureCollection, GeoFrameSource, LatLon } from '@/types'
import { EUMETSAT_GEOSERVER, gibsWmsUrl, worldviewUrl, type CropOpts } from './endpoints'
import { eumetsatWmsUrl, latestEumetsatFrame, type EumetsatFrameLayer } from './eumetsat'
import { GIBS_LAYERS, HIMAWARI_INFRARED, isoSeconds, latestGibsFrame, utcDate, type GibsFrameLayer } from './gibs'
import { preloadImage } from './image'

/** What a frame shows: day-and-night colour, visible light only, or thermal infrared. */
export type GeoFrameBand = 'colour' | 'visible' | 'infrared'

export type GeoFrameLayer = { band: GeoFrameBand; gridKm: number } & ({ via: 'gibs'; layer: GibsFrameLayer } | { via: 'eumetsat'; layer: EumetsatFrameLayer })

export interface GeoFrameSpec {
  /** The imager's name, for captions */
  sensor: string
  /** In order of preference */
  layers: readonly GeoFrameLayer[]
}

/**
 * How high the sun must stand at the place for a daylight layer's frame to be worth showing. EUMETSAT masks its
 * natural-colour product under about 3°; at 6° an 800 km square is whole (./eumetsat.ts).
 */
const DAYLIGHT_MIN_SUN_DEG = 6
/** A layer with another behind it gives up after this many frames: about half an hour of them. */
const PREFERRED_STEPS = 3

export const GEO_FRAMES: Readonly<Record<GeoFrameSource, GeoFrameSpec>> = {
  'goes-east': { sensor: 'ABI', layers: [{ via: 'gibs', layer: GIBS_LAYERS['gibs-goes-east'], band: 'colour', gridKm: 2 }] },
  'goes-west': { sensor: 'ABI', layers: [{ via: 'gibs', layer: GIBS_LAYERS['gibs-goes-west'], band: 'colour', gridKm: 2 }] },
  himawari: {
    sensor: 'AHI',
    layers: [
      { via: 'gibs', layer: { ...GIBS_LAYERS['gibs-himawari'], minSunDeg: DAYLIGHT_MIN_SUN_DEG }, band: 'visible', gridKm: 1 },
      { via: 'gibs', layer: HIMAWARI_INFRARED, band: 'infrared', gridKm: 2 },
    ],
  },
  'meteosat-0deg': { sensor: 'FCI', layers: [{ via: 'eumetsat', layer: { layer: 'mtg_fd:rgb_geocolour', stepMin: 10 }, band: 'colour', gridKm: 2 }] },
  'meteosat-iodc': {
    sensor: 'SEVIRI',
    layers: [
      { via: 'eumetsat', layer: { layer: 'msg_iodc:rgb_naturalenhncd', stepMin: 15, minSunDeg: DAYLIGHT_MIN_SUN_DEG }, band: 'colour', gridKm: 5 },
      { via: 'eumetsat', layer: { layer: 'msg_iodc:ir108', stepMin: 15 }, band: 'infrared', gridKm: 5 },
    ],
  },
}

/** True for a source whose frames come from EUMETSAT (they carry its attribution on screen). */
export const isEumetsatSource = (source: GeoFrameSource) => GEO_FRAMES[source].layers.some((l) => l.via === 'eumetsat')

export interface GeoFrame {
  /** Already loaded and checked for pixels: `preloadImage(url)` resolves at once */
  url: string
  /** The frame's own time */
  time: number
  band: GeoFrameBand
  gridKm: number
  /** 0..1 share of the picture with no data, as measured on the bytes shown (off the disc; a black night sea counts too) */
  empty: number
  /** The map layer it came from, and whose service */
  layer: string
  via: 'gibs' | 'eumetsat'
}

/** The capture collection of each source's frames. */
export const GEO_COLLECTION: Readonly<Record<GeoFrameSource, CaptureCollection>> = {
  'goes-east': 'gibs-goes-east',
  'goes-west': 'gibs-goes-west',
  himawari: 'gibs-himawari',
  'meteosat-0deg': 'eumetsat-meteosat-0deg',
  'meteosat-iodc': 'eumetsat-meteosat-iodc',
}

/** The source behind a capture collection, if it is a geostationary one. */
export function geoSourceOf(collection: string): GeoFrameSource | undefined {
  return (Object.keys(GEO_COLLECTION) as GeoFrameSource[]).find((k) => GEO_COLLECTION[k] === collection)
}

function captureOf(source: GeoFrameSource, l: GeoFrameLayer, time: number, place: LatLon, norad?: number): Capture {
  const layer = l.layer.layer
  const itemId = `${layer}@${isoSeconds(time)}`
  const { lat, lon } = place
  return {
    id: itemId,
    provider: l.via,
    collection: GEO_COLLECTION[source],
    itemId,
    platform: source,
    norad,
    datetime: time,
    gsdM: l.gridKm * 1000,
    band: l.band,
    // Both services cut in lon/lat already, so the globe's decal and the panel's card are the same kind of crop.
    cropUrl: (o) => (l.via === 'gibs' ? gibsWmsUrl(layer, isoSeconds(time), { lat, lon }, o) : eumetsatWmsUrl(layer, time, { lat, lon }, o)),
    sourceUrl: l.via === 'gibs' ? worldviewUrl(layer, utcDate(time), { lat, lon }) : `${EUMETSAT_GEOSERVER.replace('/geoserver', '')}/productviewer?v=${encodeURIComponent(layer)}`,
  }
}

/** A frame the search found, as a capture of the report. `norad` is the satellite that took it. */
export function geoCapture(source: GeoFrameSource, frame: Pick<GeoFrame, 'time' | 'layer'>, place: LatLon, norad?: number): Capture | undefined {
  const l = GEO_FRAMES[source].layers.find((x) => x.layer.layer === frame.layer)
  return l && captureOf(source, l, frame.time, place, norad)
}

/**
 * A geostationary capture from its collection and item id alone ("<layer>@<ISO time>"): how a shared one comes back.
 * Undefined for anything that is not one of ours (an unknown layer, a time that does not parse).
 */
export function geoCaptureFromItem(collection: string, itemId: string, place: LatLon, norad?: number): Capture | undefined {
  const source = geoSourceOf(collection)
  const [layer, iso] = itemId.split('@')
  const time = Date.parse(iso ?? '')
  if (!source || !Number.isFinite(time)) return undefined
  return geoCapture(source, { time, layer }, place, norad)
}

/**
 * The newest frame a source serves for the place, at `opts` size, or null when none of its layers has one (the
 * place is off the disc, or the service is down). Rejects only on abort. Browser only.
 */
export async function latestGeoFrame(source: GeoFrameSource, place: LatLon, opts: CropOpts, o: { signal?: AbortSignal; now?: number } = {}): Promise<GeoFrame | null> {
  const { layers } = GEO_FRAMES[source]
  for (const [i, l] of layers.entries()) {
    const search = i < layers.length - 1 ? { ...o, maxSteps: PREFERRED_STEPS } : o
    const found = l.via === 'gibs' ? await latestGibsFrame(l.layer, place, opts, search) : await latestEumetsatFrame(l.layer, place, opts, search)
    if (found) {
      // Already loaded by the search: this only reads what the loader measured.
      const img = await preloadImage(found.url).catch(() => null)
      return { ...found, band: l.band, gridKm: l.gridKm, empty: Number(img?.dataset.nodata) || 0, layer: l.layer.layer, via: l.via }
    }
  }
  return null
}
