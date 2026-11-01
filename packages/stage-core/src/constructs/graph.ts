import type { GraphEdge, GraphNode } from '@ai-assistant/shared'
import type { BrainLayer } from './layers'
import { layoutGraph } from './layout'
import type { LayoutOptions } from './layout'
import { clamp } from '../util/math'
import { MAX_EDGES } from './data-state'

/** A note as the daemon's brain index knows it. */
export interface GraphNoteInput {
  /** Vault path or any stable id. */
  id: string
  title?: string
  layer?: BrainLayer
  /** 1..5, default 2. */
  importance?: number
  /** Markdown body: [[wikilinks]] are read from it. */
  body?: string
  /** Extra link targets already known (resolved by id, path, basename or title like wikilinks). */
  links?: readonly string[]
}

export type GraphPalette = 'cool' | 'warm' | 'mono'

export interface KnowledgeGraphOptions extends LayoutOptions {
  /** Keep at most this many notes (highest importance first). Default 400. */
  maxNodes?: number
  palette?: GraphPalette
  /**
   * Keep at most this many edges, heaviest first (ties broken by id, so the choice is deterministic). Default 6000; never
   * more than the 20000 a stage keeps (`MAX_EDGES`), so the producer can never emit a graph the consumer refuses.
   */
  maxEdges?: number
  /** At most this many edges touch one note, heaviest first. Default 64: a note that links to everything does not turn the constellation into a hairball. */
  maxEdgesPerNode?: number
}

export interface KnowledgeGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
  /** `droppedEdges`: links left out by the edge caps (they exist in the notes, they are just not drawn). */
  stats: { notes: number; shown: number; edges: number; unresolvedLinks: number; truncated: boolean; droppedEdges: number }
}

export const DEFAULT_MAX_EDGES = 6000
export const DEFAULT_MAX_EDGES_PER_NODE = 64
/** Distinct links considered at all; a vault that links everything to everything is bounded before it is ranked. */
const CANDIDATE_CAP = 100_000

const PALETTES: Record<GraphPalette, Record<BrainLayer, string>> = {
  cool: { core: '#ffe3b0', strategy: '#ffc77a', episodic: '#7fa8ff', semantic: '#9ad1ff', project: '#8affc1', inbox: '#8a93a8' },
  warm: { core: '#fff0c8', strategy: '#ffb86b', episodic: '#ff9a7a', semantic: '#ffd29a', project: '#ffc2a1', inbox: '#a89a8a' },
  mono: { core: '#ffffff', strategy: '#e6e9ef', episodic: '#c5cad4', semantic: '#aeb4c0', project: '#d3d7e0', inbox: '#7c8392' },
}

