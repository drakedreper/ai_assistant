import { describe, expect, it } from 'vitest'
import { BOUNDED_JSON_LIMITS, STAGE_CLOCK_MAX_MS, STAGE_PROTOCOL, StageCommand, StageEvent, isBoundedJson } from '@ai-assistant/shared'
import type { StageCapabilities } from '@ai-assistant/shared'
import { createMemoryTransportPair, createSequentialIds, createStageSession, createVirtualTime, serialise, utf8Length } from '../src'
import type { CommandDraft, StageTransport } from '../src'
import { T0, lcg } from './helpers'

/**
 * Regression tests for the session and schema findings: NaN / Infinity / BigInt / cycles inside the open-ended record
 * fields (HIGH), `send` that never rejects (weird drafts, a throwing transport, a throwing listener), duplicate command
 * ids, a failed character.load that must not hold a stage slot, UTF-8 byte limits and absurd stage clocks.
 */

const caps = (over: Partial<StageCapabilities> = {}): StageCapabilities => ({
  engine: 'sim',
  engineVersion: '0',
  rigFamilies: ['vrm1'],
  face: { arkit52: true, visemes: false, audioToFaceOnStage: false },
  render: { strandHair: false, clothSim: false, runtimeAssetLoading: true, embeddedStream: false },
  tracking: { face: false, body: false },
  constructs: ['knowledge_graph', 'session_orbit'],
  maxCharacters: 1,
  ...over,
})

function manual(opts: { transport?: (t: StageTransport) => StageTransport; session?: Record<string, unknown> } = {}) {
  const vt = createVirtualTime(T0)
  const pair = createMemoryTransportPair({ timers: vt.timers })
  const transport = opts.transport ? opts.transport(pair.backend) : pair.backend
  const session = createStageSession({ transport, clock: vt.clock, timers: vt.timers, newId: createSequentialIds(), ...opts.session })
  const hello = (c: StageCapabilities = caps(), clockMs: number = vt.now()) => pair.stage.sendText(JSON.stringify({ type: 'hello', protocol: STAGE_PROTOCOL, capabilities: c, stageClockMs: clockMs }))
  const sent = () => pair.backend.sentText.map((t) => JSON.parse(t) as { id: string; type: string; [k: string]: unknown })
  const answer = (id: string, ok = true) => pair.stage.sendText(JSON.stringify(ok ? { type: 'command.done', id } : { type: 'command.failed', id, reason: 'no' }))
  return { vt, pair, session, hello, sent, answer }
}

const kg = { id: 'k', kind: 'knowledge_graph', transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, source: 'brain' }
const data = (items: unknown[]): CommandDraft => ({ type: 'scene.data', constructId: 'k', mode: 'merge', items: items as Array<Record<string, unknown>> })

