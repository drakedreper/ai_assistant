import { describe, expect, it } from 'vitest'
import { STAGE_PROTOCOL } from '@ai-assistant/shared'
import type { StageCapabilities } from '@ai-assistant/shared'
import {
  SEED_IDS as S,
  StageMirror,
  createMemoryTransportPair,
  createSequentialIds,
  createStageSession,
  createVirtualTime,
  encodeAudioFrame,
} from '../src'
import type { CommandDraft } from '../src'
import { T0 } from './helpers'
import { flush, loadAll, makeRig, makeWorldRig } from './rig'

const caps = (over: Partial<StageCapabilities> = {}): StageCapabilities => ({
  engine: 'sim',
  engineVersion: '0',
  rigFamilies: ['vrm1'],
  face: { arkit52: true, visemes: false, audioToFaceOnStage: false },
  render: { strandHair: false, clothSim: false, runtimeAssetLoading: true, embeddedStream: false },
  tracking: { face: false, body: false },
  constructs: ['knowledge_graph'],
  maxCharacters: 1,
  ...over,
})

/** A session whose stage end is driven by hand. */
function manual(opts: { latencyMs?: number; session?: Record<string, unknown> } = {}) {
  const vt = createVirtualTime(T0)
  const pair = createMemoryTransportPair({ timers: vt.timers, latencyMs: opts.latencyMs ?? 0 })
  const session = createStageSession({ transport: pair.backend, clock: vt.clock, timers: vt.timers, newId: createSequentialIds(), ...opts.session })
  const hello = (c: StageCapabilities = caps(), clockMs = vt.now(), protocol: string = STAGE_PROTOCOL) =>
    pair.stage.sendText(JSON.stringify({ type: 'hello', protocol, capabilities: c, stageClockMs: clockMs }))
  const received = () => pair.stage.sentText.length // what the stage sent; commands the backend sent are in pair.backend.sentText
  const sentByBackend = () => pair.backend.sentText.map((t) => JSON.parse(t) as { id: string; type: string })
  const answer = (id: string, ok = true, reason = 'nope') => pair.stage.sendText(JSON.stringify(ok ? { type: 'command.done', id } : { type: 'command.failed', id, reason }))
  return { vt, pair, session, hello, received, sentByBackend, answer }
}
const gaze: CommandDraft = { type: 'perform.gaze', target: { kind: 'user' } }

