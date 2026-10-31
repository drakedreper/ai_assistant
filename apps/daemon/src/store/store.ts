import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import type { AgentEvent, AgentNode, Approval, AuditEntry, ChatMessage, LaneId, Project, Session, Task } from '@ai-assistant/shared'
import { LATEST_VERSION, migrate } from './migrations'

/** Where an approval came from; it decides how a decision is routed. */
export type ApprovalOrigin = 'lane' | 'hook' | 'demo' | 'local'

export interface RawEventInput {
  ts: string
  source: 'hook' | 'lane' | 'sdk' | 'roster' | 'import'
  sessionId: string | null
  hookEvent: string
  toolUseId: string | null
  /** Already redacted. */
  payloadJson: string
  dedupeKey: string | null
}

export interface RawEventRow {
  id: number
  ts: string
  source: string
  sessionId: string | null
  hookEvent: string
  toolUseId: string | null
  payloadJson: string
  dedupeKey: string | null
}

export interface UsageRow {
  day: string
  lane: string
  model: string
  costUsd: number
}

export interface OpenStoreOptions {
  /** ':memory:' for tests. */
  file: string
  /** Defaults to 5000 ms. */
  busyTimeoutMs?: number
}

type Row = Record<string, unknown>

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string') return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : String(v ?? ''))
const optStr = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined)

/**
 * The only module that contains SQL. A thin repository layer over better-sqlite3: callers deal in the
 * shared domain types and never see a statement. Synchronous by design (better-sqlite3 is).
 */
export class Store {
  readonly db: Database.Database
  private readonly cache = new Map<string, Database.Statement>()

  constructor(db: Database.Database) {
    this.db = db
  }

  private st(sql: string): Database.Statement {
    let s = this.cache.get(sql)
    if (!s) {
      s = this.db.prepare(sql)
      this.cache.set(sql, s)
    }
    return s
  }

  tx<T>(fn: () => T): T {
    return this.db.transaction(fn)()
  }

  schemaVersion(): number {
    return Number(this.db.pragma('user_version', { simple: true }))
  }

  /** Consistent online copy through the SQLite backup API. Never copy the file under WAL. */
  async backup(destFile: string): Promise<void> {
    mkdirSync(dirname(destFile), { recursive: true })
    await this.db.backup(destFile)
  }

  close(): void {
    this.cache.clear()
    if (this.db.open) this.db.close()
  }

  // ---------------------------------------------------------------- raw events

