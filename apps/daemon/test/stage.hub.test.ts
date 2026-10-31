import { afterEach, describe, expect, it } from 'vitest'
import type { Approval, Project, Session } from '@ai-assistant/shared'
import { STAGE_TOOL_SURFACE } from '@ai-assistant/shared'
import { SESSIONS_CONSTRUCT_ID, BRAIN_CONSTRUCT_ID, ORBIT_LINGER_MS } from '../src/stage/constructs'
import { connectInProcess, until } from '../src/stage/testing'
import { makeClock, makeDaemon, type TestClock, type TestDaemon } from './helpers'

const open: TestDaemon[] = []
afterEach(async () => {
  for (const d of open.splice(0)) await d.cleanup()
})

/** A daemon with a fake clock at a LOCAL time (the behaviour director thinks in local hours). */
async function at(h: number, m = 0): Promise<{ d: TestDaemon; clock: TestClock }> {
  const clock = makeClock(new Date(2026, 10, 2, h, m, 0).getTime())
  const d = await makeDaemon({ clock })
  open.push(d)
  return { d, clock }
}

const project: Project = { id: 'p1', name: 'atlas', rootPath: 'C:\\dev\\atlas', status: 'active', tags: [], color: '#fbbf24' }
const session = (id: string, status: Session['status'] = 'running', over: Partial<Session> = {}): Session => ({
  id,
  projectId: 'p1',
  title: `Session ${id}`,
  source: 'hook',
  kind: 'interactive',
  status,
  model: 'm',
  cwd: 'C:\\dev\\atlas',
  startedAt: '2026-11-02T10:00:00.000Z',
  updatedAt: '2026-11-02T10:00:00.000Z',
  costUsd: 0,
  contextPct: 0,
  agents: [{ id: 'main', parentId: null, type: 'main', status: 'running', lastMessage: '' }],
  ...over,
})
const approval = (id: string): Approval => ({ id, kind: 'tool_permission', title: 'Run a command', detail: 'd', requestedAt: '2026-11-02T10:00:00.000Z', status: 'pending', risk: 'medium', tier: 'T4', area: 'work' })

const mood = (d: TestDaemon) => d.daemon.stage.hub.mood!.snapshot()

describe('mood from real signals', () => {
  it('a thank-you raises valence a little, a criticism lowers it, a plain message changes nothing much', async () => {
    const { d } = await at(10)
    const base = mood(d)
    await d.lane.send({ text: 'what is on my plate', modality: 'text' })
    await d.lane.settle()
    const plain = mood(d)
    await d.lane.send({ text: 'thanks, that was great job', modality: 'text' })
    const thanked = mood(d)
    expect(thanked.valence).toBeGreaterThan(plain.valence)
    await d.lane.settle()
    await d.lane.send({ text: "that's wrong, not what I asked", modality: 'text' })
    const criticised = mood(d)
    expect(criticised.valence).toBeLessThan(thanked.valence)
    expect(Math.abs(plain.valence - base.valence)).toBeLessThan(0.15)
  })

  it('a finished reply nudges composure up (task completed)', async () => {
    const { d } = await at(10)
    const before = mood(d).dominance
    d.daemon.bus.publish({ type: 'chat.done', messageId: 'm1' })
    expect(mood(d).dominance).toBeGreaterThanOrEqual(before)
    expect(mood(d).valence).toBeGreaterThan(0.2) // the baseline valence is 0.2
  })

  it('an approval that is granted lifts her; one that is denied costs a little composure', async () => {
    const { d } = await at(10)
    const hub = d.daemon.stage.hub
    d.daemon.bus.publish({ type: 'approval.new', approval: approval('a1') })
    const start = mood(d)
    d.daemon.bus.publish({ type: 'approval.resolved', id: 'a1', status: 'approved' })
    const approved = mood(d)
    expect(approved.valence).toBeGreaterThan(start.valence)
    d.daemon.bus.publish({ type: 'approval.new', approval: approval('a2') })
    d.daemon.bus.publish({ type: 'approval.resolved', id: 'a2', status: 'denied' })
    const denied = mood(d)
    expect(denied.dominance).toBeLessThan(approved.dominance)
    expect(denied.valence).toBeLessThan(approved.valence)
    expect(hub.mood!.get().label).toBeDefined()
  })

  it('returning after a long absence (a message after 10+ minutes) is a small lift', async () => {
    const { d, clock } = await at(10)
    clock.advance(30 * 60_000)
    const before = mood(d)
    d.daemon.bus.publish({ type: 'chat.message', message: { id: 'u1', role: 'user', createdAt: '2026-11-02T10:30:00.000Z', modality: 'text', parts: [{ type: 'text', text: 'hello again' }] } })
    expect(mood(d).arousal).toBeGreaterThan(before.arousal)
  })

  it('silence lowers AROUSAL (she gets sleepy) and never VALENCE: no sulking', async () => {
    const { d, clock } = await at(10)
    const hub = d.daemon.stage.hub
    hub.tick()
    const base = mood(d)
    for (let i = 0; i < 60; i++) {
      clock.advance(60_000)
      hub.tick()
    }
    const later = mood(d)
    // an hour of silence: no mood event can have pushed valence below her baseline
    expect(later.valence).toBeGreaterThanOrEqual(0.2 - 1e-9)
    expect(later.arousal).toBeLessThan(base.arousal + 1e-9)
    expect(hub.live().idle).toBe('sleepy')
  })

  it('persists across a restart of the hub (the row is written at shutdown) and decays from the time it was written', async () => {
    const { d, clock } = await at(10)
    const hub = d.daemon.stage.hub
    hub.mood!.apply({ type: 'good_news', magnitude: 2 })
    const pushed = mood(d)
    await hub.shutdown()
    const row = hub.stageStore.loadMood()!
    expect(row.valence).toBeCloseTo(pushed.valence, 6)
    expect(row.at).toBe(clock.now())
  })
})

