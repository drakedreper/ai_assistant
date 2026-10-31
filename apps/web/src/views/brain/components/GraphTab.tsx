import type { Note } from '@ai-assistant/shared'
import { ArrowUpRight, Maximize2, Network, ZoomIn, ZoomOut } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, IconButton, Panel } from '../../../components/ui'
import { cn } from '../../../lib/cn'
import { fitToBox, layoutGraph } from '../lib/graphLayout'
import { LAYERS, LAYER_ORDER, layerKeyOf, tint, type LayerKey } from '../lib/layers'
import type { VaultIndex } from '../lib/vault'
import { useBrain } from '../ui'
import { ImportanceDots, LayerBadge, LayerDot } from './atoms'

const radiusOf = (n: Note) => 5 + n.importance * 2.2

function shortLabel(title: string): string {
  let t = title.replace(/^(Project|Decision|Idea|Reflection|Clip):\s+/, '')
  if (t.includes(':')) t = t.split(':')[0] ?? t
  return t.length > 26 ? `${t.slice(0, 25)}…` : t
}

interface View {
  x: number
  y: number
  k: number
}

const MIN_K = 0.55
const MAX_K = 4

export function GraphTab({ index }: { index: VaultIndex }) {
  const hidden = useBrain((s) => s.hiddenLayers)
  const toggleLayer = useBrain((s) => s.toggleLayer)
  const sel = useBrain((s) => s.graphSel)
  const select = useBrain((s) => s.selectGraph)
  const open = useBrain((s) => s.open)
  const setTab = useBrain((s) => s.setTab)

  const wrapRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const [size, setSize] = useState({ w: 860, h: 560 })
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 })
  const [hover, setHover] = useState<string | null>(null)
  const drag = useRef<{ sx: number; sy: number; vx: number; vy: number; moved: boolean } | null>(null)

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect()
      if (r.width > 40 && r.height > 40) setSize((s) => (Math.abs(s.w - r.width) < 1 && Math.abs(s.h - r.height) < 1 ? s : { w: Math.round(r.width), h: Math.round(r.height) }))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Layout is computed once for the whole vault, so toggling a layer never moves the picture.
  const raw = useMemo(
    () => layoutGraph(index.notes.map((n) => ({ id: n.path, group: layerKeyOf(n), r: radiusOf(n) })), index.edges),
    [index],
  )
  const placed = useMemo(() => fitToBox(raw, size.w, size.h, 64), [raw, size])

  const neighbours = useMemo(() => {
    const m = new Map<string, Set<string>>()
    for (const [a, b] of index.edges) {
      if (!m.has(a)) m.set(a, new Set())
      if (!m.has(b)) m.set(b, new Set())
      m.get(a)?.add(b)
      m.get(b)?.add(a)
    }
    return m
  }, [index])

  const hiddenSet = useMemo(() => new Set<LayerKey>(hidden), [hidden])
  const visibleNotes = useMemo(() => index.notes.filter((n) => !hiddenSet.has(layerKeyOf(n))), [index, hiddenSet])
  const visiblePaths = useMemo(() => new Set(visibleNotes.map((n) => n.path)), [visibleNotes])
  const visibleEdges = useMemo(() => index.edges.filter(([a, b]) => visiblePaths.has(a) && visiblePaths.has(b)), [index, visiblePaths])

  const active = hover ?? (sel && visiblePaths.has(sel) ? sel : null)
  const hl = useMemo(() => {
    if (!active) return null
    return new Set<string>([active, ...(neighbours.get(active) ?? [])])
  }, [active, neighbours])

  const layerCounts = useMemo(() => {
    const c = new Map<LayerKey, number>()
    for (const n of index.notes) c.set(layerKeyOf(n), (c.get(layerKeyOf(n)) ?? 0) + 1)
    return c
  }, [index])

  const topHubs = useMemo(
    () => [...index.notes].sort((a, b) => (index.degree.get(b.path) ?? 0) - (index.degree.get(a.path) ?? 0) || b.importance - a.importance).slice(0, 6),
    [index],
  )
  const orphans = useMemo(() => index.notes.filter((n) => (index.degree.get(n.path) ?? 0) === 0), [index])
  const selNote = sel ? index.byPath.get(sel) : undefined
  const cross = useMemo(() => {
    const m = new Map<string, number>()
    for (const [a, b] of index.edges) {
      const na = index.byPath.get(a)
      const nb = index.byPath.get(b)
      if (!na || !nb) continue
      const la = layerKeyOf(na)
      const lb = layerKeyOf(nb)
      if (la === lb) continue
      const key = `${la}>${lb}`
      m.set(key, (m.get(key) ?? 0) + 1)
    }
    return [...m.entries()]
      .map(([k, n]) => ({ from: (k.split('>')[0] ?? 'core') as LayerKey, to: (k.split('>')[1] ?? 'core') as LayerKey, n }))
      .sort((x, y) => y.n - x.n)
      .slice(0, 6)
  }, [index])

  // ---- zoom and pan
  const zoomAt = useCallback((cx: number, cy: number, factor: number) => {
    setView((v) => {
      const k = Math.min(MAX_K, Math.max(MIN_K, v.k * factor))
      const r = k / v.k
      return { k, x: cx - (cx - v.x) * r, y: cy - (cy - v.y) * r }
    })
  }, [])

  useEffect(() => {
    const el = svgRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0016))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoomAt])

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if ((e.target as Element).closest('[data-node]')) return
    drag.current = { sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y, moved: false }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const d = drag.current
    if (!d) return
    const dx = e.clientX - d.sx
    const dy = e.clientY - d.sy
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true
    if (d.moved) setView((v) => ({ ...v, x: d.vx + dx, y: d.vy + dy }))
  }
  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    const d = drag.current
    drag.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    if (d && !d.moved) select(null)
  }

  const openNote = (path: string) => {
    open(path)
    setTab('notes')
  }

  // Stable paint order (important notes on top). It must not change on hover: moving DOM nodes under the pointer
  // would swallow the click.
  const drawOrder = useMemo(() => [...visibleNotes].sort((x, y) => x.importance - y.importance || x.path.localeCompare(y.path)), [visibleNotes])

  const summary = `${visibleNotes.length} of ${index.notes.length} notes, ${visibleEdges.length} links. Most connected: ${topHubs
    .slice(0, 3)
    .map((n) => n.title)
    .join(', ')}.`

  return (
    <div className="grid min-h-full gap-3 @4xl:h-full @4xl:grid-cols-[minmax(0,1fr)_290px]">
      <section aria-label="Vault graph" className="glass flex min-h-[460px] min-w-0 flex-col @4xl:min-h-0">
        <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-3 py-2">
          {LAYER_ORDER.map((lk) => {
            const m = LAYERS[lk]
            const on = !hiddenSet.has(lk)
            return (
              <button
                key={lk}
                type="button"
                aria-pressed={on}
                onClick={() => toggleLayer(lk)}
                title={`${on ? 'Hide' : 'Show'} ${m.folder}`}
                className={cn(
                  'inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] leading-4 font-medium transition',
                  on ? 'text-fg' : 'border-line text-faint line-through decoration-faint/70',
                )}
                style={on ? { borderColor: tint(m.hex, 0.45), background: tint(m.hex, 0.12), borderStyle: lk === 'federated' ? 'dashed' : 'solid' } : undefined}
              >
                <span
                  aria-hidden
                  className="inline-block size-2 rounded-full"
                  style={on ? { background: m.hex, boxShadow: lk === 'federated' ? `0 0 0 2px #11142a, 0 0 0 3px ${m.hex}` : undefined } : { background: 'transparent', border: `1px solid ${m.hex}` }}
                />
                {m.label}
                <span className="text-faint tabular-nums">{layerCounts.get(lk) ?? 0}</span>
              </button>
            )
          })}
          <div className="ml-auto flex items-center gap-0.5">
            <IconButton aria-label="Zoom out" title="Zoom out" className="size-7" onClick={() => zoomAt(size.w / 2, size.h / 2, 0.8)}>
              <ZoomOut className="size-4" />
            </IconButton>
            <IconButton aria-label="Zoom in" title="Zoom in" className="size-7" onClick={() => zoomAt(size.w / 2, size.h / 2, 1.25)}>
              <ZoomIn className="size-4" />
            </IconButton>
            <IconButton aria-label="Reset view" title="Reset view" className="size-7" onClick={() => setView({ x: 0, y: 0, k: 1 })}>
              <Maximize2 className="size-3.5" />
            </IconButton>
          </div>
        </div>

        <div
          ref={wrapRef}
          className="relative min-h-0 flex-1 overflow-hidden rounded-b-[inherit]"
          style={{ backgroundImage: 'radial-gradient(circle at 50% 45%, rgb(167 139 250 / 0.07), transparent 62%), radial-gradient(rgb(255 255 255 / 0.05) 1px, transparent 1px)', backgroundSize: '100% 100%, 22px 22px' }}
        >
          <svg
            ref={svgRef}
            width={size.w}
            height={size.h}
            viewBox={`0 0 ${size.w} ${size.h}`}
            role="group"
            aria-label={`Vault graph. ${summary}`}
            className="absolute inset-0 block cursor-grab touch-none select-none active:cursor-grabbing"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
              <g aria-hidden>
                {visibleEdges.map(([a, b]) => {
                  const pa = placed.get(a)
                  const pb = placed.get(b)
                  if (!pa || !pb) return null
                  const lit = hl ? hl.has(a) && hl.has(b) && (a === active || b === active) : false
                  const ha = LAYERS[layerKeyOf(index.byPath.get(a) as Note)].hex
                  return (
                    <line
                      key={`${a}|${b}`}
                      x1={pa.x}
                      y1={pa.y}
                      x2={pb.x}
                      y2={pb.y}
                      stroke={ha}
                      strokeOpacity={hl ? (lit ? 0.9 : 0.04) : 0.2}
                      strokeWidth={lit ? 1.6 : 1}
                      vectorEffect="non-scaling-stroke"
                      className="transition-[stroke-opacity] duration-150"
                    />
                  )
                })}
              </g>
              {drawOrder.map((n) => {
                const p = placed.get(n.path)
                if (!p) return null
                const lk = layerKeyOf(n)
                const meta = LAYERS[lk]
                const r = radiusOf(n)
                const lit = hl ? hl.has(n.path) : true
                const isActive = n.path === active
                const isSel = n.path === sel
                const deg = index.degree.get(n.path) ?? 0
                const showLabel = (hl ? hl.has(n.path) : n.importance >= 5 || deg >= 13 || (view.k >= 1.4 && n.importance >= 3) || view.k >= 2.2) || isSel
                const fs = 11 / view.k
                return (
                  <g
                    key={n.path}
                    data-node
                    tabIndex={0}
                    role="button"
                    aria-label={`${n.title}. ${meta.label}. ${index.degree.get(n.path) ?? 0} links.`}
                    aria-pressed={isSel}
                    transform={`translate(${p.x} ${p.y})`}
                    className="cursor-pointer outline-none transition-opacity duration-150 focus-visible:[&>circle:first-child]:stroke-mira"
                    opacity={lit ? 1 : 0.14}
                    onPointerEnter={() => setHover(n.path)}
                    onPointerLeave={() => setHover(null)}
                    onFocus={() => setHover(n.path)}
                    onBlur={() => setHover(null)}
                    onClick={(e) => {
                      e.stopPropagation()
                      select(isSel ? null : n.path)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        select(isSel ? null : n.path)
                      }
                    }}
                  >
                    <circle r={r + 6} fill="transparent" stroke="transparent" strokeWidth={2} />
                    {lk === 'federated' && <circle r={r + 4.5} fill="none" stroke={meta.hex} strokeWidth={1.2} strokeDasharray="3 3" opacity={0.9} />}
                    <circle r={r} fill={meta.hex} fillOpacity={n.status === 'superseded' ? 0.3 : lk === 'federated' ? 0.35 : 0.88} stroke={isActive ? '#ffffff' : '#0a0c16'} strokeWidth={isActive ? 2 : 1.5} />
                    {isSel && <circle r={r + 5} fill="none" stroke="#ffffff" strokeWidth={1.6} />}
                    {showLabel && (
                      <text
                        y={r + 4 + fs}
                        textAnchor="middle"
                        fontSize={fs}
                        fill="#e9ebf7"
                        stroke="#0a0c16"
                        strokeWidth={3 / view.k}
                        strokeLinejoin="round"
                        paintOrder="stroke"
                        fontWeight={isActive ? 600 : 500}
                        className="pointer-events-none"
                      >
                        {shortLabel(n.title)}
                      </text>
                    )}
                  </g>
                )
              })}
            </g>
          </svg>
          <p className="pointer-events-none absolute bottom-2 left-3 max-w-[calc(100%-190px)] truncate text-[11px] text-faint">
            Size = importance · lines = [[wikilinks]] · dashed ring = Secondbrain · scroll to zoom, drag to pan
          </p>
          <span className="pointer-events-none absolute right-3 bottom-2 rounded-md bg-black/30 px-1.5 py-0.5 text-[11px] text-muted tabular-nums">
            {visibleNotes.length} notes · {visibleEdges.length} links · {Math.round(view.k * 100)}%
          </span>
        </div>
      </section>

      {selNote ? (
        <SelectedCard note={selNote} index={index} onSelect={select} onOpen={openNote} />
      ) : (
        <Panel title="Reading the graph" subtitle="Hover to trace links, click for details" icon={Network} area="brain" className="min-h-0 overflow-y-auto" bodyClassName="flex flex-col gap-4">
          <div>
            <h3 className="mb-1.5 text-[11px] tracking-wide text-faint uppercase">Most connected</h3>
            <ul className="flex flex-col">
              {topHubs.map((n) => (
                <li key={n.path}>
                  <button
                    type="button"
                    onClick={() => select(n.path)}
                    className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1.5 text-left transition hover:bg-white/5"
                  >
                    <LayerDot layer={layerKeyOf(n)} />
                    <span className="min-w-0 flex-1 truncate text-[13px] text-muted">{n.title}</span>
                    <span className="text-[11px] text-faint tabular-nums">{index.degree.get(n.path)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="mb-1.5 text-[11px] tracking-wide text-faint uppercase">Loose ends</h3>
            {orphans.length === 0 ? (
              <p className="text-[12px] text-faint">Every note is linked to at least one other.</p>
            ) : (
              <ul className="flex flex-col">
                {orphans.map((n) => (
                  <li key={n.path}>
                    <button type="button" onClick={() => select(n.path)} className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1.5 text-left transition hover:bg-white/5">
                      <LayerDot layer={layerKeyOf(n)} />
                      <span className="min-w-0 flex-1 truncate text-[13px] text-muted">{n.title}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <h3 className="mb-1.5 text-[11px] tracking-wide text-faint uppercase">How layers link</h3>
            <ul className="flex flex-col gap-1.5">
              {cross.map((c) => (
                <li key={`${c.from}${c.to}`} className="text-[12px] text-muted">
                  <div className="flex items-center gap-1.5">
                    <LayerDot layer={c.from} />
                    <span className="min-w-0 truncate">{LAYERS[c.from].label}</span>
                    <span className="text-faint" aria-hidden>
                      &rarr;
                    </span>
                    <LayerDot layer={c.to} />
                    <span className="min-w-0 flex-1 truncate">{LAYERS[c.to].label}</span>
                    <span className="text-[11px] text-faint tabular-nums">{c.n}</span>
                  </div>
                  <div className="mt-1 h-[3px] overflow-hidden rounded-full bg-white/8" aria-hidden>
                    <div className="h-full rounded-full bg-brain/70" style={{ width: `${(c.n / (cross[0]?.n ?? 1)) * 100}%` }} />
                  </div>
                </li>
              ))}
            </ul>
          </div>
          <p className="text-[12px] leading-relaxed text-faint">
            The graph is built from your own [[wikilinks]]. Clusters form where you think about the same things, which is exactly what Mira walks when she looks for context.
          </p>
        </Panel>
      )}
    </div>
  )
}

function SelectedCard({ note, index, onSelect, onOpen }: { note: Note; index: VaultIndex; onSelect: (p: string | null) => void; onOpen: (p: string) => void }) {
  const lk = layerKeyOf(note)
  const outs = (index.outgoing.get(note.path) ?? []).filter((o) => o.note)
  const backs = index.backlinks.get(note.path) ?? []
  return (
    <Panel
      title={note.title}
      subtitle={note.path}
      area="brain"
      className="min-h-0 overflow-y-auto"
      bodyClassName="flex flex-col gap-3"
      actions={
        <Button size="xs" variant="ghost" onClick={() => onSelect(null)} aria-label="Clear selection">
          Clear
        </Button>
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <LayerBadge layer={lk} />
        <ImportanceDots value={note.importance} />
        <span className="text-[11px] text-faint">{note.status}</span>
      </div>
      {note.tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {note.tags.map((t) => (
            <span key={t} className="rounded-md bg-white/6 px-1.5 py-0.5 text-[11px] leading-4 text-muted">
              {t}
            </span>
          ))}
        </div>
      )}
      <Button variant="primary" size="md" onClick={() => onOpen(note.path)}>
        Open note <ArrowUpRight className="size-4" aria-hidden />
      </Button>
      <LinkList title={`Links out (${outs.length})`} items={outs.map((o) => o.note as Note)} onSelect={onSelect} />
      <LinkList title={`Linked from (${backs.length})`} items={backs.map((b) => b.from)} onSelect={onSelect} />
    </Panel>
  )
}

function LinkList({ title, items, onSelect }: { title: string; items: Note[]; onSelect: (p: string) => void }) {
  if (items.length === 0) return null
  return (
    <div>
      <h3 className="mb-1 text-[11px] tracking-wide text-faint uppercase">{title}</h3>
      <ul className="flex max-h-44 flex-col overflow-y-auto">
        {items.map((n) => (
          <li key={n.path}>
            <button type="button" onClick={() => onSelect(n.path)} className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1 text-left transition hover:bg-white/5">
              <LayerDot layer={layerKeyOf(n)} />
              <span className="min-w-0 flex-1 truncate text-[12.5px] text-muted">{n.title}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
