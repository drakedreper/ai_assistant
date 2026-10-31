import { describe, expect, it } from 'vitest'
import { GraphNode, StageCommand } from '@ai-assistant/shared'
import {
  ConstructDataSync,
  LAYER_ORDER,
  TerminalBindings,
  applyCommands,
  applySceneData,
  buildKnowledgeGraph,
  chunkTerminalOutput,
  constructDataEqual,
  createTerminalPaneConstruct,
  diffConstructData,
  emptyConstructData,
  extractWikilinks,
  importanceBrightness,
  importanceSize,
  layoutGraph,
  orbitStatusOf,
  replaceCommands,
  sessionOrbit,
  stableJson,
  timelineRibbon,
} from '../src'
import type { BrainLayer, ConstructData, GraphNoteInput, LayoutEdgeInput, LayoutNodeInput } from '../src'
import { T0, lcg } from './helpers'

const note = (id: string, over: Partial<GraphNoteInput> = {}): GraphNoteInput => ({ id, ...over })

describe('wikilinks and graph building', () => {
  it('extracts [[links]] with aliases and headings, ignoring junk', () => {
    expect(extractWikilinks('See [[Alpha]] and [[beta|the B note]] and [[gamma#Section]] and [[d#h|alias]].')).toEqual(['Alpha', 'beta', 'gamma', 'd'])
    expect(extractWikilinks('[[ ]] [[]] [[unclosed [[a]]b]]')).toEqual(['a'])
    expect(extractWikilinks('no links [x] (y)')).toEqual([])
    expect(extractWikilinks('[[multi\nline]]')).toEqual([])
  })

  it('resolves links by id, path without extension, unique basename and title (case-insensitive)', () => {
    const g = buildKnowledgeGraph([
      note('00-core/persona.md', { title: 'Persona', layer: 'core', importance: 5, body: 'refs [[Values]] and [[strategy/Q4 plan]] and [[PERSONA]]' }),
      note('00-core/values.md', { title: 'Values', layer: 'core', importance: 5 }),
      note('10-strategy/Q4 plan.md', { layer: 'strategy', importance: 4, body: '[[values]] [[00-core/persona]]' }),
    ])
    const pairs = g.edges.map((e) => `${e.from}>${e.to}`)
    expect(pairs).toContain('00-core/persona.md>00-core/values.md')
    expect(pairs).toContain('10-strategy/Q4 plan.md>00-core/values.md')
    expect(pairs).toContain('10-strategy/Q4 plan.md>00-core/persona.md')
    expect(pairs).not.toContain('00-core/persona.md>00-core/persona.md') // self link ignored
    expect(g.stats.unresolvedLinks).toBe(0) // "strategy/Q4 plan" resolves by its unique basename
  })

  it('does not resolve ambiguous basenames, counts unresolved links and merges duplicate links into weight', () => {
    const g = buildKnowledgeGraph([
      note('a/index.md', { body: '[[ghost]] [[x]] [[x]] [[x]]' }),
      note('b/index.md'),
      note('x.md'),
      note('y.md', { body: '[[index]]' }),
    ])
    const e = g.edges.find((x) => x.from === 'a/index.md' && x.to === 'x.md')!
    expect(e.weight).toBe(3)
    expect(g.edges.some((x) => x.from === 'y.md')).toBe(false) // "index" is ambiguous
    expect(g.stats.unresolvedLinks).toBe(2)
  })

  it('caps edge weight, ignores duplicate ids, handles empty input and bad ids', () => {
    const g = buildKnowledgeGraph([note('a', { body: '[[b]]'.repeat(9) }), note('b'), note('a', { title: 'dup' }), note('')])
    expect(g.nodes.map((n) => n.id)).toEqual(['a', 'b'])
    expect(g.edges[0]!.weight).toBe(5)
    const empty = buildKnowledgeGraph([])
    expect(empty).toMatchObject({ nodes: [], edges: [], stats: { shown: 0, truncated: false } })
  })

  it('truncates to the most important notes and says so', () => {
    const notes = Array.from({ length: 30 }, (_, i) => note(`n${String(i).padStart(2, '0')}`, { importance: (i % 5) + 1 }))
    const g = buildKnowledgeGraph(notes, { maxNodes: 10 })
    expect(g.nodes).toHaveLength(10)
    expect(g.stats.truncated).toBe(true)
    expect(g.nodes.every((n) => n.importance >= 4)).toBe(true)
  })

  it('produces nodes that satisfy the shared schema, with importance hints and layer colours', () => {
    const g = buildKnowledgeGraph([note('a', { layer: 'core', importance: 5 }), note('b', { layer: 'inbox', importance: 1 }), note('c')], { palette: 'warm' })
    for (const n of g.nodes) expect(GraphNode.safeParse(n).success).toBe(true)
    const a = g.nodes.find((n) => n.id === 'a')!
    const b = g.nodes.find((n) => n.id === 'b')!
    expect(a.size!).toBeGreaterThan(b.size!)
    expect(a.brightness!).toBeGreaterThan(b.brightness!)
    expect(a.brightness).toBe(1)
    expect(b.brightness).toBe(0.3)
    expect(a.color).not.toBe(b.color)
    expect(g.nodes.find((n) => n.id === 'c')!.label).toBe('c')
    expect(g.nodes.find((n) => n.id === 'c')!.importance).toBe(2)
  })

  it('importance hints are monotone and bounded', () => {
    let ps = 0
    let pb = 0
    for (let i = 1; i <= 5; i++) {
      expect(importanceSize(i)).toBeGreaterThan(ps)
      expect(importanceBrightness(i)).toBeGreaterThan(pb)
      ps = importanceSize(i)
      pb = importanceBrightness(i)
    }
    expect(importanceBrightness(5)).toBe(1)
  })

  it('clamps nonsense importance', () => {
    const g = buildKnowledgeGraph([note('a', { importance: 99 }), note('b', { importance: -3 }), note('c', { importance: NaN })])
    expect(g.nodes.map((n) => n.importance)).toEqual([5, 1, 2])
  })
})

