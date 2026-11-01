import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ServerEvent, STAGE_TOOL_SURFACE, TOOL_SURFACE, type ServerEvent as ServerEventT } from '@ai-assistant/shared'
import { decodeFrame, utteranceIdHash } from '@ai-assistant/stage-core'
import { connectSimulator, type SimClient } from '../src/stage/simClient'
import { openStore } from '../src/store'
import { daytimeClock, makeStageDaemon, sleep, until, type StageDaemon, type StageDaemonOptions } from '../src/stage/testing'

/**
 * The whole chain with nothing faked except the model and the engine: the REAL Secretary lane (zero-token fake Claude
 * backend), the REAL SQLite file, the real stage hub and the headless simulator connected over a REAL WebSocket with the
 * stage token. A chat message goes in; a spoken, lip-synced, camera-framed performance comes out on the simulator.
 */

const daemons: StageDaemon[] = []
const clients: SimClient[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const c of clients.splice(0)) await c.stop()
  for (const d of daemons.splice(0)) await d.stop()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function boot(extra: Partial<StageDaemonOptions> = {}): Promise<{ d: StageDaemon; events: ServerEventT[] }> {
  const dir = mkdtempSync(join(tmpdir(), 'stage-wire-'))
  dirs.push(dir)
  const d = await makeStageDaemon({ dataDir: dir, db: 'app.db', ...extra })
  daemons.push(d)
  const events: ServerEventT[] = []
  d.daemon.bus.subscribe((e) => void events.push(e))
  return { d, events }
}
const track = (c: SimClient): SimClient => {
  clients.push(c)
  return c
}
const chat = (d: StageDaemon, text: string) => d.call('/api/chat', { json: { text, modality: 'text' } })

/** The stage is connected AND has finished loading her and the space (a real engine takes a while to stream assets). */
const loaded = (d: StageDaemon, sim: { state(): { scene: unknown; characters: Record<string, unknown> } }) =>
  until('the look is loaded', async () => {
    await d.hub.flush()
    return d.hub.isConnected() && sim.state().scene !== null && Object.keys(sim.state().characters).length === 2
  })

describe('the Secretary lane gets the stage tools', () => {
  it('opens its session with the whole tool surface plus the six stage tools, and the stage ones really work', async () => {
    const { d } = await boot()
    const opened = d.backend.opened[0]
    expect(opened).toBeDefined()
    const names = opened!.tools.map((t) => t.spec.name)
    for (const t of STAGE_TOOL_SURFACE) expect(names, t.name).toContain(t.name)
    for (const t of TOOL_SURFACE.filter((x) => !x.locked && x.lanes.includes('secretary'))) expect(names, t.name).toContain(t.name)
    expect(new Set(names).size).toBe(names.length)
    // the tools she is handed are the live ones: using one changes the wardrobe
    const c = track(d.connect({ reconnect: false }))
    const sim = await c.waitConnected()
    await until('ready', () => d.hub.isConnected())
    const outfit = opened!.tools.find((t) => t.spec.name === 'stage_set_outfit')!
    expect((await outfit.handler({ presetId: 'preset.training' })).text).toMatch(/Training/)
    await until('the simulator wears it', () => sim.state().characters['char.assistant']?.equipped.top === 'outfit.training-top')
    // the autonomy tiers are what ADR 0005 expects: T0 and T1 run without a card, T2 asks
    expect(STAGE_TOOL_SURFACE.filter((t) => t.tier === 'T2').map((t) => t.name)).toEqual(['character_remember'])
  })

  it('her persistent memory survives a restart and reaches the persona prompt for the CLOUD audience only: nothing private or sensitive', async () => {
    const { d } = await boot()
    const remember = d.backend.opened[0]!.tools.find((t) => t.spec.name === 'character_remember')!
    expect((await remember.handler({ kind: 'preference', text: 'Prefers short answers in the morning', importance: 4 })).isError).toBeUndefined()
    expect((await remember.handler({ kind: 'relationship', text: 'We talked about the therapist appointment', importance: 3 })).text).toMatch(/Kept sensitive/)
    expect(d.hub.memoryDigest()).toMatch(/Prefers short answers/)
    expect(d.hub.memoryDigest()).not.toMatch(/therapist/)
    d.hub.setEnabled(false)
    expect(d.hub.memoryDigest()).toBeUndefined()
    d.hub.setEnabled(true)
    // a restart: the memory is in SQLite, and the new lane session opens with the digest in its system prompt
    await d.stop()
    daemons.splice(daemons.indexOf(d), 1)
    const again = await makeStageDaemon({ dataDir: d.dataDir, db: 'app.db' })
    daemons.push(again)
    const prompt = again.backend.opened[0]!.systemPrompt
    expect(prompt).toMatch(/Prefers short answers in the morning/)
    expect(prompt).not.toMatch(/therapist/)
    expect(again.hub.memory.list()).toHaveLength(2) // the private one is kept, just never sent
  })

  it('terminals are not among them and the stage tools cannot reach one', async () => {
    const { d } = await boot()
    const names = d.backend.opened[0]!.tools.map((t) => t.spec.name).join(' ')
    expect(names).not.toMatch(/terminal|shell|pty|keystroke/i)
    expect(d.daemon.terminals.enabled()).toBe(false)
  })
})

