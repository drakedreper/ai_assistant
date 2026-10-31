import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DaemonHealth, DaemonRoutes, Snapshot, type ServerEvent } from '@ai-assistant/shared'
import { buildSnapshot, dateOnly } from '@ai-assistant/shared/fixtures'
import { KV, PROMOTION_THRESHOLD } from '../src/snapshot'
import { createTestBudget, json, makeDaemon, makeTmp, T0, type TestDaemon } from './helpers'

const open: TestDaemon[] = []
const tmps: Array<() => void> = []
afterEach(async () => {
  for (const d of open.splice(0)) await d.cleanup()
  for (const c of tmps.splice(0)) c()
})
async function daemon(opts: Parameters<typeof makeDaemon>[0] = {}): Promise<TestDaemon> {
  const d = await makeDaemon(opts)
  open.push(d)
  return d
}
const types = (events: ServerEvent[]) => events.map((e) => e.type)
const ofType = <T extends ServerEvent['type']>(events: ServerEvent[], type: T) => events.filter((e): e is Extract<ServerEvent, { type: T }> => e.type === type)
const tick = () => new Promise((r) => setTimeout(r, 0))
async function snapshot(d: TestDaemon): Promise<Snapshot> {
  const res = await d.call('/api/snapshot')
  expect(res.status).toBe(200)
  const parsed = Snapshot.safeParse(await res.json())
  if (!parsed.success) console.error(JSON.stringify(parsed.error.issues.slice(0, 6), null, 2))
  expect(parsed.success).toBe(true)
  return parsed.data as Snapshot
}
function persistent() {
  const t = makeTmp()
  tmps.push(t.cleanup)
  return { dataDir: t.dir, keepDir: true, config: { dbFile: join(t.dir, 'app.db') } }
}

describe('GET /api/health', () => {
  it('matches the shared DaemonHealth contract', async () => {
    const d = await daemon()
    d.clock.advance(42_000)
    const res = await d.call('/api/health')
    expect(res.status).toBe(200)
    const health = DaemonHealth.parse(await res.json())
    expect(health).toMatchObject({ ok: true, backend: 'fake', lane: 'ready', hooksReceived: 0, lastHookAt: null, sessions: 0, dataDir: d.dataDir, uptimeSec: 42 })
    expect(health.epoch).toBe(d.daemon.bus.epoch)
    expect(res.headers.get('x-daemon-epoch')).toBe(d.daemon.bus.epoch)
  })
})

