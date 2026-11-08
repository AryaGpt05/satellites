/**
 * 03 / PASSES, grouped by verdict (see lib/groups.ts for the model). Photographs are individual rows
 * with a live thumbnail of the real crop; everything else is one row per satellite, expandable to its
 * passes. Long groups show their top rows, then page in 40 at a time.
 */
import { memo, useEffect, useRef, useState } from 'react'
import { useApp } from '@/state/store'
import type { Pass } from '@/types'
import { Glyph, Tag, cx } from '@/ui/system'
import { prefetchPassImage } from './actions'
import { captureFor, cropSpec, displayUrl, isDailyMosaic } from './lib/captures'
import { int } from './lib/copy'
import { visibleCount, type ListItem, type PassGroup, type PassItem, type SatItem } from './lib/groups'
import { glyphForPass, markColorVar, VERDICT_GLYPH, VERDICT_TAG, VERDICT_TITLE, type Verdict } from './lib/meta'
import { fmtLocalStamp, fmtRelative } from './lib/time'
import type { ResultsModel } from './model'
import s from './PassList.module.css'

interface Props {
  model: ResultsModel
  selectedId?: string
  now: number
  onSelect: (p: Pass) => void
}

export function PassList({ model, selectedId, now, onSelect }: Props) {
  if (!model.groups.length)
    return <p className={s.empty}>No satellite we track crossed this place in the window. That is rare; check the footnotes below.</p>
  return (
    <div className={s.list}>
      {model.groups.map((g) => (
        <Group key={g.verdict} group={g} model={model} selectedId={selectedId} now={now} onSelect={onSelect} />
      ))}
    </div>
  )
}

