import type { ReactNode } from 'react'
import { cx } from './primitives'
import s from './Kbd.module.css'

/** A key cap: mono, hairline box. `<Kbd>/</Kbd>`, `<Kbd>Esc</Kbd>`. */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return <kbd className={cx(s.kbd, className)}>{children}</kbd>
}
