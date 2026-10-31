/**
 * runStageConformance: a reusable, framework-agnostic conformance suite that ANY stage (the simulator, the web room, an
 * Unreal or Unity engine stage) must pass. It talks to the stage over the raw transport, exactly like the daemon would,
 * so it also checks the wire format. It is written against a tiny test API so it runs under vitest without this package
 * importing vitest:
 *
 *   import { describe, it, expect } from 'vitest'
 *   runStageConformance(makeHarness, { describe, it, expect })
 *
 * A harness gives the suite the backend end of a transport plus a clock and a way to let time pass (virtual for the
 * simulator, real waiting for an engine). The suite reads the stage's capabilities from its hello and skips what the stage
 * declares it cannot do (a construct kind it does not draw, backend face frames it does not take).
 */
import { StageCapabilities, StageEvent, STAGE_PROTOCOL } from '@ai-assistant/shared'
import type { RigFamily, StageCommand } from '@ai-assistant/shared'
import type { Clock, Timers } from '../util/clock'
import type { StageTransport } from '../protocol/transport'
import { encodeAudioFrame, encodeFaceFrame } from '../protocol/frames'
import { createSeedCatalog, seedBaseId, SEED_IDS } from '../assets/seed'
import { InMemoryCharacterRepo } from '../characters/repo'
import { createCharacterService } from '../characters/service'
import { createWardrobeService } from '../wardrobe/service'
import { InMemorySceneRepo } from '../scene/repo'
import { createSceneService } from '../scene/service'
import { createSequentialIds } from '../util/ids'
import { FakeTtsProvider } from '../speech/tts'
import { FakeFaceProvider } from '../speech/face'

export interface Matchers {
  toBe(expected: unknown): void
  toEqual(expected: unknown): void
  toBeTruthy(): void
  toBeGreaterThan(n: number): void
  toBeGreaterThanOrEqual(n: number): void
  toBeLessThan(n: number): void
  toBeLessThanOrEqual(n: number): void
  toBeCloseTo(n: number, digits?: number): void
  toContain(item: unknown): void
  toHaveLength(n: number): void
  toMatch(re: RegExp): void
  readonly not: Matchers
}

/** The parts of a test framework the suite needs (vitest's describe, it and expect fit). */
export interface TestApi {
  describe(name: string, fn: () => void): void
  it(name: string, fn: () => void | Promise<void>, timeoutMs?: number): void
  expect(actual: unknown): Matchers
}

export interface ConformanceHarness {
  /** The backend's end of the connection to the stage under test. */
  transport: StageTransport
  clock: Clock
  timers: Timers
  /** Start the stage (it must then send hello). Called after the suite attached its listeners. */
  start(): void | Promise<void>
  /** Let `ms` pass (virtual time for the simulator, real waiting for an engine) and let the stage work. */
  advance(ms: number): Promise<void>
  dispose(): void | Promise<void>
}

export type MakeStage = () => ConformanceHarness | Promise<ConformanceHarness>

type NewCommand = { [K in StageCommand['type']]: Omit<Extract<StageCommand, { type: K }>, 'id'> }[StageCommand['type']]

class Client {
  readonly events: StageEvent[] = []
  readonly errors: string[] = []
  private n = 0
  helloAt = 0
  constructor(readonly h: ConformanceHarness) {
    h.transport.onText((raw) => {
      let obj: unknown
      try {
        obj = JSON.parse(raw)
      } catch {
        this.errors.push('stage sent invalid JSON')
        return
      }
      const p = StageEvent.safeParse(obj)
      if (!p.success) {
        this.errors.push(`stage sent an invalid event: ${p.error.issues[0]?.path.join('.')} ${p.error.issues[0]?.message}`)
        return
      }
      if (p.data.type === 'hello') this.helloAt = h.clock.now()
      this.events.push(p.data)
    })
  }

  hello(): Extract<StageEvent, { type: 'hello' }> | undefined {
    return this.events.find((e): e is Extract<StageEvent, { type: 'hello' }> => e.type === 'hello')
  }