describe('hello and negotiation', () => {
  it('becomes ready on a valid hello and exposes the capabilities', async () => {
    const m = manual()
    expect(m.session.state).toBe('awaiting_hello')
    m.hello(caps({ engine: 'unreal', engineVersion: '5.6' }))
    const c = await m.session.ready()
    expect(c.engine).toBe('unreal')
    expect(m.session.state).toBe('ready')
    expect(m.session.capabilities?.engineVersion).toBe('5.6')
  })
  it('refuses a protocol mismatch: nothing is sent, the transport is closed, ready() rejects', async () => {
    const m = manual()
    m.session.send(gaze) // queued before the hello
    m.hello(caps(), 0, 'mira-stage/2')
    await expect(m.session.ready()).rejects.toThrow(/protocol_mismatch/)
    expect(m.session.state).toBe('closed')
    expect(m.session.closeReason).toMatch(/mira-stage\/2/)
    expect(m.pair.backend.closed).toBe(true)
    expect(m.sentByBackend()).toHaveLength(0)
  })
  it('refuses a malformed hello', async () => {
    const m = manual()
    m.pair.stage.sendText(JSON.stringify({ type: 'hello', protocol: STAGE_PROTOCOL, capabilities: { engine: 'nope' }, stageClockMs: 0 }))
    await expect(m.session.ready()).rejects.toThrow(/invalid_hello/)
    expect(m.session.state).toBe('closed')
  })
  it('refuses when no hello arrives in time', async () => {
    const m = manual()
    m.vt.advance(5001)
    await expect(m.session.ready()).rejects.toThrow(/hello_timeout/)
    expect(m.session.state).toBe('closed')
  })
  it('commands sent before the hello wait for it and then go out in order', async () => {
    const m = manual()
    const a = m.session.send({ type: 'perform.idle', profile: 'relaxed' })
    const b = m.session.send(gaze)
    expect(m.sentByBackend()).toHaveLength(0)
    m.hello()
    expect(m.sentByBackend().map((c) => c.type)).toEqual(['perform.idle', 'perform.gaze'])
    for (const c of m.sentByBackend()) m.answer(c.id)
    expect(await Promise.all([a, b])).toEqual([{ ok: true }, { ok: true }])
  })
  it('events before the hello are ignored, garbage never throws and is reported', async () => {
    const m = manual()
    const errors: string[] = []
    m.session.onProtocolError((e) => errors.push(e.reason))
    m.pair.stage.sendText(JSON.stringify({ type: 'perf', fps: 60, gpuMs: 1, vramMb: 1 }))
    expect(m.session.stats().eventsBeforeHello).toBe(1)
    m.hello()
    await m.session.ready()
    m.pair.stage.sendText('{not json')
    m.pair.stage.sendText('[1,2]')
    m.pair.stage.sendText('"str"')
    m.pair.stage.sendText(JSON.stringify({ type: 'unknown.event' }))
    m.pair.stage.sendText(JSON.stringify({ type: 'perf', fps: 'fast' }))
    m.pair.stage.sendText('x'.repeat(300_000))
    expect(errors).toHaveLength(6)
    expect(m.session.stats().invalidEvents).toBe(6)
    expect(m.session.state).toBe('ready')
  })
  it('forwards valid events to listeners', async () => {
    const m = manual()
    const seen: string[] = []
    const off = m.session.onEvent((e) => seen.push(e.type))
    m.hello()
    m.pair.stage.sendText(JSON.stringify({ type: 'perf', fps: 60, gpuMs: 4, vramMb: 900 }))
    m.pair.stage.sendText(JSON.stringify({ type: 'user.presence', present: true }))
    off()
    m.pair.stage.sendText(JSON.stringify({ type: 'perf', fps: 61, gpuMs: 4, vramMb: 900 }))
    expect(seen).toEqual(['hello', 'perf', 'user.presence'])
  })
})

