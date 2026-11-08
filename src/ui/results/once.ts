/**
 * useOnce(key): true the first time `key` is shown in this session, false on every later mount.
 * Drives "animate on first appearance only": a count-up per report, a hero reveal per capture, a
 * returning panel that shows final values at once.
 *
 * Local adapter with the same contract as the shell's planned `useOnce` (S7): switch the import to
 * '@/ui/system' when it lands.
 */
import { useEffect, useRef } from 'react'

const seen = new Set<string>()

/** Whether `key` has been shown before (without marking it). */
export const wasSeen = (key: string) => seen.has(key)
/** Mark a key as shown (e.g. from an imperative animation's start). */
export const markSeen = (key: string) => void seen.add(key)

export function useOnce(key: string): boolean {
  // Decided once per (mount, key): StrictMode's double render and effect replay must not flip it.
  const ref = useRef<{ key: string; first: boolean } | null>(null)
  if (!ref.current || ref.current.key !== key) ref.current = { key, first: !seen.has(key) }
  useEffect(() => {
    seen.add(key)
  }, [key])
  return ref.current.first
}