describe('open-ended record fields carry plain, finite, bounded JSON only (HIGH: wire-nan-in-unknown-fields)', () => {
  const circular = (): Record<string, unknown> => {
    const o: Record<string, unknown> = { id: 'c' }
    o.self = o
    return o
  }
  const deep = (n: number): Record<string, unknown> => {
    let cur: Record<string, unknown> = { id: 'd' }
    const root = cur
    for (let i = 0; i < n; i++) {
      const next: Record<string, unknown> = {}
      cur.n = next
      cur = next
    }
    return root
  }
  const BAD: Array<[string, Record<string, unknown>]> = [
    ['NaN', { id: 'a', radius: Number.NaN }],
    ['Infinity inside an array', { id: 'a', position: [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0] }],
    ['-Infinity nested', { id: 'a', meta: { deeper: { v: Number.NEGATIVE_INFINITY } } }],
    ['BigInt', { id: 'a', n: 10n }],
    ['circular', circular()],
    ['too deep', deep(12)],
    ['a function', { id: 'a', f: () => 1 }],
    ['a symbol value', { id: 'a', s: Symbol('x') }],
    ['a Date', { id: 'a', d: new Date(0) }],
    ['a Map', { id: 'a', m: new Map() }],
    ['a class instance', { id: 'a', o: new (class Foo { x = 1 })() }],
    ['undefined in an array', { id: 'a', xs: [1, undefined, 3] }],
    ['a nested getter', { id: 'a', inner: Object.defineProperty({}, 'g', { enumerable: true, get: () => 1 }) }],
    ['a nested getter that throws', { id: 'a', inner: Object.defineProperty({}, 'g', { enumerable: true, get: () => { throw new Error('boom') } }) }],
    ['a symbol key', { id: 'a', [Symbol('k')]: 1 }],
    ['a nested __proto__ key', { id: 'a', inner: JSON.parse('{"__proto__":{"x":1}}') as Record<string, unknown> }],
    ['a huge string', { id: 'a', s: 'x'.repeat(BOUNDED_JSON_LIMITS.maxString + 1) }],
    ['a huge key', { id: 'a', ['k'.repeat(BOUNDED_JSON_LIMITS.maxKey + 1)]: 1 }],
    ['a huge array', { id: 'a', xs: new Array(BOUNDED_JSON_LIMITS.maxArray + 1).fill(0) }],
    ['too many values', { id: 'a', xs: Array.from({ length: 300 }, () => ({ a: 1, b: 2 })) }],
    ['a number beyond 2^53', { id: 'a', n: 1e300 }],
  ]
  it.each(BAD)('scene.data refuses an item with %s, sends nothing and resolves a failed result', async (_n, item) => {
    const m = manual()
    m.hello()
    const r = await m.session.send(data([item]))
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/invalid command|cannot be serialised/)
    expect(m.sent()).toHaveLength(0)
  })

  it('at the top level of an item, zod copies the record: a getter is read once into a plain value and an own __proto__ key is dropped', async () => {
    const m = manual()
    m.hello()
    let reads = 0
    const withGetter = Object.defineProperty({ id: 'a' }, 'g', { enumerable: true, get: () => ++reads })
    const withProto = JSON.parse('{"id":"b","__proto__":{"polluted":true}}') as Record<string, unknown>
    const p = m.session.send(data([withGetter, withProto]))
    const wire = m.sent()[0]!
    expect(wire.items).toEqual([{ id: 'a', g: 1 }, { id: 'b' }])
    expect(reads).toBe(1)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    m.answer(wire.id)
    expect((await p).ok).toBe(true)
  })

  it('a construct query is held to the same rule (scene.construct add and update)', async () => {
    const m = manual()
    m.hello()
    for (const query of [{ layer: Number.NaN }, { layer: Number.POSITIVE_INFINITY }, { a: { b: 10n } }, circular(), deep(9)]) {
      for (const op of ['add', 'update'] as const) {
        const r = await m.session.send({ type: 'scene.construct', op, construct: { ...kg, query } as never })
        expect(r.ok, `${op} ${JSON.stringify(Object.keys(query))}`).toBe(false)
      }
    }
    expect(m.sent()).toHaveLength(0)
    const ok = m.session.send({ type: 'scene.construct', op: 'add', construct: { ...kg, query: { layer: 'strategy', limit: 20, tags: ['a', 'b'], nested: { x: [1, 2, { y: null }] } } } as never })
    expect(m.sent()).toHaveLength(1)
    m.answer(m.sent()[0]!.id)
    expect((await ok).ok).toBe(true)
  })

  it('a stored scene whose construct query is not plain JSON does not parse either', () => {
    expect(StageCommand.safeParse({ id: 'x', type: 'scene.construct', op: 'add', construct: { ...kg, query: { layer: Number.NaN } } }).success).toBe(false)
    expect(StageCommand.safeParse({ id: 'x', type: 'scene.construct', op: 'add', construct: { ...kg, query: { layer: 'ok' } } }).success).toBe(true)
  })

  it('finite numbers, strings, booleans, null, nested objects and arrays still go through unchanged', async () => {
    const m = manual()
    m.hello()
    const item = { id: 'a', radius: 0.25, label: 'Q4 plan é中😀', ok: true, none: null, position: [1, -2, 3.5], meta: { tags: ['x', 'y'], nested: { n: -0 } } }
    const p = m.session.send(data([item]))
    const wire = m.sent()[0]!
    expect(wire.items).toEqual(JSON.parse(JSON.stringify([item])))
    m.answer(wire.id)
    expect((await p).ok).toBe(true)
  })

  it('property: whatever is sent parses back to exactly what was validated, and a non-finite number is never written as null', async () => {
    const r = lcg(2027)
    const specials: unknown[] = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1e300, -1e300, 10n, undefined, () => 0, Symbol('s'), new Date(), 0, -0, 1, -1, 0.5, 'text', '', true, false, null]
    const gen = (depth: number): unknown => {
      const k = r()
      if (depth > 4 || k < 0.35) return specials[Math.floor(r() * specials.length)]
      if (k < 0.6) return Array.from({ length: Math.floor(r() * 4) }, () => gen(depth + 1))
      const o: Record<string, unknown> = {}
      for (let i = 0; i < Math.floor(r() * 4); i++) o[`k${i}`] = gen(depth + 1)
      return o
    }
    const hasHostile = (v: unknown): boolean => {
      if (typeof v === 'number') return !Number.isFinite(v) || Math.abs(v) > Number.MAX_SAFE_INTEGER
      if (typeof v === 'bigint' || typeof v === 'function' || typeof v === 'symbol') return true
      if (v === undefined) return false // inside an object it is dropped; inside an array the check below catches it
      if (v instanceof Date) return true
      if (Array.isArray(v)) return v.some((x) => x === undefined || hasHostile(x))
      if (v !== null && typeof v === 'object') return Object.values(v).some(hasHostile)
      return false
    }
    let accepted = 0
    let refused = 0
    for (let i = 0; i < 600; i++) {
      const m = manual()
      m.hello()
      const item = { id: `i${i}`, v: gen(0) } as Record<string, unknown>
      const p = m.session.send(data([item]))
      const sent = m.sent()
      if (sent.length === 1) {
        accepted++
        expect(hasHostile(item), JSON.stringify(item)).toBe(false)
        expect(sent[0]!.items).toEqual(JSON.parse(JSON.stringify([item])))
        m.answer(sent[0]!.id)
        expect((await p).ok).toBe(true)
      } else {
        refused++
        expect((await p).ok).toBe(false)
        // the generator stays inside the depth and size limits, so only a hostile value can be the reason
        expect(hasHostile(item), JSON.stringify(item, (_k, v) => (typeof v === 'bigint' ? `${v}n` : typeof v === 'number' && !Number.isFinite(v) ? String(v) : v))).toBe(true)
      }
    }
    expect(accepted).toBeGreaterThan(50)
    expect(refused).toBeGreaterThan(50)
  })

  it('isBoundedJson: examples, limits and never throwing', () => {
    expect(isBoundedJson({ a: [1, 'x', null, { b: true }] })).toBe(true)
    expect(isBoundedJson({ a: Number.NaN })).toBe(false)
    expect(isBoundedJson(Object.create(null) as object)).toBe(true)
    expect(isBoundedJson(new Proxy({}, { ownKeys: () => { throw new Error('boom') } }))).toBe(false)
    expect(isBoundedJson(new Proxy({}, { getPrototypeOf: () => { throw new Error('boom') } }))).toBe(false)
    expect(isBoundedJson({ a: { b: { c: 1 } } }, { maxDepth: 2 })).toBe(false)
    expect(isBoundedJson({ a: 1, b: 2 }, { maxNodes: 2 })).toBe(false)
    expect(isBoundedJson({ a: 1, b: 2 }, { maxNodes: 3 })).toBe(true)
    // a value in a record that is `undefined` or non-enumerable is left out by JSON.stringify, so it is not a problem
    expect(isBoundedJson({ a: undefined, b: 1 })).toBe(true)
  })
})