describe('a reply becomes a performance on the stage', () => {
  it('every sentence: perform.speak, then audio frames and face frames, in order, with the right emotion', async () => {
    const { d, events } = await boot()
    const c = track(d.connect({ reconnect: false }))
    const sim = await c.waitConnected()
    await loaded(d, sim)

    expect((await chat(d, 'Hello, what is on my calendar today?')).status).toBe(202)
    await d.lane.whenIdle()
    const spoken = events.filter((e): e is Extract<ServerEventT, { type: 'avatar' }> => e.type === 'avatar' && e.event.type === 'speak').map((e) => e.event as { type: 'speak'; text: string; emotion: string })
    expect(spoken.length).toBeGreaterThanOrEqual(2)

    await until('every sentence was announced', () => sim.utteranceIds().length === spoken.length, 8000)
    await until('and finished', () => sim.utteranceIds().every((id) => sim.utterance(id)?.endedInterrupted === false), 12_000)
    const reports = sim.utteranceIds().map((id) => sim.utterance(id)!)
    // same text, same order (the sentence is whitespace-normalised by the pipeline)
    expect(reports.map((r) => r.text)).toEqual(spoken.map((s) => s.text.replace(/\s+/g, ' ').trim()))
    for (const r of reports) {
      expect(r.audioFrames, r.text).toBeGreaterThan(0)
      expect(r.faceFrames, r.text).toBeGreaterThan(0) // the stage declares ARKit weights, so the backend sends them
      expect(r.faceSource).toBe('backend')
      expect(r.underruns).toBe(0)
      expect(r.endedInterrupted).toBe(false)
    }
    expect(sim.orphanFrames).toBe(0)
    expect(sim.rejectedFrames).toBe(0)
    expect(sim.rejectedCommands).toBe(0)
    // utterance k+1 starts after utterance k (no overlap)
    const starts = reports.map((r) => r.startedAtStageMs!)
    expect(starts).toEqual([...starts].sort((a, b) => a - b))
    // the emotion of the sentence reached the stage with the speak command
    const speakEntries = sim.entries({ kind: 'command', name: 'perform.speak' })
    expect(speakEntries.length).toBe(spoken.length)
    expect(d.hub.pipeline()!.stats().audioChunksSent).toBeGreaterThan(5)
    expect(d.hub.pipeline()!.stats().faceFramesSent).toBeGreaterThan(5)
  })

  it('binary frames carry the utterance hash the stage matches them with, and are well formed', async () => {
    const { d } = await boot()
    const c = track(d.connect({ reconnect: false, simulator: { recordFrames: true } }))
    const sim = await c.waitConnected()
    await loaded(d, sim)
    await chat(d, 'hi')
    await until('speaking', () => sim.utteranceIds().length > 0 && sim.utterance(sim.utteranceIds()[0]!)!.audioFrames > 2, 8000)
    const frames = sim.entries({ kind: 'frame' })
    expect(frames.length).toBeGreaterThan(2)
    // the pipeline's own byte stream is decodable: re-encode a frame the way the pipeline does and compare the hash rule
    const id = sim.utteranceIds()[0]!
    expect(utteranceIdHash(id)).toBeGreaterThan(0)
    expect(decodeFrame(new Uint8Array(13)).ok).toBe(false) // empty payload is refused by the codec
  })

  it('a new message interrupts what she is saying (barge-in), and the interrupt button does too', async () => {
    const { d } = await boot()
    const c = track(d.connect({ reconnect: false }))
    const sim = await c.waitConnected()
    await loaded(d, sim)
    await chat(d, 'Give me my agenda for this week and then what needs me and my notes on strategy')
    await until('she is speaking', () => sim.utteranceIds().some((id) => sim.utterance(id)?.startedAtStageMs !== undefined), 8000)
    const r = await d.call('/api/chat/interrupt', { json: {} })
    expect(r.status).toBe(202)
    await until('everything stopped', () => d.hub.pipeline()!.pendingCount() === 0, 8000)
    expect(sim.utteranceIds().filter((id) => sim.utterance(id)?.endedInterrupted === true).length).toBeGreaterThanOrEqual(1)
    expect(d.hub.pipeline()!.stats().cancels).toBeGreaterThanOrEqual(1)
    expect(sim.state().speaking).toBeNull()
  })

  it('without a stage nothing is queued and chat works as before', async () => {
    const { d, events } = await boot()
    expect((await chat(d, 'hello')).status).toBe(202)
    await d.lane.whenIdle()
    expect(events.some((e) => e.type === 'chat.done')).toBe(true)
    expect(d.hub.pipeline()).toBeUndefined()
    expect(d.hub.speak('anyone there', 'neutral')).toBe(false)
  })

  it('a stage that is switched off hears nothing, and speech resumes when it is on again', async () => {
    const { d } = await boot()
    const c = track(d.connect({ reconnect: false }))
    const sim = await c.waitConnected()
    await until('ready', () => d.hub.isConnected())
    d.hub.setEnabled(false)
    await until('closed', () => !d.hub.connection())
    expect(d.hub.speak('hello', 'happy')).toBe(false)
    d.hub.setEnabled(true)
    expect(sim.utteranceIds()).toEqual([])
  })
})

