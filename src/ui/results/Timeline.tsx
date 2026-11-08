/**
 * Timeline (02 / TIMELINE): seven days across, for THIS place.
 *
 *  - Day/night shading from the real sun elevation at the place, sampled every 10 minutes.
 *  - Day labels at local midnights in the place's time zone (DST-correct), 6-hourly ticks.
 *  - One lane per verdict. Marks at tClosest with the category glyphs; photographs are signal
 *    diamonds standing on a stem, taller than everything else. ~1,500 "could" passes become a
 *    barcode of 1px ticks rather than a pile of overlapping squares.
 *  - A continuous band on top for the geostationary imagers (they never "pass": DESIGN §2).
 *  - Hover: mono tooltip. Click/tap: select. Playhead: store.simTime during replay/scrub.
 *
 * Static layers are painted on a canvas (1,900 marks); hover, selection and the playhead are DOM so
 * the 10 Hz playhead never repaints the marks.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useApp } from '@/state/store'
import type { Pass } from '@/types'
import { Glyph, cx, palette } from '@/ui/system'
import { int } from './lib/copy'
import { glyphForPass, VERDICT_GLYPH, type Verdict } from './lib/meta'
import { daylight, hitTest, LANES, SUN_SAMPLE_MS } from './lib/timeline'
import { fmtLocalDay, fmtLocalTime, zoneAbbr } from './lib/time'
import { isDailyMosaic } from './lib/captures'
import type { ResultsModel } from './model'
import s from './Timeline.module.css'

const LANE_WORD: Record<Verdict, string> = { imaged: 'Imaged', likely: 'Likely', could: 'Could', overhead: 'Overhead' }

interface Props {
  model: ResultsModel
  selectedId?: string
  onSelect: (p: Pass) => void
  compact?: boolean
  className?: string
}

interface Layout {
  w: number
  h: number
  geoH: number
  laneTop: number
  laneH: number
  lanes: Verdict[]
  /** y centre of a lane */
  laneY: (v: Verdict) => number
  laneOf: (y: number) => Verdict | undefined
}

function layoutFor(w: number, h: number, compact: boolean, hasGeo: boolean): Layout {
  // Compact (phone): photographs on top, then everything else merged into two lanes.
  const lanes: Verdict[] = compact ? ['imaged', 'likely', 'could'] : [...LANES]
  const geoH = hasGeo ? (compact ? 6 : 10) : 0
  const laneTop = geoH
  const laneH = (h - laneTop) / lanes.length
  const laneIndex = (v: Verdict) => {
    if (compact && v === 'overhead') return 1 // crewed passes share the "likely" lane on phones
    return Math.max(0, lanes.indexOf(v))
  }
  return {
    w,
    h,
    geoH,
    laneTop,
    laneH,
    lanes,
    laneY: (v) => laneTop + laneH * (laneIndex(v) + 0.5),
    laneOf: (y) => {
      const i = Math.floor((y - laneTop) / laneH)
      return i >= 0 && i < lanes.length ? lanes[i] : undefined
    },
  }
}

