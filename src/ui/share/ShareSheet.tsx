/**
 * <ShareSheet pass report onClose/>: preview of the share card + the ways to share it.
 *
 * Phones (touch with the Web Share API): one full-width "Share image", which opens the system share
 * sheet with the card PNG attached (iMessage, WhatsApp, the X app), then Copy link / Post to X /
 * Save PNG. The PNG is rendered locally as soon as the sheet opens, so the tap can call
 * navigator.share synchronously, inside the gesture (Safari drops the share otherwise).
 *
 * Desktop: Post to X (primary) / Copy link / Copy image (pasted into a post as native media), with
 * Save PNG as a quiet text action.
 *
 * Stacked layouts (phones, portrait tablets) build the dialog on the shell's bottom Sheet: a grip, a
 * swipe down closes it, the body scrolls when the card doesn't fit. Wide layouts get a centred dialog.
 * Either way it closes the way it opened (SH5): the frozen clone slides / fades out over the scrim.
 *
 * Nothing is stored until the person actually shares: opening this sheet only previews (and renders
 * the PNG in the browser). The share row (and its short link) is created on the first Share / Copy /
 * Post press, then reused for this pass for the rest of the session.
 *
 * Privacy: the link carries coordinates rounded to ~1 km, and the card's crop is centred on that
 * rounded point, not the searched one. Esc closes this sheet only (it does not also deselect the pass).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ensureTz, timeZoneAt, tzReady } from '@/imagery'
import { cityLevelLabel } from '@/lib/backend'
import { DUR, EASE } from '@/lib/ease'
import type { Pass, Report } from '@/types'
import { Button, Glyph, Rule, Sheet, cx, useExitClone, useIsMobile, useMediaQuery } from '@/ui/system'
import { captureFor, slug } from '../results/lib/captures'
import { satMeta } from '../results/sats'
import { fmtLocalDay, fmtLocalTime } from '../results/lib/time'
import { createShareSafe, peekShare, type CreateShareInput } from './backend'
import { cardSpec, renderCardPng, summaryCardSpec, summaryFacts, type CardSpec } from './card'
import { deepLink, postText, roundedPlace, shareLink, summaryLink, summaryPostText, xIntentUrl } from './links'
import { ShareCard } from './ShareCard'
import s from './ShareSheet.module.css'

export interface ShareSheetProps {
  /** The pass to share (kind 'pass', the default). */
  pass?: Pass
  report: Report
  onClose: () => void
  /**
   * 'pass' (default): one pass, its card and a short /s/<id> link made on the first share.
   * 'summary' (SH6): the week at the place: its best look and counts; the link carries the numbers
   * itself, so nothing is stored.
   */
  kind?: 'pass' | 'summary'
  /** The picture is mostly cloud (results' isClouded): the card shows the clouded variant. */
  clouded?: boolean
  /** Scene cloud cover, %, as the results panel shows it (the card reads the capture's own value). */
  cloudPct?: number
}

type LinkState = { kind: 'idle' } | { kind: 'pending' } | { kind: 'ready'; url: string; short: boolean }
type Flash = 'link' | 'image' | null

const X_POPUP = 'width=600,height=560'
const COARSE_QUERY = '(pointer: coarse)'
/** The PNG renders after the sheet's entrance, so the first frames stay smooth (a tap before then starts it at once). */
const PNG_DELAY_MS = 500

/** True when this browser can hand a PNG file to the system share sheet. */
function canShareFiles(): boolean {
  try {
    return typeof navigator.canShare === 'function' && navigator.canShare({ files: [new File([new Uint8Array(1)], 'card.png', { type: 'image/png' })] })
  } catch {
    return false
  }
}

function canCopyImage(): boolean {
  if (typeof ClipboardItem === 'undefined' || typeof navigator === 'undefined' || !navigator.clipboard?.write) return false
  const supports = (ClipboardItem as unknown as { supports?: (type: string) => boolean }).supports
  return typeof supports === 'function' ? supports('image/png') : true
}

interface PngJob {
  promise: Promise<Blob>
  blob?: Blob
  file?: File
}

/** Everything one share needs, for a pass or for the week's summary. */
interface ShareModel {
  title: string
  spec: CardSpec
  text: string
  fileName: string
  /** Pass shares: the stored share, made on the first share action. Summaries store nothing. */
  input?: CreateShareInput
  /** Pass: the deep link used when the share service is unavailable. Summary: the link itself. */
  fallbackUrl: string
}

const origin = () => (typeof location !== 'undefined' ? location.origin : '')

