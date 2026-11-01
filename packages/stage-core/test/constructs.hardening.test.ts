import { describe, expect, it } from 'vitest'
import { DEFAULT_MAX_EDGES, DEFAULT_MAX_EDGES_PER_NODE, MAX_EDGES, MAX_WRITE_CHUNK, applyCommands, buildKnowledgeGraph, chunkTerminalOutput, emptyConstructData, layoutGraph, replaceCommands, timelineRibbon } from '../src'
import type { GraphNoteInput } from '../src'
import { lcg } from './helpers'

/**
 * Regression tests for the construct findings: chunkTerminalOutput must terminate for any max, a graph must never carry
 * more edges than a stage accepts, timelines and layouts must never produce a non-finite number, whatever the inputs.
 */

describe('chunkTerminalOutput terminates for any max and never splits a surrogate pair (LOW: terminal-helpers-hostile)', () => {
  const MAXES = [0, 1, 2, 3, -5, -0, 1.5, 2.9, 7, 16, 1e9, Number.MAX_SAFE_INTEGER, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.MIN_VALUE, null as unknown as number, undefined as unknown as number]
  const emoji = '😀'
  it.each(MAXES)('max = %s', (max) => {
    for (const data of ['', 'abcdef', emoji + emoji, 'a' + emoji + 'b', emoji.repeat(50), 'x'.repeat(100_000), '\ud83d', '\ude00', '\ud83d😀', 'a\ud83d']) {
      const chunks = chunkTerminalOutput(data, max)
      expect(chunks.join(''), JSON.stringify(data.slice(0, 20))).toBe(data)
      for (const c of chunks) expect(c.length).toBeGreaterThan(0) // every chunk makes progress
    }
  })
  it('the two reported hangs now finish', () => {
    expect(chunkTerminalOutput(emoji + emoji, 1)).toEqual([emoji, emoji])
    expect(chunkTerminalOutput('abcdef', 0)).toEqual(['ab', 'cd', 'ef'])
  })
  it('the default and the limits', () => {
    expect(chunkTerminalOutput('x'.repeat(MAX_WRITE_CHUNK + 1))).toHaveLength(2)
    expect(chunkTerminalOutput('x'.repeat(200_000), Number.POSITIVE_INFINITY).length).toBe(Math.ceil(200_000 / 65_536))
    expect(chunkTerminalOutput(5 as unknown as string)).toEqual([])
  })
  it('property: random strings with random pairs, random sizes: lossless, no chunk longer than the size, no split pair', () => {
    const r = lcg(5)
    const alphabet = ['a', 'b', ' ', '\n', emoji, '🌍', '中', '\u001b[0m']
    for (let i = 0; i < 400; i++) {
      let data = ''
      for (let k = 0; k < Math.floor(r() * 60); k++) data += alphabet[Math.floor(r() * alphabet.length)]
      const size = 2 + Math.floor(r() * 20)
      const chunks = chunkTerminalOutput(data, size)
      expect(chunks.join('')).toBe(data)
      for (let c = 0; c < chunks.length; c++) {
        expect(chunks[c]!.length).toBeLessThanOrEqual(size)
        const last = chunks[c]!.charCodeAt(chunks[c]!.length - 1)
        expect(last >= 0xd800 && last <= 0xdbff).toBe(false) // never ends in the first half of a pair
      }
    }
  })
})