describe('command dispatch and acknowledgement', () => {
  it('assigns ids, validates locally and never sends an invalid command', async () => {
    const m = manual()
    m.hello()
    const bad = await m.session.send({ type: 'perform.gesture', clip: 'x', intensity: 5 } as CommandDraft)
    expect(bad.ok).toBe(false)
    expect(bad.reason).toMatch(/invalid command perform.gesture/)
    const worse = await m.session.send({ type: 'nope' } as unknown as CommandDraft)
    expect(worse.ok).toBe(false)
    expect(m.sentByBackend()).toHaveLength(0)
    expect(m.session.stats().rejectedLocally).toBe(2)
    const p = m.session.send(gaze)
    const sent = m.sentByBackend()
    expect(sent).toHaveLength(1)
    expect(sent[0]!.id).toBe('cmd_3') // the two rejected commands consumed ids 1 and 2
    m.answer('cmd_3')
    expect((await p).ok).toBe(true)
    expect(m.session.stats()).toMatchObject({ sent: 1, acked: 1, inFlight: 0 })
  })
  it('refuses a command above the size limit without sending it', async () => {
    const m = manual({ session: { maxCommandBytes: 500 } })
    m.hello(caps({ constructs: ['terminal_pane'] }))
    const r = await m.session.send({ type: 'construct.terminal.write', constructId: 'term', data: 'x'.repeat(2000) })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/too large/)
    expect(JSON.stringify(r)).not.toContain('xxxx')
    expect(m.sentByBackend()).toHaveLength(0)
  })
  it('keeps an explicit id and fills schema defaults', async () => {
    const m = manual()
    m.hello()
    m.session.send({ ...gaze, id: 'mine' })
    const sent = JSON.parse(m.pair.backend.sentText[0]!)
    expect(sent).toMatchObject({ id: 'mine', speed: 0.6, saccades: true })
  })
  it('resolves failures with the stage reason', async () => {
    const m = manual()
    m.hello()
    const p = m.session.send(gaze)
    m.answer('cmd_1', false, 'unknown object')
    expect(await p).toEqual({ ok: false, reason: 'unknown object' })
    expect(m.session.stats().failed).toBe(1)
  })
  it('times out, ignores a late answer and keeps going', async () => {
    const m = manual({ session: { commandTimeoutMs: 1000 } })
    m.hello()
    const p = m.session.send(gaze)
    m.vt.advance(999)
    m.vt.advance(2)
    expect(await p).toEqual({ ok: false, reason: 'timeout' })
    m.answer('cmd_1') // late
    expect(m.session.stats()).toMatchObject({ timeouts: 1, acked: 0 })
    const q = m.session.send(gaze)
    m.answer('cmd_2')
    expect((await q).ok).toBe(true)
  })
  it('uses the longer load timeout for loads', async () => {
    const m = manual({ session: { commandTimeoutMs: 1000, loadTimeoutMs: 20_000 } })
    m.hello(caps({ constructs: [] }))
    const w = await makeWorldRig()
    const load = w.characters.loadCommand(w.assistant.id)
    if (!load.ok) throw new Error('setup')
    const p = m.session.send(load.value)
    m.vt.advance(5000)
    expect(m.session.stats().timeouts).toBe(0)
    m.vt.advance(16_000)
    expect(await p).toEqual({ ok: false, reason: 'timeout' })
  })
  it('fire-and-forget resolves at once and a later answer is harmless', async () => {
    const m = manual()
    m.hello()
    const r = await m.session.send(gaze, { ack: false })
    expect(r).toEqual({ ok: true })
    expect(m.session.stats().inFlight).toBe(0)
    m.answer('cmd_1')
    expect(m.session.state).toBe('ready')
  })
  it('bounds in-flight commands, queues the rest in order, and rejects when the queue is full', async () => {
    const m = manual({ session: { maxInFlight: 2, maxQueue: 3 } })
    m.hello()
    const ps = Array.from({ length: 7 }, (_, i) => m.session.send({ type: 'perform.gaze', target: { kind: 'away', direction: (['left', 'right', 'up', 'down'] as const)[i % 4]! } }))
    expect(m.sentByBackend()).toHaveLength(2)
    expect(m.session.stats()).toMatchObject({ inFlight: 2, queued: 3 })
    const results = await Promise.race([Promise.all(ps.slice(5)), flush().then(() => 'pending')])
    expect(Array.isArray(results) ? results.map((r) => r.reason) : results).toEqual(['queue_full', 'queue_full'])
    m.answer('cmd_1')
    m.answer('cmd_2')
    expect(m.sentByBackend().map((c) => c.id)).toEqual(['cmd_1', 'cmd_2', 'cmd_3', 'cmd_4'])
    for (const id of ['cmd_3', 'cmd_4', 'cmd_5']) m.answer(id)
    const all = await Promise.all(ps)
    expect(all.filter((r) => r.ok)).toHaveLength(5)
    expect(m.sentByBackend().map((c) => c.id)).toEqual(['cmd_1', 'cmd_2', 'cmd_3', 'cmd_4', 'cmd_5'])
  })
  it('closing fails everything in flight and queued', async () => {
    const m = manual({ session: { maxInFlight: 1 } })
    m.hello()
    const a = m.session.send(gaze)
    const b = m.session.send(gaze)
    m.session.close('bye')
    expect(await a).toEqual({ ok: false, reason: 'closed' })
    expect(await b).toEqual({ ok: false, reason: 'closed' })
    expect(await m.session.send(gaze)).toEqual({ ok: false, reason: 'closed' })
    expect(m.pair.backend.closed).toBe(true)
    expect(m.session.state).toBe('closed')
  })
  it('a transport close (or notifyClosed) closes the session and informs listeners once', async () => {
    const m = manual()
    m.hello()
    const reasons: string[] = []
    m.session.onClose((r) => reasons.push(r))
    m.pair.stage.close(1006, 'gone')
    m.session.notifyClosed()
    expect(reasons).toEqual(['gone'])
    const late: string[] = []
    m.session.onClose((r) => late.push(r))
    expect(late).toEqual(['gone'])
  })
  it('works with a transport that has no onClose', async () => {
    const vt = createVirtualTime(T0)
    const pair = createMemoryTransportPair()
    const t = { ...pair.backend, onClose: undefined, sendText: pair.backend.sendText.bind(pair.backend), sendBinary: pair.backend.sendBinary.bind(pair.backend), onText: pair.backend.onText.bind(pair.backend), onBinary: pair.backend.onBinary.bind(pair.backend), close: pair.backend.close.bind(pair.backend) }
    const session = createStageSession({ transport: t, clock: vt.clock, timers: vt.timers, newId: createSequentialIds() })
    session.notifyClosed('socket gone')
    expect(session.state).toBe('closed')
  })
  it('sendMany answers every command', async () => {
    const r = await makeRig()
    r.sim.emitPerf(60, 1, 1)
    const res = await r.session.sendMany([{ type: 'perform.idle', profile: 'relaxed' }, { type: 'perform.idle', profile: 'busy' }])
    // no character is loaded in a bare rig: the simulator refuses both, cleanly
    expect(res.map((x) => x.ok)).toEqual([false, false])
  })
})

