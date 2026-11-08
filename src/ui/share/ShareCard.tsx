/**
 * DOM preview of the 1200×630 share card: the same spec, positions and type the PNG renderer
 * (./card.ts) and the server's Open Graph card (api/_lib/card.ts) draw. Laid out at its native size
 * and scaled to fit its container, so type and spacing are exact.
 */
import { useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { cx, Wordmark } from '@/ui/system'
import {
  CARD_COLOR,
  CARD_FS,
  HEAD,
  PANEL,
  TONE_COLOR,
  hatchPath,
  plateOrFallback,
  verdictGlyphPrims,
  type Chip,
  type Plate,
  type Prim,
  type ScaleBar,
} from '../../../api/_lib/cardSpec'
import { CARD_H, CARD_W, PLATE, type CardSpec } from './card'
import s from './ShareCard.module.css'

export function ShareCard({ spec }: { spec: CardSpec }) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [k, setK] = useState(0.5)
  const url = spec.plate.kind === 'image' ? spec.plate.imageUrl : undefined
  const [img, setImg] = useState<{ url?: string; state: 'loading' | 'ok' | 'err' }>({ url, state: 'loading' })
  if (img.url !== url) setImg({ url, state: 'loading' })
  useLayoutEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const measure = () => setK(el.clientWidth / CARD_W)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const S = spec.size
  const P = S * HEAD.placeScale
  const colW = PANEL.w / spec.readouts.length

  return (
    <div ref={wrapRef} className={s.wrap} style={{ height: CARD_H * k }}>
      <div className={s.card} style={{ width: CARD_W, height: CARD_H, transform: `scale(${k})` }} aria-hidden>
        <PlateView plate={spec.plate} img={url ? img.state : 'err'} onImg={(state) => setImg({ url, state })} />
        <div className={s.divider} style={{ left: PLATE }} />

        <Row box={PANEL.top}>
          <Wordmark height={20} className={s.lockupMark} />
          {spec.stamp ? <span className={s.row} style={{ color: CARD_COLOR.bone2 }}>{spec.stamp}</span> : null}
        </Row>
        <Hair y={PANEL.rule1} />
        <Row box={PANEL.verdict}>
          <span className={s.verdict}>
            <Svg size={14} prims={verdictGlyphPrims(spec.verdict)} />
            <span className={s.row} style={{ color: TONE_COLOR[spec.verdictTone] }}>
              {spec.verdictLabel}
            </span>
          </span>
          <span className={s.row} style={{ color: CARD_COLOR.bone3 }}>
            {spec.coords}
          </span>
        </Row>

        <div className={s.head} style={{ left: PANEL.x, top: PANEL.headTop, width: PANEL.w, height: PANEL.headBottom - PANEL.headTop }}>
          <div className={s.lead} style={{ fontSize: S, lineHeight: HEAD.leadLH, letterSpacing: -0.02 * S }}>
            {spec.lead}
          </div>
          <div className={s.place} style={{ fontSize: P, lineHeight: HEAD.placeLH, marginTop: P * HEAD.placeGap, letterSpacing: -0.01 * P }}>
            {spec.place}
            {spec.tail}
          </div>
          {spec.sub ? (
            <div className={s.sub} style={{ fontSize: CARD_FS.sub, lineHeight: HEAD.subLH, marginTop: HEAD.subGap }}>
              {spec.sub}
            </div>
          ) : null}
        </div>

        <Hair y={PANEL.rule2} />
        {spec.readouts.map((r, i) => (
          <div key={r.label}>
            {i ? <div className={s.vrule} style={{ left: PANEL.x + i * colW, top: PANEL.roLabel[0], height: PANEL.roValue[0] + PANEL.roValue[1] - PANEL.roLabel[0] }} /> : null}
            <div className={cx(s.cell, s.row)} style={{ left: PANEL.x + i * colW + (i ? 22 : 0), top: PANEL.roLabel[0], height: PANEL.roLabel[1], color: CARD_COLOR.bone3 }}>
              {r.label}
            </div>
            <div className={s.value} style={{ left: PANEL.x + i * colW + (i ? 22 : 0), top: PANEL.roValue[0], height: PANEL.roValue[1] }}>
              <span className={s.valueNum} style={spec.readoutSize ? { fontSize: spec.readoutSize } : undefined}>
                {r.value}
              </span>
              {r.unit ? <span className={s.unit}>{r.unit}</span> : null}
            </div>
          </div>
        ))}

        <Hair y={PANEL.rule3} />
        <Row box={PANEL.foot}>
          <span className={s.row} style={{ color: CARD_COLOR.bone2 }}>
            {spec.footLeft}
          </span>
          {spec.host ? <span className={s.host}>{spec.host}</span> : null}
        </Row>
      </div>
    </div>
  )
}