describe('the lane\'s avatar events map onto her performance', () => {
  it('"thinking" holds the thinking expression, the next pose releases it', async () => {
    const { d } = await at(10)
    const hub = d.daemon.stage.hub
    d.daemon.bus.publish({ type: 'avatar', event: { type: 'pose', state: 'thinking' } })
    expect(hub.mood!.get().label).toBe('thinking')
    d.daemon.bus.publish({ type: 'avatar', event: { type: 'pose', state: 'speaking' } })
    expect(hub.mood!.get().label).not.toBe('thinking')
  })

  it('"look at the screen" while she works turns into a gaze command on the next tick', async () => {
    const { d } = await at(10)
    const hub = d.daemon.stage.hub
    hub.tick()
    d.daemon.bus.publish({ type: 'avatar', event: { type: 'lookAt', target: 'screen' } })
    hub.tick()
    expect(hub.live().gaze).toEqual({ kind: 'camera' })
    d.daemon.bus.publish({ type: 'avatar', event: { type: 'lookAt', target: 'user' } })
    hub.tick()
    expect(hub.live().gaze).toEqual({ kind: 'user' })
  })

  it('a spoken sentence is only spoken when a stage is connected and the stage is on; replies are never budget-limited', async () => {
    const { d } = await at(10)
    const hub = d.daemon.stage.hub
    expect(hub.speak('Hello there.', 'happy')).toBe(false) // no stage
    expect(hub.behavior!.requestUtterance({ kind: 'reply' }, { commit: false }).allowed).toBe(true)
    expect(hub.behavior!.requestUtterance({ kind: 'proactive', priority: 'P2' }, { commit: false }).allowed).toBe(false) // FYI waits for the briefing
  })

  it('the interrupt route barges in on the stage', async () => {
    const { d } = await at(10)
    const hub = d.daemon.stage.hub
    let n = 0
    hub.bargeIn = async () => void n++
    const r = await d.call('/api/chat/interrupt', { json: {} })
    expect(r.status).toBe(202)
    expect(n).toBe(1)
  })

  it('a message from the user is a barge-in too, and a broken stage never breaks the bus', async () => {
    const { d } = await at(10)
    const hub = d.daemon.stage.hub
    let n = 0
    hub.bargeIn = async () => void n++
    d.daemon.bus.publish({ type: 'chat.message', message: { id: 'u1', role: 'user', createdAt: 'x', modality: 'text', parts: [{ type: 'text', text: 'wait' }] } })
    expect(n).toBe(1)
    // an event with an odd shape must not throw out of the bus
    expect(() => d.daemon.bus.publish({ type: 'chat.message', message: { id: 'a1', role: 'assistant', createdAt: 'x', modality: 'text', parts: [] } })).not.toThrow()
  })
})