describe('3D force layout', () => {
  const randomGraph = (seed: number, n: number, m: number) => {
    const r = lcg(seed)
    const nodes: LayoutNodeInput[] = Array.from({ length: n }, (_, i) => ({ id: `n${i}`, layer: LAYER_ORDER[Math.floor(r() * 6)] as BrainLayer, importance: 1 + Math.floor(r() * 5) }))
    const edges: LayoutEdgeInput[] = Array.from({ length: m }, () => ({ from: `n${Math.floor(r() * n)}`, to: `n${Math.floor(r() * n)}`, weight: 1 + Math.floor(r() * 3) }))
    return { nodes, edges }
  }

  it('is deterministic for the same seed and independent of input order', () => {
    const { nodes, edges } = randomGraph(1, 40, 60)
    const a = layoutGraph(nodes, edges, { seed: 's' })
    const b = layoutGraph([...nodes].reverse(), [...edges].reverse(), { seed: 's' })
    expect(a.size).toBe(b.size)
    for (const [id, p] of a) expect(b.get(id)).toEqual(p)
    const c = layoutGraph(nodes, edges, { seed: 'other' })
    expect([...c.values()]).not.toEqual([...a.values()])
  })

  it('puts core nearest and inbox farthest: mean depth rises with the layer', () => {
    const { nodes, edges } = randomGraph(2, 120, 150)
    const pos = layoutGraph(nodes, edges)
    const mean = (layer: BrainLayer): number => {
      const zs = nodes.filter((n) => n.layer === layer).map((n) => pos.get(n.id)![2])
      return zs.reduce((s, z) => s + z, 0) / zs.length
    }
    const means = LAYER_ORDER.map(mean)
    for (let i = 1; i < means.length; i++) expect(means[i]!).toBeGreaterThan(means[i - 1]! + 0.5)
    expect(means[0]!).toBeLessThan(0.5)
  })

  it('always yields finite, bounded positions (property: many random and degenerate graphs)', () => {
    for (let s = 0; s < 40; s++) {
      const n = 1 + (s % 25) * 3
      const { nodes, edges } = randomGraph(100 + s, n, n * 2)
      const pos = layoutGraph(nodes, edges, { seed: s, iterations: 30 + (s % 4) * 30, radius: 4 + (s % 3) })
      expect(pos.size).toBe(n)
      for (const [, p] of pos) {
        expect(p.every(Number.isFinite)).toBe(true)
        expect(Math.hypot(p[0], p[1])).toBeLessThanOrEqual(4 + (s % 3) + 1e-9)
        expect(p[2]).toBeGreaterThanOrEqual(-0.3 - 1e-9)
        expect(p[2]).toBeLessThanOrEqual(1.2 * 5 + 0.6 + 1e-9)
      }
    }
  })

  it('survives degenerate inputs: duplicate ids, self and dangling edges, NaN importance, huge weights', () => {
    const nodes: LayoutNodeInput[] = [
      { id: 'a', importance: NaN },
      { id: 'b', importance: Infinity },
      { id: 'c', importance: 3, layer: 'core' },
    ]
    const edges: LayoutEdgeInput[] = [
      { from: 'a', to: 'a', weight: 1 },
      { from: 'a', to: 'zzz', weight: 1 },
      { from: 'a', to: 'b', weight: Infinity },
      { from: 'b', to: 'c', weight: NaN },
    ]
    const pos = layoutGraph(nodes, edges)
    for (const p of pos.values()) expect(p.every(Number.isFinite)).toBe(true)
    expect(layoutGraph([], []).size).toBe(0)
    expect(layoutGraph([{ id: 'only', importance: 3 }], []).get('only')!.every(Number.isFinite)).toBe(true)
  })

  it('a hundred identical nodes in one layer still spread out (no coincident stack)', () => {
    const nodes: LayoutNodeInput[] = Array.from({ length: 100 }, (_, i) => ({ id: `n${i}`, layer: 'semantic', importance: 3 }))
    const pos = [...layoutGraph(nodes, []).values()]
    let minDist = Infinity
    for (let i = 0; i < pos.length; i++) for (let j = i + 1; j < pos.length; j++) minDist = Math.min(minDist, Math.hypot(pos[i]![0] - pos[j]![0], pos[i]![1] - pos[j]![1]))
    expect(minDist).toBeGreaterThan(0.01)
  })

  it('linked nodes end up closer than unlinked ones on average', () => {
    const nodes: LayoutNodeInput[] = Array.from({ length: 30 }, (_, i) => ({ id: `n${i}`, layer: 'semantic', importance: 3 }))
    const edges: LayoutEdgeInput[] = Array.from({ length: 15 }, (_, i) => ({ from: `n${i}`, to: `n${i + 15}`, weight: 1 }))
    const pos = layoutGraph(nodes, edges, { iterations: 200 })
    const d = (a: string, b: string) => Math.hypot(pos.get(a)![0] - pos.get(b)![0], pos.get(a)![1] - pos.get(b)![1])
    const linked = edges.reduce((s, e) => s + d(e.from, e.to), 0) / edges.length
    let other = 0
    let cnt = 0
    for (let i = 0; i < 15; i++) for (let j = 0; j < 15; j++) if (i !== j) { other += d(`n${i}`, `n${j + 15}`); cnt++ }
    expect(linked).toBeLessThan(other / cnt)
  })

  it('important notes sit nearer the axis on average', () => {
    const nodes: LayoutNodeInput[] = Array.from({ length: 80 }, (_, i) => ({ id: `n${i}`, layer: 'semantic', importance: i % 2 === 0 ? 5 : 1 }))
    const pos = layoutGraph(nodes, [])
    const mean = (imp: number) => {
      const rs = nodes.filter((n) => n.importance === imp).map((n) => Math.hypot(pos.get(n.id)![0], pos.get(n.id)![1]))
      return rs.reduce((s, r) => s + r, 0) / rs.length
    }
    expect(mean(5)).toBeLessThan(mean(1))
  })
})

