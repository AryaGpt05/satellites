import { forwardRef, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { useWallSecondSync } from './phase'
import s from './primitives.module.css'

const cx = (...c: (string | false | undefined | null)[]) => c.filter(Boolean).join(' ')

export function Label({ children, className, as: As = 'span' }: { children: ReactNode; className?: string; as?: 'span' | 'div' | 'h2' | 'h3' | 'dt' }) {
  return <As className={cx(s.label, className)}>{children}</As>
}

/** Label + value + unit, stacked. Values are mono + tabular. */
export function Readout({
  label,
  value,
  unit,
  size = 'md',
  className,
}: {
  label: ReactNode
  value: ReactNode
  unit?: ReactNode
  size?: 'md' | 'lg'
  className?: string
}) {
  return (
    <div className={cx(s.readout, size === 'lg' && s.readoutLg, className)}>
      <span className={s.label}>{label}</span>
      <span className={s.readoutValue}>
        {value ?? '—'}
        {unit ? <span className={s.readoutUnit}>{unit}</span> : null}
      </span>
    </div>
  )
}

/** Hairline section rule with a mono notch label: ── 02 / PASSES ────── */
export function Rule({ index, children, className }: { index?: string; children?: ReactNode; className?: string }) {
  return (
    <div className={cx(s.rule, s.label, className)} role="separator">
      {index ? <span className={s.ruleIndex}>{index}</span> : null}
      {index && children ? <span>/</span> : null}
      {children}
    </div>
  )
}

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost'
  size?: 'md' | 'sm'
}
export const Button = forwardRef<HTMLButtonElement, BtnProps>(function Button(
  { variant = 'secondary', size = 'md', className, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      className={cx(s.btn, variant === 'primary' && s.btnPrimary, variant === 'ghost' && s.btnGhost, size === 'sm' && s.btnSm, className)}
      {...rest}
    />
  )
})

export function Tag({ children, signal, className }: { children: ReactNode; signal?: boolean; className?: string }) {
  return <span className={cx(s.tag, signal && s.tagSignal, className)}>{children}</span>
}

/** 1Hz hard blink (no fade) — live indicator, phase-locked to the wall-clock second like the HUD clock */
export function LiveDot({ className }: { className?: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  useWallSecondSync(ref, false)
  return <span ref={ref} className={cx(s.live, className)} aria-hidden data-blink />
}

export { cx }