describe('quiet hours and the idle profile', () => {
  it('asleep inside quiet hours (23:30), awake again after they end', async () => {
    const { d, clock } = await at(23, 30)
    const hub = d.daemon.stage.hub
    hub.tick()
    expect(hub.live().idle).toBe('asleep')
    expect(hub.live().posture).toBe('sleep')
    clock.advance(8.5 * 3_600_000) // 08:00
    hub.tick()
    expect(hub.live().idle).not.toBe('asleep')
  })

  it('a message wakes her inside quiet hours and she stays attentive for a while', async () => {
    const { d, clock } = await at(23, 30)
    const hub = d.daemon.stage.hub
    hub.tick()
    expect(hub.live().idle).toBe('asleep')
    clock.advance(31_000) // beyond the minimum hold of a profile
    d.daemon.bus.publish({ type: 'chat.message', message: { id: 'u1', role: 'user', createdAt: 'x', modality: 'text', parts: [{ type: 'text', text: 'are you there' }] } })
    hub.tick()
    expect(hub.live().idle).toBe('attentive')
  })

  it('the persona quiet hours are followed when they change (settings.update)', async () => {
    const { d } = await at(14)
    const hub = d.daemon.stage.hub
    hub.tick()
    expect(hub.live().idle).not.toBe('asleep')
    await d.call('/api/settings/persona', { method: 'PUT', json: { quietHours: { from: '13:00', to: '16:00' } } })
    hub.tick()
    expect(hub.live().idle).toBe('asleep')
  })
})

describe('the camera follows the conversation', () => {
  it('wide when idle, medium while talking, a close-up for an emotional beat, back to wide, and an explicit shot is not overridden', async () => {
    const { d, clock } = await at(10)
    const hub = d.daemon.stage.hub
    const shot = () => hub.scenes.getScene()!.activeCameraId
    hub.tick()
    expect(shot()).toBe('wide')
    // a conversation starts
    d.daemon.bus.publish({ type: 'chat.message', message: { id: 'u1', role: 'user', createdAt: 'x', modality: 'text', parts: [{ type: 'text', text: 'hi' }] } })
    clock.advance(500)
    hub.tick()
    expect(shot()).toBe('wide') // not yet: the want must persist (no jitter)
    clock.advance(7000)
    hub.tick()
    expect(shot()).toBe('medium')
    // an emotional beat: the camera moves in for a close-up (after the short hold of the shot it is on)
    clock.advance(3000)
    d.daemon.bus.publish({ type: 'avatar', event: { type: 'speak', text: 'I am so sorry to hear that.', emotion: 'sad' } })
    clock.advance(200)
    hub.tick()
    expect(shot()).toBe('closeup')
    // the conversation ends and the room goes quiet: back to wide
    d.daemon.bus.publish({ type: 'chat.done', messageId: 'm1' })
    clock.advance(25_000)
    hub.tick()
    clock.advance(8000)
    hub.tick()
    expect(shot()).toBe('wide')
    // an explicit shot (the user's, or the stage_camera tool) pins for a while
    expect((await d.call('/api/stage/scene/camera', { method: 'PUT', json: { shot: 'profile' } })).status).toBe(200)
    d.daemon.bus.publish({ type: 'chat.message', message: { id: 'u2', role: 'user', createdAt: 'x', modality: 'text', parts: [{ type: 'text', text: 'again' }] } })
    clock.advance(5000)
    hub.tick()
    expect(shot()).toBe('profile')
    clock.advance(20_000)
    hub.tick()
    clock.advance(2000)
    hub.tick()
    expect(shot()).toBe('medium')
  })

  it('a pending approval makes her review it with you (profile shot) when nothing else is going on', async () => {
    const { d, clock } = await at(10)
    const hub = d.daemon.stage.hub
    hub.tick()
    d.daemon.bus.publish({ type: 'approval.new', approval: approval('a1') })
    clock.advance(30_000)
    hub.tick()
    clock.advance(8000)
    hub.tick()
    const s = hub.scenes.getScene()!.activeCameraId
    expect(['profile', 'closeup']).toContain(s)
    d.daemon.bus.publish({ type: 'approval.resolved', id: 'a1', status: 'approved' })
    clock.advance(40_000)
    hub.tick()
    clock.advance(8000)
    hub.tick()
    expect(hub.scenes.getScene()!.activeCameraId).toBe('wide')
  })

  it('the camera moves are sent to the stage and persist in the scene', async () => {
    const { d, clock } = await at(10)
    const hub = d.daemon.stage.hub
    const stage = await connectInProcess(hub, {}, { clock: clock })
    d.daemon.bus.publish({ type: 'chat.message', message: { id: 'u1', role: 'user', createdAt: 'x', modality: 'text', parts: [{ type: 'text', text: 'hi' }] } })
    clock.advance(1500)
    hub.tick()
    clock.advance(7000)
    hub.tick()
    await hub.flush()
    await until('the stage moved its camera', () => stage.sim.state().scene?.activeCameraId === 'medium')
    expect(hub.snapshot().scene?.activeCameraId).toBe('medium')
  })
})