describe('scene.data reducer', () => {
  const n = (id: string): GraphNode => GraphNode.parse({ id, label: id })
  const e = (from: string, to: string) => ({ from, to, weight: 1 })
  it('replace swaps everything; merge upserts; removals come first; removing a node removes its edges', () => {
    let st = emptyConstructData()
    const r1 = applySceneData(st, { mode: 'replace', nodes: [n('a'), n('b'), n('c')], edges: [e('a', 'b'), e('b', 'c')], items: [{ id: 'i1', v: 1 }] })
    expect(r1.ok).toBe(true)
    if (!r1.ok) return
    st = r1.state
    const r2 = applySceneData(st, { mode: 'merge', nodes: [{ ...n('a'), label: 'A!' }, n('d')], edges: [e('c', 'd')], items: [{ id: 'i1', v: 2 }, { id: 'i2' }], remove: { nodes: ['b'] } })
    expect(r2.ok).toBe(true)
    if (!r2.ok) return
    expect(r2.state.nodes.map((x) => x.id).sort()).toEqual(['a', 'c', 'd'])
    expect(r2.state.nodes.find((x) => x.id === 'a')!.label).toBe('A!')
    expect(r2.state.edges.map((x) => `${x.from}>${x.to}`)).toEqual(['c>d'])
    expect(r2.state.items.find((x) => x.id === 'i1')!.v).toBe(2)
    const r3 = applySceneData(r2.state, { mode: 'replace', items: [{ x: 1 }] })
    expect(r3.ok && r3.state).toEqual({ nodes: [], edges: [], items: [{ x: 1 }] })
  })
  it('refuses dangling edges, items without ids in merge, and oversized data', () => {
    expect(applySceneData(emptyConstructData(), { mode: 'merge', edges: [e('a', 'b')] }).ok).toBe(false)
    expect(applySceneData(emptyConstructData(), { mode: 'merge', items: [{ nope: 1 }] }).ok).toBe(false)
    const many = Array.from({ length: 5001 }, (_, i) => n(`n${i}`))
    expect(applySceneData(emptyConstructData(), { mode: 'replace', nodes: many }).ok).toBe(false)
  })
  it('a node can be removed and re-added in one command with its edges', () => {
    const base = applySceneData(emptyConstructData(), { mode: 'replace', nodes: [n('a'), n('b')], edges: [e('a', 'b')] })
    if (!base.ok) throw new Error('setup')
    const r = applySceneData(base.state, { mode: 'merge', remove: { nodes: ['b'] }, nodes: [n('b')], edges: [e('a', 'b')] })
    expect(r.ok && r.state.edges).toHaveLength(1)
  })
  it('stableJson and equality ignore key and list order', () => {
    expect(stableJson({ b: 1, a: { d: 1, c: 2 } })).toBe(stableJson({ a: { c: 2, d: 1 }, b: 1 }))
    const a: ConstructData = { nodes: [n('a'), n('b')], edges: [], items: [{ id: 'x', v: 1 }, { id: 'y' }] }
    const b: ConstructData = { nodes: [n('b'), n('a')], edges: [], items: [{ id: 'y' }, { v: 1, id: 'x' }] }
    expect(constructDataEqual(a, b)).toBe(true)
    expect(constructDataEqual(a, { ...b, nodes: [n('a')] })).toBe(false)
  })
})

