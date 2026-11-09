/**
 * The clear cover (owner request D): when a week has no clear Sentinel-2 / Landsat photo of the place, the
 * results lead with the LAST clear look from before the window instead of a white frame of cloud.
 *
 *   1. Speculatively, at the start of the report (in parallel with the main archive search), list the newest
 *      nearly cloud-free scenes (scene cloud < 20 %, filtered server-side) of the 60 days before the window.
 *      Two small STAC requests; nothing else is spent until the window's own photos are known.
 *   2. When the window has no clear detailed photo (the results' rule: not clouded = spot ≠ cloud and scene
 *      cloud < 70 %), read the cloud class at the spot for the newest candidates, a few at a time, and keep the
 *      newest that is clear (or thin cirrus) right at the place. R-M1: this starts as soon as the window's own
 *      SCENES say so (`scenesLackClearPhoto`: at once when every scene is clouded over, else after their spot
 *      checks), in parallel with the pass search, so the cover is usually known before the first results. The
 *      report confirms the need on the matched passes (`needsClearCover`) before it carries the cover.
 *
 * It never holds the first results: the report carries it once it is known (usually already the partial one), and
 * a late answer arrives as a background update. It has no pass and never counts toward the window's numbers.
 */
import { MS_PER_DAY } from '@/lib/geo'
import { searchClearScenes, spotCloud } from '@/imagery'
import { Lru } from '@/imagery/lru'
import type { Capture, LatLon, Pass, SpotCloud } from '@/types'

/** How far before the window the clear cover may come from. */
export const CLEAR_COVER_LOOKBACK_MS = 60 * MS_PER_DAY
/** Scene cloud at or above this reads as clouded over (same threshold as the results' isClouded). */
export const CLOUDED_PCT = 70
/** Spot checks per round, and at most this many candidates in all (newest first). */
const CHECKS_PER_ROUND = 4
const MAX_CHECKS = 8

const isDetailed = (c: Pick<Capture, 'collection'>) => c.collection === 'sentinel-2-l2a' || c.collection === 'landsat-c2-l2'

/** The results' "clouded over" rule (ui/results isClouded): cloud at the spot, or a mostly cloudy scene. */
export function isCloudedCapture(c: Pick<Capture, 'spot' | 'cloudCoverPct'>): boolean {
  return c.spot === 'cloud' || (c.cloudCoverPct ?? 0) >= CLOUDED_PCT
}

/** Does the window lack a clear detailed photo (an imaged pass with a Sentinel-2 / Landsat capture not clouded)? */
export function needsClearCover(passes: readonly Pick<Pass, 'verdict' | 'captureId'>[], captures: readonly Capture[]): boolean {
  const byId = new Map(captures.map((c) => [c.id, c]))
  for (const p of passes) {
    if (p.verdict !== 'imaged' || !p.captureId) continue
    const c = byId.get(p.captureId)
    if (c && isDetailed(c) && !isCloudedCapture(c)) return false
  }
  return true
}

/**
 * The same rule on the window's scenes alone, before any pass is matched (every archive scene of the window is of
 * the place, so it nearly always ends up as an imaged pass's photo): true when none of them is a clear detailed
 * photo. Unchecked spots count as clear, so it can only turn true once the spot checks say "cloud".
 */
export function scenesLackClearPhoto(captures: readonly Capture[]): boolean {
  return !captures.some((c) => isDetailed(c) && !isCloudedCapture(c))
}

export interface ClearCoverDeps {
  search: (place: LatLon, start: number, end: number, signal?: AbortSignal) => Promise<Capture[]>
  spot: (capture: Capture, place: LatLon, signal?: AbortSignal) => Promise<SpotCloud>
}

const defaultDeps: ClearCoverDeps = { search: searchClearScenes, spot: spotCloud }

const isAbort = (e: unknown) => e instanceof Error && e.name === 'AbortError'

/**
 * The newest candidate (detailed, before `windowStart`) that is clear or thin cirrus at the place, checking
 * `CHECKS_PER_ROUND` at a time, newest first, at most `MAX_CHECKS`. The returned capture carries its `spot`.
 * Rejects only on abort.
 */
export async function pickClearCover(
  scenes: readonly Capture[],
  place: LatLon,
  windowStart: number,
  spot: ClearCoverDeps['spot'],
  signal?: AbortSignal,
): Promise<Capture | undefined> {
  const cands = scenes
    .filter((c) => isDetailed(c) && c.datetime < windowStart && (c.cloudCoverPct ?? 100) < CLOUDED_PCT)
    .sort((a, b) => b.datetime - a.datetime)
    .slice(0, MAX_CHECKS)
  for (let i = 0; i < cands.length; i += CHECKS_PER_ROUND) {
    const round = cands.slice(i, i + CHECKS_PER_ROUND)
    const answers: (SpotCloud | undefined)[] = round.map(() => undefined)
    // R-M1: settle as soon as the answer is known: the newest clear candidate, once every newer one has answered
    // (not clear). A slow check of an OLDER candidate no longer holds the cover back.
    const k = await new Promise<number>((resolve, reject) => {
      let left = round.length
      const decide = () => {
        for (let j = 0; j < round.length; j++) {
          const a = answers[j]
          if (a === undefined) return // a newer candidate is still being checked
          if (a === 'clear' || a === 'cirrus') return resolve(j)
        }
        if (left === 0) resolve(-1)
      }
      round.forEach((c, j) => {
        spot(c, place, signal)
          .catch((e: unknown): SpotCloud => {
            if (isAbort(e) || signal?.aborted) throw e
            return 'unknown'
          })
          .then((a) => {
            answers[j] = a
            left--
            decide()
          }, reject)
      })
    })
    if (k >= 0) return { ...round[k], spot: answers[k] }
  }
  return undefined
}

export interface ClearCoverLeg {
  /** Resolve the clear cover (spot checks start on the first call; later calls share it). Never rejects except on abort. */
  pick: () => Promise<Capture | undefined>
  /** Whether pick() has been called (the spot checks are under way or done). */
  readonly started: boolean
}

/** Scene lists by place and window start: an archive retry of the same report reuses them. */
const sceneCache = /* @__PURE__ */ new Lru<string, Promise<Capture[]>>(8)

/** Forget cached scene lists (tests). */
export function _resetClearCoverCache(): void {
  sceneCache.clear()
}

/** Start the speculative scene listing for the 60 days before `windowStart` (see the header). */
export function startClearCover(place: LatLon, windowStart: number, signal?: AbortSignal, deps: ClearCoverDeps = defaultDeps): ClearCoverLeg {
  const key = `${place.lat.toFixed(4)},${place.lon.toFixed(4)}|${windowStart}`
  let scenes = deps === defaultDeps ? sceneCache.get(key) : undefined
  if (!scenes) {
    // Not tied to the caller's signal, so a cached listing survives an aborted report.
    scenes = deps.search(place, windowStart - CLEAR_COVER_LOOKBACK_MS, windowStart).catch((): Capture[] => [])
    if (deps === defaultDeps) {
      sceneCache.set(key, scenes)
      // A failed listing (offline) must not stick.
      void scenes.then((list) => {
        if (!list.length && sceneCache.peek(key) === scenes) sceneCache.delete(key)
      })
    }
  }
  const listed = scenes
  let picked: Promise<Capture | undefined> | undefined
  return {
    pick: () =>
      (picked ??= listed.then((list) => {
        try {
          performance.mark('overflight:engine-cover-listed')
        } catch {
          /* no User Timing */
        }
        return pickClearCover(list, place, windowStart, deps.spot, signal)
      })),
    get started() {
      return picked !== undefined
    },
  }
}