describe('GET /api/snapshot', () => {
  it('in a fresh install is valid, honest and empty where it should be', async () => {
    const d = await daemon()
    const s = await snapshot(d)
    expect(s.sessions).toEqual([])
    expect(s.events).toEqual([])
    expect(s.tasks).toEqual([])
    expect(s.approvals).toEqual([])
    expect(s.projects).toEqual([])
    expect(s.chat).toHaveLength(1)
    expect(s.chat[0]).toMatchObject({ id: 'c-greeting', role: 'assistant' })
    expect(JSON.stringify(s.chat[0])).toContain('zero-token')
    expect(s.costDays).toHaveLength(14)
    expect(s.costDays.every((c) => Object.keys(c.byProject).length === 0 && Object.keys(c.byModel).length === 0)).toBe(true)
    expect(s.costDays.at(-1)?.date).toBe(dateOnly(new Date(T0)))
    expect(s.usageBlock.usedPct).toBe(0)
    expect(s.usageBlock.costUsd).toBe(0)
    expect(s.seq).toBe(d.daemon.bus.latestSeq)
    expect(s.settings.vault).toBeUndefined()
    expect(s.settings.audit.every((a) => a.action === 'Signed in from a browser')).toBe(true)
    // Fresh-install trust ladder: fixture approval counts are not carried over.
    expect(s.settings.trustRules.every((r) => r.approvals === 0 && r.rejections === 0 && !r.promotionSuggested)).toBe(true)
    expect(res(s.settings.trustRules, 'tr-money')).toMatchObject({ locked: true, mode: 'ask' })
  })

  it('has the mock sections from the fixtures so the UI is complete', async () => {
    const d = await daemon()
    const s = await snapshot(d)
    const fx = buildSnapshot(new Date(T0))
    expect(s.notes.length).toBe(fx.notes.length)
    expect(s.briefing.id).toBe(fx.briefing.id)
    expect(s.finance.accounts.length).toBe(fx.finance.accounts.length)
    expect(s.proposals.length).toBe(fx.proposals.length)
    expect(s.mail.length).toBe(fx.mail.length)
    expect(s.world.news.length).toBe(fx.world.news.length)
    expect(s.settings.integrations.length).toBe(fx.settings.integrations.length)
  })

  it('reports the real Claude connection: mode, lanes, budgets, and an honest integration row for the fake backend', async () => {
    const d = await daemon()
    const { claude, integrations } = (await snapshot(d)).settings
    expect(claude).toMatchObject({ mode: 'api-key', status: 'degraded', daemon: 'online', sdkVersion: 'fake (no SDK)', globalDailyCapUsd: 10 })
    expect(claude.lanes.map((l) => [l.id, l.enabled, l.dailyBudgetUsd, l.spentTodayUsd])).toEqual([
      ['secretary', true, 4, 0],
      ['reader', false, 1, 0],
      ['voice', false, 1, 0],
    ])
    const row = integrations.find((i) => i.id === 'int-claude')!
    expect(row).toMatchObject({ state: 'mock', kind: 'claude' })
    expect(row.dataLeaves).toMatch(/Nothing/)
  })

  it('reflects the sdk backend: connected with a key, needs_auth without one, off when the lane failed', async () => {
    const withKey = await daemon({ config: { backend: 'sdk', apiKey: 'sk-ant-test-key-000000' } })
    let s = await snapshot(withKey)
    expect(s.settings.claude).toMatchObject({ status: 'connected', sdkVersion: '0.3.316' })
    expect(s.settings.integrations.find((i) => i.id === 'int-claude')?.state).toBe('connected')
    expect(JSON.stringify(s)).not.toContain('sk-ant-test-key')

    const noKey = await daemon({ config: { backend: 'sdk' } })
    s = await snapshot(noKey)
    expect(s.settings.integrations.find((i) => i.id === 'int-claude')?.state).toBe('needs_auth')
    expect(s.settings.integrations.find((i) => i.id === 'int-claude')?.detail).toMatch(/ANTHROPIC_API_KEY/)

    noKey.lane.state = 'error'
    noKey.lane.error = 'spawn failed'
    s = await snapshot(noKey)
    expect(s.settings.claude.status).toBe('disconnected')
  })

  it('in demo mode keeps the fixture sessions, tasks, events and approvals and stays valid', async () => {
    const d = await daemon({ demo: true })
    const s = await snapshot(d)
    const fx = buildSnapshot(new Date(T0))
    expect(s.sessions).toHaveLength(fx.sessions.length)
    expect(s.tasks).toHaveLength(fx.tasks.length)
    expect(s.approvals).toHaveLength(fx.approvals.length)
    expect(s.approvals.filter((a) => a.status === 'pending')).toHaveLength(4)
    expect(s.events.length).toBeGreaterThan(30)
    expect(s.projects.map((p) => p.id).sort()).toEqual(fx.projects.map((p) => p.id).sort())
    expect(s.settings.vault).toBeDefined()
    expect(s.costDays.at(-1)?.byProject.atlas).toBeGreaterThan(0)
    expect(s.settings.trustRules.find((r) => r.id === 'tr-agent')?.approvals).toBe(31)
    // The agent trees survived the round trip through SQLite.
    const daemonSession = s.sessions.find((x) => x.id === 's-sync-retry')!
    expect(daemonSession.agents.map((a) => a.id)).toEqual(['main', 'ag-sync-plan', 'ag-sync-gp', 'ag-sync-explore'])
    expect(daemonSession.agents[3]?.parentId).toBe('ag-sync-gp')
    // Newest event first, like the fixtures.
    expect((s.events[0]?.ts ?? '') >= (s.events[1]?.ts ?? '')).toBe(true)
  })

  it('the demo database is disposable: every start begins from the fixtures again', async () => {
    const p = persistent()
    const cfg = { ...p.config, demo: true }
    const first = await daemon({ ...p, demo: true, config: cfg })
    await first.call('/api/tasks', { json: { title: 'scratch task' } })
    expect((await snapshot(first)).tasks).toHaveLength(buildSnapshot(new Date(T0)).tasks.length + 1)
    await first.cleanup()
    open.pop()
    const second = await daemon({ ...p, demo: true, config: cfg })
    const s = await snapshot(second)
    expect(s.tasks).toHaveLength(buildSnapshot(new Date(T0)).tasks.length)
    expect(s.tasks.some((t) => t.title === 'scratch task')).toBe(false)
  })

  it('demo fixture sessions are not turned stale by the sweep', async () => {
    const d = await daemon({ demo: true })
    d.clock.advance(3 * 24 * 3_600_000)
    expect(d.daemon.ctx.projection.sweep()).toBe(0)
    expect((await snapshot(d)).sessions.find((x) => x.id === 's-daemon')?.status).toBe('running')
  })

  it('demo mode runs on its own database, never on the real one', async () => {
    const c = (await import('../src/config')).loadConfig({ DEMO: '1', DATA_DIR: '/x' }, { platform: 'linux', homedir: '/h', exists: () => false, moduleDir: '/m' })
    expect(c.dbFile).toMatch(/demo\.db$/)
  })

  it('answers unknown routes with a JSON 404 and wrong methods without crashing', async () => {
    const d = await daemon()
    const nope = await d.call('/api/nope')
    expect(nope.status).toBe(404)
    expect((await json(nope)).message).toBe('No such route')
    expect((await d.call('/api/snapshot', { method: 'DELETE' })).status).toBe(404)
  })

  it('has a registered route for every entry in the shared DaemonRoutes', async () => {
    const d = await daemon()
    const r = DaemonRoutes
    const checks: Array<[string, string]> = [
      ['PATCH', r.task('nope')],
      ['POST', r.approvalDecision('nope')],
      ['POST', r.proposalDecision('nope')],
      ['PUT', r.trustMode('nope')],
      ['DELETE', r.learned('nope')],
    ]
    for (const [method, path] of checks) {
      const body = method === 'POST' ? { decision: 'approved' } : method === 'PUT' ? { mode: 'auto' } : method === 'PATCH' ? { column: 'done' } : undefined
      const res = await d.call(path, { method, ...(body ? { json: body } : {}) })
      expect(res.status, `${method} ${path}`).toBe(404)
      expect((await json(res)).message, `${method} ${path}`).not.toBe('No such route')
    }
    for (const path of [r.tasks, r.health, r.snapshot]) expect((await d.call(path)).status).toBe(200)
    for (const [path, body] of [[r.claudeMode, { mode: 'api-key' }], [r.guestMode, { on: false }], [r.webcam, { on: false }], [r.persona, {}]] as const) {
      expect((await d.call(path, { method: 'PUT', json: body })).status, path).toBe(200)
    }
    expect((await d.call(r.chat, { json: { text: 'hi' } })).status).toBe(202)
    expect((await d.call(r.chatInterrupt, { method: 'POST' })).status).toBe(202)
  })

  it('rejects oversized request bodies with 413', async () => {
    const d = await daemon()
    const res = await d.call('/api/chat', { body: JSON.stringify({ text: 'x'.repeat(600_000) }), contentType: 'application/json', headers: { 'Content-Length': '600020' } })
    expect(res.status).toBe(413)
  })
})