describe('send never rejects and dispatch never throws (LOW: session-send-never-rejects-weird-drafts)', () => {
  const circular = (): Record<string, unknown> => {
    const o: Record<string, unknown> = {}
    o.self = o
    return o
  }
  const WEIRD: Array<[string, unknown]> = [
    ['null', null],
    ['undefined', undefined],
    ['a number', 5],
    ['a string', 'perform.idle'],
    ['an array', [{ type: 'perform.idle', profile: 'busy' }]],
    ['a BigInt id', { type: 'perform.idle', profile: 'busy', id: 5n }],
    ['a draft with a getter that throws', Object.defineProperty({ type: 'perform.idle' }, 'profile', { enumerable: true, get: () => { throw new Error('boom') } })],
    ['a Proxy that throws', new Proxy({}, { get: () => { throw new Error('boom') }, ownKeys: () => { throw new Error('boom') } })],
    ['a numeric id', { type: 'perform.idle', profile: 'busy', id: 5 }],
    ['an empty id', { type: 'perform.idle', profile: 'busy', id: '' }],
    ['an id that is far too long', { type: 'perform.idle', profile: 'busy', id: 'x'.repeat(500) }],
  ]
  it.each(WEIRD)('resolves a failed result for %s (before and after the hello)', async (_n, draft) => {
    const m = manual()
    // before the hello it waits; after it, the answer is a failed result
    m.hello()
    const r = await m.session.send(draft as CommandDraft)
    expect(r.ok).toBe(false)
    expect(typeof r.reason).toBe('string')
    expect(m.sent()).toHaveLength(0)
    const ok = m.session.send({ type: 'perform.idle', profile: 'busy' })
    expect(m.sent()).toHaveLength(1)
    m.answer(m.sent()[0]!.id)
    expect((await ok).ok).toBe(true)
  })
  it('keys the schema does not know are stripped, so a circular or throwing extra field cannot reach the wire', async () => {
    const m = manual()
    m.hello()
    const p = m.session.send({ type: 'perform.gaze', target: { kind: 'user' }, extra: circular(), toJSON: () => { throw new Error('boom') }, big: 10n } as unknown as CommandDraft)
    const wire = m.sent()[0]!
    expect(wire).not.toHaveProperty('extra')
    expect(wire).not.toHaveProperty('big')
    expect(wire.type).toBe('perform.gaze')
    m.answer(wire.id)
    expect((await p).ok).toBe(true)
  })
  it('a weird opts argument is tolerated too', async () => {
    const m = manual()
    m.hello()
    const r = m.session.send({ type: 'perform.idle', profile: 'busy' }, null as never)
    expect(m.sent()).toHaveLength(1)
    m.answer(m.sent()[0]!.id)
    expect((await r).ok).toBe(true)
  })
  it('sendMany with weird entries still answers every one', async () => {
    const m = manual()
    m.hello()
    const res = await m.session.sendMany([null as never, 5 as never, circular() as never])
    expect(res.map((x) => x.ok)).toEqual([false, false, false])
  })
  it('serialise: refuses what JSON.stringify would write wrongly or throw on', () => {
    expect(serialise({ a: 1 })).toBe('{"a":1}')
    expect(serialise({ a: Number.NaN })).toBeUndefined()
    expect(serialise({ a: [Number.POSITIVE_INFINITY] })).toBeUndefined()
    expect(serialise({ a: 1n })).toBeUndefined()
    expect(serialise(circular())).toBeUndefined()
    expect(serialise({ toJSON: () => { throw new Error('x') } })).toBeUndefined()
    expect(serialise(undefined)).toBeUndefined()
  })
})

