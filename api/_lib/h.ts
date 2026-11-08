/**
 * A tiny element factory for satori.
 *
 * satori consumes React-element-shaped objects ({ type, props, key }); it never needs React's
 * runtime. Building them directly keeps the function bundle small and lets api/ compile without a
 * JSX setting in tsconfig.node.json (which `tsc -b` uses in the Vercel build).
 */
import type { CSSProperties, ReactElement } from 'react'

export type Child = ReactElement | string | number | null | undefined | false
export type Props = Record<string, unknown> & { style?: CSSProperties }

export function h(type: string, props: Props | null, ...children: (Child | Child[])[]): ReactElement {
  const flat = children.flat().filter((c): c is ReactElement | string | number => c !== null && c !== undefined && c !== false)
  const p: Record<string, unknown> = { ...(props ?? {}) }
  if (flat.length === 1) p.children = flat[0]
  else if (flat.length > 1) p.children = flat
  return { type, props: p, key: null } as ReactElement
}

/** `display: flex` box: satori requires it on any element with more than one child. */
export function box(style: CSSProperties, ...children: (Child | Child[])[]): ReactElement {
  return h('div', { style: { display: 'flex', ...style } }, ...children)
}