const res = <T extends { id: string }>(list: T[], id: string): T => {
  const found = list.find((x) => x.id === id)
  if (!found) throw new Error(`missing ${id}`)
  return found
}

describe('chat', () => {
  it('accepts a message with 202, hands it to the lane, and streams the reply over the bus', async () => {
    const d = await daemon()
    d.events.length = 0
    const r = await d.call('/api/chat', { json: { text: 'hello Mira' } })
    expect(r.status).toBe(202)
    expect(await r.json()).toEqual({ accepted: true })
    expect(d.lane.sent).toEqual([{ text: 'hello Mira', modality: 'text' }])
    await d.lane.settle()
    await tick()
    const t = types(d.events)
    expect(t.slice(0, 2)).toEqual(['chat.message', 'chat.message'])
    expect(t).toContain('chat.delta')
    expect(t.indexOf('chat.done')).toBeGreaterThan(t.lastIndexOf('chat.delta'))
    expect(t).toContain('settings.update') // spend changed, so the Settings chip refreshes
    const seqs = d.events.map((e) => e.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
  })

  it('persists the conversation so the snapshot (and a restart) have it', async () => {
    const p = persistent()
    const d = await daemon(p)
    await d.call('/api/chat', { json: { text: 'remember this' } })
    await d.lane.settle()
    let s = await snapshot(d)
    expect(s.chat.map((m) => m.role)).toEqual(['assistant', 'user', 'assistant'])
    expect(s.chat[2]?.parts[0]).toMatchObject({ type: 'text', text: 'You said: remember this' })
    await d.cleanup()
    open.pop()

    const again = await daemon(p)
    s = await snapshot(again)
    expect(s.chat).toHaveLength(3) // restored from the database, and the greeting is not seeded twice
    expect(s.chat.filter((m) => m.id === 'c-greeting')).toHaveLength(1)
  })

  it('passes voice transcripts through with their modality', async () => {
    const d = await daemon()
    await d.call('/api/chat', { json: { text: 'spoken words', modality: 'voice' } })
    expect(d.lane.sent[0]).toEqual({ text: 'spoken words', modality: 'voice' })
  })

  it.each([
    ['empty text', { text: '' }],
    ['missing text', {}],
    ['text over 8000 characters', { text: 'x'.repeat(8001) }],
    ['an unknown modality', { text: 'hi', modality: 'telepathy' }],
    ['text that is not a string', { text: 42 }],
  ])('rejects %s with 400 and does not call the lane', async (_n, body) => {
    const d = await daemon()
    const r = await d.call('/api/chat', { json: body })
    expect(r.status).toBe(400)
    expect((await json(r)).error).toBe('invalid_request')
    expect(d.lane.sent).toHaveLength(0)
  })

  it('rejects a body that is not JSON with 400', async () => {
    const d = await daemon()
    const r = await d.call('/api/chat', { body: '{ nope', contentType: 'application/json' })
    expect(r.status).toBe(400)
    expect((await json(r)).error).toBe('invalid_json')
  })

  it('interrupts the lane (barge-in)', async () => {
    const d = await daemon()
    const r = await d.call('/api/chat/interrupt', { method: 'POST' })
    expect(r.status).toBe(202)
    expect(d.lane.interrupted).toBe(1)
  })

  it('answers 503 when the lane is down, with a masked reason', async () => {
    const d = await daemon()
    d.lane.state = 'error'
    d.lane.error = 'spawn failed using sk-ant-api03-LEAKYLEAKYLEAKY0000'
    const r = await d.call('/api/chat', { json: { text: 'hi' } })
    expect(r.status).toBe(503)
    const body = await json(r)
    expect(body.error).toBe('lane_unavailable')
    expect(JSON.stringify(body)).not.toContain('LEAKY')
    expect(JSON.stringify(body)).toContain('spawn failed')
  })

  it('answers 502 when the lane refuses the message', async () => {
    const d = await daemon()
    d.lane.failSend = new Error('daily budget used up')
    const r = await d.call('/api/chat', { json: { text: 'hi' } })
    expect(r.status).toBe(502)
    expect((await json(r)).message).toContain('daily budget used up')
  })

  it('audits sends without storing what was said, and notes what leaves the PC on the sdk backend', async () => {
    const d = await daemon({ config: { backend: 'sdk', apiKey: 'k-0000000000' } })
    await d.call('/api/chat', { json: { text: 'my secret plan: buy low' } })
    const row = d.daemon.store.listAudit(5).find((a) => a.action === 'Sent chat message')!
    expect(row).toMatchObject({ actor: 'you', target: 'Secretary lane', outcome: 'auto', detail: '23 chars, text' })
    expect(row.sentToCloud).toBe('Chat text (23 chars) to Claude')
    expect(JSON.stringify(d.daemon.store.listAudit(50))).not.toContain('buy low')
    const fake = await daemon()
    await fake.call('/api/chat', { json: { text: 'hi' } })
    expect(fake.daemon.store.listAudit(5).find((a) => a.action === 'Sent chat message')?.sentToCloud).toBeUndefined()
  })
})

describe('approvals from the Secretary lane', () => {
  async function askPermission(d: TestDaemon): Promise<string> {
    d.events.length = 0
    await d.call('/api/chat', { json: { text: 'run: rm -rf build' } })
    await d.lane.settle()
    const created = ofType(d.events, 'approval.new')
    expect(created).toHaveLength(1)
    return created[0]!.approval.id
  }

  it('routes the decision to the lane, persists it, and announces the resolution once', async () => {
    const d = await daemon()
    const id = await askPermission(d)
    d.events.length = 0
    const r = await d.call(`/api/approvals/${id}/decision`, { json: { decision: 'approved' } })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ id, status: 'approved' })
    expect(d.lane.decisions).toEqual([{ id, decision: 'approved' }])
    expect(d.daemon.store.getApproval(id)?.approval.status).toBe('approved')
    expect(ofType(d.events, 'approval.resolved')).toHaveLength(1)
    const audit = d.daemon.store.listAudit(5).find((a) => a.action === 'Approved tool permission')
    expect(audit).toMatchObject({ actor: 'you', outcome: 'approved', target: 'Mira wants to run a command' })
    const s = await snapshot(d)
    expect(res(s.settings.trustRules, 'tr-agent')).toMatchObject({ approvals: 1, rejections: 0 })
  })

  it('publishes approval.resolved itself when the lane does not', async () => {
    const d = await daemon({ laneOptions: { announceResolved: false } })
    const id = await askPermission(d)
    d.events.length = 0
    await d.call(`/api/approvals/${id}/decision`, { json: { decision: 'denied' } })
    const resolved = ofType(d.events, 'approval.resolved')
    expect(resolved).toHaveLength(1)
    expect(resolved[0]).toMatchObject({ id, status: 'denied' })
  })

  it('treats "rejected" as denied and counts it against the trust rule', async () => {
    const d = await daemon()
    const id = await askPermission(d)
    const r = await d.call(`/api/approvals/${id}/decision`, { json: { decision: 'rejected' } })
    expect(await json(r)).toMatchObject({ status: 'denied' })
    expect(d.lane.decisions[0]?.decision).toBe('denied')
    expect(res((await snapshot(d)).settings.trustRules, 'tr-agent').rejections).toBe(1)
  })

  it('rejects unknown ids (404), repeated decisions (409) and invalid decisions (400)', async () => {
    const d = await daemon()
    expect((await d.call('/api/approvals/nope/decision', { json: { decision: 'approved' } })).status).toBe(404)
    const id = await askPermission(d)
    expect((await d.call(`/api/approvals/${id}/decision`, { json: { decision: 'maybe' } })).status).toBe(400)
    expect((await d.call(`/api/approvals/${id}/decision`, { json: {} })).status).toBe(400)
    expect((await d.call(`/api/approvals/${id}/decision`, { json: { decision: 'approved' } })).status).toBe(200)
    const again = await d.call(`/api/approvals/${id}/decision`, { json: { decision: 'denied' } })
    expect(again.status).toBe(409)
    expect((await json(again)).error).toBe('already_resolved')
    expect(d.lane.decisions).toHaveLength(1)
  })

  it('reports a lane that throws while applying a decision as 502 and leaves the approval pending', async () => {
    const d = await daemon()
    const id = await askPermission(d)
    d.lane.decideApproval = () => {
      throw new Error('backend exploded')
    }
    const r = await d.call(`/api/approvals/${id}/decision`, { json: { decision: 'approved' } })
    expect(r.status).toBe(502)
    expect((await json(r)).error).toBe('lane_error')
    expect(d.daemon.store.getApproval(id)?.approval.status).toBe('pending')
  })

  it('closes an approval whose turn is gone (the lane no longer knows it) as denied, with a 409', async () => {
    const d = await daemon()
    const id = await askPermission(d)
    d.lane.pending.clear()
    d.events.length = 0
    const r = await d.call(`/api/approvals/${id}/decision`, { json: { decision: 'approved' } })
    expect(r.status).toBe(409)
    expect((await json(r)).error).toBe('stale_approval')
    expect(d.daemon.store.getApproval(id)?.approval.status).toBe('denied')
    expect(ofType(d.events, 'approval.resolved')[0]).toMatchObject({ id, status: 'denied' })
  })

  it('closes approvals left pending by a previous run when the daemon boots', async () => {
    const p = persistent()
    const first = await daemon(p)
    const id = await askPermission(first)
    expect(first.daemon.store.getApproval(id)?.approval.status).toBe('pending')
    await first.cleanup()
    open.pop()
    const second = await daemon(p)
    expect(second.daemon.store.getApproval(id)?.approval.status).toBe('denied')
    expect((await snapshot(second)).approvals.filter((a) => a.status === 'pending')).toHaveLength(0)
  })
})