describe('diff helpers', () => {
  const g = (notes: GraphNoteInput[]) => buildKnowledgeGraph(notes)
  const base = [note('a', { layer: 'core', importance: 5, body: '[[b]]' }), note('b', { layer: 'strategy' }), note('c', { layer: 'inbox', body: '[[a]]' })]

  it('first push is a replace; an unchanged push is empty', () => {
    const data = g(base)
    const first = diffConstructData('kg', undefined, data)
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({ type: 'scene.data', constructId: 'kg', mode: 'replace' })
    expect(diffConstructData('kg', data, g(base))).toEqual([])
  })

  it('a changed note produces a merge with only that node, not a full replace', () => {
    const prev = g(base)
    const next = g(base.map((x) => (x.id === 'b' ? { ...x, importance: 5 } : x)))
    const cmds = diffConstructData('kg', prev, next)
    expect(cmds).toHaveLength(1)
    const c = cmds[0] as { mode: string; nodes?: Array<{ id: string }>; edges?: unknown[]; remove?: unknown }
    expect(c.mode).toBe('merge')
    // layout may nudge neighbours, but never all of them unless everything moved
    expect(c.nodes!.some((x) => x.id === 'b')).toBe(true)
    expect(c.remove).toBeUndefined()
  })

  it('a new link is a single edge upsert; a removed note uses the remove field', () => {
    const prev: ConstructData = { nodes: g(base).nodes, edges: [{ from: 'a', to: 'b', weight: 1 }], items: [] }
    const withEdge: ConstructData = { ...prev, edges: [...prev.edges, { from: 'b', to: 'c', weight: 1 }] }
    const c1 = diffConstructData('kg', prev, withEdge)
    expect(c1).toEqual([{ type: 'scene.data', constructId: 'kg', mode: 'merge', edges: [{ from: 'b', to: 'c', weight: 1 }] }])
    const withoutC: ConstructData = { nodes: prev.nodes.filter((n) => n.id !== 'c'), edges: prev.edges, items: [] }
    const c2 = diffConstructData('kg', prev, withoutC)
    expect(c2).toEqual([{ type: 'scene.data', constructId: 'kg', mode: 'merge', remove: { nodes: ['c'] } }])
  })

  it('removeStrategy "replace" falls back to a full replace on removals only', () => {
    const prev = g(base)
    const next = { nodes: prev.nodes.filter((n) => n.id !== 'c'), edges: prev.edges.filter((e) => e.from !== 'c') }
    const cmds = diffConstructData('kg', prev, next, { removeStrategy: 'replace' })
    expect(cmds[0]).toMatchObject({ mode: 'replace' })
    const additive = diffConstructData('kg', next, prev, { removeStrategy: 'replace' })
    expect(additive[0]).toMatchObject({ mode: 'merge' })
  })

  it('diffs items by id, including removals', () => {
    const prev = { items: [{ id: 'a', v: 1 }, { id: 'b', v: 1 }] }
    const next = { items: [{ id: 'a', v: 2 }, { id: 'c', v: 1 }] }
    const cmds = diffConstructData('o', prev, next)
    expect(cmds).toEqual([{ type: 'scene.data', constructId: 'o', mode: 'merge', items: [{ id: 'a', v: 2 }, { id: 'c', v: 1 }], remove: { items: ['b'] } }])
  })

  it('splits big pushes into chunks (nodes before edges) that still reproduce the data', () => {
    const notes = Array.from({ length: 30 }, (_, i) => note(`n${i}`, { body: `[[n${(i + 1) % 30}]]` }))
    const data = g(notes)
    const cmds = replaceCommands('kg', data, 7)
    expect(cmds.length).toBeGreaterThan(3)
    expect(cmds[0]).toMatchObject({ mode: 'replace' })
    const applied = applyCommands(emptyConstructData(), cmds)!
    expect(constructDataEqual(applied, { nodes: data.nodes, edges: data.edges, items: [] })).toBe(true)
  })

  it('every emitted command validates against the shared StageCommand schema', () => {
    const prev = g(base)
    const next = g(base.map((x) => (x.id === 'c' ? { ...x, importance: 4 } : x)).filter((x) => x.id !== 'b'))
    for (const c of [...diffConstructData('kg', undefined, prev), ...diffConstructData('kg', prev, next)]) {
      expect(StageCommand.safeParse({ ...c, id: 'x' }).success).toBe(true)
    }
  })

  it('PROPERTY: applying the diff to the previous state always yields the next state', () => {
    const r = lcg(5)
    const mkNodes = (): GraphNode[] => Array.from({ length: 1 + Math.floor(r() * 12) }, (_, i) => GraphNode.parse({ id: `n${Math.floor(r() * 16)}-${i}`, label: `L${Math.floor(r() * 3)}`, importance: 1 + Math.floor(r() * 5), position: [Math.round(r() * 10) / 10, 0, 0] }))
    let prev: ConstructData = emptyConstructData()
    let sync = false
    for (let step = 0; step < 150; step++) {
      const nodes = r() < 0.5 && prev.nodes.length ? prev.nodes.filter(() => r() < 0.8).concat(mkNodes().slice(0, 2)) : mkNodes()
      const uniq = [...new Map(nodes.map((n) => [n.id, n])).values()].map((n) => (r() < 0.2 ? { ...n, label: 'changed' } : n))
      const ids = uniq.map((n) => n.id)
      const edges = Array.from({ length: Math.floor(r() * 8) }, () => ({ from: ids[Math.floor(r() * ids.length)]!, to: ids[Math.floor(r() * ids.length)]!, weight: 1 + Math.floor(r() * 3) }))
      const uniqEdges = [...new Map(edges.map((e) => [`${e.from}>${e.to}`, e])).values()]
      const items = Array.from({ length: Math.floor(r() * 5) }, (_, i) => ({ id: `i${Math.floor(r() * 6)}`, v: Math.floor(r() * 3), i: 0 }))
      const uniqItems = [...new Map(items.map((i) => [i.id, i])).values()]
      const next: ConstructData = { nodes: uniq, edges: uniqEdges, items: uniqItems }
      for (const strategy of ['field', 'replace'] as const) {
        const cmds = diffConstructData('x', sync ? prev : undefined, next, { removeStrategy: strategy, maxPerCommand: 4 })
        const applied = applyCommands(sync ? prev : emptyConstructData(), cmds)
        expect(applied, `step ${step} ${strategy}`).toBeDefined()
        expect(constructDataEqual(applied!, next), `step ${step} ${strategy}`).toBe(true)
        if (sync && constructDataEqual(prev, next)) expect(cmds).toEqual([])
      }
      prev = next
      sync = true
    }
  })

  it('ConstructDataSync sends a replace first, diffs after, and replaces again after reset (reconnect)', () => {
    const sync = new ConstructDataSync()
    const data = g(base)
    expect(sync.update('kg', data)[0]).toMatchObject({ mode: 'replace' })
    expect(sync.update('kg', data)).toEqual([])
    const changed = { nodes: data.nodes.map((n) => (n.id === 'a' ? { ...n, label: 'A2' } : n)), edges: data.edges }
    const d = sync.update('kg', changed)
    expect(d).toHaveLength(1)
    expect((d[0] as { nodes: unknown[] }).nodes).toHaveLength(1)
    expect(sync.current('kg')!.nodes.find((n) => n.id === 'a')!.label).toBe('A2')
    sync.reset()
    expect(sync.update('kg', changed)[0]).toMatchObject({ mode: 'replace' })
    sync.forget('kg')
    expect(sync.current('kg')).toBeUndefined()
    expect(sync.update('other', { items: [] })).toHaveLength(1) // first push of an empty construct still clears the stage
  })
})