/** Shares are public: never publish a street address. Fall back to the city, then coordinates. */
function publicLabelOf(place: Report['place']): string {
  const r = roundedPlace(place.lat, place.lon)
  return cityLevelLabel(place) ?? `${r.lat.toFixed(2)}, ${r.lon.toFixed(2)}`
}

function passModel(pass: Pass, report: Report, tz: string, host: string, clouded?: boolean): ShareModel {
  const place = report.place
  const meta = satMeta(pass.norad)
  const capture = captureFor(report, pass)
  const rounded = roundedPlace(place.lat, place.lon)
  const label = publicLabelOf(place)
  const spec = cardSpec(pass, { ...report, place: { ...place, label } }, meta, tz, host, { clouded })
  return {
    title: 'Share this pass',
    spec,
    text: postText({
      verdict: pass.verdict,
      satName: meta.name,
      placeLabel: label,
      altitudeKm: pass.altitudeKm,
      localDay: fmtLocalDay(pass.tClosest, tz),
      localTime: fmtLocalTime(pass.tClosest, tz),
      resolution: capture ? `${Math.round(capture.gsdM)} m` : undefined,
      clouded: spec.sub !== undefined,
    }),
    fileName: `overflight-${slug(meta.name)}-${slug(label)}-${new Date(pass.tClosest).toISOString().slice(0, 10)}.png`,
    input: { placeLabel: label, lat: rounded.lat, lon: rounded.lon, pass, capture, satName: meta.name },
    fallbackUrl: deepLink(origin(), label, place.lat, place.lon, pass.id),
  }
}

function summaryModel(report: Report, tz: string, host: string): ShareModel {
  const label = publicLabelOf(report.place)
  const name = (norad: number) => satMeta(norad).name
  const facts = summaryFacts(report, label, name)
  const passes = facts.counts.likely + facts.counts.could + facts.counts.overhead + facts.counts.imaged
  return {
    title: 'Share this week',
    spec: summaryCardSpec(report, label, name, tz, host),
    text: summaryPostText({ placeLabel: label, satellites: facts.satellites, passes, best: facts.best }),
    fileName: `overflight-${slug(label)}-week-${new Date(report.windowEnd).toISOString().slice(0, 10)}.png`,
    fallbackUrl: summaryLink(origin(), facts),
  }
}

