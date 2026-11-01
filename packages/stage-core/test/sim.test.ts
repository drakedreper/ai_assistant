import { describe, expect, it } from 'vitest'
import { STAGE_PROTOCOL, StageEvent } from '@ai-assistant/shared'
import type { Asset } from '@ai-assistant/shared'
import {
  SEED_IDS as S,
  createMemoryTransportPair,
  createSimulatorStage,
  createVirtualTime,
  encodeAudioFrame,
  encodeFaceFrame,
  seedBaseId,
} from '../src'
import type { CommandDraft } from '../src'
import { T0 } from './helpers'
import { flush, loadAll, makeRig, makeWorldRig } from './rig'

/** Talk to a simulator by hand over the raw transport and read what it answers. */
function bare(simOpts: Record<string, unknown> = {}) {
  const vt = createVirtualTime(T0)
  const pair = createMemoryTransportPair({ timers: vt.timers })
  const sim = createSimulatorStage({ transport: pair.stage, clock: vt.clock, timers: vt.timers, ...simOpts })
  const seen: StageEvent[] = []
  pair.backend.onText((raw) => {
    const obj = JSON.parse(raw)
    const p = StageEvent.safeParse(obj)
    seen.push(p.success ? p.data : (obj as StageEvent)) // a deliberately wrong hello does not parse
  })
  sim.start()
  let n = 0
  const cmd = (c: Record<string, unknown>) => {
    const id = `c${++n}`
    pair.backend.sendText(JSON.stringify({ id, ...c }))
    return id
  }
  const answers = (id: string) => seen.filter((e) => (e.type === 'command.done' || e.type === 'command.failed') && e.id === id)
  const result = (id: string) => answers(id)[0]
  return { vt, pair, sim, seen, cmd, answers, result }
}

describe('hello and options', () => {
  it('says hello with the default capabilities and a stage clock', () => {
    const b = bare()
    const hello = b.seen[0]!
    expect(hello).toMatchObject({ type: 'hello', protocol: STAGE_PROTOCOL, stageClockMs: T0 })
    const caps = (hello as Extract<StageEvent, { type: 'hello' }>).capabilities
    expect(caps).toMatchObject({ engine: 'sim', maxCharacters: 4, face: { arkit52: true, visemes: true, audioToFaceOnStage: false } })
    expect(caps.constructs).toHaveLength(7)
    expect(caps.rigFamilies).toContain('vrm1')
  })
  it('merges capability overrides, applies the clock offset and can speak another protocol or wait to say hello', () => {
    const b = bare({ capabilities: { engine: 'unity', maxCharacters: 1, face: { audioToFaceOnStage: true }, render: { strandHair: true } }, clockOffsetMs: -1000, protocol: 'mira-stage/2', autoHello: false })
    expect(b.seen).toHaveLength(0)
    b.sim.sendHello()
    const hello = b.seen[0] as unknown as { protocol: string; stageClockMs: number; capabilities: { engine: string; face: { arkit52: boolean; audioToFaceOnStage: boolean }; render: { strandHair: boolean; runtimeAssetLoading: boolean } } }
    expect(hello.protocol).toBe('mira-stage/2')
    expect(hello.stageClockMs).toBe(T0 - 1000)
    expect(hello.capabilities).toMatchObject({ engine: 'unity', face: { arkit52: true, audioToFaceOnStage: true }, render: { strandHair: true, runtimeAssetLoading: true } })
    expect(b.sim.capabilities().maxCharacters).toBe(1)
    expect(b.sim.stageNow()).toBe(T0 - 1000)
  })
  it('does nothing after stop()', () => {
    const b = bare()
    b.sim.stop()
    const id = b.cmd({ type: 'perform.idle', profile: 'busy' })
    expect(b.answers(id)).toHaveLength(0)
    b.sim.emitPerf(60, 1, 1) // silently dropped
    expect(b.seen).toHaveLength(1)
  })
  it('start() twice does not send two hellos', () => {
    const b = bare()
    b.sim.start()
    expect(b.seen.filter((e) => e.type === 'hello')).toHaveLength(1)
  })
})