describe('session orbit', () => {
  const sessions = [
    { id: 's1', projectId: 'p1', title: 'Refactor', status: 'running', agents: [{ id: 's1-main', parentId: null }, { id: 'sub1', parentId: 's1-main', type: 'explorer', status: 'running' }, { id: 'sub2', parentId: 'sub1', type: 'tester', status: 'waiting' }] },
    { id: 's2', projectId: 'p1', title: 'Docs', status: 'waiting_input' },
    { id: 's3', projectId: 'p2', title: 'Fix', status: 'blocked_permission' },
    { id: 's4', projectId: 'ghost', title: 'Lost', status: 'error' },
    { id: 's5', projectId: 'p2', title: 'Old', status: 'done' },
  ]
  const projects = [{ id: 'p2', name: 'Beta', color: '#abcdef' }, { id: 'p1', name: 'Alpha' }]

  it('maps statuses and flags the blocked ones', () => {
    expect(['running', 'waiting_input', 'blocked_permission', 'idle', 'done', 'error', 'stale', 'weird'].map(orbitStatusOf)).toEqual(['running', 'blocked', 'blocked', 'idle', 'done', 'failed', 'failed', 'idle'])
    const r = sessionOrbit(sessions, projects)
    expect(r.counts).toEqual({ running: 1, blocked: 2, idle: 0, done: 1, failed: 1, total: 5 })
    expect(r.summary).toBe('1 running, 2 waiting for you, 1 failed, 1 done')
    const blocked = r.items.filter((i) => i.blocked === true && i.kind === 'session')
    expect(blocked.map((i) => i.id).sort()).toEqual(['session:s2', 'session:s3'])
    expect(blocked.every((i) => i.flare === true && i.brightness === 1)).toBe(true)
  })
  it('puts every session around its project, gives orphans an Unassigned project, and subagents orbit their parent', () => {
    const r = sessionOrbit(sessions, projects)
    const byId = new Map(r.items.map((i) => [i.id as string, i]))
    expect((byId.get('session:s1')!.orbit as { around: string }).around).toBe('project:p1')
    expect((byId.get('session:s4')!.orbit as { around: string }).around).toBe('project:ghost')
    expect(byId.get('project:ghost')!.label).toBe('Unassigned')
    expect(byId.get('project:p1')).toMatchObject({ sessions: 2, blocked: 1, label: 'Alpha' })
    expect((byId.get('agent:s1:sub1')!.orbit as { around: string }).around).toBe('session:s1')
    expect((byId.get('agent:s1:sub2')!.orbit as { around: string }).around).toBe('agent:s1:sub1')
    expect(byId.get('agent:s1:sub2')!.blocked).toBe(true)
    expect(byId.get('project:p2')!.color).toBe('#abcdef')
  })
  it('is deterministic, order independent and finite', () => {
    const a = sessionOrbit(sessions, projects)
    const b = sessionOrbit([...sessions].reverse(), [...projects].reverse())
    const norm = (r: { items: unknown[] }) => stableJson([...r.items].sort((x, y) => ((x as { id: string }).id < (y as { id: string }).id ? -1 : 1)))
    expect(norm(a)).toBe(norm(b))
    expect(JSON.stringify(a.items).includes('null')).toBe(false)
    for (const it of a.items) {
      const orbit = it.orbit as { radius: number; phase: number; speed: number; inclination: number } | undefined
      if (orbit) for (const v of Object.values(orbit)) if (typeof v === 'number') expect(Number.isFinite(v)).toBe(true)
      if (orbit) expect(orbit.radius).toBeLessThanOrEqual(2.2)
    }
  })
  it('handles no sessions', () => {
    expect(sessionOrbit([], [])).toMatchObject({ items: [], summary: 'no sessions', counts: { total: 0 } })
    expect(sessionOrbit([], [{ id: 'p' }]).items).toHaveLength(1)
  })
  it('works with a hundred sessions without producing duplicate ids', () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ id: `s${i}`, projectId: `p${i % 7}`, status: i % 3 === 0 ? 'running' : 'idle' }))
    const r = sessionOrbit(many, [])
    expect(new Set(r.items.map((i) => i.id)).size).toBe(r.items.length)
  })
})