describe('construct feeds', () => {
  async function withStage() {
    const { d, clock } = await at(10)
    const hub = d.daemon.stage.hub
    const stage = await connectInProcess(hub, {}, { clock })
    return { d, clock, hub, stage }
  }

  it('the knowledge graph is drawn from the notes with a computed layout, once', async () => {
    const { hub, stage } = await withStage()
    hub.constructs.refresh()
    await hub.flush()
    const c = await until('the brain construct exists', () => stage.sim.state().constructs[BRAIN_CONSTRUCT_ID])
    expect(c.kind).toBe('knowledge_graph')
    const data = await until('graph data arrived', () => (stage.sim.state().constructs[BRAIN_CONSTRUCT_ID]?.data.nodes.length ?? 0) > 5 && stage.sim.state().constructs[BRAIN_CONSTRUCT_ID]!.data)
    expect(data.nodes.every((n) => Array.isArray(n.position) && n.position.length === 3 && typeof n.size === 'number')).toBe(true)
    expect(data.edges.length).toBeGreaterThan(3)
    // nothing changed: nothing is sent
    expect(hub.constructs.refresh()).toEqual([])
    expect(hub.constructs.refresh()).toEqual([])
  })

  it('sessions become an orbit; a status change sends ONE small merge; an unchanged feed sends nothing', async () => {
    const { d, hub, stage } = await withStage()
    d.daemon.store.upsertProject(project)
    d.daemon.store.upsertSession(session('s1', 'running'))
    d.daemon.store.upsertSession(session('s2', 'idle'))
    hub.constructs.markDirty()
    const first = hub.constructs.refresh()
    expect(first.map((c) => c.type)).toEqual(expect.arrayContaining(['scene.construct', 'scene.data']))
    expect(first.find((c) => c.type === 'scene.construct')).toMatchObject({ op: 'add', construct: { id: SESSIONS_CONSTRUCT_ID, kind: 'session_orbit', source: 'work' } })
    await hub.flush()
    await until('orbit drawn', () => stage.sim.state().constructs[SESSIONS_CONSTRUCT_ID]?.data.items.some((i) => i.id === 'session:s1'))
    expect(stage.sim.state().constructs[SESSIONS_CONSTRUCT_ID]!.data.items.filter((i) => i.kind === 'session')).toHaveLength(2)

    expect(hub.constructs.refresh()).toEqual([])

    d.daemon.store.upsertSession(session('s1', 'blocked_permission'))
    const diff = hub.constructs.refresh()
    expect(diff).toHaveLength(1)
    const cmd = diff[0] as { type: string; mode: string; items?: Array<{ id: string; blocked: boolean }>; nodes?: unknown[] }
    expect(cmd).toMatchObject({ type: 'scene.data', mode: 'merge' })
    // the session itself and its project's "blocked" counter: two small items in one command, nothing else
    expect(cmd.items?.map((i) => i.id).sort()).toEqual(['project:p1', 'session:s1'])
    expect(cmd.items?.find((i) => i.id === 'session:s1')?.blocked).toBe(true)
    expect(cmd.nodes).toBeUndefined()
    await hub.flush()
    await until('flare arrived', () => stage.sim.state().constructs[SESSIONS_CONSTRUCT_ID]?.data.items.find((i) => i.id === 'session:s1')?.blocked === true)
  })

  it('the orbit leaves the scene a minute after the last session ends, and the void is otherwise untouched', async () => {
    const { d, clock, hub, stage } = await withStage()
    d.daemon.store.upsertProject(project)
    d.daemon.store.upsertSession(session('s1', 'running'))
    hub.constructs.markDirty()
    hub.constructs.refresh()
    expect(hub.scenes.getConstruct(SESSIONS_CONSTRUCT_ID)).toBeDefined()
    d.daemon.store.deleteSession('s1')
    hub.constructs.markDirty()
    expect(hub.constructs.refresh()).toEqual([])
    clock.advance(ORBIT_LINGER_MS - 1000)
    expect(hub.constructs.refresh()).toEqual([])
    expect(hub.scenes.getConstruct(SESSIONS_CONSTRUCT_ID)).toBeDefined()
    clock.advance(2000)
    hub.constructs.markDirty()
    const gone = hub.constructs.refresh()
    expect(gone.some((c) => c.type === 'scene.construct' && (c as { op: string }).op === 'remove')).toBe(true)
    expect(hub.scenes.getConstruct(SESSIONS_CONSTRUCT_ID)).toBeUndefined()
    await hub.flush()
    await until('removed on the stage', () => stage.sim.state().constructs[SESSIONS_CONSTRUCT_ID] === undefined)
    expect(hub.scenes.getConstruct(BRAIN_CONSTRUCT_ID)).toBeDefined() // the notes stay
  })

  it('a session update on the bus makes the feed recompute on the next tick', async () => {
    const { d, hub, clock } = await withStage()
    hub.tick()
    d.daemon.store.upsertProject(project)
    d.daemon.store.upsertSession(session('s9', 'running'))
    d.daemon.bus.publish({ type: 'session.update', session: session('s9', 'running') })
    clock.advance(100)
    hub.tick()
    expect(hub.scenes.getConstruct(SESSIONS_CONSTRUCT_ID)).toBeDefined()
  })

  it('a stage that reconnects gets everything again as a full replace (it lost its state)', async () => {
    const { d, hub, stage } = await withStage()
    d.daemon.store.upsertProject(project)
    d.daemon.store.upsertSession(session('s1'))
    hub.constructs.markDirty()
    hub.constructs.refresh()
    await hub.flush()
    await until('data on the first stage', () => (stage.sim.state().constructs[BRAIN_CONSTRUCT_ID]?.data.nodes.length ?? 0) > 0)
    hub.closeConnection('user', 'test')
    await until('gone', () => !hub.connection())
    const again = await connectInProcess(hub)
    await until('brain data replayed', () => (again.sim.state().constructs[BRAIN_CONSTRUCT_ID]?.data.nodes.length ?? 0) > 0)
    await until('orbit replayed', () => again.sim.state().constructs[SESSIONS_CONSTRUCT_ID]?.data.items.some((i) => i.id === 'session:s1'))
    const replaced = again.sim.entries({ kind: 'command', name: 'scene.data' })
    expect(replaced.length).toBeGreaterThanOrEqual(2)
  })

  it('terminals are never drawn: no terminal_pane construct is ever created by the feeds', async () => {
    const { hub } = await withStage()
    hub.tick()
    expect(hub.scenes.getScene()!.constructs.map((c) => c.kind)).not.toContain('terminal_pane')
  })
})

