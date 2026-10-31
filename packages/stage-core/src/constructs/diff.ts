/**
 * Diff helpers: turn a data change into minimal `scene.data` merge commands instead of replacing a whole construct on
 * every tick. The first push (or after `reset`, e.g. a reconnect) is a full replace; later pushes only carry what
 * changed, plus removals (the `remove` field of scene.data, or a replace when `removeStrategy` is 'replace').
 */
import type { GraphEdge, GraphNode } from '@ai-assistant/shared'
import type { CommandDraft } from '../util/commands'
import { applySceneData, constructDataEqual, edgeKey, stableJson } from './data-state'
import type { ConstructData, DataItem } from './data-state'

export interface DiffOptions {
  /** 'field' (default) sends removals in `remove`; 'replace' falls back to a full replace when anything was removed. */
  removeStrategy?: 'field' | 'replace'
  /** Split commands above this many nodes/edges/items. Default 500. */
  maxPerCommand?: number
}

export interface DataInput {
  nodes?: readonly GraphNode[]
  edges?: readonly GraphEdge[]
  items?: readonly DataItem[]
}

const full = (d: DataInput): ConstructData => ({ nodes: [...(d.nodes ?? [])], edges: [...(d.edges ?? [])], items: [...(d.items ?? [])] })

function chunk<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

type DataCmd = { type: 'scene.data'; constructId: string; mode: 'replace' | 'merge'; nodes?: GraphNode[]; edges?: GraphEdge[]; items?: DataItem[]; remove?: { nodes?: string[]; edges?: Array<{ from: string; to: string }>; items?: string[] } }

/** Full state as one replace plus merges when it is large. */
export function replaceCommands(constructId: string, data: DataInput, maxPerCommand = 500): CommandDraft[] {
  const d = full(data)
  if (d.nodes.length <= maxPerCommand && d.edges.length <= maxPerCommand && d.items.length <= maxPerCommand) {
    return [{ type: 'scene.data', constructId, mode: 'replace', nodes: d.nodes, edges: d.edges, items: d.items }]
  }
  const nodeChunks = chunk(d.nodes, maxPerCommand)
  const edgeChunks = chunk(d.edges, maxPerCommand)
  const itemChunks = chunk(d.items, maxPerCommand)
  const first: DataCmd = { type: 'scene.data', constructId, mode: 'replace', nodes: nodeChunks[0] ?? [], edges: [], items: itemChunks[0] ?? [] }
  const out: DataCmd[] = [first]
  // nodes first so edges never dangle
  for (const c of nodeChunks.slice(1)) out.push({ type: 'scene.data', constructId, mode: 'merge', nodes: c })
  for (const c of edgeChunks) out.push({ type: 'scene.data', constructId, mode: 'merge', edges: c })
  for (const c of itemChunks.slice(1)) out.push({ type: 'scene.data', constructId, mode: 'merge', items: c })
  return out as CommandDraft[]
}

/** The commands that turn `prev` into `next` (empty when nothing changed). `prev` undefined means "never sent": replace. */
export function diffConstructData(constructId: string, prev: DataInput | undefined, next: DataInput, opts: DiffOptions = {}): CommandDraft[] {
  const max = opts.maxPerCommand ?? 500
  if (!prev) return replaceCommands(constructId, next, max)
  const a = full(prev)
  const b = full(next)
  if (constructDataEqual(a, b)) return []

  const nodeJson = new Map(a.nodes.map((n) => [n.id, stableJson(n)]))
  const edgeJson = new Map(a.edges.map((e) => [edgeKey(e), stableJson(e)]))
  const itemJson = new Map<string, string>()
  for (const it of a.items) if (typeof it.id === 'string') itemJson.set(it.id, stableJson(it))

  const upNodes = b.nodes.filter((n) => nodeJson.get(n.id) !== stableJson(n))
  const upEdges = b.edges.filter((e) => edgeJson.get(edgeKey(e)) !== stableJson(e))
  const upItems = b.items.filter((it) => typeof it.id === 'string' && itemJson.get(it.id as string) !== stableJson(it))

  const nextNodeIds = new Set(b.nodes.map((n) => n.id))
  const nextEdgeKeys = new Set(b.edges.map(edgeKey))
  const nextItemIds = new Set(b.items.filter((it) => typeof it.id === 'string').map((it) => it.id as string))
  const rmNodes = a.nodes.filter((n) => !nextNodeIds.has(n.id)).map((n) => n.id)
  // edges that vanish with a removed node need no explicit removal
  const rmNodeSet = new Set(rmNodes)
  const rmEdges = a.edges.filter((e) => !nextEdgeKeys.has(edgeKey(e)) && !rmNodeSet.has(e.from) && !rmNodeSet.has(e.to)).map((e) => ({ from: e.from, to: e.to }))
  const rmItems = a.items.filter((it) => typeof it.id === 'string' && !nextItemIds.has(it.id as string)).map((it) => it.id as string)
  const hasAnonymous = b.items.some((it) => typeof it.id !== 'string') || a.items.some((it) => typeof it.id !== 'string')
  const removals = rmNodes.length + rmEdges.length + rmItems.length > 0

  if (hasAnonymous || (removals && opts.removeStrategy === 'replace')) return replaceCommands(constructId, next, max)

  // all node chunks first, then edges, then items, so an edge never arrives before its node; removals ride on the first command
  const out: DataCmd[] = []
  for (const c of chunk(upNodes, max)) out.push({ type: 'scene.data', constructId, mode: 'merge', nodes: c })
  for (const c of chunk(upEdges, max)) out.push({ type: 'scene.data', constructId, mode: 'merge', edges: c })
  for (const c of chunk(upItems, max)) out.push({ type: 'scene.data', constructId, mode: 'merge', items: c })
  if (removals) {
    const remove: NonNullable<DataCmd['remove']> = {}
    if (rmNodes.length) remove.nodes = rmNodes
    if (rmEdges.length) remove.edges = rmEdges
    if (rmItems.length) remove.items = rmItems
    if (out.length === 0) out.push({ type: 'scene.data', constructId, mode: 'merge', remove })
    else out[0]!.remove = remove
  }
  return out as CommandDraft[]
}

/**
 * Remembers what each construct last showed and emits only the difference. Call `reset()` after a reconnect (the
 * stage lost its state) so the next update is a full replace again.
 */
export class ConstructDataSync {
  private readonly last = new Map<string, ConstructData>()
  constructor(private readonly opts: DiffOptions = {}) {}

  update(constructId: string, next: DataInput): CommandDraft[] {
    const cmds = diffConstructData(constructId, this.last.get(constructId), next, this.opts)
    if (cmds.length > 0 || !this.last.has(constructId)) this.last.set(constructId, full(next))
    return cmds
  }
  /** The state this helper believes the stage shows. */
  current(constructId: string): ConstructData | undefined {
    const s = this.last.get(constructId)
    return s ? { nodes: [...s.nodes], edges: [...s.edges], items: [...s.items] } : undefined
  }
  reset(constructId?: string): void {
    if (constructId === undefined) this.last.clear()
    else this.last.delete(constructId)
  }
  forget(constructId: string): void {
    this.last.delete(constructId)
  }
}

/** Apply commands produced by this module to a data state (what a stage does). Used by tests and the mirror. */
export function applyCommands(state: ConstructData, cmds: readonly CommandDraft[]): ConstructData | undefined {
  let cur = state
  for (const c of cmds) {
    if (c.type !== 'scene.data') continue
    const r = applySceneData(cur, c as never)
    if (!r.ok) return undefined
    cur = r.state
  }
  return cur
}