describe('timeline ribbon', () => {
  const H = 3_600_000
  const now = T0 // Monday 08:15 local
  it('places events relative to now, lights today and fades the past', () => {
    const r = timelineRibbon(
      [
        { id: 'standup', title: 'Standup', startMs: now + 0.5 * H, endMs: now + H, kind: 'meeting' },
        { id: 'lunch', title: 'Lunch', startMs: now + 4 * H, important: true },
        { id: 'earlier', title: 'Earlier', startMs: now - 2 * H, endMs: now - H },
        { id: 'tomorrow', title: 'Tomorrow', startMs: now + 24 * H },
        { id: 'ongoing', title: 'Ongoing', startMs: now - 0.25 * H, endMs: now + 0.5 * H },
      ],
      { nowMs: now },
    )
    const by = new Map(r.items.map((i) => [i.id as string, i]))
    expect(by.get('now')).toMatchObject({ position: [0, 0, 0] })
    expect((by.get('event:standup')!.position as number[])[0]).toBeCloseTo(0.25)
    expect(by.get('event:standup')).toMatchObject({ kind: 'meeting', isToday: true, isPast: false, brightness: 1 })
    expect(by.get('event:earlier')).toMatchObject({ isPast: true, isToday: true, brightness: 0.45 })
    expect(by.get('event:ongoing')).toMatchObject({ isNow: true, brightness: 1 })
    expect(by.get('event:lunch')!.important).toBe(true)
    expect(by.get('event:tomorrow')!.isToday).toBe(false)
    expect((by.get('event:tomorrow')!.position as number[])[0]).toBeCloseTo(12)
  })
  it('stacks overlapping events into lanes and never overlaps within a lane', () => {
    const events = Array.from({ length: 12 }, (_, i) => ({ id: `e${i}`, title: `E${i}`, startMs: now + i * 10 * 60_000, endMs: now + i * 10 * 60_000 + 50 * 60_000 }))
    const r = timelineRibbon(events, { nowMs: now })
    const lanes = new Map<number, Array<[number, number]>>()
    for (const it of r.items.filter((i) => i.kind === 'event')) {
      const x = (it.position as number[])[0]!
      const arr = lanes.get(it.lane as number) ?? []
      arr.push([x, x + (it.length as number)])
      lanes.set(it.lane as number, arr)
    }
    for (const arr of lanes.values()) {
      arr.sort((a, b) => a[0] - b[0])
      for (let i = 1; i < arr.length; i++) expect(arr[i]![0]).toBeGreaterThanOrEqual(arr[i - 1]![1] - 2e-3) // values are rounded to millimetres
    }
    expect(lanes.size).toBeGreaterThan(1)
    const ys = r.items.filter((i) => i.kind === 'event').map((i) => (i.position as number[])[1])
    expect(ys.every(Number.isFinite)).toBe(true)
  })
  it('drops events outside the window and invalid ones, caps the count to the nearest', () => {
    const r = timelineRibbon(
      [
        { id: 'far', title: 'far', startMs: now + 100 * H },
        { id: 'old', title: 'old', startMs: now - 100 * H },
        { id: 'nan', title: 'nan', startMs: NaN },
        { id: 'backwards', title: 'b', startMs: now, endMs: now - 1 },
        { id: '', title: 'noid', startMs: now },
        { id: 'ok', title: 'ok', startMs: now + H },
      ],
      { nowMs: now },
    )
    expect(r.items.filter((i) => i.kind !== 'now').map((i) => i.id)).toEqual(['event:ok'])
    const many = Array.from({ length: 300 }, (_, i) => ({ id: `e${i}`, title: 'x', startMs: now + i * 60_000 }))
    const capped = timelineRibbon(many, { nowMs: now, maxEvents: 20 })
    expect(capped.shown).toBe(20)
    expect(capped.items.some((i) => i.id === 'event:e0')).toBe(true)
    expect(capped.items.some((i) => i.id === 'event:e100')).toBe(false)
  })
  it('is deterministic', () => {
    const ev = [{ id: 'a', title: 'A', startMs: now + H }, { id: 'b', title: 'B', startMs: now + H }]
    expect(timelineRibbon(ev, { nowMs: now })).toEqual(timelineRibbon([...ev].reverse(), { nowMs: now }))
  })
})