describe('clock sync', () => {
  it('estimates the offset from the hello (zero latency)', async () => {
    const m = manual()
    m.hello(caps(), T0 + 5000)
    expect(m.session.clockOffsetMs()).toBe(5000)
    expect(m.session.stageNow()).toBe(T0 + 5000)
    m.vt.advance(1234)
    expect(m.session.stageNow()).toBe(T0 + 5000 + 1234)
    expect(m.session.toStageTime(T0 + 10)).toBe(T0 + 5010)
    expect(m.session.toBackendTime(T0 + 5010)).toBe(T0 + 10)
  })
  it('the hello under-estimates by the one-way delay; later samples with less delay refine it', async () => {
    const m = manual()
    // stage computes stageMs at stage time T0+5000, but the hello is delivered 80 ms later
    const sent = T0 + 5000
    m.vt.advance(80)
    m.hello(caps(), sent)
    expect(m.session.clockOffsetMs()).toBe(4920)
    m.vt.advance(1000)
    // speak.started computed at stage time (now + 5000 - 10), delivered 10 ms later: only 10 ms of delay
    m.pair.stage.sendText(JSON.stringify({ type: 'speak.started', utteranceId: 'u', stageMs: m.vt.now() + 5000 - 10 }))
    expect(m.session.clockOffsetMs()).toBe(4990)
    m.vt.advance(1000)
    // a worse sample (60 ms) does not make the estimate worse
    m.pair.stage.sendText(JSON.stringify({ type: 'speak.started', utteranceId: 'v', stageMs: m.vt.now() + 5000 - 60 }))
    expect(m.session.clockOffsetMs()).toBe(4990)
    expect(m.session.clockSamples()).toBe(3)
    expect(m.session.clockJitterMs()).toBe(70)
  })
  it('keeps a bounded window and forgets it when the stage clock jumps by more than 5 s', async () => {
    const m = manual()
    m.hello(caps(), T0)
    for (let i = 0; i < 20; i++) m.pair.stage.sendText(JSON.stringify({ type: 'speak.started', utteranceId: `u${i}`, stageMs: m.vt.now() - i }))
    expect(m.session.clockSamples()).toBe(8)
    m.pair.stage.sendText(JSON.stringify({ type: 'speak.started', utteranceId: 'jump', stageMs: m.vt.now() + 60_000 }))
    expect(m.session.clockSamples()).toBe(1)
    expect(m.session.clockOffsetMs()).toBe(60_000)
  })
  it('a simulator with a different clock epoch is tracked through real speak events', async () => {
    const r = await makeRig({ sim: { clockOffsetMs: 123_456 } })
    expect(r.session.clockOffsetMs()).toBe(123_456)
  })
  it('ignores non-finite samples', async () => {
    const m = manual()
    m.hello(caps(), T0)
    m.pair.stage.sendText(JSON.stringify({ type: 'speak.started', utteranceId: 'u', stageMs: null }))
    expect(m.session.clockSamples()).toBe(1)
  })
})