export function ShareSheet({ pass, report, onClose, clouded, kind = 'pass' }: ShareSheetProps) {
  const place = report.place
  // The card prints the place's own zone ("EST"), so make sure the zone table is in (it normally is
  // by the time a report exists; a cold deep link may still be loading it).
  const [tzLoaded, setTzLoaded] = useState(tzReady)
  useEffect(() => {
    if (tzLoaded) return
    let live = true
    void ensureTz().then(() => live && setTzLoaded(tzReady()))
    return () => {
      live = false
    }
  }, [tzLoaded])
  // eslint-disable-next-line react-hooks/exhaustive-deps -- tzLoaded: re-resolve once the table is in
  const tz = useMemo(() => timeZoneAt(place.lat, place.lon), [place.lat, place.lon, tzLoaded])
  const host = typeof location !== 'undefined' ? location.host : 'overflight'
  const summary = kind === 'summary' || !pass
  const model = useMemo(
    () => (summary || !pass ? summaryModel(report, tz, host) : passModel(pass, report, tz, host, clouded)),
    [summary, pass, report, tz, host, clouded],
  )
  const { spec, text, fileName, input, fallbackUrl } = model
  const stacked = useIsMobile()
  const coarse = useMediaQuery(COARSE_QUERY)
  const canNativeShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function'
  const nativeFirst = coarse && canNativeShare
  const [shareFiles] = useState(canShareFiles)
  const [copyImageOk] = useState(canCopyImage)

  const [link, setLink] = useState<LinkState>({ kind: 'idle' })
  const [flash, setFlash] = useState<Flash>(null)
  const [png, setPng] = useState<'busy' | 'ready' | 'err'>('busy')
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const alive = useRef(true)

  // ── link: made on the first share action, never on open ─────────────────────────────────
  const linkPromise = useRef<Promise<string> | null>(null)
  const linkNow = useRef<string | null>(null)
  const resolveLink = useCallback(
    (id: Promise<string | null>) => {
      const p = id.then((v) => {
        const url = v ? shareLink(origin(), v) : fallbackUrl
        linkNow.current = url
        if (alive.current) setLink({ kind: 'ready', url, short: !!v })
        return url
      })
      linkPromise.current = p
      return p
    },
    [fallbackUrl],
  )
  /** The link to share: creates the share on first call (idempotent per pass for the session). */
  const ensureLink = useCallback((): Promise<string> => {
    if (linkPromise.current) return linkPromise.current
    if (!input) return Promise.resolve(fallbackUrl)
    setLink({ kind: 'pending' })
    return resolveLink(createShareSafe(input))
  }, [input, fallbackUrl, resolveLink])

  // Reopening the sheet for a pass already shared this session shows that link straight away. A
  // summary's link is known from the start (it stores nothing).
  useEffect(() => {
    alive.current = true
    linkPromise.current = null
    linkNow.current = null
    if (!input) {
      linkNow.current = fallbackUrl
      linkPromise.current = Promise.resolve(fallbackUrl)
      setLink({ kind: 'ready', url: fallbackUrl, short: false })
    } else {
      const prior = peekShare(input)
      setLink(prior ? { kind: 'pending' } : { kind: 'idle' })
      if (prior) void resolveLink(prior)
    }
    return () => {
      alive.current = false
    }
  }, [input, fallbackUrl, resolveLink])

  // ── the PNG: rendered locally on open (no network write), kept ready for a synchronous share ──
  const job = useRef<PngJob | null>(null)
  const startPng = useCallback((): PngJob => {
    if (job.current) return job.current
    const j: PngJob = { promise: renderCardPng(spec) }
    job.current = j
    j.promise.then(
      (blob) => {
        j.blob = blob
        j.file = new File([blob], fileName, { type: 'image/png' })
        if (alive.current && job.current === j) setPng('ready')
      },
      () => {
        if (alive.current && job.current === j) setPng('err')
      },
    )
    return j
  }, [spec, fileName])
  useEffect(() => {
    job.current = null
    setPng('busy')
    const t = window.setTimeout(() => void startPng(), PNG_DELAY_MS)
    return () => window.clearTimeout(t)
  }, [startPng])

  // ── focus in, Esc out ───────────────────────────────────────────────────────────────────
  // Capture phase: the app's own Esc handler must not also deselect the pass. `onClose` is read from
  // a ref so a parent re-render (a fresh inline callback) never re-runs this and steals focus.
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    rootRef.current?.focus({ preventScroll: true })
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        e.preventDefault()
        closeRef.current()
      } else if (e.key === 'Tab') trapFocus(e, rootRef.current)
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      prev?.focus?.({ preventScroll: true })
    }
  }, [])

  // ── close as smoothly as it opened (SH5) ────────────────────────────────────────────────
  // The frozen clone keeps the last frame: the scrim fades, the dialog drops 8px and fades (wide) or the
  // sheet slides down from wherever the finger left it (stacked). Reduced motion: a 200 ms fade.
  useExitClone(rootRef, {
    keyframes: stacked ? [{ opacity: 1 }, { opacity: 1 }] : [{ opacity: 1 }, { opacity: 0 }],
    duration: stacked ? 280 : DUR.exit,
    easing: EASE.inOut,
    onStart: (clone, reduced) => {
      if (reduced) return
      const panel = clone.querySelector<HTMLElement>('[data-share-panel]')
      if (stacked) {
        clone.querySelector<HTMLElement>(`.${s.scrim}`)?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: DUR.exit, easing: EASE.inOut, fill: 'forwards' })
        // A swipe-down dismiss leaves the sheet below its (single) snap, still moving: carry that motion
        // on with ease-out (the rule for anything already moving) instead of restarting from rest, which would stall
        // it under the finger for a few frames. The target lies a quarter beyond the bottom edge, so the
        // on-screen part leaves in the fast first half and the slow tail happens out of sight.
        // From rest (close button, Esc, scrim): ease-in-out, the full height.
        const sheet = panel?.querySelector<HTMLElement>('section')
        const dragged = /translate3d\(0px?, ([\d.]+)px/.exec(sheet?.style.transform ?? '')
        if (sheet && dragged && Number(dragged[1]) > 1) {
          const off = Math.max(0, window.innerHeight - sheet.getBoundingClientRect().top)
          panel?.animate([{ translate: '0 0' }, { translate: `0 ${Math.ceil(off * 1.25 + 8)}px` }], { duration: DUR.exit, easing: EASE.out, fill: 'forwards' })
        } else panel?.animate([{ translate: '0 0' }, { translate: '0 100%' }], { duration: 280, easing: EASE.inOut, fill: 'forwards' })
      } else {
        panel?.animate(
          [
            { transform: 'translateY(0)', opacity: 1 },
            { transform: 'translateY(8px)', opacity: 0 },
          ],
          { duration: 200, easing: EASE.inOut, fill: 'forwards' },
        )
      }
    },
  })

  const showFlash = (f: Flash) => {
    if (!alive.current) return
    setFlash(f)
    window.setTimeout(() => alive.current && setFlash((cur) => (cur === f ? null : cur)), 2000)
  }

  // ── actions ─────────────────────────────────────────────────────────────────────────────
  const copy = async () => {
    const pending = ensureLink()
    let ok = false
    if (linkNow.current) ok = await writeText(linkNow.current)
    else {
      // Safari only allows a clipboard write inside the gesture, so hand it a promise of the text.
      try {
        if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) throw new Error('no ClipboardItem')
        await navigator.clipboard.write([new ClipboardItem({ 'text/plain': pending.then((u) => new Blob([u], { type: 'text/plain' })) })])
        ok = true
      } catch {
        ok = await writeText(await pending)
      }
    }
    if (!ok) {
      // Last resort: select the field so the person can copy it themselves.
      await pending
      inputRef.current?.focus()
      inputRef.current?.select()
      ok = document.execCommand?.('copy') ?? false
    }
    if (ok) showFlash('link')
  }

  const post = () => {
    if (linkNow.current) {
      window.open(xIntentUrl(text, linkNow.current), '_blank', `noopener,noreferrer,${X_POPUP}`)
      return
    }
    // Open the window inside the click (popup blockers), then point it at the intent once the link exists.
    const w = window.open('', '_blank', X_POPUP)
    void ensureLink().then((url) => {
      const target = xIntentUrl(text, url)
      if (w && !w.closed) {
        try {
          w.opener = null
        } catch {
          /* cross-origin already: nothing to sever */
        }
        w.location.href = target
      } else window.open(target, '_blank', `noopener,noreferrer,${X_POPUP}`)
    })
  }

  const download = async () => {
    try {
      const blob = await startPng().promise
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = fileName
      document.body.appendChild(a)
      a.click()
      a.remove()
      window.setTimeout(() => URL.revokeObjectURL(a.href), 4000)
    } catch {
      if (alive.current) setPng('err')
    }
  }

  /** Desktop: the card on the clipboard, to paste into a post as native media. */
  const copyImage = async () => {
    const j = startPng()
    try {
      // A Blob if it's ready, else the promise (Safari wants the ClipboardItem inside the gesture).
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': j.blob ?? j.promise })])
      showFlash('image')
    } catch {
      void download()
    }
  }

  /**
   * Phones: the system share sheet with the card attached. Called synchronously in the tap: no await
   * comes before navigator.share, or Safari treats the gesture as spent and refuses.
   */
  const nativeShare = () => {
    void ensureLink() // the short link for next time (and for Copy); this share uses what's ready now
    const j = startPng()
    const data: ShareData = { text, url: linkNow.current ?? fallbackUrl }
    if (j.file && shareFiles) data.files = [j.file]
    let p: Promise<void>
    try {
      p = navigator.share(data)
    } catch (err) {
      p = Promise.reject(err)
    }
    p.catch((err: unknown) => {
      const name = err instanceof Error || err instanceof DOMException ? err.name : ''
      if (name === 'AbortError') return // the person cancelled
      // NotAllowedError (gesture spent / blocked) or TypeError (data refused): put the link on the clipboard.
      void copy()
    })
  }

  // Pressing any share action starts the link a beat before the click lands.
  const warm = () => void ensureLink()
  const url = link.kind === 'ready' ? link.url : ''
  const pngLabel = png === 'err' ? 'Try again' : 'Save PNG'

  const actions = nativeFirst ? (
    <div className={s.actionsTouch}>
      <Button variant="primary" className={s.native} onClick={nativeShare} onPointerDown={warm}>
        <Glyph name="share" size={14} />
        {shareFiles ? 'Share image' : 'Share'}
      </Button>
      <div className={s.secondary}>
        <Button onClick={copy} onPointerDown={warm} aria-live="polite">
          {flash === 'link' ? 'Copied' : 'Copy link'}
        </Button>
        <Button onClick={post} onPointerDown={warm}>
          Post to X
        </Button>
        <Button onClick={download}>{pngLabel}</Button>
      </div>
    </div>
  ) : (
    <div className={s.actions}>
      <Button variant="primary" onClick={post} onPointerDown={warm}>
        Post to X
      </Button>
      <Button onClick={copy} onPointerDown={warm} aria-live="polite">
        {flash === 'link' ? <Glyph name="imaged" size={10} color="var(--signal)" /> : null}
        {flash === 'link' ? 'Copied' : 'Copy link'}
      </Button>
      {copyImageOk ? (
        <Button onClick={copyImage} onPointerDown={() => void startPng()} aria-live="polite">
          {flash === 'image' ? <Glyph name="imaged" size={10} color="var(--signal)" /> : null}
          {flash === 'image' ? 'Copied' : 'Copy image'}
        </Button>
      ) : (
        <Button onClick={download}>{pngLabel}</Button>
      )}
    </div>
  )

  const body = (
    <div className={s.content}>
      <ShareCard spec={spec} />
      {actions}
      {link.kind !== 'idle' ? (
        <div className={s.linkRow}>
          <label htmlFor="share-link" className={s.linkLabel}>
            {link.kind === 'ready' && !link.short && input ? 'Link · direct' : 'Link'}
          </label>
          <input
            id="share-link"
            ref={inputRef}
            className={cx(s.link, link.kind !== 'ready' && s.linkPending)}
            readOnly
            value={link.kind === 'ready' ? url : 'Creating link…'}
            onFocus={(e) => link.kind === 'ready' && e.currentTarget.select()}
          />
        </div>
      ) : null}
      <p className={s.text}>
        <span className={s.textLabel}>Post</span>
        {/* Paragraphs as the post will have them (a blank line on X), set a little tighter here. */}
        <span className={s.textBody}>
          {text.split('\n\n').map((para, i) => (
            <span key={i}>{para}</span>
          ))}
        </span>
      </p>
      <div className={s.foot}>
        <p className={s.privacy}>
          Sharing reveals the area shown in the image. The link and the card use a point rounded to about 1 km, not the exact spot you searched.
          {input ? ' Nothing is saved until you share.' : ' Nothing is stored: the link carries the numbers.'}
          {png === 'err' ? ' The card could not be rendered here; the link still works.' : ''}
        </p>
        {!nativeFirst && copyImageOk ? (
          <button type="button" className={s.textAction} onClick={download}>
            <Glyph name="download" size={12} />
            {pngLabel}
          </button>
        ) : null}
      </div>
    </div>
  )

  const title = <span id="share-title">{model.title}</span>

  return (
    <div ref={rootRef} className={s.root} role="dialog" aria-modal="true" aria-labelledby="share-title" tabIndex={-1}>
      <div className={s.scrim} onMouseDown={onClose} aria-hidden />
      {stacked ? (
        <StackedShare onClose={onClose} title={title} label={model.title}>
          {body}
        </StackedShare>
      ) : (
        <div className={s.dialog} data-share-panel>
          <div className={s.head}>
            <Rule className={s.rule}>{title}</Rule>
            <button type="button" className={s.close} onClick={onClose} aria-label="Close" title="Close (Esc)">
              <Glyph name="close" size={14} />
            </button>
          </div>
          {body}
        </div>
      )}
    </div>
  )
}

