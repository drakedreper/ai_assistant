/**
 * The daemon with the REAL Secretary lane from @ai-assistant/agent-core, the scripted fake backend (zero tokens, no
 * network) and the real SQLite store: chat round trip, tool permission -> approval -> decision, restart and resume.
 * Nothing here talks to Anthropic. It proves the wiring between daemon and lane, not the live SDK backend.
 */
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createBudgetGuard,
  createFakeBackend,
  createMockToolBindings,
  createSecretaryLane,
  type FakeBackend,
  type SecretaryLaneImpl,
} from '@ai-assistant/agent-core'
import { Snapshot, type AgentBackend, type BudgetGuard, type ServerEvent } from '@ai-assistant/shared'
import { createDaemon, type Daemon } from '../src/app'
import { createProjectResolver } from '../src/hooks/projects'
import { makeTmp, testConfig } from './helpers'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

interface Rig {
  daemon: Daemon
  lane: SecretaryLaneImpl
  backend: FakeBackend
  events: ServerEvent[]
  budget: BudgetGuard
  dataDir: string
  cookie: string
  call(path: string, init?: { method?: string; json?: unknown }): Response | Promise<Response>
  hook(event: string, payload: unknown): Response | Promise<Response>
  stop(): Promise<void>
}

interface RigOptions {
  dataDir?: string
  backend?: AgentBackend
  budgets?: { secretary: number }
  laneOptions?: Parameters<typeof createSecretaryLane>[1]
  latencyMs?: number
}