describe('approvals and proposals backed by fixtures (demo)', () => {
  it('approving a demo permission unblocks its session like the FixtureClient does', async () => {
    const d = await daemon({ demo: true })
    d.events.length = 0
    const r = await d.call('/api/approvals/ap-rm-backup/decision', { json: { decision: 'approved' } })
    expect(r.status).toBe(200)
    expect(d.daemon.store.getApproval('ap-rm-backup')?.approval.status).toBe('approved')
    expect(d.daemon.store.getSession('s-migrate')?.status).toBe('running')
    expect(types(d.events)).toEqual(expect.arrayContaining(['approval.resolved', 'session.update', 'chat.message']))
    expect(ofType(d.events, 'chat.message')[0]?.message.role).toBe('assistant')
  })

  it('denying it moves the session to waiting_input', async () => {
    const d = await daemon({ demo: true })
    await d.call('/api/approvals/ap-rm-backup/decision', { json: { decision: 'denied' } })
    expect(d.daemon.store.getSession('s-migrate')?.status).toBe('waiting_input')
  })

  it('approving a proposal approval resolves the proposal; the vault is Phase 2 so no commit is invented', async () => {
    const d = await daemon({ demo: true })
    d.events.length = 0
    await d.call('/api/approvals/ap-q4-proposal/decision', { json: { decision: 'approved' } })
    const update = ofType(d.events, 'proposal.update')[0]!
    expect(update.proposal).toMatchObject({ id: 'pr-q4', status: 'approved' })
    expect(update.proposal.commit).toBeUndefined()
    expect(update.proposal.decidedAt).toBeDefined()
    const s = await snapshot(d)
    expect(res(s.proposals, 'pr-q4').status).toBe('approved')
  })

  it('deciding a proposal directly resolves the linked approval and persists', async () => {
    const p = persistent()
    const d = await daemon({ ...p, demo: true, config: { ...p.config, demo: true } })
    d.events.length = 0
    const r = await d.call('/api/proposals/pr-q4/decision', { json: { decision: 'rejected' } })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ id: 'pr-q4', status: 'rejected' })
    expect(ofType(d.events, 'proposal.update')[0]?.proposal.status).toBe('rejected')
    expect(ofType(d.events, 'approval.resolved')[0]).toMatchObject({ id: 'ap-q4-proposal', status: 'denied' })
    expect(d.daemon.store.getApproval('ap-q4-proposal')?.approval.status).toBe('denied')
  })

  it('works without demo data too (proposals are fixtures either way), and refuses repeats and unknown ids', async () => {
    const d = await daemon()
    expect((await d.call('/api/proposals/pr-q4/decision', { json: { decision: 'approved' } })).status).toBe(200)
    const again = await d.call('/api/proposals/pr-q4/decision', { json: { decision: 'rejected' } })
    expect(again.status).toBe(409)
    expect((await d.call('/api/proposals/nope/decision', { json: { decision: 'approved' } })).status).toBe(404)
    expect((await d.call('/api/proposals/pr-q4/decision', { json: { decision: 'sure' } })).status).toBe(400)
    expect(res((await snapshot(d)).proposals, 'pr-q4').status).toBe('approved')
    expect(d.daemon.store.listAudit(10).some((a) => a.action === 'Approved proposal' && a.detail?.includes('no vault write'))).toBe(true)
  })
})