const WIKILINK = /\[\[([^\[\]|#\n]+)(?:#[^\[\]|\n]*)?(?:\|[^\[\]\n]*)?\]\]/g

const baseName = (p: string): string => {
  const seg = p.split(/[\\/]/).pop() ?? p
  return seg.replace(/\.md$/i, '')
}
const norm = (s: string): string => s.trim().toLowerCase()

/** Visual hints from importance 1..5: node radius in metres and glow 0..1. */
export const importanceSize = (importance: number): number => Math.round((0.05 + 0.035 * importance) * 1000) / 1000
export const importanceBrightness = (importance: number): number => Math.round((0.3 + 0.7 * ((importance - 1) / 4)) * 100) / 100

export function extractWikilinks(body: string): string[] {
  const out: string[] = []
  for (const m of body.matchAll(WIKILINK)) {
    const t = m[1]!.trim()
    if (t) out.push(t)
  }
  return out
}

/** Notes -> nodes and edges (from wikilinks) with a deterministic 3D layout and importance hints. */
export function buildKnowledgeGraph(notes: readonly GraphNoteInput[], opts: KnowledgeGraphOptions = {}): KnowledgeGraph {
  const maxNodes = clamp(Math.floor(opts.maxNodes ?? 400), 1, 2000)
  const palette = PALETTES[opts.palette ?? 'cool']

  // unique ids; first occurrence wins
  const seen = new Set<string>()
  let all = notes.filter((n) => {
    if (typeof n.id !== 'string' || n.id.length === 0 || seen.has(n.id)) return false
    seen.add(n.id)
    return true
  })
  const imp = (n: GraphNoteInput): number => clamp(Math.round(Number.isFinite(n.importance) ? (n.importance as number) : 2), 1, 5)
  const truncated = all.length > maxNodes
  if (truncated) all = [...all].sort((a, b) => imp(b) - imp(a) || (a.id < b.id ? -1 : 1)).slice(0, maxNodes)
  all = [...all].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  // link resolution: exact id first, then a UNIQUE basename or title
  const byId = new Map<string, string>()
  const byName = new Map<string, string | null>()
  const addName = (key: string, id: string): void => {
    const k = norm(key)
    if (!k) return
    const cur = byName.get(k)
    byName.set(k, cur === undefined || cur === id ? id : null) // null = ambiguous
  }
  for (const n of all) {
    byId.set(norm(n.id), n.id)
    byId.set(norm(n.id.replace(/\.md$/i, '')), n.id)
    addName(baseName(n.id), n.id)
    if (n.title) addName(n.title, n.id)
  }
  const resolve = (target: string): string | undefined => {
    const t = norm(target)
    const exact = byId.get(t) ?? byId.get(norm(target.replace(/\.md$/i, '')))
    if (exact) return exact
    const named = byName.get(norm(baseName(target)))
    return named ?? undefined
  }

  const edgeMap = new Map<string, GraphEdge>()
  let unresolved = 0
  let overflow = 0
  for (const n of all) {
    const targets = [...extractWikilinks(n.body ?? ''), ...(n.links ?? [])]
    for (const t of targets) {
      const to = resolve(t)
      if (!to) {
        unresolved++
        continue
      }
      if (to === n.id) continue
      const key = `${n.id}\u0000${to}`
      const cur = edgeMap.get(key)
      if (cur) cur.weight = Math.min(5, cur.weight + 1)
      else if (edgeMap.size >= CANDIDATE_CAP) overflow++
      else edgeMap.set(key, { from: n.id, to, weight: 1 })
    }
  }
  const byEnds = (a: GraphEdge, b: GraphEdge): number => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : 0)
  const maxEdges = clamp(Math.floor(Number.isFinite(opts.maxEdges) ? (opts.maxEdges as number) : DEFAULT_MAX_EDGES), 0, MAX_EDGES)
  const perNode = clamp(Math.floor(Number.isFinite(opts.maxEdgesPerNode) ? (opts.maxEdgesPerNode as number) : DEFAULT_MAX_EDGES_PER_NODE), 1, 10_000)
  // heaviest first; the caps bound how many edges the constellation draws, and how many one note can hold
  const ranked = [...edgeMap.values()].sort((a, b) => b.weight - a.weight || byEnds(a, b))
  const degree = new Map<string, number>()
  const kept: GraphEdge[] = []
  for (const e of ranked) {
    if (kept.length >= maxEdges) break
    if ((degree.get(e.from) ?? 0) >= perNode || (degree.get(e.to) ?? 0) >= perNode) continue
    kept.push(e)
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1)
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1)
  }
  const edges = kept.sort(byEnds)
  const droppedEdges = edgeMap.size - edges.length + overflow

  const pos = layoutGraph(
    all.map((n) => ({ id: n.id, ...(n.layer ? { layer: n.layer } : {}), importance: imp(n) })),
    edges,
    opts,
  )
  const nodes: GraphNode[] = all.map((n) => {
    const importance = imp(n)
    const node: GraphNode = {
      id: n.id,
      label: (n.title && n.title.trim()) || baseName(n.id),
      importance,
      position: pos.get(n.id)!,
      color: palette[n.layer ?? 'semantic'],
      size: importanceSize(importance),
      brightness: importanceBrightness(importance),
    }
    if (n.layer) node.layer = n.layer
    return node
  })
  return { nodes, edges, stats: { notes: notes.length, shown: nodes.length, edges: edges.length, unresolvedLinks: unresolved, truncated, droppedEdges } }
}
