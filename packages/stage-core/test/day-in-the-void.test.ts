/**
 * A scripted DAY IN THE VOID: the whole backend (characters, wardrobe, outfit director, scene, constructs, mood,
 * behaviour, camera, speech, memory, session) wired to the headless simulator stage over a transport with latency, on
 * virtual time. The glue in `makeDay` is the reference wiring the daemon will implement. The assertions read the
 * simulator's state and recorded timeline.
 */
import { describe, expect, it } from 'vitest'
import { AUTHORITY_PRESENCE } from '@ai-assistant/shared'
import {
  BehaviorDirector,
  CameraDirector,
  CharacterMemory,
  ConstructDataSync,
  FakeFaceProvider,
  FakeTtsProvider,
  InMemoryCharacterRepo,
  InMemoryMemoryRepo,
  InMemorySceneRepo,
  MoodEngine,
  OutfitDirector,
  SEED_IDS as S,
  SpeechPipeline,
  StageMirror,
  TerminalBindings,
  buildKnowledgeGraph,
  constructDataEqual,
  createCharacterService,
  createMemoryTransportPair,
  createRng,
  createSceneService,
  createSeedCatalog,
  createSequentialIds,
  createSimulatorStage,
  createStageSession,
  createStageToolBindings,
  createTerminalPaneConstruct,
  createVirtualTime,
  createWardrobeService,
  seedBaseId,
} from '../src'
import type { CommandDraft, GraphNoteInput } from '../src'
import { at, T0 } from './helpers'
import { flush } from './rig'

const VOICE = { provider: 'kokoro', voiceId: 'v', speed: 1, pitchSemitones: 0 } as const
const QUIET = { from: '22:30', to: '07:00' }

async function makeDay() {
  const vt = createVirtualTime(at(6, 50))
  const newId = createSequentialIds()
  const mirror = new StageMirror()
  const connect = async () => {
    const pair = createMemoryTransportPair({ timers: vt.timers, latencyMs: 10 })
    const session = createStageSession({ transport: pair.backend, clock: vt.clock, timers: vt.timers, newId, mirror })
    const sim = createSimulatorStage({ transport: pair.stage, clock: vt.clock, timers: vt.timers, clockOffsetMs: 3_600_000 })
    sim.start()
    vt.advance(10)
    await session.ready()
    return { pair, session, sim }
  }
  let conn = await connect()

  // ---- backend services (what the daemon owns)
  const catalog = createSeedCatalog()
  const characters = createCharacterService({ repo: new InMemoryCharacterRepo(), catalog, clock: vt.clock, newId })
  const scenes = createSceneService({ repo: new InMemorySceneRepo(), catalog, clock: vt.clock, newId })
  const ctx: { activity?: 'work' | 'meeting' | 'relax' | 'sleep' | 'out' } = {}
  let outfit!: OutfitDirector
  const wardrobe = createWardrobeService({ characters, catalog, newId, onChange: (c) => outfit.handleChange(c, ctx) })
  const created = characters.create({ name: 'Mira', baseAssetId: seedBaseId('vrm1') })
  if (!created.ok) throw new Error(created.error)
  const assistant = created.value
  outfit = new OutfitDirector({ clock: vt.clock, presets: () => wardrobe.applicablePresets(assistant.id), currentPresetId: () => wardrobe.currentPresetId(assistant.id) })
  scenes.ensureVoid()
  const memory = new CharacterMemory({ repo: new InMemoryMemoryRepo(), clock: vt.clock, newId })
  const mood = MoodEngine.fromPresence(assistant.presence, vt.clock)
  const behavior = new BehaviorDirector({ clock: vt.clock, rng: createRng(7), presence: assistant.presence, mood, quietHours: QUIET, characterId: assistant.id })
  const camera = new CameraDirector({ clock: vt.clock, available: () => scenes.getScene()!.cameras.map((c) => c.id), initial: 'wide' })
  const cameraState = { activity: 'idle' as 'idle' | 'conversation' | 'working' | 'reviewing' }
  const sync = new ConstructDataSync()
  const bindings = new TerminalBindings()

  const out = (cmds: CommandDraft[], ack = false) => {
    for (const c of cmds) void conn.session.send(c, { ack })
  }
  const makePipeline = () =>
    new SpeechPipeline({ sink: conn.session, tts: new FakeTtsProvider(), face: new FakeFaceProvider(), voice: VOICE, clock: vt.clock, timers: vt.timers, newId })
  let pipeline = makePipeline()
  const wire = () => {
    conn.session.onEvent((e) => {
      pipeline.handleStageEvent(e)
      if (e.type === 'speak.started') behavior.onSpeechStarted()
      if (e.type === 'speak.ended') behavior.onSpeechEnded(e.interrupted)
      if (e.type === 'user.presence') behavior.onUserPresence(e)
    })
  }
  wire()

  /** One pass of the daemon's loop. */
  const tickAll = () => {
    out(behavior.tick())
    const profileAsleep = behavior.currentProfile() === 'asleep'
    const cam = camera.update({ activity: profileAsleep ? 'asleep' : cameraState.activity })
    if (cam) {
      const r = scenes.setActiveCamera((cam as { cameraId: string }).cameraId, (cam as { blendMs: number }).blendMs)
      if (r.ok) out(r.value.commands, true)
    }
  }
  const run = async (ms: number, step = 50) => {
    for (let t = 0; t < ms; t += step) {
      vt.advance(step)
      await flush(8)
      tickAll()
    }
    await flush(8)
  }
  /** Large steps for long stretches of the day. */
  const jumpTo = async (target: number, step = 30_000) => {
    while (vt.now() < target) {
      vt.advance(Math.min(step, target - vt.now()))
      await flush(4)
      tickAll()
    }
    await flush(8)
  }
  const sendAndWait = async (cmds: CommandDraft[], ms = 600) => {
    const p = Promise.all(cmds.map((c) => conn.session.send(c)))
    vt.advance(ms)
    const res = await p
    await flush()
    return res
  }
  const reconnect = async () => {
    conn.session.close('stage restarted')
    conn.sim.stop()
    conn = await connect()
    pipeline = makePipeline()
    wire()
  }
  return { vt, newId, mirror, get conn() { return conn }, catalog, characters, scenes, wardrobe, outfit, memory, mood, behavior, camera, cameraState, sync, bindings, assistant, ctx, get pipeline() { return pipeline }, tickAll, run, jumpTo, sendAndWait, out, reconnect }
}

