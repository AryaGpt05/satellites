/**
 * Adapter over the backend's share service (src/lib/backend.ts → createShare). It adds two things the
 * share sheet needs:
 *
 *  - a hard timeout, so a slow service degrades to the deep-link fallback instead of a stuck button;
 *  - one share per (pass, rounded place, label) per page session: copying again, or reopening the
 *    sheet, reuses the same id instead of writing another row. Failures are not cached, so a later
 *    attempt can still succeed.
 *
 * Nothing is written until the person actually shares (copy / post / native share). See ShareSheet.
 */
import { createShare, type CreateShareInput } from '@/lib/backend'

export type { CreateShareInput }

const created = new Map<string, Promise<string | null>>()

const keyOf = (input: CreateShareInput) => `${input.pass.id}|${input.lat},${input.lon}|${input.placeLabel}`

/** The share already made for this input in this session, if any (never writes). */
export function peekShare(input: CreateShareInput): Promise<string | null> | undefined {
  return created.get(keyOf(input))
}

/** Resolves the share id, or null when the service is unavailable, slow (> timeoutMs) or failed. */
export function createShareSafe(input: CreateShareInput, timeoutMs = 5000): Promise<string | null> {
  const key = keyOf(input)
  const hit = created.get(key)
  if (hit) return hit
  const p = createOnce(input, timeoutMs)
  created.set(key, p)
  void p.then((id) => {
    if (id === null) created.delete(key)
  })
  return p
}

async function createOnce(input: CreateShareInput, timeoutMs: number): Promise<string | null> {
  const ctl = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  // Abort the request at the deadline, and stop waiting then even if it ignores the signal.
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      ctl.abort()
      resolve(null)
    }, timeoutMs)
  })
  try {
    // createShare never rejects by contract; the catch is belt and braces.
    const res = await Promise.race([createShare(input, { signal: ctl.signal }), deadline])
    return res && typeof res.id === 'string' && res.id ? res.id : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