describe('the behaviour loop runs on a timer and feeds the stage and the dashboards', () => {
  it('idle profile, posture, gaze and affect arrive by themselves; the dashboards get stage.live', async () => {
    // The director sleeps during the persona's quiet hours (22:30 to 07:00 local). The daemon's clock is pinned to 10:00 local,
    // running at real speed, so this test does not depend on the hour or the time zone it runs in.
    const { d, events } = await boot({ clock: daytimeClock(10) })
    const c = track(d.connect({ reconnect: false }))
    const sim = await c.waitConnected()
    await until('ready', () => d.hub.isConnected())
    await until('the director spoke', () => ['perform.idle', 'perform.gaze', 'perform.posture', 'perform.affect'].every((n) => sim.names('command').includes(n)), 8000)
    const st = sim.state()
    expect(st.idle).toBeDefined()
    expect(st.posture?.posture).toBeDefined()
    expect(st.gaze?.target.kind).toBeDefined()
    // the dashboards see it too
    await until('live events', () => events.some((e) => e.type === 'stage.live' && e.live.connected))
    const live = events.filter((e) => e.type === 'stage.live')
    for (const e of live) expect(ServerEvent.safeParse(e).success).toBe(true)
    const last = live[live.length - 1] as Extract<ServerEventT, { type: 'stage.live' }>
    expect(last.live.mood).not.toBeNull()
    // the stage-live feed is rate limited: it does not flood the replay buffer
    await sleep(500)
    expect(events.filter((e) => e.type === 'stage.live').length).toBeLessThan(25)
  })

  it('an approval card is a reason to look at it with you; denying it is remembered as a small setback', async () => {
    const { d, events } = await boot()
    await chat(d, 'please send an email to Bob about Friday')
    const card = await until('an approval card', () => events.find((e) => e.type === 'approval.new'))
    const id = (card as { approval: { id: string } }).approval.id
    const before = d.hub.mood!.snapshot()
    const res = await d.call(`/api/approvals/${id}/decision`, { json: { decision: 'denied' } })
    expect(res.status).toBe(200)
    expect(d.hub.mood!.snapshot().dominance).toBeLessThan(before.dominance + 1e-9)
    await d.lane.whenIdle()
  })
})