function Row({ box, children }: { box: readonly [number, number]; children: React.ReactNode }) {
  return (
    <div className={s.rowBox} style={{ left: PANEL.x, top: box[0], width: PANEL.w, height: box[1] }}>
      {children}
    </div>
  )
}

const Hair = ({ y }: { y: number }) => <div className={s.hair} style={{ left: PANEL.x, top: y, width: PANEL.w }} />

function PlateView({ plate, img, onImg }: { plate: Plate; img: 'loading' | 'ok' | 'err'; onImg: (s: 'ok' | 'err') => void }) {
  // The image failed: draw what the PNG and the OG card draw in that case (the pass geometry).
  const shown = plateOrFallback(plate, img !== 'err')
  if (shown.kind === 'plan') {
    return (
      <div className={s.plate}>
        <Svg size={PLATE} prims={shown.prims} />
        {shown.chips.map((c, i) => (
          <ChipView key={i} chip={c} />
        ))}
        <Scale bar={shown.scale} />
      </div>
    )
  }
  return (
    <div className={s.plate}>
      {img !== 'ok' ? <span className={s.acq}>Acquiring…</span> : null}
      <img src={shown.imageUrl} alt="" crossOrigin="anonymous" className={cx(s.img, img === 'ok' && s.imgOn)} onLoad={() => onImg('ok')} onError={() => onImg('err')} />
      {shown.clouded ? (
        <>
          <div className={s.veil} />
          <Svg size={PLATE} prims={[{ t: 'path', d: hatchPath(PLATE), stroke: CARD_COLOR.hatch, width: 1 }]} />
        </>
      ) : null}
      <Svg size={PLATE} prims={shown.overlay} />
      <ChipView chip={shown.chip} />
      <Scale bar={shown.scale} />
      {shown.clouded ? <ChipView chip={shown.clouded} /> : null}
      <ChipView chip={shown.credit} />
    </div>
  )
}

function ChipView({ chip }: { chip: Chip }) {
  return (
    <span className={s.chip} style={{ ...chip.pos, fontSize: chip.size } as CSSProperties}>
      {chip.segs.map((seg, i) => (
        <span key={i} style={{ color: TONE_COLOR[seg.tone] }}>
          {seg.text}
        </span>
      ))}
    </span>
  )
}

function Scale({ bar }: { bar: ScaleBar }) {
  if (bar.px <= 0) return null
  return (
    <span className={s.chip} style={{ right: 24, top: 24, fontSize: CARD_FS.chip }}>
      <span className={s.bar} style={{ width: bar.px }} />
      <span>{bar.label}</span>
    </span>
  )
}

/** The shared vector primitives as inline SVG (ids are unique per instance for the gradients). */
function Svg({ size, prims }: { size: number; prims: Prim[] }) {
  const uid = useId().replace(/:/g, '')
  return (
    <svg className={size === PLATE ? s.svg : undefined} width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <defs>
        {prims.map((p, i) =>
          p.t === 'path' && p.grad ? (
            <linearGradient key={i} id={`${uid}g${i}`} gradientUnits="userSpaceOnUse" x1={p.grad.x1} y1={p.grad.y1} x2={p.grad.x2} y2={p.grad.y2}>
              <stop offset="0" stopColor={p.grad.from} />
              <stop offset="1" stopColor={p.grad.to} />
            </linearGradient>
          ) : null,
        )}
      </defs>
      {prims.map((p, i) =>
        p.t === 'circle' ? (
          <circle key={i} cx={p.cx} cy={p.cy} r={p.r} fill={p.fill ?? 'none'} stroke={p.stroke} strokeWidth={p.width} />
        ) : (
          <path
            key={i}
            d={p.d}
            fill={p.fill ?? 'none'}
            stroke={p.grad ? `url(#${uid}g${i})` : p.stroke}
            strokeWidth={p.width}
            strokeDasharray={p.dash?.join(' ')}
          />
        ),
      )}
    </svg>
  )
}