describe('the graph never carries more edges than a stage accepts (LOW: constructs-edge-explosion-vs-limits)', () => {
  const everything = (n: number): GraphNoteInput[] => {
    const ids = Array.from({ length: n }, (_, i) => `note-${String(i).padStart(4, '0')}`)
    return ids.map((id) => ({ id, title: id, body: ids.filter((x) => x !== id).map((x) => `[[${x}]]`).join(' ') }))
  }
  it('400 notes linking to all the others: the edges are capped, and a stage accepts what is produced', () => {
    const g = buildKnowledgeGraph(everything(400), { maxNodes: 400 })
    expect(g.edges.length).toBeLessThanOrEqual(DEFAULT_MAX_EDGES)
    expect(g.edges.length).toBeLessThanOrEqual(MAX_EDGES)
    expect(g.stats.edges).toBe(g.edges.length)
    expect(g.stats.droppedEdges).toBe(400 * 399 - g.edges.length)
    const degree = new Map<string, number>()
    for (const e of g.edges) for (const id of [e.from, e.to]) degree.set(id, (degree.get(id) ?? 0) + 1)
    expect(Math.max(...degree.values())).toBeLessThanOrEqual(DEFAULT_MAX_EDGES_PER_NODE)
    // the consumer limit holds: the replace commands apply to a stage's construct state without refusal
    const applied = applyCommands(emptyConstructData(), replaceCommands('k', { nodes: g.nodes, edges: g.edges }))
    expect(applied).toBeDefined()
    expect(applied!.edges.length).toBe(g.edges.length)
    expect(g.nodes.every((n) => n.position!.every(Number.isFinite))).toBe(true)
  })
  it('keeps the heaviest links first, deterministically and independently of input order', () => {
    const notes: GraphNoteInput[] = [
      { id: 'a', body: '[[b]] [[b]] [[b]] [[c]] [[d]]' }, // a->b has weight 3
      { id: 'b', body: '' },
      { id: 'c', body: '' },
      { id: 'd', body: '' },
    ]
    const g = buildKnowledgeGraph(notes, { maxEdges: 1 })
    expect(g.edges).toEqual([{ from: 'a', to: 'b', weight: 3 }])
    expect(g.stats).toMatchObject({ edges: 1, droppedEdges: 2 })
    const again = buildKnowledgeGraph([...notes].reverse(), { maxEdges: 1 })
    expect(again.edges).toEqual(g.edges)
    const perNode = buildKnowledgeGraph(notes, { maxEdgesPerNode: 2 })
    expect(perNode.edges.map((e) => `${e.from}>${e.to}`)).toEqual(['a>b', 'a>c'])
  })
  it('small graphs are untouched and the caps are sanitised', () => {
    const notes: GraphNoteInput[] = [{ id: 'a', body: '[[b]]' }, { id: 'b', body: '[[c]]' }, { id: 'c', body: '[[a]]' }]
    const g = buildKnowledgeGraph(notes)
    expect(g.edges).toHaveLength(3)
    expect(g.stats.droppedEdges).toBe(0)
    for (const maxEdges of [Number.NaN, Number.POSITIVE_INFINITY, -4, 1e12]) {
      expect(buildKnowledgeGraph(notes, { maxEdges }).edges.length).toBeLessThanOrEqual(MAX_EDGES)
    }
    expect(buildKnowledgeGraph(notes, { maxEdges: 0 }).edges).toEqual([])
    expect(buildKnowledgeGraph(notes, { maxEdgesPerNode: Number.NaN }).edges).toHaveLength(3)
  })
})