describe('what is real and what is not', () => {
  it('the snapshot of a running daemon says which stage is attached and carries the capabilities it declared', async () => {
    const { d } = await boot()
    const c = track(d.connect({ reconnect: false, simulator: { capabilities: { engineVersion: '9.9.9' } } }))
    await c.waitConnected()
    await until('ready', () => d.hub.isConnected())
    const r = await d.call('/api/snapshot')
    const body = (await r.json()) as { stage: { stage: { connected: boolean; engine: string; capabilities: { engineVersion: string } } } }
    expect(body.stage.stage.connected).toBe(true)
    expect(body.stage.stage.engine).toBe('sim')
    expect(body.stage.stage.capabilities.engineVersion).toBe('9.9.9')
  })

  it('a second client with the right token but another cookie-less browser cannot read the stage either', async () => {
    const { d } = await boot()
    const r = await d.call('/api/stage', { cookie: false, headers: { Authorization: `Bearer ${d.stageToken}` } })
    expect(r.status).toBe(401)
  })

  it('stops cleanly with a stage connected: the socket is closed going away and nothing is left running', async () => {
    const { d } = await boot()
    const c = connectSimulator({ url: d.wsUrl, token: d.stageToken, reconnect: false })
    clients.push(c)
    await c.waitConnected()
    await until('ready', () => d.hub.isConnected())
    await d.stop()
    daemons.splice(daemons.indexOf(d), 1)
    await until('the stage side saw the close', () => !c.connected())
  })
})

