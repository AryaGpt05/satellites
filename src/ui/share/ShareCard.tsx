/**
 * DOM preview of the 1200×630 share card: the same spec, positions and type the PNG renderer
 * (./card.ts) and the server's Open Graph card (api/_lib/card.ts) draw. Laid out at its native size
 * and scaled to fit its container, so type and spacing are exact.
 *
 * The plate (share R2SH1): when the spec carries a `source` (the pass view's crop, already decoded),
 * the preview shows that very picture, positioned so the plate's overflow clips it to the card's square
 * around the rounded share point: opaque from the first frame, no "Acquiring" wait. Otherwise (the
 * picture isn't in memory yet: a summary's best look, a recipient's first look) the pass geometry shows
 * while the picture loads, then the picture fades in over it.
 */
import { useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { isImageCached } from '@/imagery'
import { cx } from '@/ui/system'
import {
  CARD_COLOR,
  CARD_FS,
  HEAD,
  PANEL,
  TONE_COLOR,
  hatchPath,
  verdictGlyphPrims,
  type Chip,
  type ImagePlate,
  type PlanPlate,
  type Prim,
  type ScaleBar,
} from '../../../api/_lib/cardSpec'
import { CARD_H, CARD_W, PLATE, type CardSpec } from './card'
import s from './ShareCard.module.css'

export function ShareCard({ spec }: { spec: CardSpec }) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [k, setK] = useState(0.5)
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
        {spec.plate.kind === 'image' ? <ImagePlateView plate={spec.plate} /> : <PlanView plan={spec.plate} />}
        <div className={s.divider} style={{ left: PLATE }} />

        <Row box={PANEL.top}>
          <span className={s.lockup}>Overflight</span>
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

function PlanView({ plan, loading, leaving }: { plan: PlanPlate; loading?: boolean; leaving?: boolean }) {
  // While the picture loads, its geometry plate stands in, with the note chip saying so. Once the picture
  // starts to fade in over it (`leaving`), the stand-in's chips step out quickly, so the two layers' chips
  // (which share corners) never read doubled mid-fade.
  const chips = loading ? plan.chips.map((c, i) => (i === plan.chips.length - 1 ? { ...c, segs: [{ text: 'Acquiring…', tone: 'bone2' as const }] } : c)) : plan.chips
  return (
    <div className={s.plate}>
      <Svg size={PLATE} prims={plan.prims} />
      <div className={cx(s.labels, leaving && s.labelsOut)}>
        {chips.map((c, i) => (
          <ChipView key={i} chip={c} />
        ))}
        <Scale bar={plan.scale} />
      </div>
    </div>
  )
}

type ImgState = 'loading' | 'ok' | 'err'

/** The picture plate: the decoded pass-view crop cut to the card's square, or the card's own crop. */
function ImagePlateView({ plate }: { plate: ImagePlate }) {
  // Candidates in order: the pass view's picture (a cache hit, normally), then the card's own crop.
  const urls = [plate.source?.url, plate.imageUrl].filter((u, i, a): u is string => !!u && a.indexOf(u) === i)
  const key = urls.join('|')
  const initial = (): { key: string; at: number; state: ImgState; instant: boolean; settled: boolean } => {
    const cached = !!urls[0] && isImageCached(urls[0])
    return { key, at: 0, state: urls.length ? (cached ? 'ok' : 'loading') : 'err', instant: cached, settled: cached }
  }
  const [img, setImg] = useState(initial)
  if (img.key !== key) setImg(initial())
  const imgRef = useRef<HTMLImageElement>(null)
  const url = urls[img.at]
  const rect = plate.source && url === plate.source.url ? plate.source : undefined

  // "Cached" can also mean still in flight (the pass view asked for it a moment ago): if the element
  // isn't decoded yet, show the geometry until it is, then fade the picture in.
  useLayoutEffect(() => {
    const el = imgRef.current
    if (img.state === 'ok' && img.instant && el && !(el.complete && el.naturalWidth > 0)) setImg((v) => (v.key === key ? { ...v, state: 'loading', instant: false, settled: false } : v))
  }, [key, img.state, img.instant])

  const onLoad = () => setImg((v) => (v.key === key ? { ...v, state: 'ok' } : v))
  const onError = () => setImg((v) => (v.key !== key ? v : v.at + 1 < urls.length ? { ...v, at: v.at + 1, state: 'loading', instant: false } : { ...v, state: 'err' }))
  // The stand-in goes once the picture has faded in over it.
  const onFaded = (e: React.TransitionEvent) => {
    if (e.target === e.currentTarget && e.propertyName === 'opacity') setImg((v) => (v.key === key && v.state === 'ok' ? { ...v, settled: true } : v))
  }

  // Nothing could be fetched: draw what the PNG and the OG card draw in that case (the pass geometry).
  if (img.state === 'err' || !url) return <PlanView plan={plate.fallback} />

  const style: CSSProperties | undefined = rect
    ? {
        left: (-rect.sx * PLATE) / rect.sw,
        top: (-rect.sy * PLATE) / rect.sh,
        width: (rect.px * PLATE) / rect.sw,
        height: (rect.px * PLATE) / rect.sh,
      }
    : undefined
  return (
    <div className={s.plate}>
      {img.settled ? null : <PlanView plan={plate.fallback} loading leaving={img.state === 'ok'} />}
      <div className={cx(s.picture, img.state === 'ok' && (img.instant ? s.pictureNow : s.pictureOn))} onTransitionEnd={onFaded}>
        <img
          ref={imgRef}
          key={url}
          crossOrigin="anonymous"
          decoding={img.instant ? 'sync' : 'async'}
          src={url}
          alt=""
          className={rect ? s.cut : s.img}
          style={style}
          onLoad={onLoad}
          onError={onError}
        />
        {plate.clouded ? (
          <>
            <div className={s.veil} />
            <Svg size={PLATE} prims={[{ t: 'path', d: hatchPath(PLATE), stroke: CARD_COLOR.hatch, width: 1 }]} />
          </>
        ) : null}
        <Svg size={PLATE} prims={plate.overlay} />
        <ChipView chip={plate.chip} />
        <Scale bar={plate.scale} />
        {plate.clouded ? <ChipView chip={plate.clouded} /> : null}
        <ChipView chip={plate.credit} />
      </div>
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