describe('validation of every incoming command', () => {
  it('rejects schema violations with command.failed (when an id can be read) and an error event otherwise', () => {
    const b = bare()
    const id1 = b.cmd({ type: 'perform.dance' })
    expect(b.result(id1)).toMatchObject({ type: 'command.failed', reason: expect.stringMatching(/invalid command/) })
    const id2 = b.cmd({ type: 'perform.gesture', clip: 'x', intensity: 2 })
    expect(b.result(id2)!.type).toBe('command.failed')
    b.pair.backend.sendText(JSON.stringify({ type: 'perform.idle', profile: 'busy' })) // no id
    b.pair.backend.sendText('not json at all')
    b.pair.backend.sendText('42')
    const errors = b.seen.filter((e) => e.type === 'error')
    expect(errors).toHaveLength(3)
    expect(errors.every((e) => e.type === 'error' && !e.fatal)).toBe(true)
    expect(b.sim.rejectedCommands).toBeGreaterThanOrEqual(5)
  })
  it('rejects NaN and Infinity (they cannot even be expressed in JSON) and non-finite numbers in numbers fields', () => {
    const b = bare()
    const id = b.cmd({ type: 'perform.gaze', target: { kind: 'point', position: [1, 2, 'x'] } })
    expect(b.result(id)!.type).toBe('command.failed')
    b.pair.backend.sendText('{"id":"n1","type":"perform.affect","affect":{"valence":NaN}}')
    expect(b.seen.filter((e) => e.type === 'error').length).toBe(1)
  })
  it('refuses performance before a character exists and scene commands before a scene', () => {
    const b = bare()
    for (const c of [{ type: 'perform.gaze', target: { kind: 'user' } }, { type: 'perform.idle', profile: 'busy' }, { type: 'perform.affect', affect: { valence: 0, arousal: 0, dominance: 0, label: 'neutral' } }, { type: 'perform.posture', posture: 'stand' }, { type: 'perform.speak', utteranceId: 'u', text: 'hi', emotion: 'neutral', audio: { format: 'pcm_s16le', sampleRate: 24000, channels: 1 }, faceSource: 'stage' }]) {
      expect(b.result(b.cmd(c))).toMatchObject({ type: 'command.failed', reason: 'no character is loaded' })
    }
    for (const c of [{ type: 'scene.camera', cameraId: 'wide' }, { type: 'scene.data', constructId: 'k', mode: 'merge' }, { type: 'scene.lighting', lighting: { id: 'x', name: 'x', mode: 'fixed' } }]) {
      expect(b.result(b.cmd(c))!.type).toBe('command.failed')
    }
  })
})