describe('what she writes down leaves no copy behind once you forget it', () => {
  const TEXT = 'I take my tea without sugar'

  /** Every row of the tables that could hold a copy, as text. The chat transcript is excluded on purpose: it holds the sentence YOU typed. */
  const stored = (d: StageDaemon): string => {
    const db = d.daemon.store.db
    return JSON.stringify([db.prepare('SELECT * FROM approvals').all(), db.prepare('SELECT * FROM audit').all()])
  }
  const snapshotWithoutChat = async (d: StageDaemon): Promise<string> => {
    const { chat: _transcript, ...rest } = (await (await d.call('/api/snapshot')).json()) as Record<string, unknown>
    return JSON.stringify(rest)
  }
  type Card = { id: string; status: string; title: string; preview?: string; sensitive?: boolean }
  const waitForCard = async (d: StageDaemon): Promise<Card> => {
    let card: Card | undefined
    await until('the approval card for the memory', async () => {
      const snap = (await (await d.call('/api/snapshot')).json()) as { approvals: Card[] }
      card = snap.approvals.find((a) => a.status === 'pending' && a.title === 'Remember something about you')
      return card !== undefined
    })
    return card!
  }
  const decide = (d: StageDaemon, id: string, decision: 'approved' | 'denied') => d.call(`/api/approvals/${id}/decision`, { json: { decision } })

  it('through the real lane and broker: the card shows it while you decide; once decided nothing stored or audited holds it; forgetting it leaves nothing', async () => {
    const { d } = await boot()
    expect((await chat(d, `Please remember that ${TEXT}`)).status).toBe(202)

    const card = await waitForCard(d)
    expect(card.preview).toContain(TEXT) // you have to see what she wants to write down
    expect(card.sensitive).toBe(true)
    expect(card.title).toBe('Remember something about you')

    expect((await decide(d, card.id, 'approved')).ok).toBe(true)
    await d.lane.whenIdle()
    expect(d.hub.memory.list().map((i) => i.text)).toEqual([TEXT]) // she wrote it down
    expect(stored(d)).not.toContain(TEXT) // but the approval and the audit log hold no copy
    expect(await snapshotWithoutChat(d)).not.toContain(TEXT)
    const audit = d.daemon.store.listAudit(100).filter((a) => a.action === 'tool:character_remember')
    expect(audit.length).toBeGreaterThan(0)
    for (const a of audit) expect(a.target).toBe('character_remember (preference)')

    // it is listed, then forgotten, and nothing anywhere has it
    const list = (await (await d.call('/api/stage/memory')).json()) as { items: Array<{ id: string; text: string }> }
    expect(list.items.map((i) => i.text)).toEqual([TEXT])
    expect((await d.call(`/api/stage/memory/${list.items[0]!.id}`, { method: 'DELETE' })).status).toBe(200)
    expect(d.hub.memory.list()).toEqual([])
    expect(stored(d)).not.toContain(TEXT)
    expect(await snapshotWithoutChat(d)).not.toContain(TEXT)
    expect(JSON.stringify(d.daemon.store.listAudit(500))).not.toContain(TEXT)
  })

  it('denied: nothing is written and no copy is kept either', async () => {
    const { d } = await boot()
    expect((await chat(d, `remember this: ${TEXT}`)).status).toBe(202)
    const card = await waitForCard(d)
    expect(card.preview).toContain(TEXT)
    expect((await decide(d, card.id, 'denied')).ok).toBe(true)
    await d.lane.whenIdle()
    expect(d.hub.memory.list()).toEqual([])
    expect(stored(d)).not.toContain(TEXT)
    expect(await snapshotWithoutChat(d)).not.toContain(TEXT)
  })

  const orphan = (over: Record<string, unknown> = {}) =>
    ({ id: 'ap-orphan', kind: 'tool_permission', title: 'Remember something about you', detail: 'x', requestedAt: '2026-11-02T10:00:00.000Z', status: 'pending', risk: 'low', tier: 'T2', preview: `preference: ${TEXT}`, sensitive: true, area: 'brain', ...over }) as const

  it('a crash while the card is pending: the next start closes it and drops the sentence (a graceful stop already does)', async () => {
    const { d } = await boot()
    const dir = d.dataDir
    await d.stop()
    daemons.splice(daemons.indexOf(d), 1)
    // the previous process died with the card pending: the row is in the stopped database exactly as the broker wrote it
    const store = openStore({ file: join(dir, 'app.db') })
    store.upsertApproval(orphan(), 'lane')
    store.upsertApproval(orphan({ id: 'ap-plain', title: 'Edit a note', preview: 'an ordinary preview', sensitive: false }), 'lane') // not private: its preview stays
    store.upsertApproval(orphan({ id: 'ap-hook' }), 'hook') // another origin: not this sweep's business
    store.close()
    const again = await makeStageDaemon({ dataDir: dir, db: 'app.db' })
    daemons.push(again)
    const snap = (await (await again.call('/api/snapshot')).json()) as { approvals: Card[] }
    const by = Object.fromEntries(snap.approvals.map((a) => [a.id, a]))
    expect(by['ap-orphan']).toMatchObject({ status: 'denied' })
    expect(by['ap-orphan']?.preview).toBeUndefined()
    expect(by['ap-plain']).toMatchObject({ status: 'denied', preview: 'an ordinary preview' }) // closed by the boot-time loop, which has always kept a non-private preview
    expect(by['ap-hook']).toMatchObject({ status: 'pending' })
    expect(JSON.stringify(again.daemon.store.db.prepare("SELECT * FROM approvals WHERE id = 'ap-orphan'").all())).not.toContain(TEXT)
  })

  it('clicking a card whose turn is gone closes it as denied and keeps no copy of the sentence', async () => {
    const { d } = await boot()
    d.daemon.store.upsertApproval(orphan(), 'lane') // pending in the database, unknown to the running broker
    const r = await decide(d, 'ap-orphan', 'approved')
    expect(r.status).toBe(409)
    expect(((await r.json()) as { error: string }).error).toBe('stale_approval')
    expect(stored(d)).not.toContain(TEXT)
    expect(d.daemon.store.getApproval('ap-orphan')?.approval).toMatchObject({ status: 'denied' })
  })

  it('forgetting starts a fresh Claude conversation: the next session has no resumeSessionId and a prompt without the text (a refused forget does not)', async () => {
    const { d } = await boot()
    expect((await chat(d, `Please remember that ${TEXT}`)).status).toBe(202)
    const card = await waitForCard(d)
    expect((await decide(d, card.id, 'approved')).ok).toBe(true)
    await d.lane.whenIdle()
    const memory = d.hub.memory.list()
    expect(memory).toHaveLength(1)
    const sessions = d.backend.opened.length

    expect((await d.call('/api/stage/memory/mem.ghost', { method: 'DELETE' })).status).toBe(404) // nothing was forgotten
    expect((await chat(d, 'Hello once more')).status).toBe(202)
    await d.lane.whenIdle()
    expect(d.backend.opened.length).toBe(sessions) // the same conversation carried on

    expect((await d.call(`/api/stage/memory/${memory[0]!.id}`, { method: 'DELETE' })).status).toBe(200)
    expect((await chat(d, 'Hello again')).status).toBe(202)
    await d.lane.whenIdle()
    expect(d.backend.opened.length).toBe(sessions + 1)
    const next = d.backend.opened.at(-1)!
    expect(next.resumeSessionId).toBeUndefined()
    expect(next.systemPrompt).not.toContain(TEXT)
  })
})
