import { cx } from './primitives'
import s from './Bezel.module.css'

/**
 * The viewport frame (DESIGN §4). Fixed, inset by `--bezel-inset`, never interactive.
 * Mount it once, above the scene and below panels (the HUD does this).
 */
export function Bezel({ className, ruler = true }: { className?: string; ruler?: boolean }) {
  return (
    <div className={cx(s.bezel, className)} aria-hidden>
      {ruler ? (
        <>
          <span className={cx(s.ruler, s.rulerL)} />
          <span className={cx(s.ruler, s.rulerR)} />
        </>
      ) : null}
      <span className={cx(s.corner, s.tl)} />
      <span className={cx(s.corner, s.tr)} />
      <span className={cx(s.corner, s.bl)} />
      <span className={cx(s.corner, s.br)} />
    </div>
  )
}
