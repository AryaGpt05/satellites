/**
 * Keyboard model for the place combobox (pure, unit-tested).
 * `active` is the highlighted option index, or -1 for "none" (focus stays in the input).
 */

/** ↑ / ↓ with wrap-around through "none": none → 0 → … → n-1 → none. */
export function stepActive(active: number, count: number, dir: 1 | -1): number {
  if (count <= 0) return -1
  if (active < 0) return dir === 1 ? 0 : count - 1
  const next = active + dir
  return next < 0 || next >= count ? -1 : next
}

/** What Enter should pick: the highlighted option, else the first one. -1 if there are none. */
export function enterTarget(active: number, count: number): number {
  if (count <= 0) return -1
  return active >= 0 && active < count ? active : 0
}

/** Keep a highlight valid when the result list changes underneath it. */
export function clampActive(active: number, count: number): number {
  return active >= 0 && active < count ? active : -1
}

/** True if a key event should be ignored by global shortcuts because the user is typing. */
export function isTypingTarget(el: EventTarget | null): boolean {
  if (!el || typeof (el as Element).closest !== 'function') return false
  const e = el as HTMLElement
  return !!e.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')
}

/**
 * Whether the primary "go" action should be offered: there is a query to act on, and the latest
 * answer for exactly this query isn't empty ("No match" / "Search unavailable" offer no action).
 */
export function canSubmitQuery(query: string, minLength: number, answer: { q: string; count: number } | null): boolean {
  const q = query.trim()
  if (q.length < minLength) return false
  return !(answer && answer.q === q && answer.count === 0)
}