describe('capability adaptation', () => {
  const knowledge = { id: 'kg', kind: 'knowledge_graph', transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, source: 'brain' } as const
  const terminal = { id: 'term', kind: 'terminal_pane', transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, source: 'terminal' } as const

  it('skips constructs the stage cannot draw, along with their data and terminal bytes, and does not send them', async () => {
    const r = await makeWorldRig({ sim: { capabilities: { constructs: ['knowledge_graph'] } } })
    await loadAll(r)
    const kg = await r.session.send({ type: 'scene.construct', op: 'add', construct: knowledge as never })
    expect(kg).toEqual({ ok: true })
    const t = await r.session.send({ type: 'scene.construct', op: 'add', construct: terminal as never })
    expect(t).toEqual({ ok: true, skipped: 'unsupported_construct' })
    expect(await r.session.send({ type: 'construct.terminal.write', constructId: 'term', data: 'hi' })).toEqual({ ok: true, skipped: 'unsupported_construct' })
    expect(await r.session.send({ type: 'scene.data', constructId: 'term', mode: 'merge', items: [{ id: 'a' }] })).toEqual({ ok: true, skipped: 'unsupported_construct' })
    expect(await r.session.send({ type: 'scene.construct', op: 'remove', construct: terminal as never })).toEqual({ ok: true, skipped: 'unsupported_construct' })
    expect(Object.keys(r.sim.state().constructs)).toEqual(['kg'])
    expect(r.session.stats().skipped).toBe(4)
    expect(r.session.supports('knowledge_graph')).toBe(true)
    expect(r.session.supports('terminal_pane')).toBe(false)
  })
  it('scene.load is filtered to the constructs the stage supports', async () => {
    const r = await makeWorldRig({ sim: { capabilities: { constructs: ['knowledge_graph'] } } })
    r.scenes.addConstruct(knowledge)
    r.scenes.addConstruct(terminal)
    const load = r.scenes.loadCommand()
    if (!load.ok) throw new Error('setup')
    const p = r.session.send(load.value)
    r.vt.advance(1000)
    expect((await p).ok).toBe(true)
    expect(r.sim.state().scene!.constructs.map((c) => c.id)).toEqual(['kg'])
    expect(await r.session.send({ type: 'scene.data', constructId: 'term', mode: 'merge', items: [{ id: 'a' }] })).toMatchObject({ skipped: 'unsupported_construct' })
  })
  it('refuses a rig the stage does not support and a character beyond maxCharacters, without sending', async () => {
    const r = await makeWorldRig({ sim: { capabilities: { rigFamilies: ['metahuman'], maxCharacters: 1 } } })
    const load = r.characters.loadCommand(r.assistant.id)
    if (!load.ok) throw new Error('setup')
    const bad = await r.session.send(load.value)
    expect(bad.reason).toMatch(/rig_unsupported/)
    expect(r.pair.backend.sentText).toHaveLength(0)
    expect(r.session.stats().rejectedLocally).toBe(1)
    const r2 = await makeWorldRig({ sim: { capabilities: { maxCharacters: 1 } } })
    const l1 = r2.characters.loadCommand(r2.assistant.id)
    const user = r2.characters.create({ name: 'Me', role: 'user', baseAssetId: 'base.vrm1.poised' })
    if (!l1.ok || !user.ok) throw new Error('setup')
    const p = r2.session.send(l1.value)
    r2.vt.advance(1000)
    expect((await p).ok).toBe(true)
    const l2 = r2.characters.loadCommand(user.value.id)
    if (!l2.ok) throw new Error('setup')
    expect((await r2.session.send(l2.value)).reason).toMatch(/max_characters/)
    // reloading the same character is fine
    const again = r2.session.send(l1.value)
    r2.vt.advance(1000)
    expect((await again).ok).toBe(true)
  })
  it.each([
    [{ arkit52: true, visemes: false, audioToFaceOnStage: false }, 'backend'],
    [{ arkit52: false, visemes: true, audioToFaceOnStage: false }, 'backend'],
    [{ arkit52: true, visemes: true, audioToFaceOnStage: true }, 'stage'],
    [{ arkit52: false, visemes: false, audioToFaceOnStage: false }, 'stage'],
  ])('picks the face source from capabilities %j -> %s', async (face, expected) => {
    const m = manual()
    expect(m.session.faceSource()).toBe('stage') // before the hello
    m.hello(caps({ face }))
    expect(m.session.faceSource()).toBe(expected)
  })
  it('coerces a backend face request to the stage when the stage cannot take frames', async () => {
    const m = manual()
    m.hello(caps({ face: { arkit52: false, visemes: false, audioToFaceOnStage: false } }))
    m.session.send({ type: 'perform.speak', utteranceId: 'u', text: 'hi', emotion: 'neutral', audio: { format: 'pcm_s16le', sampleRate: 24000, channels: 1 }, faceSource: 'backend' })
    expect(JSON.parse(m.pair.backend.sentText[0]!).faceSource).toBe('stage')
    const n = manual()
    n.hello(caps())
    n.session.send({ type: 'perform.speak', utteranceId: 'u', text: 'hi', emotion: 'neutral', audio: { format: 'pcm_s16le', sampleRate: 24000, channels: 1 }, faceSource: 'backend' })
    expect(JSON.parse(n.pair.backend.sentText[0]!).faceSource).toBe('backend')
  })
})