describe('the stage tools (STAGE_TOOL_SURFACE) act through the services, audited as her', () => {
  const tool = (d: TestDaemon, name: string) => d.daemon.stage.hub.toolBindings().find((b) => b.spec.name === name)!

  it('binds exactly the surface and refuses bad input without throwing', async () => {
    const { d } = await at(10)
    const names = d.daemon.stage.hub.toolBindings().map((b) => b.spec.name)
    expect(names).toEqual(STAGE_TOOL_SURFACE.map((t) => t.name))
    for (const b of d.daemon.stage.hub.toolBindings()) {
      const r = await b.handler({ definitely: 'not valid', presetId: 5, shot: 7, clip: [], text: {} })
      expect(r.text.length).toBeGreaterThan(0)
      await expect(b.handler(undefined)).resolves.toBeDefined()
    }
    for (const b of d.daemon.stage.hub.toolBindings()) expect(['T0', 'T1', 'T2']).toContain(b.spec.tier) // cosmetic and reversible
  })

  it('stage_set_outfit changes the wardrobe, tells the stage, bumps the revision and audits her', async () => {
    const { d, clock } = await at(10)
    const hub = d.daemon.stage.hub
    const stage = await connectInProcess(hub, {}, { clock })
    const rev = hub.revision()
    const r = await tool(d, 'stage_set_outfit').handler({ presetId: 'preset.meeting' })
    expect(r.isError).toBeUndefined()
    expect(r.text).toMatch(/Meeting/)
    expect(hub.assistant()!.equipped.outerwear).toBe('outfit.tailored-blazer')
    expect(hub.revision()).toBeGreaterThan(rev)
    await hub.flush()
    await until('stage dressed', () => stage.sim.state().characters['char.assistant']?.equipped.outerwear === 'outfit.tailored-blazer')
    expect(d.daemon.store.listAudit(20).some((a) => a.actor === 'mira' && /Used stage_set_outfit/.test(a.action) && a.outcome === 'auto')).toBe(true)
    // the director counts it for its cooldown, so she does not keep changing
    expect(hub.outfit.cooldownRemainingMs()).toBeGreaterThan(0)
  })

  it('refusals come back as error text, are audited as blocked, and change nothing', async () => {
    const { d } = await at(10)
    const hub = d.daemon.stage.hub
    const before = hub.assistant()!.equipped
    const r = await tool(d, 'stage_set_outfit').handler({ slot: 'top', assetId: null })
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/full outfit/)
    expect(hub.assistant()!.equipped).toEqual(before)
    expect(d.daemon.store.listAudit(20).some((a) => a.actor === 'mira' && a.outcome === 'blocked')).toBe(true)
  })

  it('stage_camera and stage_set_scene and stage_gesture work and stage_state describes the moment', async () => {
    const { d } = await at(10)
    const hub = d.daemon.stage.hub
    expect((await tool(d, 'stage_set_scene').handler({ presetId: 'preset.void-seating' })).text).toMatch(/Void with seating/)
    expect(hub.scenes.getScene()!.objects).toHaveLength(2)
    expect((await tool(d, 'stage_set_scene').handler({ op: 'remove', objectId: 'data_plinth' })).isError).toBeUndefined()
    expect((await tool(d, 'stage_camera').handler({ shot: 'closeup' })).isError).toBeUndefined()
    expect(hub.scenes.getScene()!.activeCameraId).toBe('closeup')
    expect((await tool(d, 'stage_camera').handler({ shot: 'drone' })).isError).toBe(true)
    expect((await tool(d, 'stage_gesture').handler({ clip: 'nod_small' })).isError).toBeUndefined()
    expect((await tool(d, 'stage_gesture').handler({ clip: 'moonwalk' })).isError).toBe(true)
    const st = await tool(d, 'stage_state').handler({})
    expect(st.text).toMatch(/Look:/)
    expect(st.text).toMatch(/Mood: /)
    expect(st.text).toMatch(/Scene: Void with seating, camera closeup, 1 object/)
    expect(st.text).toMatch(/Stage: not connected/)
  })

  it('character_remember stores a memory; a secret is refused; the audit never holds the memory text', async () => {
    const { d } = await at(10)
    const hub = d.daemon.stage.hub
    const ok = await tool(d, 'character_remember').handler({ kind: 'preference', text: 'Likes the camera wide while she works', importance: 3 })
    expect(ok.isError).toBeUndefined()
    expect(hub.memory.list()).toHaveLength(1)
    const secret = await tool(d, 'character_remember').handler({ kind: 'episode', text: 'the key is sk-ant-api03-abcdefghijklmnop1234', importance: 2 })
    expect(secret.isError).toBe(true)
    expect(hub.memory.list()).toHaveLength(1)
    const blob = JSON.stringify(d.daemon.store.listAudit(50))
    expect(blob).not.toContain('Likes the camera wide')
    expect(blob).not.toContain('sk-ant')
  })
})

describe('shutdown', () => {
  it('closes the stage connection (going away), saves the mood, stops the loop and is safe twice', async () => {
    const { d, clock } = await at(10)
    const hub = d.daemon.stage.hub
    const stage = await connectInProcess(hub, {}, { clock })
    hub.mood!.apply({ type: 'praise' })
    await hub.shutdown()
    expect(stage.pair.backend.closed).toBe(true)
    expect(hub.stageStore.loadMood()).toBeDefined()
    await hub.shutdown()
    hub.tick() // after shutdown the loop does nothing
  })
})