export function Timeline({ model, selectedId, onSelect, compact = false, className }: Props) {
  const { report, tz, lanes, sun, days, hours, meta } = model
  const t0 = report.windowStart
  const t1 = report.windowEnd
  const span = t1 - t0
  const plotRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [hover, setHover] = useState<{ pass: Pass; x: number } | null>(null)
  // The globe writes simTime at 10 Hz even in live mode; only the playhead needs it, and only while
  // replaying or scrubbing, so live time never re-renders the strip.
  const head = useApp((st) => (st.timeMode === 'live' ? undefined : st.simTime))
  const hasGeo = report.geo.length > 0
  const L = useMemo(() => layoutFor(size.w, size.h, compact, hasGeo), [size.w, size.h, compact, hasGeo])
  const xOf = useCallback((t: number) => ((t - t0) / span) * size.w, [t0, span, size.w])
  const captureById = useMemo(() => new Map(report.captures.map((c) => [c.id, c])), [report.captures])

  // ── size ─────────────────────────────────────────────────────────────────────────
  useLayoutEffect(() => {
    const el = plotRef.current
    if (!el) return
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight })
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // ── static paint ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    const cv = canvasRef.current
    if (!cv || !L.w || !L.h) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    cv.width = Math.round(L.w * dpr)
    cv.height = Math.round(L.h * dpr)
    const ctx = cv.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, L.w, L.h)
    const px = 1 / dpr
    const X = (t: number) => ((t - t0) / span) * L.w
    const snap = (x: number) => Math.round(x * dpr) / dpr + px / 2

    // Day / night: the real sun at this place.
    for (let i = 0; i < sun.length - 1; i++) {
      const a = X(t0 + i * SUN_SAMPLE_MS)
      const b = X(Math.min(t1, t0 + (i + 1) * SUN_SAMPLE_MS))
      const d = daylight((sun[i] + sun[i + 1]) / 2)
      if (d <= 0.001) continue
      ctx.fillStyle = `rgba(236,232,224,${((compact ? 0.055 : 0.07) * d).toFixed(4)})`
      ctx.fillRect(a, 0, b - a + 0.5, L.h)
    }

    // Local midnights and 6-hourly ticks.
    ctx.lineWidth = px
    ctx.strokeStyle = 'rgba(236,232,224,0.16)'
    ctx.beginPath()
    for (const d of days) {
      const x = snap(X(d.t))
      ctx.moveTo(x, 0)
      ctx.lineTo(x, L.h)
    }
    ctx.stroke()
    ctx.strokeStyle = 'rgba(236,232,224,0.14)'
    ctx.beginPath()
    for (const hm of hours) {
      const x = snap(X(hm.t))
      const len = hm.hour === 12 ? 5 : 3
      ctx.moveTo(x, L.h)
      ctx.lineTo(x, L.h - len)
    }
    ctx.stroke()

    // Lane separators.
    ctx.strokeStyle = 'rgba(236,232,224,0.05)'
    ctx.beginPath()
    for (let i = 1; i < L.lanes.length; i++) {
      const y = Math.round((L.laneTop + i * L.laneH) * dpr) / dpr + px / 2
      ctx.moveTo(0, y)
      ctx.lineTo(L.w, y)
    }
    ctx.stroke()

    // Geostationary: continuous presence, one hairline per watcher, ticked at each hour.
    if (L.geoH) {
      const n = Math.min(3, report.geo.length)
      for (let g = 0; g < n; g++) {
        const y = Math.round(((g + 1) * L.geoH) / (n + 1) * dpr) / dpr + px / 2
        ctx.strokeStyle = `rgba(236,232,224,${g === 0 ? 0.42 : 0.2})`
        ctx.beginPath()
        ctx.moveTo(0, y)
        ctx.lineTo(L.w, y)
        ctx.stroke()
      }
    }

    // ── marks ──
    const bone = 'rgba(236,232,224,0.52)'
    const ice = 'rgba(169,199,211,0.75)'
    // could: barcode ticks
    const could = lanes.could.passes
    const cy = L.laneY('could')
    const tickH = Math.min(9, L.laneH * 0.62)
    for (const p of could) {
      const radar = meta(p.norad).category === 'radar'
      ctx.strokeStyle = radar ? 'rgba(169,199,211,0.42)' : 'rgba(236,232,224,0.2)'
      const x = snap(X(p.tClosest))
      ctx.beginPath()
      ctx.moveTo(x, cy - tickH / 2)
      ctx.lineTo(x, cy + tickH / 2)
      ctx.stroke()
    }
    // likely + overhead: small glyphs
    const g = compact ? 2 : 2.7
    for (const v of ['likely', 'overhead'] as const) {
      const y = L.laneY(v)
      for (const p of lanes[v].passes) {
        const x = X(p.tClosest)
        const cat = meta(p.norad).category
        ctx.strokeStyle = cat === 'radar' ? ice : bone
        ctx.fillStyle = bone
        ctx.beginPath()
        switch (glyphForPass(p.verdict, cat)) {
          case 'likely':
            ctx.moveTo(x, y - g - 0.6)
            ctx.lineTo(x + g + 0.6, y)
            ctx.lineTo(x, y + g + 0.6)
            ctx.lineTo(x - g - 0.6, y)
            ctx.closePath()
            break
          case 'weather-leo':
            ctx.arc(x, y, g, 0, Math.PI * 2)
            break
          case 'crewed':
            ctx.moveTo(x, y - g - 0.5)
            ctx.lineTo(x, y + g + 0.5)
            ctx.moveTo(x - g - 0.5, y)
            ctx.lineTo(x + g + 0.5, y)
            break
          default:
            ctx.rect(x - g + 0.5, y - g + 0.5, 2 * g - 1, 2 * g - 1)
        }
        ctx.stroke()
      }
    }
    // imaged: signal diamonds on stems that rise from the baseline (they stand tallest)
    const iy = L.laneY('imaged')
    for (const p of lanes.imaged.passes) {
      const c = p.captureId ? captureById.get(p.captureId) : undefined
      const detailed = !(c && isDailyMosaic(c))
      const x = X(p.tClosest)
      const r = detailed ? (compact ? 4.2 : 5.2) : compact ? 2.8 : 3.4
      ctx.strokeStyle = detailed ? 'rgba(255,106,26,0.55)' : 'rgba(255,106,26,0.28)'
      ctx.beginPath()
      ctx.moveTo(snap(x), iy + r)
      ctx.lineTo(snap(x), L.h)
      ctx.stroke()
      ctx.fillStyle = palette.signal
      ctx.beginPath()
      ctx.moveTo(x, iy - r)
      ctx.lineTo(x + r, iy)
      ctx.lineTo(x, iy + r)
      ctx.lineTo(x - r, iy)
      ctx.closePath()
      ctx.fill()
    }
  }, [L, sun, days, hours, lanes, report.geo.length, t0, t1, span, meta, compact, captureById])

  // ── pointer ──────────────────────────────────────────────────────────────────────
  const pick = (clientX: number, clientY: number, tolPx: number): { pass: Pass; x: number } | null => {
    const el = plotRef.current
    if (!el || !size.w) return null
    const r = el.getBoundingClientRect()
    const x = clientX - r.left
    const y = clientY - r.top
    const t = t0 + (x / size.w) * span
    const tol = (tolPx / size.w) * span
    let lane = L.laneOf(y)
    if (compact && lane === 'likely') lane = undefined // shared lane on phones: let order decide
    const p = hitTest(lanes, t, tol, lane)
    return p ? { pass: p, x: xOf(p.tClosest) } : null
  }
  const onMove = (e: React.PointerEvent) => {
    if (e.pointerType !== 'mouse') return
    const h = pick(e.clientX, e.clientY, 7)
    setHover((prev) => (prev?.pass.id === h?.pass.id ? prev : h))
    const st = useApp.getState()
    if (st.hoveredNorad !== h?.pass.norad) st.setHoveredNorad(h?.pass.norad)
  }
  const onLeave = () => {
    setHover(null)
    useApp.getState().setHoveredNorad(undefined)
  }
  const onClick = (e: React.MouseEvent) => {
    const h = pick(e.clientX, e.clientY, compact ? 14 : 8)
    if (h) onSelect(h.pass)
  }

  // ── overlay positions ────────────────────────────────────────────────────────────
  const selected = selectedId ? model.passById.get(selectedId) : undefined
  const showHead = head !== undefined && head >= t0 && head <= t1
  const pct = (t: number) => `${(((t - t0) / span) * 100).toFixed(3)}%`
  const nowish = Math.abs(Date.now() - t1) < 3_600_000
  const zoneA = zoneAbbr(t0, tz)
  const zoneB = zoneAbbr(t1, tz)
  const tzLabel = zoneA === zoneB ? zoneA : `${zoneA} → ${zoneB}`
  const geoNames = report.geo.slice(0, 3).map((g) => g.name)
  const daysN = Math.round(span / 86_400_000)

  const laneCount = (v: Verdict) => lanes[v].passes.length
  // The window's first (partial) day gets a label at the left edge too.
  const startDay = { t: t0, label: fmtLocalDay(t0, tz), day: Number(fmtLocalDay(t0, tz).split(' ')[1]), weekday: fmtLocalDay(t0, tz).slice(0, 3) }
  const axisDays = days.length && ((days[0].t - t0) / span) * size.w < 40 ? days : [startDay, ...days]
  const endLabel = nowish ? 'Now' : compact ? '' : `${fmtLocalTime(t1, tz)} ${zoneAbbr(t1, tz)}`
  const endRoom = endLabel ? endLabel.length * (compact ? 5.6 : 6.6) + 12 : 0

  return (
    <div
      className={cx(s.timeline, compact && s.compact, className)}
      role="group"
      aria-label={`Timeline: ${int(report.passes.length)} passes over ${daysN} days. Use the left and right arrow keys to step through passes.`}
    >
      {!compact ? (
        <div className={s.head}>
          <span className={s.title}>
            <span className={s.idx}>02</span>
            <span className={s.sep}>/</span>Timeline
            <span className={s.meta}>
              {daysN} days · {tz.replace(/_/g, ' ')} · {tzLabel}
            </span>
          </span>
          <span className={s.legend} aria-hidden>
            <span>
              <Glyph name="imaged" size={10} color="var(--signal)" /> Photographed
            </span>
            <span>
              <Glyph name="weather-leo" size={10} /> Weather
            </span>
            <span>
              <Glyph name="commercial" size={10} /> Commercial
            </span>
            <span>
              <Glyph name="radar" size={10} color="var(--ice)" /> Radar
            </span>
            <span>
              <Glyph name="crewed" size={10} /> Crewed
            </span>
            <span className={s.dayKey}>
              <i /> Daylight here
            </span>
          </span>
        </div>
      ) : null}

      <div className={s.body}>
        {!compact ? (
          <div className={s.lanes} aria-hidden>
            {L.geoH ? (
              <span className={s.laneLabel} style={{ top: 0, height: L.geoH }} title={geoNames.join(', ')}>
                <span className={s.geoLabel}>
                  <Glyph name="weather-geo" size={9} /> Geo · {report.geo.length}
                </span>
              </span>
            ) : null}
            {L.lanes.map((v) => (
              <span key={v} className={cx(s.laneLabel, laneCount(v) === 0 && s.laneEmpty)} style={{ top: L.laneY(v) - 8, height: 16 }}>
                <Glyph name={VERDICT_GLYPH[v]} size={10} color={v === 'imaged' ? 'var(--signal)' : undefined} />
                <span className={s.laneWord}>{LANE_WORD[v]}</span>
                <span className={cx(s.laneCount, v === 'imaged' && laneCount(v) > 0 && s.signal)}>{int(laneCount(v))}</span>
              </span>
            ))}
          </div>
        ) : null}

        <div className={s.plotWrap}>
          <div
            ref={plotRef}
            className={s.plot}
            onPointerMove={onMove}
            onPointerLeave={onLeave}
            onClick={onClick}
          >
            <canvas ref={canvasRef} className={s.canvas} aria-hidden />

            {selected ? (
              <div className={s.selLine} style={{ left: pct(selected.tClosest) }} aria-hidden>
                <span className={s.selGlyph} style={{ top: L.laneY(selected.verdict) }}>
                  <Glyph name={glyphForPass(selected.verdict, meta(selected.norad).category)} size={compact ? 10 : 12} color="var(--signal)" />
                </span>
              </div>
            ) : null}

            {hover && hover.pass.id !== selectedId ? (
              <div className={s.hoverLine} style={{ left: hover.x }} aria-hidden>
                <span className={s.hoverGlyph} style={{ top: L.laneY(hover.pass.verdict) }}>
                  <Glyph
                    name={glyphForPass(hover.pass.verdict, meta(hover.pass.norad).category)}
                    size={12}
                    color={hover.pass.verdict === 'imaged' ? 'var(--signal)' : 'var(--bone)'}
                  />
                </span>
              </div>
            ) : null}

            {showHead ? (
              <div className={s.playhead} style={{ left: pct(head) }} aria-hidden>
                <span className={s.playheadCap} />
              </div>
            ) : null}
          </div>

          {/* Day labels at local midnights */}
          <div className={s.axis} aria-hidden>
            {axisDays.map((d, i) => {
              const next = axisDays[i + 1]?.t ?? t1
              // A label must fit its own day and stay clear of the end label ("Now").
              const x = ((d.t - t0) / span) * size.w
              const limit = Math.min(((next - t0) / span) * size.w, size.w - endRoom)
              const charW = compact ? 5.6 : 6.6
              const label = compact ? `${d.weekday.slice(0, 2)} ${d.day}` : d.label
              const short = compact ? '' : String(d.day)
              const text = x + label.length * charW + 8 <= limit ? label : x + short.length * charW + 8 <= limit ? short : ''
              return (
                <span key={d.t} className={cx(s.day, d.t === t0 && s.dayStart)} style={{ left: pct(d.t) }}>
                  {text}
                </span>
              )
            })}
            {endLabel ? <span className={s.end}>{endLabel}</span> : null}
          </div>

          {hover ? <Tooltip pass={hover.pass} x={hover.x} w={size.w} model={model} /> : null}
        </div>
      </div>
    </div>
  )
}