describe('a transport that throws (LOW: session-transport-sendtext-throws)', () => {
  it('send resolves transport_error, the slot is free at once, and the queue moves on', async () => {
    let boom = true
    const m = manual({
      transport: (t) => ({ ...t, sendText: (d: string) => { if (boom) throw new Error('EPIPE'); t.sendText(d) } }),
      session: { maxInFlight: 2, commandTimeoutMs: 5000 },
    })
    m.hello()
    const a = await m.session.send({ type: 'perform.idle', profile: 'busy' })
    const b = await m.session.send({ type: 'perform.idle', profile: 'sleepy' })
    const c = await m.session.send({ type: 'perform.idle', profile: 'relaxed' })
    for (const r of [a, b, c]) expect(r).toEqual({ ok: false, reason: 'transport_error' })
    expect(m.session.stats()).toMatchObject({ inFlight: 0, transportErrors: 3, sent: 0 })
    // with the cap at 2 a leaked slot would block the third: it did not, and nothing waits for the 5 s timeout
    expect(m.vt.pending()).toBe(0)
    boom = false
    const d = m.session.send({ type: 'perform.idle', profile: 'busy' })
    expect(m.sent()).toHaveLength(1)
    m.answer(m.sent()[0]!.id)
    expect((await d).ok).toBe(true)
  })
  it('a fire-and-forget command reports it too and is not mirrored', async () => {
    const m = manual({ transport: (t) => ({ ...t, sendText: () => { throw new Error('EPIPE') } }) })
    m.hello()
    const r = await m.session.send({ type: 'perform.idle', profile: 'busy' }, { ack: false })
    expect(r).toEqual({ ok: false, reason: 'transport_error' })
    expect(m.session.mirror.currentLook()).toEqual({})
  })
  it('a binary frame that cannot be sent is reported as not sent', () => {
    const m = manual({ transport: (t) => ({ ...t, sendBinary: () => { throw new Error('EPIPE') } }) })
    m.hello()
    expect(m.session.sendBinary(new Uint8Array(20))).toBe(false)
    expect(m.session.stats().transportErrors).toBe(1)
  })
})

