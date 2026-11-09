/**
 * A cheap, faithful copy of what a subtree shows right now: the ghost an exit or a cross-fade animates
 * (R3-1, R3-4). Instead of cloneNode(true) on the whole panel (~1,300 nodes, every photo re-created as a new
 * <img>: a 130–208 ms style + layout task at 4× CPU on phones), it copies:
 *
 *   - with `clip`: only what is on screen. An element entirely past the visible area (below it, or right of a
 *     horizontal scroller's viewport) is left out; one entirely before it (scrolled past) becomes an empty
 *     placeholder of its exact size, so what follows sits where it was. The visible area narrows at every
 *     scroll container (the panel body, the gallery track);
 *   - every <img> as a <canvas> painted from the live, decoded element (object-fit honoured): no new image
 *     element, so no request, no decode, no load event (A2);
 *   - every <canvas> with its pixels; scroll offsets are restored after insertion (`restore`).
 *
 * Entrance animations never replay in the copy (animation: none on every element).
 */

interface Box {
  l: number
  t: number
  r: number
  b: number
}

export interface Snapshot {
  node: HTMLElement
  /** Call once the copy is in the document: puts its scrollers back where the originals were */
  restore: () => void
}

const meet = (a: Box, b: DOMRect): Box => ({ l: Math.max(a.l, b.left), t: Math.max(a.t, b.top), r: Math.min(a.r, b.right), b: Math.min(a.b, b.bottom) })

export function snapshot(root: HTMLElement, opts: { clip?: boolean } = {}): Snapshot {
  const scrolls: [Element, number, number][] = []
  let clip: Box | null = null
  if (opts.clip) clip = meet({ l: 0, t: 0, r: window.innerWidth, b: window.innerHeight }, root.getBoundingClientRect())
  const node = copy(root, clip, scrolls, true) as HTMLElement
  return {
    node,
    restore: () => {
      for (const [el, t, l] of scrolls) {
        if (t) el.scrollTop = t
        if (l) el.scrollLeft = l
      }
    },
  }
}

function copy(src: Node, clip: Box | null, scrolls: [Element, number, number][], isRoot: boolean): Node | null {
  if (src.nodeType === Node.TEXT_NODE) return src.cloneNode(false)
  if (src.nodeType !== Node.ELEMENT_NODE) return null
  const el = src as Element
  if (el instanceof HTMLImageElement) return imageCanvas(el)
  if (el instanceof HTMLCanvasElement) return canvasCopy(el)
  let rect: DOMRect | undefined
  if (clip && !isRoot) {
    rect = el.getBoundingClientRect()
    // display: contents (and other box-less wrappers) report an empty rect: look inside them.
    if (rect.width || rect.height) {
      if (rect.top >= clip.b || rect.left >= clip.r) return null
      if (rect.bottom <= clip.t || rect.right <= clip.l) return placeholder(el, rect)
    }
  }
  if (el instanceof SVGElement) return el.cloneNode(true)
  const c = el.cloneNode(false) as Element
  c.removeAttribute('id')
  if (c instanceof HTMLElement) c.style.animation = 'none'
  let inner = clip
  if (el instanceof HTMLElement) {
    if (el.scrollTop || el.scrollLeft) scrolls.push([c, el.scrollTop, el.scrollLeft])
    if (clip && (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1)) {
      const cs = getComputedStyle(el)
      if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') inner = meet(clip, rect ?? el.getBoundingClientRect())
    }
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) (c as HTMLInputElement).value = el.value
  }
  for (const ch of Array.from(el.childNodes)) {
    const k = copy(ch, inner, scrolls, false)
    if (k) c.appendChild(k)
  }
  return c
}

/** An element scrolled past: the same box (classes, so the same flow), its exact size, nothing inside. */
function placeholder(el: Element, r: DOMRect): Element {
  const c = el.cloneNode(false) as Element
  c.removeAttribute('id')
  if (c instanceof HTMLElement || c instanceof SVGElement)
    c.style.cssText += `;box-sizing:border-box;width:${r.width}px;height:${r.height}px;min-width:0;min-height:0;max-width:none;max-height:none;visibility:hidden;animation:none`
  return c
}

/** A decoded photo as a canvas of the same box: no new <img> (no request, no load event). */
function imageCanvas(img: HTMLImageElement): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.className = img.className
  c.setAttribute('aria-hidden', 'true')
  const w = img.clientWidth
  const h = img.clientHeight
  if (!w || !h) return c
  const cs = getComputedStyle(img)
  // The rules that placed the <img> (some select `img` by tag) carried over as inline style.
  c.style.cssText = `position:${cs.position};top:${cs.top};left:${cs.left};right:${cs.right};bottom:${cs.bottom};width:${w}px;height:${h}px;display:${cs.display === 'inline' ? 'inline-block' : cs.display};margin:${cs.margin};opacity:${cs.opacity};filter:${cs.filter};vertical-align:${cs.verticalAlign};animation:none`
  const iw = img.naturalWidth
  const ih = img.naturalHeight
  if (!img.complete || !iw || !ih) return c
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  c.width = Math.max(1, Math.round(w * dpr))
  c.height = Math.max(1, Math.round(h * dpr))
  const ctx = c.getContext('2d')
  if (!ctx) return c
  try {
    if (cs.objectFit === 'fill') ctx.drawImage(img, 0, 0, c.width, c.height)
    else {
      const k = cs.objectFit === 'contain' ? Math.min(c.width / iw, c.height / ih) : Math.max(c.width / iw, c.height / ih)
      const dw = iw * k
      const dh = ih * k
      ctx.drawImage(img, (c.width - dw) / 2, (c.height - dh) / 2, dw, dh)
    }
  } catch {
    /* a broken image: the box stays empty */
  }
  return c
}

function canvasCopy(from: HTMLCanvasElement): HTMLCanvasElement {
  const c = from.cloneNode(false) as HTMLCanvasElement
  c.removeAttribute('id')
  if (!from.width || !from.height) return c
  try {
    c.width = from.width
    c.height = from.height
    c.getContext('2d')?.drawImage(from, 0, 0)
  } catch {
    /* tainted or lost context: the copy shows the frame without pixels */
  }
  return c
}
