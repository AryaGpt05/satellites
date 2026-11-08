/**
 * DOM preview of the 1200×630 share card (the same layout the PNG renderer and the server OG card draw).
 * Laid out at its native size and scaled to fit its container, so type and spacing are exact.
 */
import { useLayoutEffect, useRef, useState } from 'react'
import type { Pass } from '@/types'
import { Glyph, cx } from '@/ui/system'
import { PassPlan } from '../results/PassPlan'
import type { SatMeta } from '../results/lib/meta'
import { CARD_H, CARD_W, headlineSize, type CardSpec } from './card'
import { roundedPlace } from './links'
import s from './ShareCard.module.css'

export function ShareCard({ spec, pass, meta, lat, lon }: { spec: CardSpec; pass: Pass; meta: SatMeta; lat: number; lon: number }) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [k, setK] = useState(0.5)
  const [img, setImg] = useState<'loading' | 'ok' | 'err'>('loading')
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
  const r = roundedPlace(lat, lon)
  const size = headlineSize(spec.lead)

  return (
    <div ref={wrapRef} className={s.wrap} style={{ height: CARD_H * k }}>
      <div className={s.card} style={{ width: CARD_W, height: CARD_H, transform: `scale(${k})` }} aria-hidden>
        <div className={s.left}>
          {spec.imageUrl ? (
            <>
              {img !== 'ok' ? <span className={s.acq}>{img === 'err' ? 'Image unavailable' : 'Acquiring…'}</span> : null}
              <img
                src={spec.imageUrl}
                alt=""
                crossOrigin="anonymous"
                className={cx(s.img, img === 'ok' && s.imgOn)}
                onLoad={() => setImg('ok')}
                onError={() => setImg('err')}
              />
            </>
          ) : (
            <PassPlan pass={pass} meta={meta} lat={r.lat} lon={r.lon} live={false} labels={false} className={s.plan} />
          )}
          <svg className={s.reticle} viewBox="-50 -50 100 100">
            <circle r="22" />
            <path d="M0 -46V-30M0 30V46M-46 0H-30M30 0H46" />
            <rect x="-2" y="-2" width="4" height="4" className={s.reticleDot} />
          </svg>
          {spec.imageLabel ? <span className={s.chip}>{spec.imageLabel}</span> : null}
        </div>
        <div className={s.right}>
          <div className={s.brand}>
            <span className={s.word}>Overflight</span>
            <span className={s.tagline}>What photographed you this week</span>
            {spec.verdict === 'imaged' ? <Glyph name="imaged" size={18} color="var(--signal)" className={s.mark} /> : null}
          </div>
          <h3 className={s.headline} style={{ fontSize: size }}>
            {spec.lead}
            <br />
            <span className={s.place}>{spec.place}.</span>
          </h3>
          <div className={s.when}>
            {spec.date} · {spec.time}
          </div>
          <div className={s.readouts}>
            {spec.readouts.map((ro) => (
              <div key={ro.label} className={s.readout}>
                <span className={s.roLabel}>{ro.label}</span>
                <span className={s.roValue}>
                  {ro.value}
                  {ro.unit ? <span className={s.roUnit}>{ro.unit}</span> : null}
                </span>
              </div>
            ))}
          </div>
          <div className={s.foot}>
            <span>{spec.coords}</span>
            <span>{spec.host}</span>
          </div>
        </div>
      </div>
    </div>
  )
}