describe('duplicate command ids (LOW: session-duplicate-caller-ids)', () => {
  it('refuses a caller-supplied id that is still in flight; the first command is untouched and settles on its own answer', async () => {
    const m = manual()
    m.hello()
    const first = m.session.send({ type: 'perform.idle', profile: 'busy', id: 'dup' })
    const second = await m.session.send({ type: 'perform.idle', profile: 'sleepy', id: 'dup' })
    expect(second.ok).toBe(false)
    expect(second.reason).toMatch(/duplicate command id "dup"/)
    expect(m.sent()).toHaveLength(1)
    m.vt.advance(4000)
    m.answer('dup')
    expect(await first).toEqual({ ok: true })
    // once settled, the id may be used again
    const again = m.session.send({ type: 'perform.idle', profile: 'sleepy', id: 'dup' })
    expect(m.sent()).toHaveLength(2)
    m.answer('dup')
    expect((await again).ok).toBe(true)
  })
  it('an IdGenerator that repeats itself never orphans a waiting command', async () => {
    const m = manual({ session: { newId: () => 'same' } })
    m.hello()
    const first = m.session.send({ type: 'perform.idle', profile: 'busy' })
    const second = await m.session.send({ type: 'perform.idle', profile: 'sleepy' })
    expect(second.ok).toBe(false)
    expect(second.reason).toMatch(/invalid command id/)
    m.answer('same')
    expect((await first).ok).toBe(true)
  })
  it('a generator that repeats a few times is retried', async () => {
    let n = 0
    const m = manual({ session: { newId: () => (n++ < 3 ? 'same' : `fresh_${n}`) } })
    m.hello()
    const first = m.session.send({ type: 'perform.idle', profile: 'busy' }) // takes 'same' (n=0 -> same)
    expect(m.sent()[0]!.id).toBe('same')
    const second = m.session.send({ type: 'perform.idle', profile: 'sleepy' }) // 'same' (n=1), 'same' (n=2), then fresh
    expect(m.sent()[1]!.id).toMatch(/^fresh_/)
    m.answer(m.sent()[0]!.id)
    m.answer(m.sent()[1]!.id)
    expect((await first).ok && (await second).ok).toBe(true)
  })
})

describe('listeners are isolated (LOW: session-throwing-listener)', () => {
  it('a throwing event listener neither starves the others nor reaches the transport callback; the command still settles', async () => {
    const m = manual()
    const seen: string[] = []
    m.session.onEvent(() => {
      throw new Error('listener bug')
    })
    m.session.onEvent((e) => seen.push(e.type))
    expect(() => m.hello()).not.toThrow() // the hello reaches both listeners
    const p = m.session.send({ type: 'perform.idle', profile: 'busy' })
    expect(() => m.answer(m.sent()[0]!.id)).not.toThrow()
    expect((await p).ok).toBe(true)
    expect(seen).toEqual(['hello', 'command.done'])
    expect(m.session.stats().listenerErrors).toBe(2)
  })
  it('the same holds for protocol-error and close listeners', async () => {
    const m = manual()
    const closed: string[] = []
    m.session.onProtocolError(() => {
      throw new Error('bug')
    })
    m.session.onProtocolError((e) => closed.push(`err:${e.reason}`))
    m.session.onClose(() => {
      throw new Error('bug')
    })
    m.session.onClose((r) => closed.push(`close:${r}`))
    m.hello()
    expect(() => m.pair.stage.sendText('{not json')).not.toThrow()
    expect(() => m.session.close('bye')).not.toThrow()
    expect(closed).toEqual(['err:not valid JSON', 'close:bye'])
    // and registering on a closed session is safe as well
    expect(() => m.session.onClose(() => { throw new Error('bug') })).not.toThrow()
  })
  it('an owner callback that throws in resumeCommands does not take the connection down', async () => {
    const m = manual({ session: { resumeCommands: () => { throw new Error('bug') } } })
    expect(() => m.hello()).not.toThrow()
    await expect(m.session.ready()).resolves.toBeDefined()
    expect(m.session.state).toBe('ready')
  })
})