describe('tasks', () => {
  it('creates, lists, moves, edits and deletes tasks, publishing a ServerEvent for each change', async () => {
    const d = await daemon()
    d.events.length = 0
    const created = await d.call('/api/tasks', { json: { title: '  Write the README  ' } })
    expect(created.status).toBe(201)
    const task = await json<{ id: string; title: string; column: string; priority: string; source: string; sessionIds: string[] }>(created)
    expect(task).toMatchObject({ title: 'Write the README', column: 'todo', priority: 'medium', source: 'manual', sessionIds: [] })
    expect(ofType(d.events, 'task.update')[0]?.task.id).toBe(task.id)

    expect(await json<unknown[]>(await d.call('/api/tasks'))).toHaveLength(1)

    d.events.length = 0
    const moved = await d.call(`/api/tasks/${task.id}`, { method: 'PATCH', json: { column: 'doing' } })
    expect(moved.status).toBe(200)
    expect(await json(moved)).toMatchObject({ column: 'doing' })
    expect(ofType(d.events, 'task.update')[0]?.task.column).toBe('doing')

    const edited = await d.call(`/api/tasks/${task.id}`, { method: 'PUT', json: { title: 'Ship the README', priority: 'high', description: 'with a table', column: 'review' } })
    expect(await json(edited)).toMatchObject({ title: 'Ship the README', priority: 'high', description: 'with a table', column: 'review' })

    d.events.length = 0
    const del = await d.call(`/api/tasks/${task.id}`, { method: 'DELETE' })
    expect(del.status).toBe(204)
    expect(ofType(d.events, 'snapshot.reset')).toHaveLength(1) // the contract has no task-removed event
    expect((await snapshot(d)).tasks).toEqual([])
    expect(d.daemon.store.listAudit(20).map((a) => a.action)).toEqual(expect.arrayContaining(['Created task', 'Moved task to doing', 'Moved task to review', 'Deleted task']))
  })

  it('accepts a column and a project on create, and rejects bad input', async () => {
    const d = await daemon({ demo: true })
    const ok = await d.call('/api/tasks', { json: { title: 'X', projectId: 'atlas', column: 'backlog' } })
    expect(await json(ok)).toMatchObject({ projectId: 'atlas', column: 'backlog' })
    expect((await d.call('/api/tasks', { json: { title: '' } })).status).toBe(400)
    expect((await d.call('/api/tasks', { json: { title: 'x'.repeat(201) } })).status).toBe(400)
    expect((await d.call('/api/tasks', { json: { title: 'X', column: 'someday' } })).status).toBe(400)
    const unknown = await d.call('/api/tasks', { json: { title: 'X', projectId: 'no-such-project' } })
    expect(unknown.status).toBe(400)
    expect((await json(unknown)).error).toBe('unknown_project')
  })

  it('rejects invalid edits and unknown tasks', async () => {
    const d = await daemon()
    const t = await json<{ id: string }>(await d.call('/api/tasks', { json: { title: 'X' } }))
    expect((await d.call(`/api/tasks/${t.id}`, { method: 'PATCH', json: { column: 'someday' } })).status).toBe(400)
    expect((await d.call(`/api/tasks/${t.id}`, { method: 'PATCH', json: {} })).status).toBe(400)
    expect((await d.call('/api/tasks/nope', { method: 'PATCH', json: { column: 'done' } })).status).toBe(404)
    expect((await d.call('/api/tasks/nope', { method: 'DELETE' })).status).toBe(404)
  })

  it('persists tasks across a restart', async () => {
    const p = persistent()
    const d = await daemon(p)
    const t = await json<{ id: string }>(await d.call('/api/tasks', { json: { title: 'Survive restarts' } }))
    await d.call(`/api/tasks/${t.id}`, { method: 'PATCH', json: { column: 'done' } })
    await d.cleanup()
    open.pop()
    const again = await daemon(p)
    const s = await snapshot(again)
    expect(s.tasks).toHaveLength(1)
    expect(s.tasks[0]).toMatchObject({ id: t.id, title: 'Survive restarts', column: 'done' })
  })
})

