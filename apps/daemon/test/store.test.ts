import { existsSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import type { Approval, ChatMessage, Session, Task } from '@ai-assistant/shared'
import { createIdGen } from '../src/ids'
import { createLaneStore, createRecordingBudget, hydrateBudget, LATEST_VERSION, MIGRATIONS, migrate, MigrationError, openStore, type Store } from '../src/store'
import { redactHookPayload } from '../src/store/redact'
import { createTestBudget, makeTmp } from './helpers'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

function memStore(): Store {
  const s = openStore({ file: ':memory:' })
  cleanups.push(() => s.close())
  return s
}

const project = { id: 'p1', name: 'atlas', rootPath: 'C:\\dev\\atlas', status: 'active' as const, tags: ['hooks'], color: '#fbbf24' }

function session(over: Partial<Session> = {}): Session {
  return {
    id: 's1',
    projectId: 'p1',
    title: 'T',
    source: 'hook',
    kind: 'interactive',
    status: 'running',
    model: 'm',
    cwd: 'C:\\dev\\atlas',
    startedAt: '2026-11-02T10:00:00.000Z',
    updatedAt: '2026-11-02T10:00:00.000Z',
    costUsd: 0,
    contextPct: 0,
    agents: [
      { id: 'main', parentId: null, type: 'main', status: 'running', lastMessage: 'hi' },
      { id: 'a1', parentId: 'main', type: 'Explore', status: 'done', lastMessage: '', description: 'look' },
    ],
    ...over,
  }
}

describe('migrations', () => {
  it('creates every table on an empty database and reaches the latest version', () => {
    const s = memStore()
    expect(s.schemaVersion()).toBe(LATEST_VERSION)
    const tables = (s.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((t) => t.name)
    for (const t of ['events', 'projects', 'sessions', 'agents', 'tasks', 'approvals', 'chat_messages', 'audit', 'kv', 'agent_events', 'usage', 'lane_sessions']) {
      expect(tables).toContain(t)
    }
  })

  it('is idempotent: migrating again changes nothing', () => {
    const s = memStore()
    const r = migrate(s.db)
    expect(r.from).toBe(LATEST_VERSION)
    expect(r.to).toBe(LATEST_VERSION)
  })

  it('upgrades from an older version and keeps the data that is already there', () => {
    const tmp = makeTmp()
    cleanups.push(tmp.cleanup)
    const file = join(tmp.dir, 'old.db')
    const old = new Database(file)
    old.pragma('foreign_keys = ON')
    // Install only migration 1, as an older daemon would have.
    const first = MIGRATIONS[0]!
    old.transaction(() => {
      first.up(old)
      old.pragma(`user_version = ${first.version}`)
    })()
    old.prepare("INSERT INTO kv (key, value_json, updated_at) VALUES ('keep', '\"me\"', 'now')").run()
    old.prepare("INSERT INTO projects (id, name, root_path, status, tags_json, color) VALUES ('p1','n','r','active','[]','#fff')").run()
    expect(Number(old.pragma('user_version', { simple: true }))).toBe(1)
    old.close()

    const s = openStore({ file })
    cleanups.push(() => s.close())
    expect(s.schemaVersion()).toBe(LATEST_VERSION)
    expect(s.kvGet('keep')).toBe('me')
    expect(s.getProject('p1')?.name).toBe('n')
    expect(s.countAgentEvents()).toBe(0) // a v2 table exists and is usable
  })

  it('refuses a database written by a newer daemon', () => {
    const tmp = makeTmp()
    cleanups.push(tmp.cleanup)
    const file = join(tmp.dir, 'future.db')
    const db = new Database(file)
    db.pragma('user_version = 999')
    db.close()
    expect(() => openStore({ file })).toThrow(MigrationError)
  })

  it('rolls a failing migration back instead of leaving a half-applied schema', () => {
    const db = new Database(':memory:')
    const bad = [
      { version: 1, name: 'ok', up: (d: Database.Database) => void d.exec('CREATE TABLE a (x)') },
      {
        version: 2,
        name: 'broken',
        up: (d: Database.Database) => {
          d.exec('CREATE TABLE b (x)')
          d.exec('THIS IS NOT SQL')
        },
      },
    ]
    expect(() => migrate(db, bad)).toThrow()
    expect(Number(db.pragma('user_version', { simple: true }))).toBe(1)
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((t) => t.name)
    expect(names).toContain('a')
    expect(names).not.toContain('b')
    db.close()
  })

  it('opens file databases in WAL mode with foreign keys on and a busy timeout', () => {
    const tmp = makeTmp()
    cleanups.push(tmp.cleanup)
    const s = openStore({ file: join(tmp.dir, 'nested', 'app.db') })
    cleanups.push(() => s.close())
    expect(String(s.db.pragma('journal_mode', { simple: true }))).toBe('wal')
    expect(Number(s.db.pragma('foreign_keys', { simple: true }))).toBe(1)
    expect(Number(s.db.pragma('busy_timeout', { simple: true }))).toBeGreaterThanOrEqual(1000)
  })
})

describe('repositories', () => {
  it('stores raw events with a unique dedupe key but allows many events without one', () => {
    const s = memStore()
    const base = { ts: 't', source: 'hook' as const, sessionId: 's1', hookEvent: 'PostToolUse', toolUseId: 'tu1', payloadJson: '{}' }
    expect(s.insertEvent({ ...base, dedupeKey: 's1|tu1|PostToolUse' }).inserted).toBe(true)
    expect(s.insertEvent({ ...base, dedupeKey: 's1|tu1|PostToolUse' }).inserted).toBe(false)
    expect(s.insertEvent({ ...base, dedupeKey: null }).inserted).toBe(true)
    expect(s.insertEvent({ ...base, dedupeKey: null }).inserted).toBe(true)
    expect(s.countEvents('s1')).toBe(3)
  })

  it('prunes raw events per session, keeping the newest', () => {
    const s = memStore()
    for (let i = 0; i < 30; i++) s.insertEvent({ ts: String(i), source: 'hook', sessionId: 'a', hookEvent: 'X', toolUseId: null, payloadJson: `{"i":${i}}`, dedupeKey: null })
    for (let i = 0; i < 5; i++) s.insertEvent({ ts: String(i), source: 'hook', sessionId: 'b', hookEvent: 'X', toolUseId: null, payloadJson: '{}', dedupeKey: null })
    expect(s.pruneEvents('a', 10)).toBe(20)
    expect(s.countEvents('a')).toBe(10)
    expect(s.countEvents('b')).toBe(5)
    expect(JSON.parse(s.listEvents('a', 1)[0]!.payloadJson)).toEqual({ i: 29 })
    expect(s.pruneEvents('a', 10)).toBe(0)
  })

  it('round-trips a session with its agent tree and cascades deletes', () => {
    const s = memStore()
    s.upsertProject(project)
    s.upsertSession(session({ branch: 'main', summary: 'sum', relatedNotes: ['a.md'], error: 'e', currentTool: 'Bash' }))
    const back = s.getSession('s1')!
    expect(back.agents.map((a) => a.id)).toEqual(['main', 'a1'])
    expect(back.agents[1]).toMatchObject({ parentId: 'main', type: 'Explore', description: 'look' })
    expect(back).toMatchObject({ branch: 'main', summary: 'sum', relatedNotes: ['a.md'], error: 'e', currentTool: 'Bash' })

    s.upsertSession(session({ status: 'done', agents: [{ id: 'main', parentId: null, type: 'main', status: 'done', lastMessage: '' }] }))
    expect(s.getSession('s1')!.agents).toHaveLength(1)
    expect(s.countSessions()).toBe(1)

    s.insertAgentEvent({ id: 'e1', ts: 't', sessionId: 's1', hookEvent: 'Stop', summary: 'x', level: 'info' })
    expect(s.countAgentEvents()).toBe(1)
    expect(s.deleteSession('s1')).toBe(true)
    expect(s.countAgentEvents()).toBe(0)
    expect(s.getSession('s1')).toBeUndefined()
  })

  it('enforces foreign keys: a session needs its project, an event needs its session', () => {
    const s = memStore()
    expect(() => s.upsertSession(session())).toThrow()
    s.upsertProject(project)
    expect(() => s.insertAgentEvent({ id: 'e', ts: 't', sessionId: 'nope', hookEvent: 'Stop', summary: 'x', level: 'info' })).toThrow()
  })

  it('prunes projected agent events per session and old finished sessions', () => {
    const s = memStore()
    s.upsertProject(project)
    s.upsertSession(session())
    for (let i = 0; i < 20; i++) s.insertAgentEvent({ id: `e${i}`, ts: String(i), sessionId: 's1', hookEvent: 'PostToolUse', summary: `s${i}`, level: 'info' })
    s.pruneAgentEvents('s1', 5)
    expect(s.countAgentEvents('s1')).toBe(5)
    expect(s.listAgentEvents(10)[0]!.id).toBe('e19') // newest first

    s.upsertSession(session({ id: 'old', status: 'done', updatedAt: '2020-01-01T00:00:00.000Z' }))
    s.upsertSession(session({ id: 'old-running', status: 'running', updatedAt: '2020-01-01T00:00:00.000Z' }))
    expect(s.deleteSessionsBefore('2021-01-01T00:00:00.000Z')).toEqual(['old'])
    expect(s.getSession('old-running')).toBeDefined()
    expect(s.pruneSessions(1)).toEqual([]) // only running sessions left over the cap: nothing finished to drop
  })

  it('handles tasks, approvals, chat, audit, kv and usage', () => {
    const s = memStore()
    const task: Task = { id: 't1', title: 'A', column: 'todo', priority: 'medium', sessionIds: ['x'], source: 'manual' }
    s.insertTask(task, 'now')
    s.insertTask({ ...task, id: 't2', title: 'B', projectId: 'p1', prUrl: 'u' }, 'now')
    expect(s.listTasks().map((t) => t.id)).toEqual(['t1', 't2'])
    expect(s.updateTask({ ...task, column: 'done', branch: 'b' }, 'later')).toBe(true)
    expect(s.getTask('t1')).toMatchObject({ column: 'done', branch: 'b', sessionIds: ['x'] })
    expect(s.deleteTask('t2')).toBe(true)
    expect(s.deleteTask('t2')).toBe(false)

    const ap: Approval = { id: 'a1', kind: 'tool_permission', title: 't', detail: 'd', requestedAt: 'r', status: 'pending', risk: 'low', tier: 'T4', area: 'work', sessionId: 's1', refId: 'ref' }
    s.upsertApproval(ap, 'hook')
    expect(s.getApproval('a1')).toMatchObject({ origin: 'hook', approval: { status: 'pending', refId: 'ref' } })
    expect(s.pendingApprovalsForSession('s1')).toHaveLength(1)
    expect(s.pendingApprovalsByRef('ref')).toHaveLength(1)
    s.setApprovalStatus('a1', 'approved', 'when')
    expect(s.pendingApprovalsForSession('s1')).toHaveLength(0)
    expect(s.listApprovals()[0]!.status).toBe('approved')

    const m: ChatMessage = { id: 'c1', role: 'user', createdAt: 'x', modality: 'text', parts: [{ type: 'text', text: 'hi' }] }
    s.upsertChat(m)
    s.upsertChat({ id: 'c2', role: 'assistant', createdAt: 'y', modality: 'text', parts: [] })
    s.upsertChat({ ...m, parts: [{ type: 'text', text: 'edited' }] }) // replace by id keeps its place
    expect(s.recentChat(10).map((c) => c.id)).toEqual(['c1', 'c2'])
    expect(s.recentChat(10)[0]!.parts).toEqual([{ type: 'text', text: 'edited' }])
    expect(s.recentChat(1).map((c) => c.id)).toEqual(['c2'])

    s.insertAudit({ id: 'au1', at: '1', actor: 'you', action: 'a', target: 't', outcome: 'auto', sensitive: true, detail: 'd' })
    s.insertAudit({ id: 'au2', at: '2', actor: 'mira', action: 'b', target: 't', outcome: 'blocked' })
    expect(s.listAudit(10).map((a) => a.id)).toEqual(['au2', 'au1'])
    expect(s.listAudit(10)[1]).toMatchObject({ sensitive: true, detail: 'd' })

    expect(s.kvGet('missing')).toBeUndefined()
    s.kvSet('k', { a: [1, 2] })
    s.kvSet('k', { a: [3] })
    expect(s.kvGet('k')).toEqual({ a: [3] })
    s.kvDelete('k')
    expect(s.kvGet('k')).toBeUndefined()

    s.addUsage('2026-11-02', 'secretary', 'm1', 0.5)
    s.addUsage('2026-11-02', 'secretary', 'm1', 0.25)
    s.addUsage('2026-11-01', 'secretary', 'm1', 1)
    expect(s.listUsage('2026-11-02')).toEqual([{ day: '2026-11-02', lane: 'secretary', model: 'm1', costUsd: 0.75 }])
    expect(s.listUsage('2026-11-01')).toHaveLength(2)
  })

  it('keeps projects and finds lane sessions', () => {
    const s = memStore()
    s.upsertProject(project)
    s.upsertProject({ ...project, name: 'renamed' })
    expect(s.listProjects()).toHaveLength(1)
    expect(s.getProject('p1')?.name).toBe('renamed')
    expect(s.addLaneSession('x', 'secretary', 't')).toBe(true)
    expect(s.addLaneSession('x', 'secretary', 't')).toBe(false)
    expect(s.isLaneSession('x')).toBe(true)
    expect(s.isLaneSession('y')).toBe(false)
    expect(s.listLaneSessionIds()).toEqual(['x'])
  })

  it('backs up through the SQLite backup API into a readable, independent copy', async () => {
    const tmp = makeTmp()
    cleanups.push(tmp.cleanup)
    const s = openStore({ file: join(tmp.dir, 'app.db') })
    cleanups.push(() => s.close())
    s.kvSet('hello', 'world')
    s.insertAudit({ id: 'au1', at: '1', actor: 'you', action: 'a', target: 't', outcome: 'auto' })
    const dest = join(tmp.dir, 'backups', 'copy.db')
    await s.backup(dest)
    expect(existsSync(dest)).toBe(true)
    s.kvSet('after', 'backup')
    const copy = openStore({ file: dest })
    cleanups.push(() => copy.close())
    expect(copy.kvGet('hello')).toBe('world')
    expect(copy.kvGet('after')).toBeUndefined()
    expect(copy.countAudit()).toBe(1)
  })

  it('redacts before persisting: a stored event contains no secret', () => {
    const s = memStore()
    const r = redactHookPayload({ session_id: 's1', tool_input: { command: 'export API_KEY=sk-ant-api03-SUPERSECRET0000' } })
    s.insertEvent({ ts: 't', source: 'hook', sessionId: 's1', hookEvent: 'PostToolUse', toolUseId: null, payloadJson: r.json, dedupeKey: null })
    expect(s.listEvents('s1', 5)[0]!.payloadJson).not.toContain('SUPERSECRET')
  })
})

describe('LaneStore on SQLite', () => {
  it('persists backend session ids, chat, approvals and audit, and reports owned sessions', () => {
    const s = memStore()
    const owned: string[] = []
    const ls = createLaneStore(s, { now: () => new Date('2026-11-02T10:00:00Z'), newId: createIdGen(), onOwnedSession: (id) => owned.push(id) })
    expect(ls.loadBackendSessionId('secretary')).toBeUndefined()
    ls.saveBackendSessionId('secretary', 'sdk-1')
    expect(ls.loadBackendSessionId('secretary')).toBe('sdk-1')
    expect(owned).toEqual(['sdk-1'])
    expect(s.isLaneSession('sdk-1')).toBe(true)

    ls.upsertChat({ id: 'c', role: 'assistant', createdAt: 'x', modality: 'text', parts: [{ type: 'text', text: 'yo' }] })
    expect(ls.recentChat(5)).toHaveLength(1)

    ls.saveApproval({ id: 'ap', kind: 'tool_permission', title: 't', detail: 'd', requestedAt: 'r', status: 'pending', risk: 'low', tier: 'T4', area: 'work' })
    expect(s.getApproval('ap')?.origin).toBe('lane')
    ls.setApprovalStatus('ap', 'denied')
    expect(s.getApproval('ap')?.approval.status).toBe('denied')

    ls.audit({ at: 'a', actor: 'mira', action: 'x', target: 'y', outcome: 'auto' })
    const a = s.listAudit(5)[0]!
    expect(a.id).toMatch(/^au-/)
  })

  it('persists lane spend through the recording budget and replays today on restart', () => {
    const s = memStore()
    const now = () => new Date('2026-11-02T10:00:00')
    const models = { secretary: 'claude-sonnet-5-5', reader: 'claude-haiku-5-5', voice: 'claude-haiku-5-5' }
    const first = createRecordingBudget(createTestBudget(), s, { now, laneModels: models })
    first.record('secretary', 0.4)
    first.record('secretary', 0.1)
    first.record('secretary', 0) // ignored
    first.record('secretary', Number.NaN) // ignored
    expect(s.listUsage('2026-11-02')).toEqual([{ day: '2026-11-02', lane: 'secretary', model: 'claude-sonnet-5-5', costUsd: 0.5 }])

    const inner = createTestBudget()
    hydrateBudget(inner, s, now())
    expect(inner.status().lanes.find((l) => l.lane === 'secretary')!.spentTodayUsd).toBeCloseTo(0.5)
    // Hydration must not write usage again.
    expect(s.listUsage('2026-11-02')[0]!.costUsd).toBe(0.5)
    // Yesterday's spend is not replayed.
    s.addUsage('2026-11-01', 'secretary', 'claude-sonnet-5-5', 3)
    const next = createTestBudget()
    hydrateBudget(next, s, now())
    expect(next.status().lanes.find((l) => l.lane === 'secretary')!.spentTodayUsd).toBeCloseTo(0.5)
  })
})