describe('a failed character.load does not hold a stage slot (LOW: session-capability-adaptation)', () => {
  const profile = (id: string) => ({
    id,
    role: 'assistant',
    name: id,
    baseAssetId: 'b',
    rigFamily: 'vrm1',
    params: {},
    equipped: Object.fromEntries(['hair', 'hairAccessory', 'headwear', 'glasses', 'earrings', 'neck', 'top', 'bottom', 'fullBody', 'outerwear', 'legwear', 'footwear', 'gloves', 'wristwear', 'back', 'tail'].map((s) => [s, null])),
    presets: [],
    voice: { provider: 'kokoro', voiceId: 'd', speed: 1, pitchSemitones: 0 },
    createdAt: 'x',
    updatedAt: 'x',
  })
  const load = (id: string): CommandDraft => ({ type: 'character.load', characterId: id, character: profile(id) as never, assets: [] })

  it('load A is failed by the stage, so load B is accepted (maxCharacters 1)', async () => {
    const m = manual()
    m.hello(caps({ maxCharacters: 1 }))
    const a = m.session.send(load('A'))
    m.answer(m.sent()[0]!.id, false)
    expect((await a).ok).toBe(false)
    const b = m.session.send(load('B'))
    expect(m.sent()).toHaveLength(2)
    m.answer(m.sent()[1]!.id)
    expect((await b).ok).toBe(true)
    // now the slot is really taken: C is refused locally, B again is fine (same character)
    const c = await m.session.send(load('C'))
    expect(c.reason).toMatch(/max_characters/)
    const b2 = m.session.send(load('B'))
    expect(m.sent()).toHaveLength(3)
    m.answer(m.sent()[2]!.id)
    expect((await b2).ok).toBe(true)
  })
  it('a load that is still waiting for its answer holds the slot; a timed-out one frees it', async () => {
    const m = manual()
    m.hello(caps({ maxCharacters: 1 }))
    const a = m.session.send(load('A'))
    const b = await m.session.send(load('B'))
    expect(b.reason).toMatch(/max_characters/)
    m.vt.advance(31_000) // the load timeout
    expect(await a).toEqual({ ok: false, reason: 'timeout' })
    const b2 = m.session.send(load('B'))
    expect(m.sent()).toHaveLength(2)
    m.answer(m.sent()[1]!.id)
    expect((await b2).ok).toBe(true)
  })
  it('a fire-and-forget load counts at once (there is no answer to wait for)', async () => {
    const m = manual()
    m.hello(caps({ maxCharacters: 1 }))
    expect((await m.session.send(load('A'), { ack: false })).ok).toBe(true)
    expect((await m.session.send(load('B'), { ack: false })).reason).toMatch(/max_characters/)
  })
})

describe('sizes are counted in UTF-8 bytes (INFO: session-command-size-limit)', () => {
  it('utf8Length matches TextEncoder for every kind of character', () => {
    for (const s of ['', 'abc', 'é', '中文', '😀', 'a😀b', '\ud83d', '\ude00', '\ud83d😀', '\u0000\u007f\u0080߿ࠀ￿']) {
      expect(utf8Length(s), JSON.stringify(s)).toBe(new TextEncoder().encode(s).length)
    }
  })
  it('a command whose UTF-16 length is under the limit but whose UTF-8 size is over it is refused', async () => {
    const m = manual({ session: { maxCommandBytes: 1000 } })
    m.hello()
    const text = '中'.repeat(330) // 330 UTF-16 units but 990 bytes: the whole command is about 490 units and 1190 bytes
    const r = await m.session.send({ type: 'perform.speak', utteranceId: 'u', text, emotion: 'neutral', audio: { format: 'pcm_s16le', sampleRate: 24000, channels: 1 }, faceSource: 'stage' })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/too large \(\d+ bytes\)/)
    const ok = m.session.send({ type: 'perform.speak', utteranceId: 'u', text: 'a'.repeat(300), emotion: 'neutral', audio: { format: 'pcm_s16le', sampleRate: 24000, channels: 1 }, faceSource: 'stage' })
    expect(m.sent()).toHaveLength(1)
    m.answer(m.sent()[0]!.id)
    expect((await ok).ok).toBe(true)
  })
  it('an inbound text frame is limited in bytes as well', async () => {
    const m = manual({ session: { maxTextBytes: 1000 } })
    m.hello()
    const errors: string[] = []
    m.session.onProtocolError((e) => errors.push(e.reason))
    m.pair.stage.sendText(JSON.stringify({ type: 'error', message: '中'.repeat(400) })) // ~1200 bytes, 400+ units
    expect(errors).toEqual(['text frame too large or not text'])
  })
})