function Group({ group, model, selectedId, now, onSelect }: { group: PassGroup } & Props) {
  const [pages, setPages] = useState(0)
  const [open, setOpen] = useState<Set<string>>(() => new Set())
  const total = group.items.length
  const shown = visibleCount(total, group.verdict, pages)
  const rest = total - shown
  const sats = group.items.filter((i) => i.kind === 'sat').length
  const unit = sats === total ? (total === 1 ? 'satellite' : 'satellites') : 'rows'
  // Keep a selected pass visible: if it lives in a collapsed satellite, open that satellite.
  useEffect(() => {
    if (!selectedId) return
    const idx = group.items.findIndex((i) => (i.kind === 'sat' ? i.passes.some((p) => p.id === selectedId) : i.pass.id === selectedId))
    if (idx < 0) return
    const item = group.items[idx]
    if (item.kind === 'sat') setOpen((o) => (o.has(item.key) ? o : new Set(o).add(item.key)))
    // Page far enough that the row is rendered.
    setPages((pg) => {
      let n = pg
      while (visibleCount(total, group.verdict, n) <= idx) n++
      return n
    })
    // Only when the selection changes, so the user can still collapse it afterwards.
  }, [selectedId, group.items])

  const toggle = (key: string) =>
    setOpen((o) => {
      const n = new Set(o)
      if (n.has(key)) n.delete(key)
      else n.add(key)
      return n
    })

  return (
    <section className={s.group} id={`passes-${group.verdict}`} aria-label={VERDICT_TITLE[group.verdict]}>
      <header className={s.groupHead}>
        <span className={cx(s.groupTitle, group.verdict === 'imaged' && s.signal)}>
          <Glyph name={VERDICT_GLYPH[group.verdict]} size={12} color={group.verdict === 'imaged' ? 'var(--signal)' : undefined} />
          {VERDICT_TITLE[group.verdict]}
        </span>
        <span className={s.groupCount}>
          {int(group.passCount)} {group.verdict === 'imaged' ? (group.passCount === 1 ? 'image' : 'images') : group.passCount === 1 ? 'pass' : 'passes'}
          <span className={s.dim}> · {int(group.satCount)} {group.satCount === 1 ? 'sat' : 'sats'}</span>
        </span>
      </header>
      <ul className={s.rows}>
        {group.items.slice(0, shown).map((item) => (
          <li key={item.key}>
            {item.kind === 'pass' ? (
              <PassRow item={item} model={model} selected={item.pass.id === selectedId} now={now} onSelect={onSelect} />
            ) : (
              <SatRow
                item={item}
                verdict={group.verdict}
                model={model}
                expanded={open.has(item.key)}
                onToggle={() => toggle(item.key)}
                selectedId={selectedId}
                now={now}
                onSelect={onSelect}
              />
            )}
          </li>
        ))}
      </ul>
      {rest > 0 || pages > 0 ? (
        <div className={s.more}>
          {rest > 0 ? (
            <button type="button" className={s.moreBtn} onClick={() => setPages((p) => p + 1)}>
              {pages === 0 ? `Show all ${int(total)} ${unit}` : `Show ${int(Math.min(rest, 40))} more`}
              <span className={s.dim}>{pages === 0 ? '' : ` · ${int(rest)} left`}</span>
              <Glyph name="arrow-right" size={11} className={s.down} />
            </button>
          ) : null}
          {pages > 0 ? (
            <button type="button" className={s.moreBtn} onClick={() => setPages(0)}>
              Show fewer
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

const hover = (p: Pass | undefined) => useApp.getState().setHoveredNorad(p?.norad)

const PassRow = memo(function PassRow({
  item,
  model,
  selected,
  now,
  onSelect,
}: {
  item: PassItem
  model: ResultsModel
  selected: boolean
  now: number
  onSelect: (p: Pass) => void
}) {
  const { pass: p, meta } = item
  const capture = captureFor(model.report, p)
  const imaged = p.verdict === 'imaged'
  return (
    <button
      type="button"
      className={cx(s.row, selected && s.selected)}
      aria-current={selected || undefined}
      data-pass-row
      onClick={() => onSelect(p)}
      onPointerEnter={() => {
        hover(p)
        prefetchPassImage(model.report, p)
      }}
      onPointerLeave={() => hover(undefined)}
      onFocus={() => prefetchPassImage(model.report, p)}
    >
      <span className={s.glyph}>
        <Glyph name={glyphForPass(p.verdict, meta.category)} size={14} color={markColorVar(p.verdict, meta.category)} />
      </span>
      <span className={s.main}>
        <span className={s.nameLine}>
          <span className={s.name}>{meta.name}</span>
          <Tag signal={imaged} className={s.tag}>
            {imaged && capture && isDailyMosaic(capture) ? 'Mosaic' : VERDICT_TAG[p.verdict]}
          </Tag>
        </span>
        <span className={s.metaLine}>
          {fmtLocalStamp(p.tClosest, model.tz)}
          <span className={s.dim}> · {fmtRelative(p.tClosest, now)}</span>
        </span>
        <span className={s.metaLine}>
          {p.offNadirDeg.toFixed(1)}° off-nadir · {int(p.groundDistanceKm)} km
          {capture?.cloudCoverPct !== undefined ? <span className={s.dim}> · cloud {int(capture.cloudCoverPct)}%</span> : null}
        </span>
      </span>
      {capture && !isDailyMosaic(capture) ? <Thumb url={displayUrl(capture, { ...cropSpec(capture.collection), px: 112 })} /> : null}
    </button>
  )
})

const SatRow = memo(function SatRow({
  item,
  verdict,
  model,
  expanded,
  onToggle,
  selectedId,
  now,
  onSelect,
}: {
  item: SatItem
  verdict: Verdict
  model: ResultsModel
  expanded: boolean
  onToggle: () => void
  selectedId?: string
  now: number
  onSelect: (p: Pass) => void
}) {
  const { meta, passes, latest, closest } = item
  const containsSelected = !!selectedId && passes.some((p) => p.id === selectedId)
  const listId = `sat-${item.key.replace(/[^a-z0-9-]/gi, '')}`
  return (
    <>
      <button
        type="button"
        className={cx(s.row, s.satRow, containsSelected && !expanded && s.selected)}
        aria-expanded={expanded}
        aria-controls={listId}
        onClick={onToggle}
        onPointerEnter={() => hover(latest)}
        onPointerLeave={() => hover(undefined)}
      >
        <span className={s.glyph}>
          <Glyph name={glyphForPass(verdict, meta.category)} size={14} color={markColorVar(verdict, meta.category)} />
        </span>
        <span className={s.main}>
          <span className={s.nameLine}>
            <span className={s.name}>{meta.name}</span>
            {meta.operator ? <span className={s.operator}>{meta.operator}</span> : null}
          </span>
          <span className={s.metaLine}>
            Latest {fmtLocalStamp(latest.tClosest, model.tz)}
            <span className={s.dim}> · {fmtRelative(latest.tClosest, now)}</span>
          </span>
          <span className={s.metaLine}>
            Closest {closest.offNadirDeg.toFixed(1)}° off-nadir · {int(closest.groundDistanceKm)} km
          </span>
        </span>
        <span className={s.count}>
          <span className={s.countNum}>{int(passes.length)}</span>
          <span className={s.countUnit}>{verdict === 'imaged' ? (passes.length === 1 ? 'image' : 'images') : passes.length === 1 ? 'pass' : 'passes'}</span>
        </span>
        <span className={cx(s.chev, expanded && s.chevOpen)} aria-hidden>
          <Glyph name="arrow-right" size={11} />
        </span>
      </button>
      {expanded ? (
        <ul className={s.sub} id={listId}>
          {passes.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                className={cx(s.subRow, p.id === selectedId && s.selected)}
                aria-current={p.id === selectedId || undefined}
                data-pass-row
                onClick={() => onSelect(p)}
                onPointerEnter={() => {
                  hover(p)
                  prefetchPassImage(model.report, p)
                }}
                onPointerLeave={() => hover(undefined)}
              >
                <span>
                  {fmtLocalStamp(p.tClosest, model.tz)}
                  <span className={s.dim}> · {fmtRelative(p.tClosest, now)}</span>
                </span>
                <span className={s.subGeo}>
                  {p.offNadirDeg.toFixed(1)}° · {int(p.groundDistanceKm)} km
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  )
})

/** Lazy thumbnail of the real crop (loads when scrolled near). */
function Thumb({ url }: { url: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [visible, setVisible] = useState(false)
  const [state, setState] = useState<'idle' | 'ok' | 'err'>('idle')
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (typeof IntersectionObserver === 'undefined') return setVisible(true)
    const io = new IntersectionObserver((e) => e.some((x) => x.isIntersecting) && setVisible(true), { rootMargin: '200px' })
    io.observe(el)
    return () => io.disconnect()
  }, [])
  return (
    <span ref={ref} className={cx(s.thumb, state === 'ok' && s.thumbOk)} aria-hidden>
      {visible && state !== 'err' ? (
        <img src={url} alt="" crossOrigin="anonymous" decoding="async" onLoad={() => setState('ok')} onError={() => setState('err')} />
      ) : null}
      <span className={s.thumbMark} />
    </span>
  )
}

export type { ListItem }