describe('settings', () => {
  it('changes a trust rule, persists it, audits it and publishes settings.update; locked rules refuse', async () => {
    const p = persistent()
    const d = await daemon(p)
    d.events.length = 0
    const r = await d.call('/api/settings/trust/tr-notes', { method: 'PUT', json: { mode: 'auto' } })
    expect(r.status).toBe(200)
    expect(res((await snapshot(d)).settings.trustRules, 'tr-notes').mode).toBe('auto')
    const update = ofType(d.events, 'settings.update')[0]!
    expect(res(update.settings.trustRules, 'tr-notes').mode).toBe('auto')
    expect(d.daemon.store.listAudit(5)[0]).toMatchObject({ action: 'Set "Edit knowledge and project notes" to auto', actor: 'you' })

    const locked = await d.call('/api/settings/trust/tr-money', { method: 'PUT', json: { mode: 'auto' } })
    expect(locked.status).toBe(409)
    const lockedBody = await json(locked)
    expect(lockedBody).toMatchObject({ error: 'locked' })
    expect(String(lockedBody.message)).toMatch(/locked|Permanently/i)
    expect((await d.call('/api/settings/trust/tr-persona', { method: 'PUT', json: { mode: 'auto' } })).status).toBe(409)
    expect((await d.call('/api/settings/trust/tr-strategy', { method: 'PUT', json: { mode: 'auto' } })).status).toBe(409)
    expect((await d.call('/api/settings/trust/tr-nope', { method: 'PUT', json: { mode: 'auto' } })).status).toBe(404)
    expect((await d.call('/api/settings/trust/tr-notes', { method: 'PUT', json: { mode: 'always' } })).status).toBe(400)
    expect(res((await snapshot(d)).settings.trustRules, 'tr-money').mode).toBe('ask')

    await d.cleanup()
    open.pop()
    const again = await daemon(p)
    expect(res((await snapshot(again)).settings.trustRules, 'tr-notes').mode).toBe('auto')
  })

  it('suggests promotion after enough approvals without a rejection', async () => {
    const d = await daemon()
    d.daemon.store.kvSet(KV.trustCounts, { 'tr-agent': { approvals: PROMOTION_THRESHOLD, rejections: 0 }, 'tr-send': { approvals: 50, rejections: 1 } })
    const rules = (await snapshot(d)).settings.trustRules
    expect(res(rules, 'tr-agent')).toMatchObject({ approvals: PROMOTION_THRESHOLD, promotionSuggested: true })
    expect(res(rules, 'tr-send').promotionSuggested).toBe(false)
    await d.call('/api/settings/trust/tr-agent', { method: 'PUT', json: { mode: 'auto' } })
    expect(res((await snapshot(d)).settings.trustRules, 'tr-agent').promotionSuggested).toBe(false)
  })

  it('switches the Claude connection mode, and the lane sees it', async () => {
    const d = await daemon()
    const r = await d.call('/api/settings/claude-mode', { method: 'PUT', json: { mode: 'local-login' } })
    expect(r.status).toBe(200)
    expect((await snapshot(d)).settings.claude.mode).toBe('local-login')
    expect(d.lane.ctx.getClaude().mode).toBe('local-login')
    expect((await d.call('/api/settings/claude-mode', { method: 'PUT', json: { mode: 'oauth' } })).status).toBe(400)
  })

  it('toggles guest mode and the webcam, validates the body, and accepts POST as an alias for PUT', async () => {
    const d = await daemon()
    d.events.length = 0
    expect((await d.call('/api/settings/guest', { method: 'PUT', json: { on: true } })).status).toBe(200)
    expect((await d.call('/api/settings/webcam', { method: 'POST', json: { on: true } })).status).toBe(200)
    const s = await snapshot(d)
    expect(s.settings.guestMode).toBe(true)
    expect(s.settings.webcam).toEqual({ enabled: true, retention: 'none' })
    expect(ofType(d.events, 'settings.update')).toHaveLength(2)
    expect((await d.call('/api/settings/guest', { method: 'PUT', json: { on: 'yes' } })).status).toBe(400)
    expect((await d.call('/api/settings/webcam', { method: 'PUT', json: {} })).status).toBe(400)
    expect(d.daemon.store.listAudit(10).find((a) => a.action === 'Allowed the webcam')?.sensitive).toBe(true)
  })

  it('merges persona edits, validates them, and gives the lane the new persona', async () => {
    const p = persistent()
    const d = await daemon(p)
    const r = await d.call('/api/settings/persona', { method: 'PUT', json: { name: 'Aria', tagline: 'Calm and quick.' } })
    expect(r.status).toBe(200)
    expect(await json(r)).toMatchObject({ name: 'Aria', tagline: 'Calm and quick.' })
    const persona = (await snapshot(d)).settings.persona
    expect(persona.name).toBe('Aria')
    expect(persona.boundaries.length).toBeGreaterThan(0) // untouched fields survive
    expect(d.lane.ctx.getPersona().name).toBe('Aria')
    expect((await d.call('/api/settings/persona', { method: 'PUT', json: { vibe: { warmth: 500, playfulness: 1, directness: 1, proactivity: 1 } } })).status).toBe(400)
    expect((await d.call('/api/settings/persona', { method: 'PUT', json: { name: 42 } })).status).toBe(400)
    await d.cleanup()
    open.pop()
    expect((await snapshot(await daemon(p))).settings.persona.name).toBe('Aria')
  })

  it('persists guest mode, webcam and the Claude mode across a restart', async () => {
    const p = persistent()
    const d = await daemon(p)
    await d.call('/api/settings/guest', { method: 'PUT', json: { on: true } })
    await d.call('/api/settings/claude-mode', { method: 'PUT', json: { mode: 'local-login' } })
    await d.cleanup()
    open.pop()
    const s = (await snapshot(await daemon(p))).settings
    expect(s.guestMode).toBe(true)
    expect(s.claude.mode).toBe('local-login')
  })
})

