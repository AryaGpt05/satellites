/**
 * Window events between the UI and the globe (separate chunks: neither imports the other).
 *
 * UI_ENTRANCE: a heavy UI entrance was just committed (the results panel's handoff). Dispatched from the commit's
 * layout effect, so it lands before the next frame; on phones the globe skips its composer render in that frame,
 * so the browser's style / layout / paint of the new panel and the globe's frame land in different tasks (U-1 /
 * PH-06: together they were one 144–213 ms task at 4× CPU).
 */
export const UI_ENTRANCE_EVENT = 'watched:ui-entrance'

export function announceUiEntrance(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(UI_ENTRANCE_EVENT))
}