describe('back-pressure', () => {
  it('holds binary frames back above the high-water mark and counts it', async () => {
    const m = manual({ session: { highWaterBytes: 1000 } })
    expect(m.session.canSendBinary()).toBe(false) // not ready yet
    m.hello()
    const frame = encodeAudioFrame('u', 0, new Uint8Array(960))
    expect(m.session.canSendBinary()).toBe(true)
    expect(m.session.sendBinary(frame)).toBe(true)
    m.pair.backend.buffered = 1000
    expect(m.session.bufferedAmount()).toBe(1000)
    expect(m.session.canSendBinary()).toBe(false)
    expect(m.session.sendBinary(frame)).toBe(false)
    m.pair.backend.buffered = 999
    expect(m.session.sendBinary(frame)).toBe(true)
    expect(m.session.stats()).toMatchObject({ binarySent: 2, binaryHeldBack: 1 })
    expect(m.pair.backend.sentBinary).toHaveLength(2)
  })
  it('never sends binary when closed', async () => {
    const m = manual()
    m.hello()
    m.session.close()
    expect(m.session.sendBinary(encodeAudioFrame('u', 0, new Uint8Array(2)))).toBe(false)
  })
})

describe('state mirror and resume', () => {
  it('mirrors what the stage acknowledged, not what failed', async () => {
    const r = await makeWorldRig()
    await loadAll(r)
    const eq = r.wardrobe.equip(r.assistant.id, S.blazer)
    if (!eq.ok) throw new Error('setup')
    for (const c of eq.value.commands) await r.send(c, 200)
    const failed = await r.send({ type: 'scene.camera', cameraId: 'nope' })
    expect(failed.ok).toBe(false)
    const m = r.session.mirror
    expect(m.character()!.equipped.outerwear).toBe(S.blazer)
    expect(m.sceneState()!.activeCameraId).toBe('wide')
    await r.send({ type: 'scene.camera', cameraId: 'closeup', blendMs: 500 })
    expect(m.sceneState()!.activeCameraId).toBe('closeup')
    expect(m.assistantId()).toBe(r.assistant.id)
  })

  it('RESUME: a new connection replays characters, scene, constructs, data and the current look', async () => {
    const mirror = new StageMirror()
    const r = await makeWorldRig({ mirror })
    await loadAll(r)
    const eq = r.wardrobe.equip(r.assistant.id, S.coat)
    if (!eq.ok) throw new Error('setup')
    for (const c of eq.value.commands) await r.send(c, 200)
    const params = r.characters.setParams(r.assistant.id, { 'hair.color': '#112233', 'body.height_cm': 180 })
    if (!params.ok || !params.value.command) throw new Error('setup')
    await r.send(params.value.command)
    const add = r.scenes.addConstruct({ id: 'kg', kind: 'knowledge_graph', transform: { position: [0, 1.5, 3], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, source: 'brain' })
    if (!add.ok) throw new Error('setup')
    await r.send(add.value.commands[0]!)
    await r.send({ type: 'scene.data', constructId: 'kg', mode: 'replace', nodes: [{ id: 'a', label: 'A', importance: 3 }, { id: 'b', label: 'B', importance: 2 }], edges: [{ from: 'a', to: 'b', weight: 1 }] })
    await r.send({ type: 'scene.camera', cameraId: 'profile', blendMs: 100 }, 200)
    await r.send({ type: 'perform.idle', profile: 'attentive' })
    await r.send({ type: 'perform.affect', affect: { valence: 0.4, arousal: 0.1, dominance: 0.6, label: 'happy' }, blendMs: 0 })
    await r.send({ type: 'perform.posture', posture: 'stand' })
    await r.send({ type: 'perform.gaze', target: { kind: 'user' }, speed: 0.5, saccades: true })
    const before = r.sim.state()
    expect(before.camera.activeId).toBe('profile')

    // the stage goes away; a NEW stage connects and the backend resumes it
    r.session.close('stage restarted')
    const vt = r.vt
    const pair2 = createMemoryTransportPair({ timers: vt.timers })
    const { createStageSession: mk, createSimulatorStage } = await import('../src')
    const session2 = mk({ transport: pair2.backend, clock: vt.clock, timers: vt.timers, newId: r.newId, mirror })
    const sim2 = createSimulatorStage({ transport: pair2.stage, clock: vt.clock, timers: vt.timers })
    sim2.start()
    await session2.ready()
    vt.advance(5000)
    await flush(20)
    const after = sim2.state()
    expect(after.characters[r.assistant.id]!.equipped).toEqual(before.characters[r.assistant.id]!.equipped)
    expect(after.characters[r.assistant.id]!.params).toEqual(before.characters[r.assistant.id]!.params)
    expect(after.scene!.objects).toEqual(before.scene!.objects)
    expect(after.scene!.constructs.map((c) => c.id)).toEqual(['kg'])
    expect(after.constructs.kg!.data).toEqual(before.constructs.kg!.data)
    expect(after.camera.activeId).toBe('profile')
    expect(after.idle).toBe('attentive')
    expect(after.affect?.label).toBe('happy')
    expect(after.posture?.posture).toBe('stand')
    expect(after.gaze?.target).toEqual({ kind: 'user' })
    expect(after.assistantId).toBe(r.assistant.id)
    expect(session2.stats().failed).toBe(0)
  })

  it('does not resume a fresh install (empty mirror) and can resume on demand', async () => {
    const r = await makeRig()
    expect(r.session.mirror.hasContent()).toBe(false)
    expect(r.session.stats().sent).toBe(0)
    expect(await r.session.resume()).toEqual([])
  })

  it('resumeCommands lets the owner rebuild the stage from its own services, plus the mirrored look', async () => {
    const mirror = new StageMirror()
    const r1 = await makeWorldRig({ mirror })
    await loadAll(r1)
    await r1.send({ type: 'perform.idle', profile: 'busy' })
    // the backend changes the outfit while the stage is away: the mirror cannot know, the services do
    const eq = r1.wardrobe.equip(r1.assistant.id, S.coat)
    if (!eq.ok) throw new Error('setup')
    r1.session.close('away')
    const r2 = await makeRig({
      mirror,
      vt: r1.vt,
      session: {
        resumeCommands: () => {
          const c = r1.characters.loadCommand(r1.assistant.id)
          const s = r1.scenes.loadCommand()
          if (!c.ok || !s.ok) throw new Error('setup')
          return [c.value, s.value, ...mirror.replayLook()]
        },
      },
    })
    r2.vt.advance(3000)
    await flush(20)
    expect(r2.sim.state().characters[r1.assistant.id]!.equipped.outerwear).toBe(S.coat)
    expect(r2.sim.state().idle).toBe('busy')
    expect(mirror.replayLook().map((c) => c.type)).toEqual(['perform.idle'])
  })
  it('autoResume can be switched off', async () => {
    const mirror = new StageMirror()
    const r1 = await makeWorldRig({ mirror })
    await loadAll(r1)
    const r2 = await makeRig({ mirror, vt: r1.vt, session: { autoResume: false } })
    expect(r2.session.stats().sent).toBe(0)
    expect(r2.sim.state().scene).toBeNull()
  })
})