describe('asset-load latency and character state', () => {
  it('models per-asset load time, emits asset.loaded with its ms, and completes when the slowest is done', async () => {
    const r = await makeWorldRig({ sim: { assetLatencyMs: (a: Asset) => (a.kind === 'character_base' ? 400 : 100) } })
    const load = r.characters.loadCommand(r.assistant.id)
    if (!load.ok) throw new Error('setup')
    const p = r.session.send(load.value)
    r.vt.advance(99)
    expect(r.sim.entries({ kind: 'event', name: 'asset.loaded' })).toHaveLength(0)
    r.vt.advance(2)
    expect(r.sim.entries({ kind: 'event', name: 'asset.loaded' })).toHaveLength(3) // shirt, trousers, boots at 100 ms
    let done = false
    void p.then(() => (done = true))
    await flush()
    expect(done).toBe(false)
    r.vt.advance(300)
    expect((await p).ok).toBe(true)
    const loaded = r.sim.entries({ kind: 'event', name: 'asset.loaded' }).map((e) => (e.data as { assetId: string; ms: number }))
    expect(loaded.find((l) => l.assetId === seedBaseId('vrm1'))!.ms).toBe(400)
    expect(r.sim.state().loadedAssets).toHaveLength(4)
    expect(r.sim.state().characters[r.assistant.id]!.equipped.top).toBe(S.shirt)
    expect(r.sim.names('state')).toContain('character.loaded')
  })
  it('does not reload an asset it already holds', async () => {
    const r = await makeWorldRig()
    await loadAll(r)
    const n = r.sim.entries({ kind: 'event', name: 'asset.loaded' }).length
    const again = r.characters.loadCommand(r.assistant.id)
    if (!again.ok) throw new Error('setup')
    const p = r.session.send(again.value)
    await flush()
    expect((await p).ok).toBe(true)
    expect(r.sim.entries({ kind: 'event', name: 'asset.loaded' })).toHaveLength(n)
  })
  it('fails when an asset fails to load, reporting asset.failed first', async () => {
    const r = await makeWorldRig({ sim: { failAssets: [S.shirt] } })
    const load = r.characters.loadCommand(r.assistant.id)
    if (!load.ok) throw new Error('setup')
    const p = r.session.send(load.value)
    r.vt.advance(1000)
    const res = await p
    expect(res.ok).toBe(false)
    expect(res.reason).toMatch(/failed to load/)
    expect(r.sim.entries({ kind: 'event', name: 'asset.failed' })).toHaveLength(1)
    expect(r.sim.state().characters[r.assistant.id]).toBeUndefined()
  })
  it('processes commands strictly in order, even while an earlier load is still running', async () => {
    const r = await makeWorldRig()
    const load = r.characters.loadCommand(r.assistant.id)
    if (!load.ok) throw new Error('setup')
    const order: string[] = []
    const p1 = r.session.send(load.value).then(() => order.push('load'))
    const p2 = r.session.send({ type: 'perform.idle', profile: 'relaxed' }).then(() => order.push('idle'))
    r.vt.advance(1000)
    await Promise.all([p1, p2])
    expect(order).toEqual(['load', 'idle'])
    expect(r.sim.state().idle).toBe('relaxed')
  })
  it('applies the ack latency', async () => {
    const r = await makeRig({ sim: { ackLatencyMs: 50 } })
    let done = false
    void r.session.send({ type: 'perform.idle', profile: 'busy' }).then(() => (done = true))
    await flush()
    expect(done).toBe(false)
    r.vt.advance(50)
    await flush()
    expect(done).toBe(true)
  })
  it('tracks params, equips with slot and rig checks, and outfits', async () => {
    const r = await makeWorldRig()
    await loadAll(r)
    const id = r.assistant.id
    expect((await r.send({ type: 'character.params', characterId: id, params: { 'hair.color': '#ff0000', 'face.width': 0.4 }, blendMs: 0 })).ok).toBe(true)
    expect(r.sim.state().characters[id]!.params).toMatchObject({ 'hair.color': '#ff0000', 'face.width': 0.4 })
    const blazer = r.catalog.get(S.blazer)!
    expect((await r.send({ type: 'character.equip', characterId: id, slot: 'outerwear', assetId: S.blazer, asset: blazer }, 100)).ok).toBe(true)
    expect(r.sim.state().characters[id]!.equipped.outerwear).toBe(S.blazer)
    expect((await r.send({ type: 'character.equip', characterId: id, slot: 'footwear', assetId: S.blazer })).reason).toMatch(/cannot occupy/)
    expect((await r.send({ type: 'character.equip', characterId: id, slot: 'outerwear', assetId: S.coat })).reason).toMatch(/not provided/)
    const mhOnly: Asset = { ...blazer, id: 'outfit.mh', rigFamilies: ['metahuman'] }
    expect((await r.send({ type: 'character.equip', characterId: id, slot: 'outerwear', assetId: 'outfit.mh', asset: mhOnly })).reason).toMatch(/does not fit a vrm1 rig/)
    const applied = r.wardrobe.applyPreset(id, 'preset.training')
    if (!applied.ok) throw new Error('setup')
    for (const c of applied.value.commands) await r.send(c, 200)
    expect(r.sim.state().characters[id]!.equipped).toMatchObject({ top: S.trainingTop, bottom: S.leggings, outerwear: null })
    expect((await r.send({ type: 'character.params', characterId: 'nobody', params: {}, blendMs: 0 })).reason).toMatch(/unknown character/)
  })
  it('enforces the character limit and the rig list', async () => {
    const r = await makeWorldRig({ sim: { capabilities: { maxCharacters: 1, rigFamilies: ['vrm1'] } }, session: { autoResume: false } })
    await loadAll(r)
    // bypass the session's own pre-checks: speak to the stage directly
    const user = r.characters.create({ name: 'Me', role: 'user', baseAssetId: seedBaseId('vrm1', 'poised') })
    if (!user.ok) throw new Error('setup')
    const cmd = r.characters.loadCommand(user.value.id)
    if (!cmd.ok) throw new Error('setup')
    r.pair.backend.sendText(JSON.stringify({ ...cmd.value, id: 'raw1' }))
    expect(r.sim.entries({ kind: 'event', name: 'command.failed' }).some((e) => (e.data as { id: string; reason: string }).reason === 'too many characters')).toBe(true)
    const mh = r.characters.create({ name: 'MH', baseAssetId: seedBaseId('metahuman') })
    if (!mh.ok) throw new Error('setup')
    const mhCmd = r.characters.loadCommand(mh.value.id)
    if (!mhCmd.ok) throw new Error('setup')
    r.pair.backend.sendText(JSON.stringify({ ...mhCmd.value, id: 'raw2' }))
    expect(r.sim.entries({ kind: 'event', name: 'command.failed' }).some((e) => /not supported/.test((e.data as { reason: string }).reason))).toBe(true)
  })
})