describe('timelines and layouts never produce a number that is not finite (LOW: wire-nan-timeline-overflow, wire-nan-layout-options)', () => {
  const allFinite = (v: unknown): boolean => {
    if (typeof v === 'number') return Number.isFinite(v)
    if (Array.isArray(v)) return v.every(allFinite)
    if (v !== null && typeof v === 'object') return Object.values(v).every(allFinite)
    return true
  }
  const NOW = new Date(2026, 10, 2, 9, 0, 0).getTime()

  it('the reported overflow (an event from -MAX_VALUE to MAX_VALUE) gives a finite, bounded length', () => {
    const r = timelineRibbon([{ id: 'a', title: 'forever', startMs: -Number.MAX_VALUE, endMs: Number.MAX_VALUE }], { nowMs: NOW })
    expect(allFinite(r.items)).toBe(true)
    const r2 = timelineRibbon([{ id: 'a', title: 'long', startMs: NOW, endMs: NOW + 1e15 }], { nowMs: NOW })
    const item = r2.items.find((i) => i.id === 'event:a') as { length: number } | undefined
    expect(item).toBeDefined()
    expect(item!.length).toBeLessThanOrEqual(((6 + 48) * 0.5) + 1e-9) // as long as the window, at 0.5 m per hour
  })
  it('hostile options and timestamps: every number out is finite', () => {
    const BAD = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.MAX_VALUE, -Number.MAX_VALUE, 1e300, -1e300, 0, -1, 2 ** 53, Number.MIN_VALUE]
    for (const x of BAD) {
      const r = timelineRibbon(
        [{ id: 'e', title: 't', startMs: NOW + 1000, endMs: NOW + 5000 }, { id: 'f', title: 'u', startMs: x, endMs: x }, { id: 'g', title: 'v', startMs: x }],
        { nowMs: x, pastMs: x, futureMs: x, unitsPerHour: x, maxEvents: x },
      )
      expect(allFinite(r.items), `option ${x}`).toBe(true)
      expect(Number.isFinite(r.shown) && Number.isFinite(r.dropped)).toBe(true)
      const r2 = timelineRibbon([{ id: 'e', title: 't', startMs: NOW + 1000 }], { nowMs: NOW, pastMs: x, futureMs: x, unitsPerHour: x })
      expect(allFinite(r2.items), `window ${x}`).toBe(true)
    }
    expect(timelineRibbon(null as never, { nowMs: NOW }).items).toHaveLength(1) // only the "now" marker
  })
  it('property: random events and options', () => {
    const r = lcg(31)
    const pool = [NOW, NOW - 3_600_000, NOW + 86_400_000, 0, -1e12, 1e15, Number.MAX_VALUE, -Number.MAX_VALUE, Number.NaN, Number.POSITIVE_INFINITY, 8.64e15, -8.64e15]
    const pick = (): number => pool[Math.floor(r() * pool.length)]!
    for (let i = 0; i < 300; i++) {
      const events = Array.from({ length: 1 + Math.floor(r() * 6) }, (_, k) => ({ id: `e${k}`, title: 't', startMs: pick(), ...(r() < 0.7 ? { endMs: pick() } : {}) }))
      const out = timelineRibbon(events, { nowMs: r() < 0.8 ? NOW : pick(), pastMs: r() < 0.5 ? pick() : undefined, futureMs: r() < 0.5 ? pick() : undefined, unitsPerHour: r() < 0.5 ? pick() : undefined })
      expect(allFinite(out.items)).toBe(true)
    }
  })

  it('layout options: NaN, Infinity and absurd values are clamped, positions stay finite and inside the radius', () => {
    const nodes = Array.from({ length: 12 }, (_, i) => ({ id: `n${i}`, importance: 1 + (i % 5), layer: (['core', 'strategy', 'episodic', 'semantic', 'project', 'inbox'] as const)[i % 6] }))
    const edges = [{ from: 'n0', to: 'n1', weight: 1 }, { from: 'n2', to: 'n3', weight: 2 }, { from: 'n4', to: 'n5', weight: 1 }]
    const BAD = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1e308, -1e308, 0, -3, 1e-300]
    for (const x of BAD) {
      for (const opts of [{ radius: x }, { depthStep: x }, { iterations: x }, { radius: x, depthStep: x, iterations: x }]) {
        const pos = layoutGraph(nodes, edges, opts)
        expect(pos.size).toBe(nodes.length)
        for (const [id, p] of pos) {
          expect(p.every(Number.isFinite), `${id} ${JSON.stringify(opts)}`).toBe(true)
          expect(Math.hypot(p[0], p[1])).toBeLessThanOrEqual(100)
          expect(Math.abs(p[2])).toBeLessThanOrEqual(100)
        }
      }
    }
  })
  it('the production defaults are unchanged for sane options', () => {
    const nodes = [{ id: 'a', importance: 3 }, { id: 'b', importance: 2, layer: 'core' as const }]
    expect(layoutGraph(nodes, [], { radius: 6, depthStep: 1.2 })).toEqual(layoutGraph(nodes, []))
  })
})