describe('absurd stage clocks (LOW: frames-encoder-decoder-time-asymmetry, schema-unbounded-magnitudes)', () => {
  it.each([-1, -1e15, -1e300, 2 ** 51, 2 ** 53, 1e300, Number.POSITIVE_INFINITY])('refuses a hello with stageClockMs %s', async (clockMs) => {
    const m = manual()
    m.hello(caps(), clockMs)
    await expect(m.session.ready()).rejects.toThrow(/invalid_hello/)
    expect(m.session.state).toBe('closed')
  })
  it('accepts the whole plausible range, including 0 and the epoch', async () => {
    for (const clockMs of [0, 1, 123_456, 1.8e12, STAGE_CLOCK_MAX_MS]) {
      const m = manual()
      m.hello(caps(), clockMs)
      await expect(m.session.ready()).resolves.toBeDefined()
    }
  })
  it('a later speak.started with an absurd clock is a protocol error and never a clock sample', async () => {
    const m = manual()
    m.hello(caps(), T0)
    const errors: string[] = []
    m.session.onProtocolError((e) => errors.push(e.reason))
    const before = m.session.clockOffsetMs()
    for (const stageMs of [-5, 1e300, 2 ** 53]) m.pair.stage.sendText(JSON.stringify({ type: 'speak.started', utteranceId: 'u', stageMs }))
    expect(errors).toHaveLength(3)
    expect(m.session.clockOffsetMs()).toBe(before)
    expect(m.session.clockSamples()).toBe(1)
  })
  it('counts the clock epoch: a jump of more than 5 s starts a new one, normal jitter does not', async () => {
    const m = manual()
    m.hello(caps(), T0)
    expect(m.session.clockEpoch()).toBe(0)
    m.pair.stage.sendText(JSON.stringify({ type: 'speak.started', utteranceId: 'u', stageMs: m.vt.now() - 30 }))
    expect(m.session.clockEpoch()).toBe(0)
    m.pair.stage.sendText(JSON.stringify({ type: 'speak.started', utteranceId: 'v', stageMs: m.vt.now() + 60_000 }))
    expect(m.session.clockEpoch()).toBe(1)
    m.pair.stage.sendText(JSON.stringify({ type: 'speak.started', utteranceId: 'w', stageMs: m.vt.now() + 60_000 - 5 }))
    expect(m.session.clockEpoch()).toBe(1)
  })
})