/**
 * The stacked dialog: the shell's bottom Sheet with one snap, measured to the content (capped by the
 * Sheet below the HUD band). The grip and a swipe down close it; the body scrolls if it can't all fit.
 */
function StackedShare({ onClose, title, label, children }: { onClose: () => void; title: React.ReactNode; label: string; children: React.ReactNode }) {
  const bodyRef = useRef<HTMLDivElement>(null)
  const [fit, setFit] = useState(0)
  useLayoutEffect(() => {
    const body = bodyRef.current
    const content = body?.firstElementChild as HTMLElement | null
    const section = body?.parentElement
    if (!body || !content || !section) return
    const measure = () => {
      const cs = getComputedStyle(body)
      const chrome = section.offsetHeight - body.offsetHeight
      const need = chrome + parseFloat(cs.paddingTop) + content.offsetHeight + parseFloat(cs.paddingBottom)
      setFit(Math.ceil(need))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(content)
    return () => ro.disconnect()
  }, [])
  return (
    <div className={s.stacked} data-share-panel>
      <Sheet
        label={label}
        header={<Rule className={s.rule}>{title}</Rule>}
        // Start low and rise to the measured height: the first frame never overshoots the content.
        snaps={[fit || 0.4]}
        onClose={onClose}
        closeLabel="Close"
        dismissible
        className={s.sheet}
        bodyRef={bodyRef}
      >
        {children}
      </Sheet>
    </div>
  )
}

async function writeText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

function trapFocus(e: KeyboardEvent, root: HTMLElement | null) {
  if (!root) return
  const items = [...root.querySelectorAll<HTMLElement>('button:not([disabled]), input, a[href], [tabindex]:not([tabindex="-1"])')]
  if (!items.length) return
  const first = items[0]
  const last = items[items.length - 1]
  const active = document.activeElement
  if (e.shiftKey && (active === first || active === root)) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && active === last) {
    e.preventDefault()
    first.focus()
  }
}