  insertEvent(e: RawEventInput): { inserted: boolean; id: number } {
    const r = this.st(
      `INSERT OR IGNORE INTO events (ts, source, session_id, hook_event, tool_use_id, payload_json, dedupe_key)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(e.ts, e.source, e.sessionId, e.hookEvent, e.toolUseId, e.payloadJson, e.dedupeKey)
    return { inserted: r.changes > 0, id: Number(r.lastInsertRowid) }
  }

  countEvents(sessionId?: string): number {
    const row = (sessionId
      ? this.st('SELECT COUNT(*) AS n FROM events WHERE session_id = ?').get(sessionId)
      : this.st('SELECT COUNT(*) AS n FROM events').get()) as { n: number }
    return row.n
  }

  listEvents(sessionId: string | null, limit: number): RawEventRow[] {
    const rows = (sessionId === null
      ? this.st('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit)
      : this.st('SELECT * FROM events WHERE session_id = ? ORDER BY id DESC LIMIT ?').all(sessionId, limit)) as Row[]
    return rows.map((r) => ({
      id: Number(r.id),
      ts: str(r.ts),
      source: str(r.source),
      sessionId: (r.session_id as string | null) ?? null,
      hookEvent: str(r.hook_event),
      toolUseId: (r.tool_use_id as string | null) ?? null,
      payloadJson: str(r.payload_json),
      dedupeKey: (r.dedupe_key as string | null) ?? null,
    }))
  }

  /** Keep only the newest `keep` raw events of a session. */
  pruneEvents(sessionId: string, keep: number): number {
    return this.st(
      `DELETE FROM events WHERE session_id = ? AND id <= COALESCE(
         (SELECT id FROM events WHERE session_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?), 0)`,
    ).run(sessionId, sessionId, keep).changes
  }

  deleteEventsBefore(iso: string): number {
    return this.st('DELETE FROM events WHERE ts < ?').run(iso).changes
  }

  // ---------------------------------------------------------------- agent events (projection)

  insertAgentEvent(e: AgentEvent): void {
    this.st(
      `INSERT OR REPLACE INTO agent_events (id, ts, session_id, agent_id, hook_event, tool_name, summary, level)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(e.id, e.ts, e.sessionId, e.agentId ?? null, e.hookEvent, e.toolName ?? null, e.summary, e.level)
  }

  /** Newest first. */
  listAgentEvents(limit: number): AgentEvent[] {
    const rows = this.st('SELECT * FROM agent_events ORDER BY ord DESC LIMIT ?').all(limit) as Row[]
    return rows.map((r) => ({
      id: str(r.id),
      ts: str(r.ts),
      sessionId: str(r.session_id),
      ...(optStr(r.agent_id) ? { agentId: str(r.agent_id) } : {}),
      hookEvent: str(r.hook_event),
      ...(optStr(r.tool_name) ? { toolName: str(r.tool_name) } : {}),
      summary: str(r.summary),
      level: (['info', 'warn', 'error'].includes(str(r.level)) ? str(r.level) : 'info') as AgentEvent['level'],
    }))
  }

  pruneAgentEvents(sessionId: string, keep: number): number {
    return this.st(
      `DELETE FROM agent_events WHERE session_id = ? AND ord <= COALESCE(
         (SELECT ord FROM agent_events WHERE session_id = ? ORDER BY ord DESC LIMIT 1 OFFSET ?), 0)`,
    ).run(sessionId, sessionId, keep).changes
  }

  countAgentEvents(sessionId?: string): number {
    const row = (sessionId
      ? this.st('SELECT COUNT(*) AS n FROM agent_events WHERE session_id = ?').get(sessionId)
      : this.st('SELECT COUNT(*) AS n FROM agent_events').get()) as { n: number }
    return row.n
  }

  // ---------------------------------------------------------------- projects

  upsertProject(p: Project): void {
    this.st(
      `INSERT INTO projects (id, name, root_path, status, tags_json, color, hub_note)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, root_path = excluded.root_path, status = excluded.status,
         tags_json = excluded.tags_json, color = excluded.color, hub_note = excluded.hub_note`,
    ).run(p.id, p.name, p.rootPath, p.status, JSON.stringify(p.tags), p.color, p.hubNote ?? null)
  }

  getProject(id: string): Project | undefined {
    const r = this.st('SELECT * FROM projects WHERE id = ?').get(id) as Row | undefined
    return r ? this.rowToProject(r) : undefined
  }

  listProjects(): Project[] {
    return (this.st('SELECT * FROM projects ORDER BY name COLLATE NOCASE').all() as Row[]).map((r) => this.rowToProject(r))
  }

  private rowToProject(r: Row): Project {
    return {
      id: str(r.id),
      name: str(r.name),
      rootPath: str(r.root_path),
      status: str(r.status) as Project['status'],
      tags: parseJson<string[]>(r.tags_json, []),
      color: str(r.color),
      ...(optStr(r.hub_note) ? { hubNote: str(r.hub_note) } : {}),
    }
  }

  // ---------------------------------------------------------------- sessions and agents

  upsertSession(s: Session): void {
    this.tx(() => {
      this.st(
        `INSERT INTO sessions (id, project_id, title, source, kind, status, model, cwd, branch, started_at, updated_at,
           current_tool, cost_usd, context_pct, summary, related_notes_json, error)
         VALUES (@id, @projectId, @title, @source, @kind, @status, @model, @cwd, @branch, @startedAt, @updatedAt,
           @currentTool, @costUsd, @contextPct, @summary, @relatedNotes, @error)
         ON CONFLICT(id) DO UPDATE SET project_id = excluded.project_id, title = excluded.title, source = excluded.source,
           kind = excluded.kind, status = excluded.status, model = excluded.model, cwd = excluded.cwd, branch = excluded.branch,
           updated_at = excluded.updated_at, current_tool = excluded.current_tool, cost_usd = excluded.cost_usd,
           context_pct = excluded.context_pct, summary = excluded.summary, related_notes_json = excluded.related_notes_json,
           error = excluded.error`,
      ).run({
        id: s.id,
        projectId: s.projectId,
        title: s.title,
        source: s.source,
        kind: s.kind,
        status: s.status,
        model: s.model,
        cwd: s.cwd,
        branch: s.branch ?? null,
        startedAt: s.startedAt,
        updatedAt: s.updatedAt,
        currentTool: s.currentTool ?? null,
        costUsd: s.costUsd,
        contextPct: s.contextPct,
        summary: s.summary ?? null,
        relatedNotes: s.relatedNotes ? JSON.stringify(s.relatedNotes) : null,
        error: s.error ?? null,
      })
      this.st('DELETE FROM agents WHERE session_id = ?').run(s.id)
      const ins = this.st(
        `INSERT INTO agents (session_id, id, ord, parent_id, type, status, last_message, description, current_tool)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      s.agents.forEach((a, i) => ins.run(s.id, a.id, i, a.parentId, a.type, a.status, a.lastMessage, a.description ?? null, a.currentTool ?? null))
    })
  }

  private rowToSession(r: Row, agents: AgentNode[]): Session {
    return {
      id: str(r.id),
      projectId: str(r.project_id),
      title: str(r.title),
      source: str(r.source) as Session['source'],
      kind: str(r.kind) as Session['kind'],
      status: str(r.status) as Session['status'],
      model: str(r.model),
      cwd: str(r.cwd),
      ...(optStr(r.branch) ? { branch: str(r.branch) } : {}),
      startedAt: str(r.started_at),
      updatedAt: str(r.updated_at),
      ...(optStr(r.current_tool) ? { currentTool: str(r.current_tool) } : {}),
      costUsd: Number(r.cost_usd ?? 0),
      contextPct: Number(r.context_pct ?? 0),
      agents,
      ...(optStr(r.summary) ? { summary: str(r.summary) } : {}),
      ...(typeof r.related_notes_json === 'string' ? { relatedNotes: parseJson<string[]>(r.related_notes_json, []) } : {}),
      ...(optStr(r.error) ? { error: str(r.error) } : {}),
    }
  }

  private agentsBySession(sessionId?: string): Map<string, AgentNode[]> {
    const rows = (sessionId
      ? this.st('SELECT * FROM agents WHERE session_id = ? ORDER BY ord').all(sessionId)
      : this.st('SELECT * FROM agents ORDER BY session_id, ord').all()) as Row[]
    const map = new Map<string, AgentNode[]>()
    for (const r of rows) {
      const node: AgentNode = {
        id: str(r.id),
        parentId: typeof r.parent_id === 'string' ? r.parent_id : null,
        type: str(r.type),
        status: str(r.status) as AgentNode['status'],
        lastMessage: str(r.last_message),
        ...(optStr(r.description) ? { description: str(r.description) } : {}),
        ...(optStr(r.current_tool) ? { currentTool: str(r.current_tool) } : {}),
      }
      const list = map.get(str(r.session_id)) ?? []
      list.push(node)
      map.set(str(r.session_id), list)
    }
    return map
  }

  getSession(id: string): Session | undefined {
    const r = this.st('SELECT * FROM sessions WHERE id = ?').get(id) as Row | undefined
    if (!r) return undefined
    return this.rowToSession(r, this.agentsBySession(id).get(id) ?? [])
  }

  /** Most recently updated first. */
  listSessions(): Session[] {
    const rows = this.st('SELECT * FROM sessions ORDER BY updated_at DESC, id').all() as Row[]
    const agents = this.agentsBySession()
    return rows.map((r) => this.rowToSession(r, agents.get(str(r.id)) ?? []))
  }

  countSessions(): number {
    return (this.st('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n
  }

  deleteSession(id: string): boolean {
    return this.st('DELETE FROM sessions WHERE id = ?').run(id).changes > 0
  }

  /** Delete finished sessions (never running or blocked ones) last updated before `iso`. Cascades to agents and events. */
  deleteSessionsBefore(iso: string): string[] {
    const ids = (this.st(
      `SELECT id FROM sessions WHERE updated_at < ? AND status IN ('done', 'error', 'stale', 'idle')`,
    ).all(iso) as Array<{ id: string }>).map((r) => r.id)
    for (const id of ids) this.st('DELETE FROM sessions WHERE id = ?').run(id)
    return ids
  }

  /** Keep at most `keep` sessions, dropping the oldest finished ones first. */
  pruneSessions(keep: number): string[] {
    const over = this.countSessions() - keep
    if (over <= 0) return []
    const ids = (this.st(
      `SELECT id FROM sessions WHERE status IN ('done', 'error', 'stale', 'idle') ORDER BY updated_at ASC LIMIT ?`,
    ).all(over) as Array<{ id: string }>).map((r) => r.id)
    for (const id of ids) this.st('DELETE FROM sessions WHERE id = ?').run(id)
    return ids
  }

  // ---------------------------------------------------------------- tasks

  private nextOrd(table: 'tasks' | 'approvals'): number {
    const row = this.st(`SELECT COALESCE(MAX(ord), 0) + 1 AS n FROM ${table}`).get() as { n: number }
    return row.n
  }

  insertTask(t: Task, updatedAt: string): void {
    this.st(
      `INSERT INTO tasks (id, ord, project_id, title, description, col, priority, session_ids_json, source, branch, pr_url, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      t.id,
      this.nextOrd('tasks'),
      t.projectId ?? null,
      t.title,
      t.description ?? null,
      t.column,
      t.priority,
      JSON.stringify(t.sessionIds),
      t.source,
      t.branch ?? null,
      t.prUrl ?? null,
      updatedAt,
    )
  }

  updateTask(t: Task, updatedAt: string): boolean {
    return (
      this.st(
        `UPDATE tasks SET project_id = ?, title = ?, description = ?, col = ?, priority = ?, session_ids_json = ?,
           source = ?, branch = ?, pr_url = ?, updated_at = ? WHERE id = ?`,
      ).run(
        t.projectId ?? null,
        t.title,
        t.description ?? null,
        t.column,
        t.priority,
        JSON.stringify(t.sessionIds),
        t.source,
        t.branch ?? null,
        t.prUrl ?? null,
        updatedAt,
        t.id,
      ).changes > 0
    )
  }

  deleteTask(id: string): boolean {
    return this.st('DELETE FROM tasks WHERE id = ?').run(id).changes > 0
  }

  private rowToTask(r: Row): Task {
    return {
      id: str(r.id),
      ...(optStr(r.project_id) ? { projectId: str(r.project_id) } : {}),
      title: str(r.title),
      ...(optStr(r.description) ? { description: str(r.description) } : {}),
      column: str(r.col) as Task['column'],
      priority: str(r.priority) as Task['priority'],
      sessionIds: parseJson<string[]>(r.session_ids_json, []),
      source: str(r.source) as Task['source'],
      ...(optStr(r.branch) ? { branch: str(r.branch) } : {}),
      ...(optStr(r.pr_url) ? { prUrl: str(r.pr_url) } : {}),
    }
  }

  getTask(id: string): Task | undefined {
    const r = this.st('SELECT * FROM tasks WHERE id = ?').get(id) as Row | undefined
    return r ? this.rowToTask(r) : undefined
  }

  listTasks(): Task[] {
    return (this.st('SELECT * FROM tasks ORDER BY ord').all() as Row[]).map((r) => this.rowToTask(r))
  }

  // ---------------------------------------------------------------- approvals

  upsertApproval(a: Approval, origin: ApprovalOrigin): void {
    this.st(
      `INSERT INTO approvals (id, ord, kind, title, detail, requested_at, session_id, status, risk, tier, preview, area, ref_id, origin)
       VALUES (@id, @ord, @kind, @title, @detail, @requestedAt, @sessionId, @status, @risk, @tier, @preview, @area, @refId, @origin)
       ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, title = excluded.title, detail = excluded.detail,
         requested_at = excluded.requested_at, session_id = excluded.session_id, status = excluded.status, risk = excluded.risk,
         tier = excluded.tier, preview = excluded.preview, area = excluded.area, ref_id = excluded.ref_id`,
    ).run({
      id: a.id,
      ord: this.nextOrd('approvals'),
      kind: a.kind,
      title: a.title,
      detail: a.detail,
      requestedAt: a.requestedAt,
      sessionId: a.sessionId ?? null,
      status: a.status,
      risk: a.risk,
      tier: a.tier,
      preview: a.preview ?? null,
      area: a.area,
      refId: a.refId ?? null,
      origin,
    })
  }

  setApprovalStatus(id: string, status: Approval['status'], decidedAt?: string): boolean {
    return this.st('UPDATE approvals SET status = ?, decided_at = ? WHERE id = ?').run(status, decidedAt ?? null, id).changes > 0
  }

  private rowToApproval(r: Row): Approval {
    return {
      id: str(r.id),
      kind: str(r.kind) as Approval['kind'],
      title: str(r.title),
      detail: str(r.detail),
      requestedAt: str(r.requested_at),
      ...(optStr(r.session_id) ? { sessionId: str(r.session_id) } : {}),
      status: str(r.status) as Approval['status'],
      risk: str(r.risk) as Approval['risk'],
      tier: str(r.tier) as Approval['tier'],
      ...(optStr(r.preview) ? { preview: str(r.preview) } : {}),
      area: str(r.area) as Approval['area'],
      ...(optStr(r.ref_id) ? { refId: str(r.ref_id) } : {}),
    }
  }

  getApproval(id: string): { approval: Approval; origin: ApprovalOrigin } | undefined {
    const r = this.st('SELECT * FROM approvals WHERE id = ?').get(id) as Row | undefined
    return r ? { approval: this.rowToApproval(r), origin: str(r.origin) as ApprovalOrigin } : undefined
  }

  /** Oldest first, limited to the newest `limit`. */
  listApprovals(limit = 200): Approval[] {
    const rows = this.st('SELECT * FROM (SELECT * FROM approvals ORDER BY ord DESC LIMIT ?) ORDER BY ord ASC').all(limit) as Row[]
    return rows.map((r) => this.rowToApproval(r))
  }

  pendingApprovalsForSession(sessionId: string): Array<{ approval: Approval; origin: ApprovalOrigin }> {
    const rows = this.st(`SELECT * FROM approvals WHERE session_id = ? AND status = 'pending' ORDER BY ord`).all(sessionId) as Row[]
    return rows.map((r) => ({ approval: this.rowToApproval(r), origin: str(r.origin) as ApprovalOrigin }))
  }

  pendingApprovalsByRef(refId: string): Approval[] {
    const rows = this.st(`SELECT * FROM approvals WHERE ref_id = ? AND status = 'pending' ORDER BY ord`).all(refId) as Row[]
    return rows.map((r) => this.rowToApproval(r))
  }

  // ---------------------------------------------------------------- chat

  upsertChat(m: ChatMessage): void {
    this.st(
      `INSERT INTO chat_messages (id, role, created_at, modality, parts_json) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET role = excluded.role, created_at = excluded.created_at,
         modality = excluded.modality, parts_json = excluded.parts_json`,
    ).run(m.id, m.role, m.createdAt, m.modality, JSON.stringify(m.parts))
  }

  /** Oldest first, the newest `limit` messages. */
  recentChat(limit: number): ChatMessage[] {
    const rows = this.st('SELECT * FROM (SELECT * FROM chat_messages ORDER BY ord DESC LIMIT ?) ORDER BY ord ASC').all(limit) as Row[]
    return rows.map((r) => ({
      id: str(r.id),
      role: str(r.role) as ChatMessage['role'],
      createdAt: str(r.created_at),
      modality: str(r.modality) as ChatMessage['modality'],
      parts: parseJson<ChatMessage['parts']>(r.parts_json, []),
    }))
  }

  countChat(): number {
    return (this.st('SELECT COUNT(*) AS n FROM chat_messages').get() as { n: number }).n
  }

  // ---------------------------------------------------------------- audit

  insertAudit(e: AuditEntry): void {
    this.st(
      `INSERT OR REPLACE INTO audit (id, at, actor, action, target, outcome, sent_to_cloud, detail, sensitive)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(e.id, e.at, e.actor, e.action, e.target, e.outcome, e.sentToCloud ?? null, e.detail ?? null, e.sensitive ? 1 : 0)
  }

  /** Newest first. */
  listAudit(limit: number): AuditEntry[] {
    const rows = this.st('SELECT * FROM audit ORDER BY ord DESC LIMIT ?').all(limit) as Row[]
    return rows.map((r) => ({
      id: str(r.id),
      at: str(r.at),
      actor: str(r.actor) as AuditEntry['actor'],
      action: str(r.action),
      target: str(r.target),
      outcome: str(r.outcome) as AuditEntry['outcome'],
      ...(optStr(r.sent_to_cloud) ? { sentToCloud: str(r.sent_to_cloud) } : {}),
      ...(optStr(r.detail) ? { detail: str(r.detail) } : {}),
      ...(Number(r.sensitive) === 1 ? { sensitive: true } : {}),
    }))
  }

  countAudit(): number {
    return (this.st('SELECT COUNT(*) AS n FROM audit').get() as { n: number }).n
  }

  // ---------------------------------------------------------------- kv

  kvGet<T>(key: string): T | undefined {
    const r = this.st('SELECT value_json FROM kv WHERE key = ?').get(key) as { value_json: string } | undefined
    if (!r) return undefined
    try {
      return JSON.parse(r.value_json) as T
    } catch {
      return undefined
    }
  }

  kvSet(key: string, value: unknown, updatedAt: string = new Date().toISOString()): void {
    this.st(
      `INSERT INTO kv (key, value_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    ).run(key, JSON.stringify(value), updatedAt)
  }

  kvDelete(key: string): void {
    this.st('DELETE FROM kv WHERE key = ?').run(key)
  }

  // ---------------------------------------------------------------- usage (lane spend, API-equivalent estimate)

  addUsage(day: string, lane: LaneId, model: string, costUsd: number): void {
    this.st(
      `INSERT INTO usage (day, lane, model, cost_usd) VALUES (?, ?, ?, ?)
       ON CONFLICT(day, lane, model) DO UPDATE SET cost_usd = cost_usd + excluded.cost_usd`,
    ).run(day, lane, model, costUsd)
  }

  listUsage(sinceDay: string): UsageRow[] {
    const rows = this.st('SELECT * FROM usage WHERE day >= ? ORDER BY day, lane, model').all(sinceDay) as Row[]
    return rows.map((r) => ({ day: str(r.day), lane: str(r.lane), model: str(r.model), costUsd: Number(r.cost_usd) }))
  }

  // ---------------------------------------------------------------- lane-owned backend sessions

  addLaneSession(sessionId: string, lane: LaneId, createdAt: string): boolean {
    return this.st('INSERT OR IGNORE INTO lane_sessions (session_id, lane, created_at) VALUES (?, ?, ?)').run(sessionId, lane, createdAt).changes > 0
  }

  isLaneSession(sessionId: string): boolean {
    return this.st('SELECT 1 AS x FROM lane_sessions WHERE session_id = ?').get(sessionId) !== undefined
  }

  listLaneSessionIds(): string[] {
    return (this.st('SELECT session_id FROM lane_sessions').all() as Array<{ session_id: string }>).map((r) => r.session_id)
  }
}

/** Open (creating if needed) the operations database, apply pragmas, and run migrations. */
export function openStore(opts: OpenStoreOptions): Store {
  if (opts.file !== ':memory:') mkdirSync(dirname(opts.file), { recursive: true })
  const db = new Database(opts.file)
  try {
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    db.pragma(`busy_timeout = ${Math.trunc(opts.busyTimeoutMs ?? 5000)}`)
    db.pragma('synchronous = NORMAL')
    migrate(db)
  } catch (err) {
    db.close()
    throw err
  }
  return new Store(db)
}

export { LATEST_VERSION }