const NOTES: GraphNoteInput[] = [
  { id: '00-core/persona.md', title: 'Persona', layer: 'core', importance: 5, body: 'See [[Values]] and [[Q4 plan]].' },
  { id: '00-core/values.md', title: 'Values', layer: 'core', importance: 5 },
  { id: '10-strategy/Q4 plan.md', title: 'Q4 plan', layer: 'strategy', importance: 4, body: 'Depends on [[Values]] and [[Positioning]].' },
  { id: '30-projects/Positioning.md', title: 'Positioning', layer: 'project', importance: 3, body: 'Feeds [[Q4 plan]].' },
  { id: '90-inbox/idea.md', title: 'Idea', layer: 'inbox', importance: 1, body: 'Maybe [[Positioning]]?' },
]

describe('a day in the void', () => {
  it('runs the whole script and the simulator timeline tells the story', async () => {
    const d = await makeDay()
    const sim = () => d.conn.sim

    // ------------------------------------------------------------------ 06:50 boot: the void and the assistant
    d.characters.restore()
    const loadChar = d.characters.loadCommand(d.assistant.id)
    const loadScene = d.scenes.loadCommand()
    if (!loadChar.ok || !loadScene.ok) throw new Error('boot')
    const boot = await d.sendAndWait([loadChar.value, loadScene.value], 1200)
    expect(boot.every((r) => r.ok)).toBe(true)
    const s0 = sim().state()
    expect(s0.scene).toMatchObject({ environmentAssetId: S.void, activeCameraId: 'wide', lightingLook: 'void' })
    expect(s0.scene!.cameraIds).toEqual(['wide', 'medium', 'closeup', 'profile', 'back', 'over_shoulder'])
    expect(s0.characters[d.assistant.id]).toMatchObject({ role: 'assistant', rigFamily: 'vrm1' })
    expect(s0.characters[d.assistant.id]!.equipped).toMatchObject({ top: S.shirt, bottom: S.trousers, footwear: S.boots })
    expect(sim().entries({ kind: 'event', name: 'asset.loaded' }).map((e) => (e.data as { assetId: string }).assetId)).toContain(S.void)

    // ------------------------------------------------- quiet hours: she sleeps, silently, and stays within her budget
    d.behavior.onUserPresence({ present: false })
    await d.run(60_000, 500)
    expect(d.behavior.currentProfile()).toBe('asleep')
    expect(sim().state()).toMatchObject({ idle: 'asleep', posture: { posture: 'sleep' } })
    const asleepSince = sim().entries({ kind: 'command', name: 'perform.idle' }).at(-1)!.seq
    expect(d.behavior.requestUtterance({ kind: 'proactive' })).toMatchObject({ allowed: false, reason: 'quiet hours' })
    expect(d.behavior.requestUtterance({ kind: 'briefing' })).toMatchObject({ allowed: false, reason: 'quiet hours' })

    // ----------------------------------------------------- 07:30 the user comes back, she wakes and greets with speech
    await d.jumpTo(at(7, 30))
    expect(d.behavior.requestUtterance({ kind: 'briefing' }, { commit: false }).allowed).toBe(true)
    sim().emitPresence({ present: true, lookingAtScreen: true, distance: 'near' })
    d.behavior.onUserMessage()
    d.behavior.setActivity('conversation')
    d.cameraState.activity = 'conversation'
    await d.run(300)
    expect(d.behavior.currentProfile()).toBe('attentive')
    expect(sim().state().idle).toBe('attentive')
    expect(d.behavior.requestUtterance({ kind: 'briefing' }).allowed).toBe(true)
    expect(d.behavior.requestUtterance({ kind: 'briefing' }).allowed).toBe(false)
    // while she slept (until quiet hours ended at 07:00 on the stage clock) she made no gaze, gesture or speech commands
    const quietEndStage = at(7, 0) + 3_600_000
    const duringSleep = sim().timeline.filter((e) => e.seq > asleepSince && e.kind === 'command' && e.tMs < quietEndStage && ['perform.gaze', 'perform.gesture', 'perform.speak'].includes(e.name))
    expect(duringSleep).toEqual([])
    expect(sim().timeline.some((e) => e.kind === 'command' && e.name === 'perform.gaze' && e.tMs >= quietEndStage)).toBe(true) // and she came to life afterwards

    d.pipeline.enqueue({ text: 'Good morning.', emotion: 'happy' })
    d.pipeline.enqueue({ text: 'Two Claude sessions are waiting for you.', emotion: 'neutral' })
    await d.run(9000)
    await d.pipeline.idle()
    const speaks = sim().entries({ kind: 'command', name: 'perform.speak' })
    expect(speaks).toHaveLength(2)
    expect(sim().entries({ kind: 'event', name: 'speak.ended' }).map((e) => (e.data as { interrupted: boolean }).interrupted)).toEqual([false, false])
    for (const id of sim().utteranceIds()) {
      const u = sim().utterance(id)!
      expect(u.receivedMs).toBeCloseTo(u.totalMs!, 0)
      expect(u.faceFrames).toBe(Math.ceil((u.totalMs! * 30) / 1000))
      expect(u.faceSource).toBe('backend')
    }
    expect(sim().state().camera.activeId).toBe('medium') // the conversation shot, after the dwell
    // her gaze is on the user, and she turned to them
    expect(sim().state().gaze).toBeDefined()
    expect(sim().entries({ kind: 'command', name: 'perform.gaze' }).some((e) => (e.data as { target: { kind: string } }).target.kind === 'user')).toBe(true)

    // ---------------------------------------------------------------------- good news: mood shifts, camera beat
    const before = d.mood.get()
    d.mood.apply({ type: 'good_news' })
    d.camera.noteBeat('emotional')
    await d.run(1500)
    expect(d.mood.get().valence).toBeGreaterThan(before.valence)
    expect(d.mood.get().label).toBe('happy')
    expect(sim().state().affect).toMatchObject({ label: 'happy' })
    expect(sim().state().camera.activeId).toBe('closeup')
    await d.run(9000)
    expect(sim().state().camera.activeId).toBe('medium') // back to the conversation shot after the beat
    const blends = sim().entries({ name: 'camera.blend.start' }).map((e) => (e.data as { to: string }).to)
    expect(blends).toEqual(['medium', 'closeup', 'medium'])
    d.memory.remember({ kind: 'episode', text: 'Good news about the Q4 positioning draft', importance: 4, emotion: 'happy' })

    // ---------------------------------------------- a meeting is coming: the director picks an outfit and explains it
    d.ctx.activity = 'meeting'
    const sug = d.outfit.suggest({ activity: 'meeting', weather: 'clear' })!
    expect(sug).toMatchObject({ presetId: 'preset.meeting', changed: true })
    expect(sug.explanation).toBe('Changing into Meeting: you have a meeting.')
    const applied = d.wardrobe.applyPreset(d.assistant.id, sug.presetId, { source: 'director' })
    if (!applied.ok) throw new Error(applied.error)
    expect((await d.sendAndWait(applied.value.commands, 600)).every((r) => r.ok)).toBe(true)
    expect(sim().state().characters[d.assistant.id]!.equipped).toMatchObject({ outerwear: S.blazer, top: S.shirt })
    expect(sim().entries({ kind: 'event', name: 'asset.loaded' }).some((e) => (e.data as { assetId: string }).assetId === S.blazer)).toBe(true)
    // she does not change again straight away; an explicit user choice then always wins
    const keep = d.outfit.suggest({ activity: 'relax', timeOfDay: 'evening' })!
    expect(keep).toMatchObject({ presetId: 'preset.meeting', changed: false })
    expect(keep.explanation).toMatch(/changed recently/)
    const user = d.wardrobe.applyPreset(d.assistant.id, 'preset.training', { source: 'user' })
    if (!user.ok) throw new Error(user.error)
    await d.sendAndWait(user.value.commands, 600)
    expect(sim().state().characters[d.assistant.id]!.equipped).toMatchObject({ top: S.trainingTop, bottom: S.leggings, outerwear: null })
    expect(d.outfit.suggest({ activity: 'meeting', bypassCooldown: true })).toMatchObject({ presetId: 'preset.training', changed: false })

    // ------------------------------------------------------------- a knowledge graph appears, then changes minimally
    const add = d.scenes.addConstruct({ id: 'kg', kind: 'knowledge_graph', transform: { position: [0, 1.4, 3.2], rotation: [0, 1, 0, 0], scale: [1, 1, 1] }, source: 'brain' })
    if (!add.ok) throw new Error(add.error)
    await d.sendAndWait(add.value.commands)
    const g1 = buildKnowledgeGraph(NOTES)
    expect(g1.stats.unresolvedLinks).toBe(0)
    const first = d.sync.update('kg', g1)
    expect(first).toHaveLength(1)
    expect((await d.sendAndWait(first)).every((r) => r.ok)).toBe(true)
    expect(sim().state().constructs.kg!.data.nodes).toHaveLength(5)
    expect(sim().state().constructs.kg!.data.edges.length).toBe(g1.edges.length)
    for (const n of sim().state().constructs.kg!.data.nodes) expect(n.position!.every(Number.isFinite)).toBe(true)
    const core = sim().state().constructs.kg!.data.nodes.find((n) => n.id === '00-core/persona.md')!
    const inbox = sim().state().constructs.kg!.data.nodes.find((n) => n.id === '90-inbox/idea.md')!
    expect(core.position![2]).toBeLessThan(inbox.position![2]) // core is nearer than the inbox
    const notes2: GraphNoteInput[] = [...NOTES.filter((n) => n.id !== '90-inbox/idea.md'), { id: '20-semantic/Briefing.md', title: 'Briefing', layer: 'semantic', importance: 3, body: 'Links [[Persona]].' }]
    const g2 = buildKnowledgeGraph(notes2)
    const delta = d.sync.update('kg', g2)
    expect(delta.length).toBeGreaterThan(0)
    expect(delta.every((c) => (c as { mode: string }).mode === 'merge')).toBe(true) // never a full replace on an update
    expect(delta.map((c) => (c as { remove?: { nodes?: string[] } }).remove?.nodes ?? []).flat()).toContain('90-inbox/idea.md')
    await d.sendAndWait(delta)
    expect(constructDataEqual({ nodes: sim().state().constructs.kg!.data.nodes, edges: sim().state().constructs.kg!.data.edges, items: [] }, { nodes: g2.nodes, edges: g2.edges, items: [] })).toBe(true)
    // she works in the construct: the camera goes over her shoulder
    d.behavior.setActivity('working')
    d.cameraState.activity = 'working'
    d.behavior.setScreenObject(undefined)
    await d.run(8000)
    expect(sim().state().camera.activeId).toBe('over_shoulder')
    // a terminal pane shows PTY output
    const term = createTerminalPaneConstruct({ terminalId: 't1' })
    const addTerm = d.scenes.addConstruct(term)
    if (!addTerm.ok) throw new Error(addTerm.error)
    await d.sendAndWait(addTerm.value.commands)
    d.bindings.bind(term.id, 't1')
    await d.sendAndWait(d.bindings.writeCommands('t1', '\u001b[32mclaude>\u001b[0m building...\r\n'))
    expect(sim().state().constructs[term.id]!.terminalBytes).toBeGreaterThan(10)
    d.cameraState.activity = 'conversation'
    d.behavior.setActivity('conversation')

    // --------------------------------------------------------------------------------------------- barge-in
    d.pipeline.enqueue({ text: 'Let me walk you through all four of the open items on the board, one at a time, starting with the oldest.', emotion: 'neutral' })
    await d.run(2000)
    expect(sim().state().speaking).not.toBeNull()
    const speakingId = sim().state().speaking!
    const domBefore = d.mood.get().dominance
    const pending = d.pipeline.cancel({ fadeMs: 100 })
    await d.run(300)
    const report = await pending
    expect(report.cancelled).toEqual([speakingId])
    expect(report.droppedChunks).toBeGreaterThan(20)
    const interrupted = sim().utterance(speakingId)!
    expect(interrupted.endedInterrupted).toBe(true)
    expect(interrupted.receivedMs).toBeLessThan(interrupted.totalMs!)
    expect(sim().entries({ kind: 'event', name: 'speak.ended' }).at(-1)!.data).toMatchObject({ utteranceId: speakingId, interrupted: true })
    expect(d.mood.get().dominance).toBeLessThan(domBefore)
    const received = interrupted.receivedMs
    await d.run(3000)
    expect(sim().utterance(speakingId)!.receivedMs).toBe(received)
    d.memory.remember({ kind: 'preference', text: 'Interrupts when the answer gets long: keep it short', importance: 4 })

    // ----------------------------------------------------------------------- the day passes; quiet hours return
    d.behavior.setActivity('idle')
    d.cameraState.activity = 'idle'
    await d.jumpTo(at(22, 20))
    expect(['relaxed', 'sleepy', 'attentive', 'busy']).toContain(d.behavior.currentProfile())
    await d.jumpTo(at(22, 55))
    expect(d.behavior.currentProfile()).toBe('asleep')
    expect(sim().state()).toMatchObject({ idle: 'asleep', posture: { posture: 'sleep' } })
    expect(d.behavior.requestUtterance({ kind: 'proactive' })).toMatchObject({ allowed: false, reason: 'quiet hours' })
    expect(d.behavior.requestUtterance({ kind: 'reply' }).allowed).toBe(true)
    const sleptAt = sim().entries({ kind: 'command', name: 'perform.idle' }).at(-1)!
    await d.jumpTo(at(23, 25))
    const later = sim().timeline.filter((e) => e.seq > sleptAt.seq && e.kind === 'command' && ['perform.gaze', 'perform.gesture', 'perform.speak'].includes(e.name))
    expect(later).toEqual([]) // total silence and stillness while she sleeps
    expect(sim().state().camera.activeId).toBe('wide') // the camera backs off to the wide shot
    // a message from the user wakes her
    d.behavior.onUserMessage()
    await d.run(600)
    expect(sim().state().idle).toBe('attentive')
    expect(d.behavior.currentProfile()).toBe('attentive')

    // ------------------------------------------------- the stage restarts: reconnect, resume from the mirror
    const snapshot = sim().state()
    await d.run(300)
    const snap2 = sim().state()
    await d.reconnect()
    await d.run(4000)
    const after = sim().state()
    const aid = d.assistant.id
    expect(after.characters[aid]!.equipped).toEqual(snap2.characters[aid]!.equipped)
    expect(after.characters[aid]!.params).toEqual(snap2.characters[aid]!.params)
    expect(after.scene!.constructs.map((c) => c.id).sort()).toEqual(['kg', 'term_t1'])
    expect(constructDataEqual(after.constructs.kg!.data, snap2.constructs.kg!.data)).toBe(true)
    expect(after.scene!.activeCameraId).toBe(snap2.scene!.activeCameraId)
    expect(after.camera.activeId).toBe(snapshot.camera.activeId)
    expect(after.affect?.label).toBeDefined()
    expect(after.idle).toBe('attentive')
    expect(after.assistantId).toBe(aid)
    expect(d.conn.session.stats().failed).toBe(0)
    // the construct sync is told to start over after a reconnect: its next push is a replace again
    d.sync.reset()
    expect(d.sync.update('kg', g2)[0]).toMatchObject({ mode: 'replace' })

    // --------------------------------------------------------------- memory kept the day, privately
    expect(d.memory.recall('Q4 positioning').map((r) => r.item.text)).toEqual(['Good news about the Q4 positioning draft'])
    expect(d.memory.digest().text).toContain('keep it short')
  })

  it('the stage tools drive the same world: outfit, scene, gesture, camera, memory and state in one conversation', async () => {
    const d = await makeDay()
    const loadChar = d.characters.loadCommand(d.assistant.id)
    const loadScene = d.scenes.loadCommand()
    if (!loadChar.ok || !loadScene.ok) throw new Error('boot')
    await d.sendAndWait([loadChar.value, loadScene.value], 1200)
    await d.jumpTo(at(9, 0), 5000)
    d.behavior.onUserMessage()
    const tools = createStageToolBindings({
      characters: d.characters,
      wardrobe: d.wardrobe,
      scenes: d.scenes,
      memory: d.memory,
      perform: (c) => d.out(c, true),
      requestGesture: (clip, i) => d.behavior.requestGesture(clip, i),
      requestShot: (shot) => d.camera.request(shot),
      mood: () => d.mood.get(),
      posture: () => d.behavior.currentPosture(),
      stage: () => ({ connected: d.conn.session.state === 'ready', engine: d.conn.session.capabilities?.engine }),
    })
    const call = async (name: string, input: unknown) => tools.find((t) => t.spec.name === name)!.handler(input)
    const settle = async () => {
      d.vt.advance(600)
      await flush(20)
    }
    expect((await call('stage_set_outfit', { presetId: 'preset.out' })).text).toMatch(/Now wearing "Out"/)
    await settle()
    expect(d.conn.sim.state().characters[d.assistant.id]!.equipped.outerwear).toBe(S.coat)
    expect((await call('stage_set_scene', { presetId: 'preset.void-seating' })).text).toMatch(/Void with seating/)
    await settle()
    expect(d.conn.sim.state().scene!.objects.map((o) => o.id).sort()).toEqual(['data_plinth', 'lounge_chair'])
    expect((await call('stage_gesture', { clip: 'nod_slow' })).isError).toBeUndefined()
    await settle()
    expect(d.conn.sim.state().gestures).toContain('nod_slow')
    expect((await call('stage_camera', { shot: 'profile' })).text).toBe('Camera: profile.')
    await settle()
    expect(d.conn.sim.state().camera.activeId).toBe('profile')
    expect((await call('character_remember', { kind: 'preference', text: 'Likes the profile shot when reviewing' })).text).toMatch(/Remembered/)
    const state = (await call('stage_state', {})).text
    expect(state).toMatch(/Look: .*Structured long coat/)
    expect(state).toMatch(/camera profile/)
    expect(state).toMatch(/Stage: connected \(sim\)/)
    expect(d.conn.session.stats().failed).toBe(0)
    void T0
  })
})