describe('terminal pane binding', () => {
  it('builds a terminal_pane construct bound to a terminal id', () => {
    const c = createTerminalPaneConstruct({ terminalId: 't1' })
    expect(c).toMatchObject({ id: 'term_t1', kind: 'terminal_pane', source: 'terminal', query: { terminalId: 't1' }, interactive: true })
  })
  it('chunks output without splitting surrogate pairs and reproduces the data', () => {
    const data = 'ab\u{1F600}'.repeat(3000)
    const chunks = chunkTerminalOutput(data, 101)
    expect(chunks.join('')).toBe(data)
    for (const ch of chunks) {
      expect(ch.length).toBeLessThanOrEqual(101)
      const last = ch.charCodeAt(ch.length - 1)
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false)
    }
    expect(chunkTerminalOutput('')).toEqual([])
    expect(chunkTerminalOutput('\u001b[32mok\u001b[0m')).toEqual(['\u001b[32mok\u001b[0m'])
  })
  it('routes output to every bound pane and input/resize back to the terminal', () => {
    const b = new TerminalBindings()
    expect(b.bind('pane1', 't1').ok).toBe(true)
    expect(b.bind('pane2', 't1').ok).toBe(true)
    expect(b.bind('../x', 't1').ok).toBe(false)
    expect(b.writeCommands('t1', 'hi')).toEqual([
      { type: 'construct.terminal.write', constructId: 'pane1', data: 'hi' },
      { type: 'construct.terminal.write', constructId: 'pane2', data: 'hi' },
    ])
    expect(b.writeCommands('nope', 'hi')).toEqual([])
    expect(b.routeInput({ constructId: 'pane1', data: 'ls\r' })).toEqual({ ok: true, value: { terminalId: 't1', data: 'ls\r' } })
    expect(b.routeInput({ constructId: 'ghost', data: 'x' })).toMatchObject({ ok: false, code: 'not_bound' })
    expect(b.routeInput({ constructId: 'pane1', data: '' }).ok).toBe(false)
    expect(b.routeInput({ constructId: 'pane1', data: 'x'.repeat(5000) })).toMatchObject({ ok: false, code: 'too_large' })
    expect(b.routeResize({ constructId: 'pane1', cols: 5000, rows: 1 })).toEqual({ ok: true, value: { terminalId: 't1', cols: 400, rows: 5 } })
    expect(b.routeResize({ constructId: 'pane1', cols: 80.5, rows: 24 }).ok).toBe(false)
    expect(b.unbind('pane1')).toBe(true)
    expect(b.terminalOf('pane1')).toBeUndefined()
    expect(b.constructsOf('t1')).toEqual(['pane2'])
  })
  it('error results never echo terminal content', () => {
    const b = new TerminalBindings()
    b.bind('p', 't')
    const secret = 'sk-ant-SECRET'.padEnd(5000, 'x')
    const r = b.routeInput({ constructId: 'p', data: secret })
    expect(JSON.stringify(r)).not.toContain('SECRET')
  })
})
