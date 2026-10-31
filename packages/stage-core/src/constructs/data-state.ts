/**
 * The state a `scene.data` command builds up inside a construct, and the pure reducer for it. Shared by the
 * StageMirror (what the stage should show), the SimulatorStage (what it does show) and the diff helpers, so all three
 * agree on what 'replace', 'merge' and 'remove' mean:
 *   replace: swap everything (omitted collections become empty);
 *   merge:   removals first, then upsert by id (nodes, items) or by from->to (edges); a removed node takes its edges.
 * A result with an edge pointing at a missing node is refused.
 */
import type { GraphEdge, GraphNode, StageCommand } from '@ai-assistant/shared'

export type SceneDataCommand = Extract<StageCommand, { type: 'scene.data' }>
export type DataItem = Record<string, unknown>

export interface ConstructData {
  nodes: GraphNode[]
  edges: GraphEdge[]
  items: DataItem[]
}

export const MAX_NODES = 5000
export const MAX_EDGES = 20000
export const MAX_ITEMS = 5000

export const emptyConstructData = (): ConstructData => ({ nodes: [], edges: [], items: [] })
export const edgeKey = (e: { from: string; to: string }): string => `${e.from}\u0000${e.to}`

export type ApplyResult = { ok: true; state: ConstructData } | { ok: false; error: string }

export function applySceneData(prev: ConstructData, cmd: Pick<SceneDataCommand, 'mode' | 'nodes' | 'edges' | 'items' | 'remove'>): ApplyResult {
  const mode = cmd.mode ?? 'merge'
  let nodes: Map<string, GraphNode>
  let edges: Map<string, GraphEdge>
  let items: Map<string, DataItem>
  const anon: DataItem[] = []

  if (mode === 'replace') {
    nodes = new Map()
    edges = new Map()
    items = new Map()
  } else {
    nodes = new Map(prev.nodes.map((n) => [n.id, n]))
    edges = new Map(prev.edges.map((e) => [edgeKey(e), e]))
    items = new Map()
    for (const it of prev.items) {
      if (typeof it.id === 'string') items.set(it.id, it)
      else anon.push(it)
    }
    const rm = cmd.remove
    if (rm) {
      const gone = new Set(rm.nodes ?? [])
      for (const id of gone) nodes.delete(id)
      if (gone.size > 0) for (const [k, e] of edges) if (gone.has(e.from) || gone.has(e.to)) edges.delete(k)
      for (const e of rm.edges ?? []) edges.delete(edgeKey(e))
      for (const id of rm.items ?? []) items.delete(id)
    }
  }

  for (const n of cmd.nodes ?? []) nodes.set(n.id, n)
  for (const e of cmd.edges ?? []) edges.set(edgeKey(e), e)
  for (const it of cmd.items ?? []) {
    if (typeof it.id === 'string') items.set(it.id, it)
    else if (mode === 'replace') anon.push(it)
    else return { ok: false, error: 'merge needs an "id" string on every item' }
  }

  for (const e of edges.values()) {
    if (!nodes.has(e.from) || !nodes.has(e.to)) return { ok: false, error: `edge ${e.from} -> ${e.to} refers to a node that does not exist` }
  }
  if (nodes.size > MAX_NODES || edges.size > MAX_EDGES || items.size + anon.length > MAX_ITEMS) return { ok: false, error: 'construct data is too large' }
  return { ok: true, state: { nodes: [...nodes.values()], edges: [...edges.values()], items: [...anon, ...items.values()] } }
}

/** Key-sorted JSON, so equal values compare equal whatever their key order. */
export function stableJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`
  const o = v as Record<string, unknown>
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(',')}}`
}

/** Order-insensitive equality of two construct data states. */
export function constructDataEqual(a: ConstructData, b: ConstructData): boolean {
  const norm = (d: ConstructData): string =>
    stableJson({
      nodes: [...d.nodes].sort((x, y) => (x.id < y.id ? -1 : 1)),
      edges: [...d.edges].sort((x, y) => (edgeKey(x) < edgeKey(y) ? -1 : 1)),
      items: [...d.items].map(stableJson).sort(),
    })
  return norm(a) === norm(b)
}