describe('scene, objects, constructs and the camera', () => {
  it('loads a scene and validates objects, parents and anchors', async () => {
    const r = await makeWorldRig()
    await loadAll(r)
    const add = r.scenes.addObject({ id: 'chair', assetId: S.chair, anchors: [{ id: 'seat', kind: 'sit', local: { position: [0, 0.4, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } }] })
    if (!add.ok) throw new Error('setup')
    expect((await r.send(add.value.commands[0]!, 200)).ok).toBe(true)
    expect(r.sim.state().scene!.objects.map((o) => o.id)).toEqual(['chair'])
    expect((await r.send(add.value.commands[0]!, 200)).reason).toMatch(/already exists/)
    const child = r.scenes.addObject({ id: 'lamp', assetId: S.plinth, parentId: 'chair' })
    if (!child.ok) throw new Error('setup')
    expect((await r.send({ ...child.value.commands[0]!, object: { ...(child.value.commands[0] as { object: object }).object, parentId: 'ghost' } } as CommandDraft)).reason).toMatch(/parent/)
    expect((await r.send({ type: 'perform.posture', posture: 'sit', anchorObjectId: 'chair', anchorId: 'seat' })).ok).toBe(true)
    expect(r.sim.state().posture).toEqual({ posture: 'sit', anchorObjectId: 'chair', anchorId: 'seat' })
    expect((await r.send({ type: 'perform.posture', posture: 'sit', anchorObjectId: 'chair', anchorId: 'nope' })).reason).toMatch(/unknown anchor/)
    expect((await r.send({ type: 'perform.gaze', target: { kind: 'object', objectId: 'chair' }, speed: 0.5, saccades: true })).ok).toBe(true)
    expect((await r.send({ type: 'perform.gaze', target: { kind: 'object', objectId: 'nope' }, speed: 0.5, saccades: true })).ok).toBe(false)
    expect((await r.send({ type: 'perform.interact', objectId: 'chair', action: 'sit' })).ok).toBe(true)
    expect((await r.send({ type: 'perform.interact', objectId: 'nope', action: 'sit' })).ok).toBe(false)
    r.scenes.removeObject('lamp') // the lamp only exists in the backend's scene (it was never accepted by the stage)
    const rm = r.scenes.removeObject('chair')
    if (!rm.ok) throw new Error('setup')
    expect((await r.send(rm.value.commands[0]!)).ok).toBe(true)
    expect(r.sim.state().scene!.objects).toEqual([])
  })
  it('rejects a scene with duplicate ids, a missing parent or a missing active camera', async () => {
    const r = await makeWorldRig()
    const load = r.scenes.loadCommand()
    if (!load.ok || load.value.type !== 'scene.load') throw new Error('setup')
    const scene = load.value.scene
    const send = async (s: object) => r.session.send({ ...load.value, scene: s } as unknown as CommandDraft)
    const obj = { id: 'a', assetId: S.chair, transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, parentId: null, role: 'static', anchors: [], visible: true }
    const assets = [...(load.value.assets ?? []), r.catalog.get(S.chair)!]
    const p1 = r.session.send({ ...load.value, assets, scene: { ...scene, objects: [obj, obj] } } as unknown as CommandDraft)
    r.vt.advance(1000)
    expect((await p1).reason).toMatch(/duplicate id/)
    const p2 = r.session.send({ ...load.value, assets, scene: { ...scene, objects: [{ ...obj, parentId: 'ghost' }] } } as unknown as CommandDraft)
    r.vt.advance(1000)
    expect((await p2).reason).toMatch(/missing parent/)
    expect((await send({ ...scene, activeCameraId: 'ghost' })).reason).toMatch(/active camera/)
    expect(r.sim.state().scene).toBeNull()
  })
  it('blends the camera over blendMs, records start and end, and cuts when blend is 0 or the shot is unchanged', async () => {
    const r = await makeWorldRig()
    await loadAll(r)
    expect((await r.send({ type: 'scene.camera', cameraId: 'closeup', blendMs: 600 })).ok).toBe(true)
    expect(r.sim.state().camera).toMatchObject({ activeId: 'closeup', blend: { from: 'wide', to: 'closeup', durationMs: 600 } })
    expect(r.sim.cameraBlendProgress()).toBe(0)
    r.vt.advance(300)
    expect(r.sim.cameraBlendProgress()).toBeCloseTo(0.5)
    r.vt.advance(300)
    expect(r.sim.cameraBlendProgress()).toBe(1)
    expect(r.sim.state().camera.blend).toBeUndefined()
    expect(r.sim.names('state').filter((n) => n.startsWith('camera'))).toEqual(['camera.blend.start', 'camera.blend.end'])
    await r.send({ type: 'scene.camera', cameraId: 'profile', blendMs: 0 })
    await r.send({ type: 'scene.camera', cameraId: 'profile', blendMs: 500 })
    expect(r.sim.names('state').filter((n) => n.startsWith('camera')).slice(2)).toEqual(['camera.cut', 'camera.cut'])
    // a new blend interrupts a running one
    await r.send({ type: 'scene.camera', cameraId: 'back', blendMs: 1000 })
    r.vt.advance(200)
    await r.send({ type: 'scene.camera', cameraId: 'medium', blendMs: 400 })
    expect(r.sim.state().camera.blend).toMatchObject({ from: 'back', to: 'medium' })
    r.vt.advance(500)
    expect(r.sim.entries({ name: 'camera.blend.end' }).map((e) => (e.data as { to: string }).to)).toEqual(['closeup', 'medium'])
    expect((await r.send({ type: 'scene.camera', cameraId: 'ghost' })).reason).toMatch(/unknown camera/)
  })
  it('keeps construct data across replace, merge and remove, counts terminal bytes without keeping content, and refuses wrong targets', async () => {
    const r = await makeWorldRig()
    await loadAll(r)
    const kg = r.scenes.addConstruct({ id: 'kg', kind: 'knowledge_graph', transform: { position: [0, 1, 3], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, source: 'brain' })
    const term = r.scenes.addConstruct({ id: 'term', kind: 'terminal_pane', transform: { position: [1, 1, 3], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, source: 'terminal' })
    if (!kg.ok || !term.ok) throw new Error('setup')
    await r.send(kg.value.commands[0]!)
    await r.send(term.value.commands[0]!)
    expect((await r.send({ type: 'scene.construct', op: 'add', construct: kg.value.value })).reason).toMatch(/already exists/)
    await r.send({ type: 'scene.data', constructId: 'kg', mode: 'replace', nodes: [{ id: 'a', label: 'A', importance: 2 }, { id: 'b', label: 'B', importance: 2 }], edges: [{ from: 'a', to: 'b', weight: 1 }] })
    await r.send({ type: 'scene.data', constructId: 'kg', mode: 'merge', nodes: [{ id: 'c', label: 'C', importance: 4 }], remove: { nodes: ['a'] } })
    const data = r.sim.state().constructs.kg!.data
    expect(data.nodes.map((n) => n.id).sort()).toEqual(['b', 'c'])
    expect(data.edges).toEqual([])
    expect((await r.send({ type: 'construct.terminal.write', constructId: 'term', data: 'secret-token-123\r\n' })).ok).toBe(true)
    expect((await r.send({ type: 'construct.terminal.write', constructId: 'kg', data: 'x' })).reason).toMatch(/not a terminal pane/)
    expect((await r.send({ type: 'construct.terminal.write', constructId: 'nope', data: 'x' })).ok).toBe(false)
    await r.send({ type: 'construct.terminal.write', constructId: 'term', data: 'y'.repeat(5000) })
    const t = r.sim.state().constructs.term!
    expect(t.terminalBytes).toBe(18 + 5000)
    expect(t.terminalTail).toBe('') // terminal content is not kept by default
    // the timeline never carries terminal content
    expect(JSON.stringify(r.sim.timeline)).not.toContain('secret-token-123')
    expect(r.sim.entries({ name: 'construct.terminal.write' })[0]!.data).toMatchObject({ constructId: 'term', bytes: 18 })
    expect((await r.send({ type: 'scene.construct', op: 'remove', construct: kg.value.value })).ok).toBe(true)
    expect((await r.send({ type: 'scene.data', constructId: 'kg', mode: 'merge', nodes: [] })).ok).toBe(false)
  })
  it('keeps a bounded terminal tail only when asked to (tests)', async () => {
    const r = await makeWorldRig({ sim: { keepTerminalTail: true } })
    await loadAll(r)
    const term = r.scenes.addConstruct({ id: 'term', kind: 'terminal_pane', transform: { position: [0, 1, 3], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, source: 'terminal' })
    if (!term.ok) throw new Error('setup')
    await r.send(term.value.commands[0]!)
    await r.send({ type: 'construct.terminal.write', constructId: 'term', data: 'a'.repeat(3000) + 'END' })
    const tail = r.sim.state().constructs.term!.terminalTail
    expect(tail.length).toBe(2048)
    expect(tail.endsWith('END')).toBe(true)
  })
  it('updates lighting and tracks constructs inside scene.load', async () => {
    const r = await makeWorldRig()
    await loadAll(r)
    expect((await r.send({ type: 'scene.lighting', lighting: { id: 'n', name: 'Night', mode: 'fixed', look: 'night' } })).ok).toBe(true)
    expect(r.sim.state().scene!.lightingLook).toBe('night')
  })
})

describe('virtual audio playback', () => {
  const pcm = (ms: number) => new Int16Array(Math.round((ms * 24000) / 1000)).fill(1000)
  async function speakRig(opts: { totalMs?: number | null; atOffset?: number; faceSource?: 'stage' | 'backend'; id?: string } = {}) {
    const r = await makeWorldRig()
    await loadAll(r)
    const id = opts.id ?? 'u1'
    const totalMs = opts.totalMs === null ? undefined : (opts.totalMs ?? 1000)
    const startAt = r.sim.stageNow() + (opts.atOffset ?? 100)
    const res = await r.send({ type: 'perform.speak', utteranceId: id, text: 'hello', emotion: 'neutral', audio: { format: 'pcm_s16le', sampleRate: 24000, channels: 1, ...(totalMs !== undefined ? { totalMs } : {}) }, faceSource: opts.faceSource ?? 'backend', atMs: startAt })
    expect(res.ok).toBe(true)
    const chunks = (from: number, to: number, base = startAt, total = 1000) => {
      for (let t = from; t < to; t += 20) r.pair.backend.sendBinary(encodeAudioFrame(id, base + t, pcm(Math.min(20, total - t))))
    }
    return { r, id, startAt, totalMs: totalMs ?? 0, chunks }
  }
  it('starts at the announced time, ends after the total duration and reports both', async () => {
    const { r, id, startAt, chunks } = await speakRig()
    chunks(0, 1000)
    r.vt.advance(99)
    expect(r.sim.state().speaking).toBeNull()
    r.vt.advance(2)
    expect(r.sim.state().speaking).toBe(id)
    r.vt.advance(1000)
    expect(r.sim.state().speaking).toBeNull()
    const started = r.sim.entries({ name: 'speak.started' })[0]!.data as { stageMs: number }
    const ended = r.sim.entries({ name: 'speak.ended' })[0]!.data as { stageMs: number; interrupted: boolean }
    expect(started.stageMs).toBe(startAt)
    expect(ended.stageMs).toBe(startAt + 1000)
    expect(ended.interrupted).toBe(false)
    const rep = r.sim.utterance(id)!
    expect(rep).toMatchObject({ audioFrames: 50, underruns: 0, endedInterrupted: false })
    expect(rep.receivedMs).toBeCloseTo(1000)
    expect(r.sim.utteranceIds()).toEqual([id])
  })
  it('a late first chunk starts playback when it arrives', async () => {
    const { r, id, startAt, chunks } = await speakRig({ atOffset: 50 })
    r.vt.advance(400)
    chunks(0, 1000)
    const started = r.sim.entries({ name: 'speak.started' })[0]!.data as { stageMs: number }
    expect(started.stageMs).toBeGreaterThan(startAt + 300)
    expect(r.sim.state().speaking).toBe(id)
  })
  it('counts an underrun when audio arrives after playback caught up, and waits for the rest before ending', async () => {
    const { r, id, chunks } = await speakRig()
    chunks(0, 400)
    r.vt.advance(1500) // playback ran out of audio
    expect(r.sim.state().speaking).toBe(id)
    expect(r.sim.entries({ name: 'speak.ended' })).toHaveLength(0)
    chunks(400, 1000)
    expect(r.sim.utterance(id)!.underruns).toBeGreaterThan(0)
    r.vt.advance(100)
    expect(r.sim.entries({ name: 'speak.ended' })).toHaveLength(1)
  })
  it('without totalMs it ends shortly after the last chunk', async () => {
    const { r, chunks } = await speakRig({ totalMs: null })
    chunks(0, 600, undefined, 600)
    r.vt.advance(1000)
    expect(r.sim.entries({ name: 'speak.ended' })).toHaveLength(1)
  })
  it('cancel before playback: ended(interrupted) at once and no started; cancel during playback fades out', async () => {
    const early = await speakRig({ atOffset: 500 })
    early.chunks(0, 200)
    expect((await early.r.send({ type: 'perform.cancel', utteranceId: early.id, fadeMs: 100 })).ok).toBe(true)
    expect(early.r.sim.entries({ name: 'speak.started' })).toHaveLength(0)
    expect(early.r.sim.entries({ name: 'speak.ended' })[0]!.data).toMatchObject({ interrupted: true })
    const live = await speakRig({ id: 'u2' })
    live.chunks(0, 400)
    live.r.vt.advance(300)
    const p = live.r.session.send({ type: 'perform.cancel', utteranceId: 'u2', fadeMs: 150 })
    await p
    expect(live.r.sim.entries({ name: 'speak.ended' })).toHaveLength(0) // still fading
    live.r.vt.advance(150)
    const ended = live.r.sim.entries({ name: 'speak.ended' })[0]!.data as { interrupted: boolean; stageMs: number }
    expect(ended.interrupted).toBe(true)
    expect(live.r.sim.utterance('u2')!.endedInterrupted).toBe(true)
    live.chunks(400, 1000)
    expect(live.r.sim.orphanFrames).toBeGreaterThan(0)
  })
  it('queues a second utterance behind the first', async () => {
    const a = await speakRig({ id: 'a' })
    a.chunks(0, 1000)
    const startB = a.r.sim.stageNow() + 100
    await a.r.send({ type: 'perform.speak', utteranceId: 'b', text: 'second', emotion: 'neutral', audio: { format: 'pcm_s16le', sampleRate: 24000, channels: 1, totalMs: 500 }, faceSource: 'stage', atMs: startB })
    for (let t = 0; t < 500; t += 20) a.r.pair.backend.sendBinary(encodeAudioFrame('b', startB + t, pcm(20)))
    a.r.vt.advance(200)
    expect(a.r.sim.state().speaking).toBe('a')
    a.r.vt.advance(1500)
    const started = a.r.sim.entries({ name: 'speak.started' }).map((e) => (e.data as { utteranceId: string; stageMs: number }))
    expect(started.map((s) => s.utteranceId)).toEqual(['a', 'b'])
    expect(started[1]!.stageMs).toBeGreaterThanOrEqual(started[0]!.stageMs + 1000)
  })
  it('counts face frames, rejects duplicate utterance ids while active, and bad speak parameters', async () => {
    const { r, id, startAt } = await speakRig()
    r.pair.backend.sendBinary(encodeFaceFrame(id, startAt, new Array(104).fill(0.1)))
    expect(r.sim.utterance(id)!.faceFrames).toBe(2)
    expect((await r.send({ type: 'perform.speak', utteranceId: id, text: 'x', emotion: 'neutral', audio: { format: 'pcm_s16le', sampleRate: 24000, channels: 1 }, faceSource: 'stage' })).reason).toMatch(/already active/)
    // an absurd rate is refused by the shared schema before it is sent (the contract bounds it to 8 kHz .. 192 kHz) ...
    expect((await r.send({ type: 'perform.speak', utteranceId: 'z', text: 'x', emotion: 'neutral', audio: { format: 'pcm_s16le', sampleRate: 100, channels: 1 }, faceSource: 'stage' })).reason).toMatch(/sample ?rate/i)
    // ... and one the schema allows but this stage cannot play (above 96 kHz) is refused by the stage itself
    expect((await r.send({ type: 'perform.speak', utteranceId: 'z', text: 'x', emotion: 'neutral', audio: { format: 'pcm_s16le', sampleRate: 150_000, channels: 1 }, faceSource: 'stage' })).reason).toMatch(/unsupported sample rate/)
    expect((await r.send({ type: 'perform.speak', utteranceId: 'z', text: 'x', emotion: 'neutral', audio: { format: 'pcm_s16le', sampleRate: 24000, channels: 1, totalMs: -5 }, faceSource: 'stage' })).reason).toMatch(/totalMs/)
  })
  it('rejects undecodable binary frames and counts frames of unknown utterances; can record every frame', async () => {
    const r = await makeWorldRig({ sim: { recordFrames: true } })
    await loadAll(r)
    r.pair.backend.sendBinary(new Uint8Array([1, 2, 3]))
    r.pair.backend.sendBinary(encodeAudioFrame('ghost', 5, new Uint8Array(960)))
    expect(r.sim.rejectedFrames).toBe(1)
    expect(r.sim.orphanFrames).toBe(1)
    expect(r.sim.entries({ kind: 'frame' }).map((e) => e.name)).toEqual(['rejected', 'orphan'])
    const startAt = r.sim.stageNow() + 50
    await r.send({ type: 'perform.speak', utteranceId: 'u', text: 'hi', emotion: 'neutral', audio: { format: 'pcm_s16le', sampleRate: 24000, channels: 1, totalMs: 40 }, faceSource: 'backend', atMs: startAt })
    r.pair.backend.sendBinary(encodeAudioFrame('u', startAt, new Uint8Array(960)))
    r.pair.backend.sendBinary(encodeFaceFrame('u', startAt, new Array(52).fill(0)))
    expect(r.sim.entries({ kind: 'frame' }).map((e) => e.name)).toEqual(['rejected', 'orphan', 'audio', 'face'])
  })
})

describe('gestures, state and events', () => {
  it('knownClips makes unknown gestures fail', async () => {
    const r = await makeWorldRig({ sim: { knownClips: ['nod_small'] } })
    await loadAll(r)
    expect((await r.send({ type: 'perform.gesture', clip: 'nod_small', intensity: 0.5 })).ok).toBe(true)
    expect((await r.send({ type: 'perform.gesture', clip: 'moonwalk', intensity: 0.5 })).reason).toMatch(/unknown clip/)
    expect(r.sim.state().gestures).toEqual(['nod_small'])
  })
  it('tracks affect, idle, gaze and posture', async () => {
    const r = await makeWorldRig()
    await loadAll(r)
    await r.send({ type: 'perform.affect', affect: { valence: 0.3, arousal: 0, dominance: 0.5, label: 'happy' }, blendMs: 100 })
    await r.send({ type: 'perform.idle', profile: 'sleepy' })
    await r.send({ type: 'perform.gaze', target: { kind: 'away', direction: 'left' }, speed: 0.4, saccades: false })
    await r.send({ type: 'perform.posture', posture: 'stand' })
    expect(r.sim.state()).toMatchObject({ affect: { label: 'happy' }, idle: 'sleepy', gaze: { target: { kind: 'away', direction: 'left' }, speed: 0.4, saccades: false }, posture: { posture: 'stand' } })
  })
  it('returns state snapshots that cannot be used to alter the stage', async () => {
    const r = await makeWorldRig()
    await loadAll(r)
    const s = r.sim.state()
    s.characters[r.assistant.id]!.equipped.top = 'hacked'
    s.loadedAssets.push('x')
    expect(r.sim.state().characters[r.assistant.id]!.equipped.top).toBe(S.shirt)
    expect(r.sim.state().loadedAssets).not.toContain('x')
  })
  it('emits perf, presence, clicks, interaction and terminal events, validated against the contract', async () => {
    const r = await makeWorldRig()
    const seen: string[] = []
    r.session.onEvent((e) => seen.push(e.type))
    r.sim.emitPerf(90, 5.5, 4200)
    r.sim.emitPresence({ present: true, lookingAtScreen: true, distance: 'near' })
    r.sim.emitObjectClicked('chair')
    r.sim.emitObjectClicked('chair', 'secondary')
    r.sim.emitCharacterInteract('c1', 'hand', 'wave')
    r.sim.emitConstructClicked('kg', 'note_1')
    r.sim.emitTerminalInput('term', 'ls\r')
    r.sim.emitTerminalResize('term', 120, 40)
    r.sim.emitError('something odd', false)
    expect(seen).toEqual(['perf', 'user.presence', 'object.clicked', 'object.clicked', 'character.interact', 'construct.clicked', 'construct.terminal.input', 'construct.terminal.resize', 'error'])
    expect(() => r.sim.emitCharacterInteract('c1', 'elbow' as never, 'click')).toThrow()
    expect(() => r.sim.emitPerf('fast' as never, 1, 1)).toThrow()
  })
  it('keeps the timeline bounded and names/filters work', async () => {
    const r = await makeWorldRig({ sim: { maxTimeline: 50 } })
    await loadAll(r)
    for (let i = 0; i < 40; i++) await r.send({ type: 'perform.idle', profile: i % 2 ? 'busy' : 'relaxed' })
    expect(r.sim.timeline.length).toBe(50)
    expect(r.sim.timelineDropped).toBeGreaterThan(0)
    expect(r.sim.entries({ kind: 'command', name: 'perform.idle' }).length).toBeGreaterThan(0)
    expect(r.sim.names('command').every((n) => typeof n === 'string')).toBe(true)
    const seqs = r.sim.timeline.map((e) => e.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
  })
  it('timeline timestamps are on the stage clock (offset applied) and never go backwards', async () => {
    const r = await makeWorldRig({ sim: { clockOffsetMs: 1_000_000 } })
    await loadAll(r)
    for (const e of r.sim.timeline) expect(e.tMs).toBeGreaterThanOrEqual(T0 + 1_000_000)
    const ts = r.sim.timeline.map((e) => e.tMs)
    expect(ts).toEqual([...ts].sort((a, b) => a - b))
  })
})