describe('learned facts', () => {
  it('forgets a fact, persists it, and publishes learned.update with what remains', async () => {
    const p = persistent()
    const d = await daemon(p)
    const before = (await snapshot(d)).learned
    expect(before.length).toBeGreaterThan(1)
    const victim = before[0]!
    d.events.length = 0
    const r = await d.call(`/api/learned/${victim.id}`, { method: 'DELETE' })
    expect(r.status).toBe(204)
    const update = ofType(d.events, 'learned.update')[0]!
    expect(update.learned.map((f) => f.id)).not.toContain(victim.id)
    expect(update.learned).toHaveLength(before.length - 1)
    expect((await d.call(`/api/learned/${victim.id}`, { method: 'DELETE' })).status).toBe(404)
    expect((await d.call('/api/learned/nope', { method: 'DELETE' })).status).toBe(404)
    await d.cleanup()
    open.pop()
    expect((await snapshot(await daemon(p))).learned.map((f) => f.id)).not.toContain(victim.id)
  })
})

describe('costs and budgets', () => {
  it('computes cost days from lane usage, shows lane spend in settings, and survives a restart', async () => {
    const p = persistent()
    const d = await daemon(p)
    await d.call('/api/chat', { json: { text: 'one' } })
    await d.call('/api/chat', { json: { text: 'two' } })
    await d.lane.settle()
    let s = await snapshot(d)
    const today = s.costDays.at(-1)!
    expect(today.date).toBe(dateOnly(new Date(T0)))
    expect(today.byProject.secretary).toBeCloseTo(0.04)
    expect(today.byModel['claude-sonnet-5-5']).toBeCloseTo(0.04)
    expect(s.settings.claude.lanes[0]?.spentTodayUsd).toBeCloseTo(0.04)
    expect(s.usageBlock.costUsd).toBeCloseTo(0.04)
    expect(s.projects.find((x) => x.id === 'secretary')?.name).toMatch(/Secretary lane/)
    await d.cleanup()
    open.pop()

    const fresh = createTestBudget() // a new process starts with an empty in-memory guard
    const again = await daemon({ ...p, budget: fresh })
    expect(fresh.status().lanes.find((l) => l.lane === 'secretary')?.spentTodayUsd).toBeCloseTo(0.04)
    s = await snapshot(again)
    expect(s.settings.claude.lanes[0]?.spentTodayUsd).toBeCloseTo(0.04)
    expect(s.costDays.at(-1)?.byProject.secretary).toBeCloseTo(0.04)
  })

  it('does not replay yesterday\'s spend into today\'s budget', async () => {
    const p = persistent()
    const d = await daemon(p)
    d.daemon.store.addUsage(dateOnly(new Date(T0), -1), 'secretary', 'claude-sonnet-5-5', 3)
    await d.cleanup()
    open.pop()
    const fresh = createTestBudget()
    const again = await daemon({ ...p, budget: fresh })
    expect(fresh.status().lanes.find((l) => l.lane === 'secretary')?.spentTodayUsd).toBe(0)
    const s = await snapshot(again)
    expect(s.costDays.at(-2)?.byProject.secretary).toBe(3)
  })
})