function Tooltip({ pass, x, w, model }: { pass: Pass; x: number; w: number; model: ResultsModel }) {
  const m = model.meta(pass.norad)
  const capture = pass.captureId ? model.report.captures.find((c) => c.id === pass.captureId) : undefined
  const tag =
    pass.verdict === 'imaged'
      ? capture && isDailyMosaic(capture)
        ? `Daily mosaic, ${Math.round(capture.gsdM)} m`
        : 'Photographed'
      : pass.verdict === 'likely'
        ? 'Likely in view'
        : pass.verdict === 'could'
          ? 'Could have pointed here'
          : 'Overhead'
  // Keep the box inside the strip: anchor left/right near the edges.
  const anchor = x < 140 ? 'left' : x > w - 140 ? 'right' : 'center'
  return (
    <div className={cx(s.tip, s[`tip_${anchor}`])} style={{ left: x }} role="tooltip">
      <div className={s.tipName}>
        <Glyph name={glyphForPass(pass.verdict, m.category)} size={11} color={pass.verdict === 'imaged' ? 'var(--signal)' : undefined} />
        {m.name}
      </div>
      <div className={s.tipLine}>
        {fmtLocalDay(pass.tClosest, model.tz)} · {fmtLocalTime(pass.tClosest, model.tz, true)} {zoneAbbr(pass.tClosest, model.tz)}
      </div>
      <div className={s.tipLine}>
        {pass.offNadirDeg.toFixed(1)}° off-nadir · {int(pass.groundDistanceKm)} km
      </div>
      <div className={cx(s.tipLine, pass.verdict === 'imaged' && s.signal)}>{tag}</div>
    </div>
  )
}