async function rig(opts: RigOptions = {}): Promise<Rig> {
  const tmp = opts.dataDir ? undefined : makeTmp('integration-')
  if (tmp) cleanups.push(tmp.cleanup)
  const dataDir = opts.dataDir ?? tmp!.dir
  const backend = (opts.backend ?? createFakeBackend({ latencyMs: opts.latencyMs ?? 0 })) as FakeBackend
  const budget = createBudgetGuard({
    lanes: [
      { lane: 'secretary', dailyBudgetUsd: opts.budgets?.secretary ?? 4 },
      { lane: 'reader', dailyBudgetUsd: 1 },
      { lane: 'voice', dailyBudgetUsd: 1 },
    ],
    globalDailyCapUsd: 10,
  })
  let lane!: SecretaryLaneImpl
  const daemon = createDaemon({
    config: testConfig(dataDir, { dbFile: join(dataDir, 'app.db'), port: 7421 }),
    budget,
    lane: (ctx) => (lane = createSecretaryLane({ ...ctx, backend, tools: createMockToolBindings() }, opts.laneOptions)),
    resolver: createProjectResolver({ existsSync: () => false, readFileSync: () => '', isDirectory: () => false }),
  })
  const events: ServerEvent[] = []
  daemon.bus.subscribe((e) => void events.push(e))
  await lane.start()

  const code = daemon.security.issueExchangeCode().code
  const ex = await daemon.app.request('/api/auth/exchange', {
    method: 'POST',
    headers: { Host: '127.0.0.1:7421', Origin: 'http://127.0.0.1:7421', 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  })
  expect(ex.status).toBe(200)
  const cookie = (ex.headers.get('set-cookie') ?? '').split(';')[0] ?? ''

  const r: Rig = {
    daemon,
    lane,
    backend,
    events,
    budget,
    dataDir,
    cookie,
    call(path, init = {}) {
      const method = init.method ?? (init.json !== undefined ? 'POST' : 'GET')
      const headers: Record<string, string> = { Host: '127.0.0.1:7421', Cookie: cookie }
      if (method !== 'GET') headers.Origin = 'http://127.0.0.1:7421'
      if (init.json !== undefined) headers['Content-Type'] = 'application/json'
      return daemon.app.request(path, { method, headers, ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}) })
    },
    hook(event, payload) {
      return daemon.app.request(`/hooks/${event}`, {
        method: 'POST',
        headers: { Host: '127.0.0.1:7421', Authorization: `Bearer ${daemon.security.hookToken()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
    },
    stop: () => daemon.stop(),
  }
  cleanups.push(() => daemon.stop())
  return r
}

const ofType = <T extends ServerEvent['type']>(events: ServerEvent[], type: T) => events.filter((e): e is Extract<ServerEvent, { type: T }> => e.type === type)
const textOf = (m: { parts: Array<{ type: string; text?: string }> }) => m.parts.filter((p) => p.type === 'text').map((p) => p.text).join(' ')

async function snapshot(r: Rig): Promise<Snapshot> {
  const res = await r.call('/api/snapshot')
  expect(res.status).toBe(200)
  const parsed = Snapshot.safeParse(await res.json())
  if (!parsed.success) console.error(JSON.stringify(parsed.error.issues.slice(0, 5), null, 2))
  expect(parsed.success).toBe(true)
  return parsed.data as Snapshot
}

describe('daemon + real Secretary lane + fake backend + SQLite', () => {
  it('chat round trip: the user message, a streamed reply with emotion tags stripped, persistence, spend', async () => {
    const r = await rig()
    r.events.length = 0
    const res = await r.call('/api/chat', { json: { text: 'hello there' } })
    expect(res.status).toBe(202)
    await r.lane.whenIdle()
    await new Promise((x) => setTimeout(x, 0))

    const messages = ofType(r.events, 'chat.message')
    expect(messages[0]?.message).toMatchObject({ role: 'user', parts: [{ type: 'text', text: 'hello there' }] })
    expect(ofType(r.events, 'chat.delta').length).toBeGreaterThan(0)
    expect(ofType(r.events, 'chat.done')).toHaveLength(1)
    expect(ofType(r.events, 'avatar').length).toBeGreaterThan(0)
    expect(ofType(r.events, 'settings.update').length).toBeGreaterThan(0)
    const seqs = r.events.map((e) => e.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    expect(new Set(seqs).size).toBe(seqs.length)

    const snap = await snapshot(r)
    const reply = snap.chat.filter((m) => m.role === 'assistant').at(-1)!
    expect(textOf(reply)).toContain('offline demo mode')
    expect(JSON.stringify(snap.chat)).not.toMatch(/\[(happy|relaxed|neutral|thinking)\]/) // tags never reach the UI
    expect(snap.chat.map((m) => m.role)).toEqual(['assistant', 'user', 'assistant']) // greeting, user, reply

    const today = snap.costDays.at(-1)!
    expect(today.byProject.secretary).toBeGreaterThan(0)
    expect(snap.settings.claude.lanes[0]!.spentTodayUsd).toBeGreaterThan(0)
    expect(snap.settings.claude.lanes[0]).toMatchObject({ id: 'secretary', model: 'claude-sonnet-5-5', enabled: true })
    expect(snap.settings.claude.status).toBe('degraded') // config backend is 'fake' in this rig
    expect((await (await r.call('/api/health')).json() as { lane: string }).lane).toBe('ready')
  })

  it('tool permission -> approval -> decision: approving runs the tool and resolves the card exactly once', async () => {
    const r = await rig()
    r.events.length = 0
    await r.call('/api/chat', { json: { text: 'please send the reply to Priya' } })
    // The turn is now parked on the permission request.
    for (let i = 0; i < 200 && ofType(r.events, 'approval.new').length === 0; i++) await new Promise((x) => setTimeout(x, 5))
    const created = ofType(r.events, 'approval.new')
    expect(created).toHaveLength(1)
    const approval = created[0]!.approval
    expect(approval).toMatchObject({ kind: 'email_draft', status: 'pending', area: 'life' })
    expect(r.daemon.store.getApproval(approval.id)).toMatchObject({ origin: 'lane', approval: { status: 'pending' } })

    let snap = await snapshot(r)
    expect(snap.approvals.filter((a) => a.status === 'pending').map((a) => a.id)).toEqual([approval.id])
    const card = snap.chat.at(-1)!.parts.find((p) => p.type === 'approval')
    expect(card).toMatchObject({ approvalId: approval.id })

    r.events.length = 0
    const decided = await r.call(`/api/approvals/${approval.id}/decision`, { json: { decision: 'approved' } })
    expect(decided.status).toBe(200)
    await r.lane.whenIdle()
    expect(ofType(r.events, 'approval.resolved')).toHaveLength(1)
    expect(ofType(r.events, 'approval.resolved')[0]).toMatchObject({ id: approval.id, status: 'approved' })
    expect(r.daemon.store.getApproval(approval.id)?.approval.status).toBe('approved')

    snap = await snapshot(r)
    expect(textOf(snap.chat.at(-1)!)).toContain('went through the mock tool')
    expect(snap.settings.audit.some((a) => a.action === 'Approved email draft' && a.actor === 'you' && a.outcome === 'approved')).toBe(true)
    expect(snap.settings.trustRules.find((x) => x.id === 'tr-send')).toMatchObject({ approvals: 1 })
    // Deciding again is refused.
    expect((await r.call(`/api/approvals/${approval.id}/decision`, { json: { decision: 'denied' } })).status).toBe(409)
  })

  it('denying tells the backend no: the tool does not run and the reply says so', async () => {
    const r = await rig()
    r.events.length = 0
    await r.call('/api/chat', { json: { text: 'send it' } })
    for (let i = 0; i < 200 && ofType(r.events, 'approval.new').length === 0; i++) await new Promise((x) => setTimeout(x, 5))
    const id = ofType(r.events, 'approval.new')[0]!.approval.id
    expect((await r.call(`/api/approvals/${id}/decision`, { json: { decision: 'rejected' } })).status).toBe(200)
    await r.lane.whenIdle()
    const snap = await snapshot(r)
    expect(textOf(snap.chat.at(-1)!)).toContain('will not do that')
    expect(snap.approvals.find((a) => a.id === id)?.status).toBe('denied')
    expect(snap.settings.trustRules.find((x) => x.id === 'tr-send')).toMatchObject({ approvals: 0, rejections: 1 })
  })

  it('never raises an approval for the locked money tool: it is refused and audited as blocked', async () => {
    const r = await rig()
    await r.call('/api/chat', { json: { text: 'pay my rent now' } })
    await r.lane.whenIdle()
    const snap = await snapshot(r)
    expect(snap.approvals).toEqual([])
    expect(snap.settings.audit.some((a) => a.outcome === 'blocked')).toBe(true)
  })

  it('reads through the mock tools and records them in the audit log without sending chat text anywhere', async () => {
    const r = await rig()
    await r.call('/api/chat', { json: { text: 'what is on my calendar today' } })
    await r.lane.whenIdle()
    const snap = await snapshot(r)
    const reply = snap.chat.at(-1)!
    expect(reply.parts.some((p) => p.type === 'tool' && p.tool === 'calendar_agenda' && p.status === 'done')).toBe(true)
    expect(snap.settings.audit.some((a) => a.action === 'tool:calendar_agenda')).toBe(true)
  })

  it('by default a restart starts a fresh conversation (memory-first), while the chat history is still there', async () => {
    const dir = makeTmp('integration-fresh-')
    cleanups.push(dir.cleanup)
    const first = await rig({ dataDir: dir.dir })
    await first.call('/api/chat', { json: { text: 'hello' } })
    await first.lane.whenIdle()
    await first.stop()
    const second = await rig({ dataDir: dir.dir })
    expect(second.backend.opened[0]?.resumeSessionId).toBeUndefined()
    const snap = await snapshot(second)
    expect(snap.chat.map((m) => m.role)).toEqual(['assistant', 'user', 'assistant'])
  })

  it('saves the lane\'s backend session id, treats it as owned (hooks for it are dropped), and in resume mode resumes it after a restart', async () => {
    const dir = makeTmp('integration-restart-')
    cleanups.push(dir.cleanup)
    const first = await rig({ dataDir: dir.dir })
    await first.call('/api/chat', { json: { text: 'hello' } })
    await first.lane.whenIdle()
    const sessionId = first.lane.status().backendSessionId
    expect(sessionId).toMatch(/^fake-secretary-/)
    expect(first.daemon.store.isLaneSession(sessionId!)).toBe(true)

    // User-level hooks also fire for SDK sessions: the daemon must not show the lane's own session as an external one.
    first.events.length = 0
    const dropped = await first.hook('SessionStart', { session_id: sessionId, hook_event_name: 'SessionStart', cwd: 'C:\\dev\\x' })
    expect(dropped.status).toBe(200)
    await first.daemon.ctx.hooks.drain()
    expect(first.daemon.store.countSessions()).toBe(0)
    expect(first.daemon.ctx.hooks.stats().ownedDropped).toBe(1)
    await first.stop()

    const second = await rig({ dataDir: dir.dir, laneOptions: { conversation: 'resume' } })
    expect(second.backend.opened[0]?.resumeSessionId).toBe(sessionId) // in 'resume' mode the lane asks the backend to resume
    const snap = await snapshot(second)
    expect(snap.chat.map((m) => m.role)).toEqual(['assistant', 'user', 'assistant']) // history restored, no second greeting
    // an ordinary external session still works
    await second.hook('SessionStart', { session_id: 'terminal-1', hook_event_name: 'SessionStart', cwd: 'C:\\dev\\x' })
    await second.daemon.ctx.hooks.drain()
    expect(second.daemon.store.countSessions()).toBe(1)
  })

  it('restores the day\'s spend into the real budget guard after a restart', async () => {
    const dir = makeTmp('integration-budget-')
    cleanups.push(dir.cleanup)
    const first = await rig({ dataDir: dir.dir })
    await first.call('/api/chat', { json: { text: 'hello' } })
    await first.lane.whenIdle()
    const spent = first.budget.status().lanes.find((l) => l.lane === 'secretary')!.spentTodayUsd
    expect(spent).toBeGreaterThan(0)
    await first.stop()
    const second = await rig({ dataDir: dir.dir })
    expect(second.budget.status().lanes.find((l) => l.lane === 'secretary')!.spentTodayUsd).toBeCloseTo(spent, 6)
    expect(second.budget.status().globalSpentTodayUsd).toBeCloseTo(spent, 6)
  })

  it('a used-up budget makes the lane post a notice instead of calling the backend', async () => {
    const r = await rig({ budgets: { secretary: 0 } })
    const res = await r.call('/api/chat', { json: { text: 'hello' } })
    expect(res.status).toBe(202)
    await r.lane.whenIdle()
    const snap = await snapshot(r)
    const last = snap.chat.at(-1)!
    expect(last.role).toBe('system')
    expect(textOf(last)).toMatch(/daily budget/i)
    expect(r.backend.sessions[0]).toBeDefined()
  })

  it('barge-in: interrupting stops the reply and ends the turn once', async () => {
    const r = await rig({ latencyMs: 20 })
    r.events.length = 0
    await r.call('/api/chat', { json: { text: 'hello there my friend' } })
    await new Promise((x) => setTimeout(x, 60))
    const res = await r.call('/api/chat/interrupt', { method: 'POST' })
    expect(res.status).toBe(202)
    await r.lane.whenIdle()
    expect(ofType(r.events, 'chat.done')).toHaveLength(1)
    expect(r.lane.status().state).toBe('ready')
    // and the lane still answers afterwards
    r.events.length = 0
    await r.call('/api/chat', { json: { text: 'thanks' } })
    await r.lane.whenIdle()
    expect(ofType(r.events, 'chat.done')).toHaveLength(1)
  })

  it('reports a lane that could not start: health says error, chat answers 503, the daemon stays up', async () => {
    const broken: AgentBackend = {
      kind: 'fake',
      async open() {
        throw new Error('spawn failed')
      },
    }
    const r = await rig({ backend: broken, laneOptions: { maxRestarts: 0 } })
    const health = (await (await r.call('/api/health')).json()) as { lane: string; ok: boolean }
    expect(health).toMatchObject({ ok: true, lane: 'error' })
    const chat = await r.call('/api/chat', { json: { text: 'hello' } })
    expect(chat.status).toBe(503)
    const snap = await snapshot(r)
    expect(snap.settings.claude.status).toBe('disconnected')
  })

  it('shuts down gracefully: interrupts and stops the lane, then closes the database', async () => {
    const r = await rig({ latencyMs: 10 })
    await r.call('/api/chat', { json: { text: 'hello there' } })
    await r.daemon.stop()
    expect(r.lane.status().state).toBe('stopped')
    expect(() => r.daemon.store.countChat()).toThrow() // the database is closed
    await expect(r.daemon.stop()).resolves.toBeUndefined()
  })

  it('passes the daemon\'s persona and Claude settings to the lane', async () => {
    const r = await rig()
    await r.call('/api/settings/persona', { method: 'PUT', json: { name: 'Aria' } })
    const opened = r.backend.opened[0]!
    expect(opened.lane).toBe('secretary')
    expect(opened.authMode).toBe('api-key')
    expect(opened.cwd).toBe(join(r.dataDir, 'agent'))
    expect(opened.tools.every((t) => (t.spec.lanes as readonly string[]).includes('secretary') && !t.spec.locked)).toBe(true)
    // The persona the lane reads is the live one.
    const ctxPersona = r.daemon.ctx.snapshots.persona()
    expect(ctxPersona.name).toBe('Aria')
  })
})