describe('event and command bounds in the shared schema (LOW: schema-unbounded-magnitudes, schema-graphnode-fields)', () => {
  const ev = (e: unknown) => StageEvent.safeParse(e).success
  it('events: perf, terminal.resize and speak times are bounded', () => {
    expect(ev({ type: 'perf', fps: 60, gpuMs: 4, vramMb: 900 })).toBe(true)
    for (const bad of [{ fps: 1e308, gpuMs: 1, vramMb: 1 }, { fps: -1, gpuMs: 1, vramMb: 1 }, { fps: 60, gpuMs: -3, vramMb: 1 }, { fps: 60, gpuMs: 1, vramMb: -1 }]) expect(ev({ type: 'perf', ...bad })).toBe(false)
    expect(ev({ type: 'construct.terminal.resize', constructId: 't', cols: 120, rows: 40 })).toBe(true)
    for (const [cols, rows] of [[2 ** 53 - 1, 10], [-1, 10], [0, 10], [10, 0], [10, 100000]]) expect(ev({ type: 'construct.terminal.resize', constructId: 't', cols, rows })).toBe(false)
    expect(ev({ type: 'speak.ended', utteranceId: 'u', stageMs: -1, interrupted: false })).toBe(false)
  })
  const cmd = (c: Record<string, unknown>) => StageCommand.safeParse({ id: 'c', ...c }).success
  it('commands: blend and fade times, atMs, the sample rate and the atmosphere are bounded', () => {
    expect(cmd({ type: 'character.params', characterId: 'a', params: { x: 1 }, blendMs: 5000 })).toBe(true)
    for (const blendMs of [-5, 10_001, 1e308]) {
      expect(cmd({ type: 'character.params', characterId: 'a', params: { x: 1 }, blendMs })).toBe(false)
      expect(cmd({ type: 'scene.camera', cameraId: 'a', blendMs })).toBe(false)
    }
    expect(cmd({ type: 'perform.cancel', utteranceId: 'u', fadeMs: -1 })).toBe(false)
    expect(cmd({ type: 'perform.gaze', target: { kind: 'user' }, atMs: -1e12 })).toBe(false)
    expect(cmd({ type: 'perform.gaze', target: { kind: 'user' }, atMs: 1.8e12 })).toBe(true)
    const speak = (audio: Record<string, unknown>) => ({ type: 'perform.speak', utteranceId: 'u', text: 'x', emotion: 'neutral', audio: { format: 'pcm_s16le', channels: 1, ...audio }, faceSource: 'stage' })
    expect(cmd(speak({ sampleRate: 24000, totalMs: 1500 }))).toBe(true)
    for (const sampleRate of [0, -1, 100, 1e9]) expect(cmd(speak({ sampleRate }))).toBe(false)
    expect(cmd(speak({ sampleRate: 24000, totalMs: -1 }))).toBe(false)
    const lighting = (floorPool: Record<string, unknown>) => ({ type: 'scene.lighting', lighting: { id: 'l', name: 'L', mode: 'fixed', atmosphere: { floorPool } } })
    expect(cmd(lighting({ radius: 2.2, intensity: 1, color: '#cfe3ff' }))).toBe(true)
    expect(cmd(lighting({ radius: -1e9 }))).toBe(false)
    expect(cmd(lighting({ intensity: 1e9 }))).toBe(false)
  })
  it('graph nodes: ids, labels, colours, positions and sizes are bounded', () => {
    const node = (over: Record<string, unknown>) => ({ type: 'scene.data', constructId: 'k', mode: 'merge', nodes: [{ id: 'n', label: 'N', importance: 2, ...over }] })
    expect(cmd(node({ position: [1, 2, 3], color: '#8affc1', size: 0.2 }))).toBe(true)
    for (const bad of [{ id: 'x'.repeat(100_000) }, { label: 'x'.repeat(100_000) }, { color: 'javascript:alert(1)' }, { color: 'red' }, { position: [1e300, -1e300, 0] }, { size: 1e300 }, { id: '' }]) {
      expect(cmd(node(bad)), JSON.stringify(Object.keys(bad))).toBe(false)
    }
    expect(cmd({ type: 'scene.data', constructId: 'k', mode: 'merge', edges: [{ from: 'a', to: 'b', weight: 1e9 }] })).toBe(false)
  })
  it('licence strings and parameter counts are bounded (a manifest cannot carry megabytes)', () => {
    const asset = (over: Record<string, unknown>) => ({ type: 'scene.object', op: 'add', object: { id: 'o', assetId: 'a', transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } }, asset: { id: 'a', kind: 'prop', name: 'A', locator: 'p/a', license: { id: 'MIT', personalUse: true, commercialUse: true, redistribution: true }, ...over } })
    expect(cmd(asset({}))).toBe(true)
    expect(cmd(asset({ license: { id: 'L'.repeat(1_000_000), personalUse: true, commercialUse: true, redistribution: true } }))).toBe(false)
    expect(cmd(asset({ license: { id: 'MIT', notes: 'N'.repeat(5_000_000), personalUse: true, commercialUse: true, redistribution: true } }))).toBe(false)
    expect(cmd(asset({ params: Array.from({ length: 300 }, (_, i) => ({ id: `p${i}`, group: 'other', label: 'l', min: 0, max: 1, default: 0, type: 'scalar' })) }))).toBe(false)
  })
})