  /** The stage clock now, estimated from the hello. */
  stageNow(): number {
    const hello = this.hello()
    return hello ? hello.stageClockMs + (this.h.clock.now() - this.helloAt) : this.h.clock.now()
  }

  async until(pred: () => boolean, maxMs: number, stepMs = 10): Promise<boolean> {
    for (let t = 0; t < maxMs; t += stepMs) {
      if (pred()) return true
      await this.h.advance(stepMs)
    }
    return pred()
  }

  nextId(): string {
    return `conf_${++this.n}`
  }

  /** Send a command and wait for its answer. */
  async command(cmd: NewCommand, maxMs = 8000): Promise<{ ok: boolean; reason?: string; id: string }> {
    const id = this.nextId()
    return this.raw(JSON.stringify({ ...cmd, id }), id, maxMs)
  }

  async raw(text: string, id: string, maxMs = 8000): Promise<{ ok: boolean; reason?: string; id: string }> {
    this.h.transport.sendText(text)
    const answered = (): StageEvent | undefined => this.events.find((e) => (e.type === 'command.done' || e.type === 'command.failed') && e.id === id)
    if (!(await this.until(() => !!answered(), maxMs))) throw new Error(`the stage did not answer command ${id} within ${maxMs} ms`)
    const a = answered()!
    return a.type === 'command.done' ? { ok: true, id } : { ok: false, reason: (a as Extract<StageEvent, { type: 'command.failed' }>).reason, id }
  }

  count(type: string): number {
    return this.events.filter((e) => e.type === type).length
  }
  ofType<T extends StageEvent['type']>(type: T): Array<Extract<StageEvent, { type: T }>> {
    return this.events.filter((e): e is Extract<StageEvent, { type: T }> => e.type === type)
  }
}

/** Fixtures built from the seed catalog and the backend services, so the suite sends REAL contract payloads. */
function fixtures(rig: RigFamily) {
  const clock = { now: () => 1_700_000_000_000 }
  const catalog = createSeedCatalog()
  const newId = createSequentialIds()
  const characters = createCharacterService({ repo: new InMemoryCharacterRepo(), catalog, clock, newId })
  const wardrobe = createWardrobeService({ characters, catalog, newId })
  const scenes = createSceneService({ repo: new InMemorySceneRepo(), catalog, clock, newId })
  const created = characters.create({ name: 'Conformance', baseAssetId: seedBaseId(rig) })
  if (!created.ok) throw new Error(`conformance fixture: ${created.error}`)
  scenes.ensureVoid()
  return { catalog, characters, wardrobe, scenes, character: created.value }
}

const FIRST_RIG = (caps: StageCapabilities): RigFamily | undefined => (['vrm1', 'metahuman', 'cc5'] as const).find((r) => caps.rigFamilies.includes(r))

