/**
 * <ShareSheet pass report onClose/>: preview of the share card + the ways to share it.
 *
 *  Copy link      short link from the share service (`/s/<id>`), or a deep link if it is unavailable
 *  Post to X      web intent with precise, prefilled text and the link
 *  Card PNG       the 1200×630 card rendered to PNG in the browser
 *  Share…         the native share sheet, with the PNG attached where supported
 *
 * Nothing is stored until the person actually shares: opening this sheet only previews. The share
 * row (and its short link) is created on the first Copy / Post / Share press, then reused for this
 * pass for the rest of the session.
 *
 * Privacy: the link carries coordinates rounded to ~1 km, and the card's crop is centred on that
 * rounded point, not the searched one. Esc closes this sheet only (it does not also deselect the pass).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { timeZoneAt } from '@/imagery'
import { cityLevelLabel } from '@/lib/backend'
import type { Pass, Report } from '@/types'
import { Button, Glyph, Rule, cx } from '@/ui/system'
import { captureFor, slug } from '../results/lib/captures'
import { satMeta } from '../results/sats'
import { fmtLocalDay, fmtLocalTime } from '../results/lib/time'
import { createShareSafe, peekShare, type CreateShareInput } from './backend'
import { cardSpec, planPainter, renderCardPng } from './card'
import { deepLink, postText, roundedPlace, shareLink, xIntentUrl } from './links'
import { ShareCard } from './ShareCard'
import s from './ShareSheet.module.css'

export interface ShareSheetProps {
  pass: Pass
  report: Report
  onClose: () => void
}

type LinkState = { kind: 'idle' } | { kind: 'pending' } | { kind: 'ready'; url: string; short: boolean }

const X_POPUP = 'width=600,height=560'

export function ShareSheet({ pass, report, onClose }: ShareSheetProps) {
  const place = report.place
  const tz = useMemo(() => timeZoneAt(place.lat, place.lon), [place.lat, place.lon])
  const meta = satMeta(pass.norad)
  const capture = captureFor(report, pass)
  const host = typeof location !== 'undefined' ? location.host : 'overflight'
  const spec = useMemo(() => cardSpec(pass, report, meta, tz, host), [pass, report, meta, tz, host])
  const rounded = useMemo(() => roundedPlace(place.lat, place.lon), [place.lat, place.lon])
  // Shares are public: never publish a street address. Fall back to the city, then coordinates.
  const publicLabel = cityLevelLabel(place) ?? `${rounded.lat.toFixed(2)}, ${rounded.lon.toFixed(2)}`
  const [link, setLink] = useState<LinkState>({ kind: 'idle' })
  const [copied, setCopied] = useState(false)
  const [png, setPng] = useState<'idle' | 'busy' | 'err'>('idle')
  const dialogRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const alive = useRef(true)
  const canNativeShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function'

  // ── link: made on the first share action, never on open ─────────────────────────────────
  const input: CreateShareInput = useMemo(
    () => ({ placeLabel: publicLabel, lat: rounded.lat, lon: rounded.lon, pass, capture, satName: meta.name }),
    [publicLabel, rounded, pass, capture, meta.name],
  )
  const linkPromise = useRef<Promise<string> | null>(null)
  const resolveLink = useCallback(
    (id: Promise<string | null>) => {
      const origin = location.origin
      const fallback = deepLink(origin, place.label, place.lat, place.lon, pass.id)
      const p = id.then((v) => {
        const url = v ? shareLink(origin, v) : fallback
        if (alive.current) setLink({ kind: 'ready', url, short: !!v })
        return url
      })
      linkPromise.current = p
      return p
    },
    [place.label, place.lat, place.lon, pass.id],
  )
  /** The link to share: creates the share on first call (idempotent per pass for the session). */
  const ensureLink = useCallback((): Promise<string> => {
    if (linkPromise.current) return linkPromise.current
    setLink({ kind: 'pending' })
    return resolveLink(createShareSafe(input))
  }, [input, resolveLink])

  // Reopening the sheet for a pass already shared this session shows that link straight away.
  useEffect(() => {
    alive.current = true
    linkPromise.current = null
    const prior = peekShare(input)
    setLink(prior ? { kind: 'pending' } : { kind: 'idle' })
    if (prior) void resolveLink(prior)
    return () => {
      alive.current = false
    }
  }, [input, resolveLink])

  // ── focus in, Esc out ───────────────────────────────────────────────────────────────────
  // Capture phase: the app's own Esc handler must not also deselect the pass. `onClose` is read from
  // a ref so a parent re-render (a fresh inline callback) never re-runs this and steals focus.
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    dialogRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        e.preventDefault()
        closeRef.current()
      } else if (e.key === 'Tab') trapFocus(e, dialogRef.current)
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      prev?.focus?.()
    }
  }, [])

  const text = postText({
    verdict: pass.verdict,
    satName: meta.name,
    placeLabel: publicLabel,
    altitudeKm: pass.altitudeKm,
    localDay: fmtLocalDay(pass.tClosest, tz),
    localTime: fmtLocalTime(pass.tClosest, tz),
    resolution: capture ? `${Math.round(capture.gsdM)} m` : undefined,
  })
  const fileName = `overflight-${slug(meta.name)}-${slug(place.label)}-${new Date(pass.tClosest).toISOString().slice(0, 10)}.png`

  // ── actions ─────────────────────────────────────────────────────────────────────────────
  const copy = async () => {
    const pending = ensureLink()
    let ok = false
    if (link.kind === 'ready') ok = await writeText(link.url)
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
    if (ok && alive.current) {
      setCopied(true)
      window.setTimeout(() => alive.current && setCopied(false), 2000)
    }
  }

  const post = () => {
    if (link.kind === 'ready') {
      window.open(xIntentUrl(text, link.url), '_blank', `noopener,noreferrer,${X_POPUP}`)
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

  const makePng = () => renderCardPng(spec, capture ? undefined : planPainter(pass, meta, rounded.lat, rounded.lon))

  const download = async () => {
    if (png === 'busy') return
    setPng('busy')
    try {
      const blob = await makePng()
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = fileName
      document.body.appendChild(a)
      a.click()
      a.remove()
      window.setTimeout(() => URL.revokeObjectURL(a.href), 4000)
      if (alive.current) setPng('idle')
    } catch {
      if (alive.current) setPng('err')
    }
  }

  const nativeShare = async () => {
    try {
      // Link and card in parallel: the share sheet must open while the tap still counts as a gesture.
      const [url, blob] = await Promise.all([ensureLink(), makePng().catch(() => null)])
      const file = blob ? new File([blob], fileName, { type: 'image/png' }) : null
      const data: ShareData = { title: 'Overflight', text, url }
      if (file && navigator.canShare?.({ files: [file] })) data.files = [file]
      await navigator.share(data)
    } catch {
      /* cancelled, or the gesture expired: the link is still in the field */
    }
  }

  // Pressing any share action starts the link a beat before the click lands.
  const warm = () => void ensureLink()
  const url = link.kind === 'ready' ? link.url : ''

  return (
    <div className={s.backdrop} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={dialogRef} className={s.dialog} role="dialog" aria-modal="true" aria-labelledby="share-title" tabIndex={-1}>
        <div className={s.head}>
          <Rule className={s.rule}>
            <span id="share-title">Share this pass</span>
          </Rule>
          <button type="button" className={s.close} onClick={onClose} aria-label="Close" title="Close (Esc)">
            <Glyph name="close" size={14} />
          </button>
        </div>

        <ShareCard spec={spec} pass={pass} meta={meta} lat={place.lat} lon={place.lon} />

        <div className={s.linkRow}>
          <label htmlFor="share-link" className={s.linkLabel}>
            {link.kind === 'ready' && !link.short ? 'Link · direct' : 'Link'}
          </label>
          <input
            id="share-link"
            ref={inputRef}
            className={cx(s.link, link.kind !== 'ready' && s.linkPending)}
            readOnly
            value={link.kind === 'ready' ? url : link.kind === 'pending' ? 'Creating link…' : 'Made when you copy or post'}
            onFocus={(e) => link.kind === 'ready' && e.currentTarget.select()}
          />
        </div>

        <div className={s.actions}>
          <Button variant="primary" onClick={copy} onPointerDown={warm} aria-live="polite">
            <Glyph name={copied ? 'imaged' : 'share'} size={13} />
            {copied ? 'Copied' : 'Copy link'}
          </Button>
          <Button onClick={post} onPointerDown={warm}>
            Post to X
          </Button>
          <Button onClick={download} disabled={png === 'busy'}>
            <Glyph name="download" size={13} />
            {png === 'busy' ? 'Rendering…' : png === 'err' ? 'Try again' : 'Card PNG'}
          </Button>
          {canNativeShare ? (
            <Button onClick={nativeShare} onPointerDown={warm} className={s.native}>
              Share…
            </Button>
          ) : null}
        </div>

        <p className={s.text}>
          <span className={s.textLabel}>Post</span>
          {text}
        </p>

        <p className={s.privacy}>
          Sharing reveals the area shown in the image. The link and the card use a point rounded to about 1 km, not the exact spot you searched.
          Nothing is saved until you copy or post.
          {png === 'err' ? ' The card could not be rendered here; the link still works.' : ''}
        </p>
      </div>
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