export function runStageConformance(make: MakeStage, api: TestApi): void {
  const { describe, it, expect } = api

  async function withStage(body: (c: Client, caps: StageCapabilities) => Promise<void>): Promise<void> {
    const h = await make()
    const c = new Client(h)
    try {
      await h.start()
      const gotHello = await c.until(() => !!c.hello(), 5000)
      if (!gotHello) throw new Error('the stage did not send hello within 5 s')
      await body(c, c.hello()!.capabilities)
      expect(c.errors).toEqual([])
    } finally {
      await h.dispose()
    }
  }

  const loadBoth = async (c: Client, caps: StageCapabilities) => {
    const rig = FIRST_RIG(caps)
    if (!rig) return undefined
    const f = fixtures(rig)
    const load = f.characters.loadCommand(f.character.id)
    const scene = f.scenes.loadCommand()
    if (!load.ok || !scene.ok) throw new Error('conformance fixture failed')
    const a = await c.command(load.value as NewCommand)
    const b = await c.command(scene.value as NewCommand)
    return { f, a, b }
  }

  describe('stage conformance: negotiation', () => {
    it('sends a valid hello first: our protocol, a valid capability set and a finite stage clock', () =>
      withStage(async (c, caps) => {
        expect(c.events[0]!.type).toBe('hello')
        const hello = c.hello()!
        expect(hello.protocol).toBe(STAGE_PROTOCOL)
        expect(StageCapabilities.safeParse(caps).success).toBe(true)
        expect(Number.isFinite(hello.stageClockMs)).toBe(true)
        expect(caps.maxCharacters).toBeGreaterThan(0)
        expect(caps.rigFamilies.length).toBeGreaterThan(0)
        expect(c.count('hello')).toBe(1)
      }))
  })

  describe('stage conformance: loading', () => {
    it('loads a character and reports asset.loaded for what it loaded', () =>
      withStage(async (c, caps) => {
        const rig = FIRST_RIG(caps)
        if (!rig) return
        const f = fixtures(rig)
        const load = f.characters.loadCommand(f.character.id)
        if (!load.ok) throw new Error('fixture')
        const r = await c.command(load.value as NewCommand)
        expect(r.ok).toBe(true)
        const loaded = new Set(c.ofType('asset.loaded').map((e) => e.assetId))
        expect(loaded.has(seedBaseId(rig))).toBe(true)
        for (const e of c.ofType('asset.loaded')) expect(e.ms).toBeGreaterThanOrEqual(0)
        expect(c.count('asset.failed')).toBe(0)
      }))
    it('loads the cerebral void scene', () =>
      withStage(async (c, caps) => {
        const r = await loadBoth(c, caps)
        if (!r) return
        expect(r.a.ok).toBe(true)
        expect(r.b.ok).toBe(true)
        expect(c.ofType('asset.loaded').some((e) => e.assetId === SEED_IDS.void)).toBe(true)
      }))
    it('refuses a character with an unknown rig and one whose outfit asset was not provided', () =>
      withStage(async (c, caps) => {
        const rig = FIRST_RIG(caps)
        if (!rig) return
        const f = fixtures(rig)
        const load = f.characters.loadCommand(f.character.id)
        if (!load.ok) throw new Error('fixture')
        const cmd = load.value as Extract<StageCommand, { type: 'character.load' }>
        const missing = await c.command({ ...cmd, assets: cmd.assets.filter((a) => a.kind === 'character_base') } as NewCommand)
        expect(missing.ok).toBe(false)
        expect((missing.reason ?? '').length).toBeGreaterThan(0)
      }))
  })

  describe('stage conformance: wardrobe', () => {
    it('equips and unequips an item', () =>
      withStage(async (c, caps) => {
        const r = await loadBoth(c, caps)
        if (!r) return
        const asset = r.f.catalog.get(SEED_IDS.blazer)!
        const on = await c.command({ type: 'character.equip', characterId: r.f.character.id, slot: 'outerwear', assetId: asset.id, asset } as NewCommand)
        expect(on.ok).toBe(true)
        const off = await c.command({ type: 'character.equip', characterId: r.f.character.id, slot: 'outerwear', assetId: null } as NewCommand)
        expect(off.ok).toBe(true)
        const wrongSlot = await c.command({ type: 'character.equip', characterId: r.f.character.id, slot: 'footwear', assetId: asset.id, asset } as NewCommand)
        expect(wrongSlot.ok).toBe(false)
        const unknown = await c.command({ type: 'character.equip', characterId: 'nobody', slot: 'outerwear', assetId: null } as NewCommand)
        expect(unknown.ok).toBe(false)
      }))
    it('applies an outfit preset', () =>
      withStage(async (c, caps) => {
        const r = await loadBoth(c, caps)
        if (!r) return
        const applied = r.f.wardrobe.applyPreset(r.f.character.id, 'preset.meeting')
        if (!applied.ok) throw new Error('fixture')
        for (const cmd of applied.value.commands) expect((await c.command(cmd as NewCommand)).ok).toBe(true)
      }))
  })

  describe('stage conformance: camera', () => {
    it('blends to another shot, and refuses a shot the scene does not have', () =>
      withStage(async (c, caps) => {
        const r = await loadBoth(c, caps)
        if (!r) return
        expect((await c.command({ type: 'scene.camera', cameraId: 'closeup', blendMs: 400 })).ok).toBe(true)
        expect((await c.command({ type: 'scene.camera', cameraId: 'profile', blendMs: 0 })).ok).toBe(true)
        const bad = await c.command({ type: 'scene.camera', cameraId: 'no_such_shot', blendMs: 400 })
        expect(bad.ok).toBe(false)
        expect((bad.reason ?? '').length).toBeGreaterThan(0)
      }))
  })

  describe('stage conformance: speech', () => {
    const speakFixture = async (c: Client, caps: StageCapabilities, text: string) => {
      const r = await loadBoth(c, caps)
      if (!r) return undefined
      const tts = new FakeTtsProvider()
      const audio = await tts.synthesize({ text, voice: { provider: 'kokoro', voiceId: 'v', speed: 1, pitchSemitones: 0 }, emotion: 'neutral', sampleRate: 24000 })
      const totalMs = (audio.pcm.length / 24000) * 1000
      const faceSource: 'stage' | 'backend' = caps.face.audioToFaceOnStage || !(caps.face.arkit52 || caps.face.visemes) ? 'stage' : 'backend'
      const startAt = c.stageNow() + 150
      const utteranceId = 'conf_utt_1'
      const res = await c.command({ type: 'perform.speak', utteranceId, text, emotion: 'neutral', emotionTimeline: [], audio: { format: 'pcm_s16le', sampleRate: 24000, channels: 1, totalMs }, faceSource, atMs: startAt } as NewCommand)
      return { r, audio, totalMs, faceSource, startAt, utteranceId, res }
    }
    const sendAudio = (c: Client, fx: NonNullable<Awaited<ReturnType<typeof speakFixture>>>, fromChunk: number, toChunk: number) => {
      const per = 480
      for (let i = fromChunk; i < toChunk && i * per < fx.audio.pcm.length; i++) {
        const slice = fx.audio.pcm.subarray(i * per, Math.min(fx.audio.pcm.length, (i + 1) * per))
        c.h.transport.sendBinary(encodeAudioFrame(fx.utteranceId, fx.startAt + i * 20, slice))
      }
    }
    const sendFace = (c: Client, fx: NonNullable<Awaited<ReturnType<typeof speakFixture>>>) => {
      if (fx.faceSource !== 'backend') return
      const frames = new FakeFaceProvider().frames({ pcm: fx.audio.pcm, sampleRate: 24000, fps: 30, emotion: 'neutral', intensity: 0.5, utteranceId: fx.utteranceId })
      frames.forEach((f, i) => c.h.transport.sendBinary(encodeFaceFrame(fx.utteranceId, fx.startAt + (i * 1000) / 30, f)))
    }

    it('plays an utterance: speak.started, then speak.ended (not interrupted) after about its duration', () =>
      withStage(async (c, caps) => {
        const fx = await speakFixture(c, caps, 'Good morning. This is a short test.')
        if (!fx) return
        expect(fx.res.ok).toBe(true)
        sendAudio(c, fx, 0, 100000)
        sendFace(c, fx)
        const ended = await c.until(() => c.count('speak.ended') > 0, fx.totalMs + 4000)
        expect(ended).toBe(true)
        const started = c.ofType('speak.started')
        const end = c.ofType('speak.ended')
        expect(started).toHaveLength(1)
        expect(end).toHaveLength(1)
        expect(started[0]!.utteranceId).toBe(fx.utteranceId)
        expect(end[0]!.interrupted).toBe(false)
        const order = c.events.map((e) => e.type).filter((t) => t === 'speak.started' || t === 'speak.ended')
        expect(order).toEqual(['speak.started', 'speak.ended'])
        expect(end[0]!.stageMs).toBeGreaterThanOrEqual(started[0]!.stageMs)
        expect(end[0]!.stageMs - started[0]!.stageMs).toBeGreaterThan(fx.totalMs * 0.8)
      }))
    it('cancels mid-utterance: speak.ended with interrupted=true, and late frames do no harm', () =>
      withStage(async (c, caps) => {
        const fx = await speakFixture(c, caps, 'This is a rather long sentence that will be interrupted well before the end of it.')
        if (!fx) return
        sendAudio(c, fx, 0, 40)
        await c.until(() => c.count('speak.started') > 0, 3000)
        expect(c.count('speak.started')).toBe(1)
        const cancel = await c.command({ type: 'perform.cancel', utteranceId: fx.utteranceId, fadeMs: 100 })
        expect(cancel.ok).toBe(true)
        await c.until(() => c.count('speak.ended') > 0, 2000)
        const end = c.ofType('speak.ended')
        expect(end).toHaveLength(1)
        expect(end[0]!.interrupted).toBe(true)
        sendAudio(c, fx, 40, 100000) // arrives after the cancel
        await c.h.advance(fx.totalMs + 500)
        expect(c.count('speak.ended')).toBe(1)
        // the stage is still healthy
        expect((await c.command({ type: 'perform.idle', profile: 'attentive' })).ok).toBe(true)
      }))
    it('answers a cancel for an utterance it does not know with done, not a crash', () =>
      withStage(async (c, caps) => {
        const r = await loadBoth(c, caps)
        if (!r) return
        expect((await c.command({ type: 'perform.cancel', utteranceId: 'ghost', fadeMs: 50 })).ok).toBe(true)
      }))
    it('ignores binary frames for an utterance it never heard of', () =>
      withStage(async (c, caps) => {
        const r = await loadBoth(c, caps)
        if (!r) return
        c.h.transport.sendBinary(encodeAudioFrame('never_announced', c.stageNow(), new Uint8Array(960)))
        c.h.transport.sendBinary(new Uint8Array([9, 9, 9]))
        await c.h.advance(200)
        expect(c.count('speak.started')).toBe(0)
        expect((await c.command({ type: 'perform.idle', profile: 'relaxed' })).ok).toBe(true)
      }))
  })

  describe('stage conformance: constructs', () => {
    it('adds a knowledge graph, replaces then merges its data, and refuses a dangling edge', () =>
      withStage(async (c, caps) => {
        if (!caps.constructs.includes('knowledge_graph')) return
        const r = await loadBoth(c, caps)
        if (!r) return
        const construct = { id: 'kg', kind: 'knowledge_graph' as const, transform: { position: [0, 1.5, 3] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number], scale: [1, 1, 1] as [number, number, number] }, source: 'brain' as const, query: {}, style: { palette: 'cool' as const, density: 0.5, scale: 1 }, interactive: true }
        expect((await c.command({ type: 'scene.construct', op: 'add', construct })).ok).toBe(true)
        const node = (id: string, importance = 3) => ({ id, label: id, importance, position: [0, 0, 0] as [number, number, number] })
        expect((await c.command({ type: 'scene.data', constructId: 'kg', mode: 'replace', nodes: [node('a'), node('b')], edges: [{ from: 'a', to: 'b', weight: 1 }] })).ok).toBe(true)
        expect((await c.command({ type: 'scene.data', constructId: 'kg', mode: 'merge', nodes: [node('c', 5)], edges: [{ from: 'b', to: 'c', weight: 1 }] })).ok).toBe(true)
        expect((await c.command({ type: 'scene.data', constructId: 'kg', mode: 'merge', remove: { nodes: ['a'] } })).ok).toBe(true)
        const dangling = await c.command({ type: 'scene.data', constructId: 'kg', mode: 'merge', edges: [{ from: 'c', to: 'nowhere', weight: 1 }] })
        expect(dangling.ok).toBe(false)
        const unknown = await c.command({ type: 'scene.data', constructId: 'nope', mode: 'merge', nodes: [node('z')] })
        expect(unknown.ok).toBe(false)
        expect((await c.command({ type: 'scene.construct', op: 'remove', construct })).ok).toBe(true)
      }))
    it('refuses a construct kind it declared it cannot draw', () =>
      withStage(async (c, caps) => {
        const unsupported = (['knowledge_graph', 'session_orbit', 'project_cluster', 'timeline_ribbon', 'terminal_pane', 'mail_stream', 'finance_pulse'] as const).find((k) => !caps.constructs.includes(k))
        if (!unsupported) return
        const r = await loadBoth(c, caps)
        if (!r) return
        const construct = { id: 'x', kind: unsupported, transform: { position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number], scale: [1, 1, 1] as [number, number, number] }, source: 'brain' as const, query: {}, style: { palette: 'cool' as const, density: 0.5, scale: 1 }, interactive: true }
        expect((await c.command({ type: 'scene.construct', op: 'add', construct })).ok).toBe(false)
      }))
  })

  describe('stage conformance: invalid input', () => {
    it('answers every command exactly once, with done or failed', () =>
      withStage(async (c, caps) => {
        const r = await loadBoth(c, caps)
        if (!r) return
        const ids: string[] = []
        for (const cmd of [{ type: 'perform.idle', profile: 'busy' }, { type: 'perform.gaze', target: { kind: 'user' }, speed: 0.5, saccades: true }, { type: 'perform.affect', affect: { valence: 0, arousal: 0, dominance: 0, label: 'neutral' }, blendMs: 100 }, { type: 'perform.posture', posture: 'stand' }, { type: 'perform.gesture', clip: 'nod_small', intensity: 0.5 }] as NewCommand[]) {
          const res = await c.command(cmd)
          ids.push(res.id)
        }
        await c.h.advance(200)
        for (const id of ids) expect(c.events.filter((e) => (e.type === 'command.done' || e.type === 'command.failed') && e.id === id)).toHaveLength(1)
      }))
    it('rejects invalid commands with command.failed and keeps working', () =>
      withStage(async (c, caps) => {
        const r = await loadBoth(c, caps)
        if (!r) return
        const unknownType = await c.raw(JSON.stringify({ id: 'bad_1', type: 'perform.dance' }), 'bad_1')
        expect(unknownType.ok).toBe(false)
        const badField = await c.raw(JSON.stringify({ id: 'bad_2', type: 'perform.gesture', clip: 'x', intensity: 9 }), 'bad_2')
        expect(badField.ok).toBe(false)
        const missing = await c.raw(JSON.stringify({ id: 'bad_3', type: 'scene.camera' }), 'bad_3')
        expect(missing.ok).toBe(false)
        expect((await c.command({ type: 'character.params', characterId: 'nobody', params: { x: 1 }, blendMs: 0 })).ok).toBe(false)
        expect((await c.command({ type: 'perform.gaze', target: { kind: 'object', objectId: 'no_such_object' }, speed: 0.5, saccades: true })).ok).toBe(false)
        expect((await c.command({ type: 'perform.posture', posture: 'sit', anchorObjectId: 'no_such_object', anchorId: 'seat' })).ok).toBe(false)
        expect((await c.command({ type: 'scene.object', op: 'remove', object: { id: 'ghost', assetId: SEED_IDS.chair, transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, parentId: null, role: 'static', anchors: [], visible: true } })).ok).toBe(false)
        // garbage on the wire: no crash, and the stage still answers
        c.h.transport.sendText('{ this is not json')
        c.h.transport.sendText('[1,2,3]')
        c.h.transport.sendBinary(new Uint8Array(0))
        await c.h.advance(100)
        expect((await c.command({ type: 'perform.idle', profile: 'relaxed' })).ok).toBe(true)
        // every failure carried a reason
        for (const e of c.ofType('command.failed')) expect(e.reason.length).toBeGreaterThan(0)
      }))
    it('does not accept performance commands before a character is loaded', () =>
      withStage(async (c) => {
        const res = await c.command({ type: 'perform.gesture', clip: 'nod_small', intensity: 0.5 })
        expect(res.ok).toBe(false)
      }))
  })
}

