import type { AgentEvent, AgentNode, Approval, HookPayload, ServerEventDraft, Session, SessionStatus } from '@ai-assistant/shared'
import type { IdGen } from '../ids'
import type { Logger } from '../log'
import type { Store } from '../store'
import { redactText } from '../store/redact'
import { pathApiFor, type ProjectResolver } from './projects'

export interface ProjectionConfig {
  /** `running` sessions with no event for this long become stale. */
  staleRunningMs: number
  /** idle / waiting_input / blocked_permission sessions with no event for this long become stale. */
  staleIdleMs: number
  /** Projected AgentEvents kept per session. */
  eventsPerSession: number
  maxSessions: number
  maxAgentsPerSession: number
  /** Sessions finished longer ago than this are deleted by sweep(). */
  retentionMs: number
}

export const DEFAULT_PROJECTION_CONFIG: ProjectionConfig = {
  staleRunningMs: 10 * 60_000,
  staleIdleMs: 6 * 3_600_000,
  eventsPerSession: 200,
  maxSessions: 300,
  maxAgentsPerSession: 64,
  retentionMs: 30 * 24 * 3_600_000,
}

export interface ProjectionDeps {
  store: Store
  publish: (draft: ServerEventDraft) => void
  /** A new project appeared: there is no project event in the contract, so the app pushes a snapshot.reset. */
  announceProjectsChanged: () => void
  resolver: ProjectResolver
  clock: () => number
  newId: IdGen
  config: ProjectionConfig
  /** Exact secrets of the daemon, masked out of every summary. */
  literals?: () => string[]
  log: Logger
  /** Session ids the staleness sweep must leave alone (demo fixtures). */
  protectedIds?: Set<string>
}

/** The hook events this projection understands. Everything else is stored raw and ignored here. */
export const PROJECTED_EVENTS = new Set([
  'SessionStart',
  'UserPromptSubmit',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Notification',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'StopFailure',
  'SessionEnd',
])

const MAIN = 'main'
const DEFAULT_TITLE_PREFIX = 'Claude Code in '

const FILE_TOOLS_WRITE = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

/** First non-empty line, whitespace collapsed, masked and cut to `max`. */
export function oneLine(text: unknown, max: number, literals: readonly string[] = []): string {
  if (typeof text !== 'string') return ''
  const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? ''
  return redactText(line.replace(/\s+/g, ' '), max, literals)
}

const rec = (v: unknown): Record<string, unknown> => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const s = (v: unknown): string => (typeof v === 'string' ? v : '')

/** A short human summary of a tool call, built from tool_input. Never includes file contents. */
export function summarizeTool(tool: string | undefined, input: unknown, literals: readonly string[] = []): string {
  const name = tool ?? 'tool'
  const i = rec(input)
  const cut = (t: string, n = 140) => oneLine(t, n, literals)
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return s(i.command) ? `Ran ${cut(s(i.command))}` : `Ran a ${name} command`
    case 'Write':
      return s(i.file_path) ? `Wrote ${cut(s(i.file_path))}` : 'Wrote a file'
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return s(i.file_path ?? i.notebook_path) ? `Edited ${cut(s(i.file_path ?? i.notebook_path))}` : 'Edited a file'
    case 'Read':
      return s(i.file_path) ? `Read ${cut(s(i.file_path))}` : 'Read a file'
    case 'Grep':
    case 'Glob':
      return s(i.pattern) ? `Searched "${cut(s(i.pattern), 80)}"` : `Used ${name}`
    case 'WebFetch':
      return s(i.url) ? `Fetched ${cut(s(i.url))}` : 'Fetched a page'
    case 'WebSearch':
      return s(i.query) ? `Searched the web for "${cut(s(i.query), 80)}"` : 'Searched the web'
    case 'Task':
    case 'Agent':
      return s(i.description) ? `Started a subagent: ${cut(s(i.description))}` : 'Started a subagent'
    default:
      return name.startsWith('mcp__') ? `Called ${name.replace(/^mcp__/, '').replace(/__/g, ' / ')}` : `Used ${name}`
  }
}

function riskOf(tool: string | undefined, input: unknown): Approval['risk'] {
  const cmd = tool === 'Bash' || tool === 'PowerShell' ? s(rec(input).command) : ''
  if (/\b(rm\s+-[a-z]*[rf]|rmdir|Remove-Item|del\s+\/|format\s|mkfs|dd\s+if=|sudo\b|chmod\s+-R|git\s+reset\s+--hard|git\s+push\b.*--force)|curl[^|]*\|\s*(ba)?sh/i.test(cmd)) return 'high'
  if (tool === 'Bash' || tool === 'PowerShell' || (tool !== undefined && (FILE_TOOLS_WRITE.has(tool) || tool.startsWith('mcp__')))) return 'medium'
  return 'low'
}

function detectKind(p: HookPayload): Session['kind'] {
  const k = (p as Record<string, unknown>).kind ?? (p as Record<string, unknown>).session_kind
  return k === 'background' || (p as Record<string, unknown>).background === true ? 'background' : 'interactive'
}

export interface ApplyResult {
  handled: boolean
  sessionId?: string
}

/**
 * Per-session state machine fed by Claude Code hook events. It is deliberately tolerant: any event may be the
 * first one seen for a session (the daemon may start after the session did), fields may be missing, and unknown
 * events are ignored. Sessions owned by the Secretary lane are never projected (the lane streams those).
 */
export class HookProjection {
  private readonly sessions = new Map<string, Session>()
  private lastRetentionAt = 0
  readonly deps: ProjectionDeps

  constructor(deps: ProjectionDeps) {
    this.deps = deps
    for (const sess of deps.store.listSessions()) this.sessions.set(sess.id, sess)
  }

  private iso(): string {
    return new Date(this.deps.clock()).toISOString()
  }

  private lits(): string[] {
    return this.deps.literals?.() ?? []
  }

  get size(): number {
    return this.sessions.size
  }

  getSession(id: string): Session | undefined {
    return this.sessions.get(id)
  }

  /** Apply one hook event. `payload` is the raw (unredacted) payload; only masked, truncated text is persisted. */
  apply(eventName: string, payload: HookPayload): ApplyResult {
    if (!PROJECTED_EVENTS.has(eventName)) return { handled: false }
    const sid = payload.session_id
    if (!sid || this.deps.store.isLaneSession(sid)) return { handled: false }

    let sess = this.sessions.get(sid)
    let newProject = false
    if (!sess) {
      const created = this.createSession(payload)
      sess = created.session
      newProject = created.newProject
    }
    this.handle(eventName, payload, sess)
    sess.updatedAt = this.iso()
    this.syncMain(sess)
    this.deps.store.upsertSession(sess)
    if (newProject) this.deps.announceProjectsChanged()
    else this.deps.publish({ type: 'session.update', session: structuredClone(sess) })
    return { handled: true, sessionId: sid }
  }

  // ---------------------------------------------------------------- session creation

  private createSession(p: HookPayload): { session: Session; newProject: boolean } {
    const { store, resolver } = this.deps
    const { project, cwd } = resolver.resolve(p.cwd)
    const newProject = !store.getProject(project.id)
    if (newProject) store.upsertProject(project)
    const folder = cwd ? pathApiFor(cwd).basename(cwd.replace(/[\\/]+$/, '')) || project.name : project.name
    const branch = resolver.branch(p.cwd)
    const now = this.iso()
    const session: Session = {
      id: p.session_id,
      projectId: project.id,
      title: `${DEFAULT_TITLE_PREFIX}${folder}`,
      source: 'hook',
      kind: detectKind(p),
      status: 'idle',
      model: p.model ?? 'unknown',
      cwd,
      ...(branch ? { branch } : {}),
      startedAt: now,
      updatedAt: now,
      costUsd: 0, // hook sessions carry no cost yet (transcript or OTel cost is a later phase)
      contextPct: 0,
      agents: [{ id: MAIN, parentId: null, type: 'main', status: 'waiting', lastMessage: '' }],
    }
    this.sessions.set(session.id, session)
    store.upsertSession(session)
    for (const gone of store.pruneSessions(this.deps.config.maxSessions)) this.sessions.delete(gone)
    return { session, newProject }
  }

  // ---------------------------------------------------------------- helpers

  private setStatus(sess: Session, status: SessionStatus): void {
    sess.status = status
    if (status !== 'error' && status !== 'stale') delete sess.error
  }

  private main(sess: Session): AgentNode {
    let node = sess.agents.find((a) => a.id === MAIN)
    if (!node) {
      node = { id: MAIN, parentId: null, type: 'main', status: 'waiting', lastMessage: '' }
      sess.agents.unshift(node)
    }
    return node
  }

  /** Keep the main agent node consistent with the session status. */
  private syncMain(sess: Session): void {
    const node = this.main(sess)
    const map: Record<SessionStatus, AgentNode['status']> = {
      running: 'running',
      waiting_input: 'waiting',
      blocked_permission: 'waiting',
      idle: 'waiting',
      done: 'done',
      error: 'error',
      stale: 'waiting',
    }
    node.status = map[sess.status]
    // The tool shown on the main agent is set where the event is handled (it may have been a subagent's tool);
    // here it is only cleared once the session has no tool in flight.
    if (!sess.currentTool) delete node.currentTool
  }

  private ensureAgent(sess: Session, id: string, type: string, parentId: string): AgentNode {
    let node = sess.agents.find((a) => a.id === id)
    if (!node) {
      const known = sess.agents.some((a) => a.id === parentId)
      node = { id, parentId: known ? parentId : MAIN, type, status: 'running', lastMessage: '' }
      sess.agents.push(node)
      const cap = this.deps.config.maxAgentsPerSession
      while (sess.agents.length > cap) {
        const idx = sess.agents.findIndex((a) => a.id !== MAIN && a.status === 'done')
        if (idx < 0) break
        sess.agents.splice(idx, 1)
      }
    }
    return node
  }

  /** The agent a tool event belongs to: the subagent when `agent_id` is present, otherwise the main agent. */
  private actor(sess: Session, p: HookPayload): AgentNode {
    return p.agent_id ? this.ensureAgent(sess, p.agent_id, p.agent_type ?? 'subagent', MAIN) : this.main(sess)
  }

  private emitEvent(sess: Session, e: Omit<AgentEvent, 'id' | 'ts' | 'sessionId' | 'level'> & { level?: AgentEvent['level'] }): void {
    const event: AgentEvent = {
      id: this.deps.newId('ev'),
      ts: this.iso(),
      sessionId: sess.id,
      ...(e.agentId ? { agentId: e.agentId } : {}),
      hookEvent: e.hookEvent,
      ...(e.toolName ? { toolName: e.toolName } : {}),
      summary: e.summary,
      level: e.level ?? 'info',
    }
    this.deps.store.insertAgentEvent(event) // the session row exists: createSession persists it first
    this.deps.store.pruneAgentEvents(sess.id, this.deps.config.eventsPerSession)
    this.deps.publish({ type: 'agent.event', event })
  }

  private resolveHookApprovals(sess: Session, status: 'approved' | 'denied', match?: (a: Approval) => boolean): void {
    for (const { approval, origin } of this.deps.store.pendingApprovalsForSession(sess.id)) {
      if (origin !== 'hook' || (match && !match(approval))) continue
      this.deps.store.setApprovalStatus(approval.id, status, this.iso())
      this.deps.publish({ type: 'approval.resolved', id: approval.id, status })
    }
  }

  // ---------------------------------------------------------------- the state machine

  private handle(name: string, p: HookPayload, sess: Session): void {
    const lits = this.lits()
    switch (name) {
      case 'SessionStart': {
        // A fresh or resumed session waits for a prompt; after a compaction the turn continues.
        this.setStatus(sess, p.source === 'compact' ? 'running' : 'idle')
        if (p.model) sess.model = p.model
        delete sess.currentTool
        for (const a of sess.agents) if (a.id !== MAIN && a.status === 'running') a.status = 'done'
        const where = sess.cwd ? pathApiFor(sess.cwd).basename(sess.cwd.replace(/[\\/]+$/, '')) : 'an unknown folder'
        this.emitEvent(sess, { agentId: MAIN, hookEvent: name, summary: `Session ${p.source === 'resume' ? 'resumed' : 'started'} in ${redactText(where, 80, lits)}` })
        break
      }
      case 'UserPromptSubmit': {
        this.setStatus(sess, 'running')
        const text = oneLine(p.prompt, 140, lits)
        if (sess.title.startsWith(DEFAULT_TITLE_PREFIX) && text) sess.title = oneLine(p.prompt, 80, lits)
        this.main(sess).lastMessage = text
        this.emitEvent(sess, { agentId: MAIN, hookEvent: name, summary: text || 'Prompt submitted' })
        break
      }
      case 'PostToolUse':
      case 'PostToolUseFailure': {
        const failed = name === 'PostToolUseFailure'
        this.setStatus(sess, 'running')
        const node = this.actor(sess, p)
        const base = summarizeTool(p.tool_name, p.tool_input, lits)
        const reason = failed ? oneLine((p as Record<string, unknown>).error ?? p.message, 100, lits) : ''
        const summary = failed ? `${base} failed${reason ? `: ${reason}` : ''}` : base
        if (p.tool_name) {
          node.currentTool = p.tool_name
          sess.currentTool = p.tool_name
        }
        node.lastMessage = summary
        node.status = 'running'
        // If this tool had been waiting on a permission prompt, the user must have allowed it.
        this.resolveHookApprovals(sess, 'approved', (a) => (p.tool_use_id ? a.refId === p.tool_use_id : a.refId === `tool:${p.tool_name ?? ''}`))
        this.emitEvent(sess, { agentId: node.id, hookEvent: name, ...(p.tool_name ? { toolName: p.tool_name } : {}), summary, level: failed ? 'error' : 'info' })
        break
      }
      case 'PermissionRequest': {
        this.setStatus(sess, 'blocked_permission')
        const node = this.actor(sess, p)
        const preview = summarizeTool(p.tool_name, p.tool_input, lits)
        if (p.tool_name) {
          node.currentTool = p.tool_name
          sess.currentTool = p.tool_name
        }
        node.lastMessage = `Wants permission: ${preview}`
        this.recordPermission(sess, p, preview)
        this.emitEvent(sess, { agentId: node.id, hookEvent: name, ...(p.tool_name ? { toolName: p.tool_name } : {}), summary: `Permission needed: ${preview}`, level: 'warn' })
        break
      }
      case 'Notification': {
        const type = p.notification_type ?? ''
        const msg = oneLine(p.message, 140, lits)
        const blocked = type === 'permission_prompt' || (!type && /permission/i.test(p.message ?? ''))
        const waiting = !blocked && (type === 'idle_prompt' || type === 'agent_needs_input' || type.startsWith('elicitation') || (!type && /waiting for|needs your input/i.test(p.message ?? '')))
        if (blocked) this.setStatus(sess, 'blocked_permission')
        else if (waiting) this.setStatus(sess, 'waiting_input')
        this.emitEvent(sess, { agentId: p.agent_id ?? MAIN, hookEvent: name, summary: msg || (type ? `Notification: ${type}` : 'Notification'), level: blocked || waiting ? 'warn' : 'info' })
        break
      }
      case 'SubagentStart': {
        const id = p.agent_id ?? this.deps.newId('ag')
        const parent = s((p as Record<string, unknown>).parent_agent_id) || MAIN
        const node = this.ensureAgent(sess, id, p.agent_type ?? 'subagent', parent)
        node.type = p.agent_type ?? node.type
        node.status = 'running'
        const desc = oneLine(p.prompt ?? (p as Record<string, unknown>).description, 140, lits)
        if (desc) node.description = desc
        this.setStatus(sess, 'running')
        this.emitEvent(sess, { agentId: id, hookEvent: name, summary: `${node.type} subagent started${desc ? `: ${desc}` : ''}` })
        break
      }
      case 'SubagentStop': {
        const id = p.agent_id ?? this.deps.newId('ag')
        const node = this.ensureAgent(sess, id, p.agent_type ?? 'subagent', MAIN)
        node.status = 'done'
        delete node.currentTool
        const last = oneLine((p as Record<string, unknown>).last_assistant_message, 140, lits)
        if (last) node.lastMessage = last
        this.emitEvent(sess, { agentId: id, hookEvent: name, summary: `${node.type} subagent finished${last ? `: ${last}` : ''}` })
        break
      }
      case 'Stop': {
        this.setStatus(sess, 'idle')
        delete sess.currentTool
        const last = oneLine((p as Record<string, unknown>).last_assistant_message, 300, lits)
        if (last) {
          sess.summary = last
          this.main(sess).lastMessage = oneLine(last, 140, lits)
        }
        // The turn ended, so any permission prompt that was still open has been answered (and the tool did not run).
        this.resolveHookApprovals(sess, 'denied')
        this.emitEvent(sess, { agentId: MAIN, hookEvent: name, summary: last ? `Turn finished: ${oneLine(last, 100, lits)}` : 'Turn finished' })
        break
      }
      case 'StopFailure': {
        this.setStatus(sess, 'error')
        sess.error = oneLine((p as Record<string, unknown>).error ?? p.message ?? 'The turn ended with an error', 300, lits)
        delete sess.currentTool
        this.resolveHookApprovals(sess, 'denied')
        this.emitEvent(sess, { agentId: MAIN, hookEvent: name, summary: `Turn failed: ${sess.error}`, level: 'error' })
        break
      }
      case 'SessionEnd': {
        this.setStatus(sess, 'done')
        delete sess.currentTool
        for (const a of sess.agents) {
          a.status = 'done'
          delete a.currentTool
        }
        this.resolveHookApprovals(sess, 'denied')
        const reason = oneLine(p.reason, 60, lits)
        this.emitEvent(sess, { agentId: MAIN, hookEvent: name, summary: `Session ended${reason ? ` (${reason})` : ''}` })
        break
      }
    }
  }

  /** A PermissionRequest becomes a pending approval, but one this app cannot answer: hooks do not block. */
  private recordPermission(sess: Session, p: HookPayload, preview: string): void {
    const { store } = this.deps
    const refId = p.tool_use_id ?? `tool:${p.tool_name ?? ''}`
    const already = store.pendingApprovalsForSession(sess.id).some((x) => x.origin === 'hook' && x.approval.refId === refId && x.approval.preview === preview)
    if (already) return
    const approval: Approval = {
      id: this.deps.newId('ap-hook'),
      kind: 'tool_permission',
      title: `${sess.title} wants to use ${p.tool_name ?? 'a tool'}`.slice(0, 160),
      detail:
        'Seen through Claude Code hooks, which are non-blocking, so this app cannot approve or deny it. Answer it in that Claude Code terminal; this card resolves by itself when the session moves on.',
      requestedAt: this.iso(),
      sessionId: sess.id,
      status: 'pending',
      risk: riskOf(p.tool_name, p.tool_input),
      tier: 'T4',
      preview,
      area: 'work',
      refId,
    }
    store.upsertApproval(approval, 'hook')
    this.deps.publish({ type: 'approval.new', approval: structuredClone(approval) })
  }

  // ---------------------------------------------------------------- staleness and retention

  /**
   * Mark sessions stale when events stop arriving: SessionEnd has a 1.5 s hook budget and is often never
   * delivered, so absence of events is the only signal that a terminal was closed. Returns how many changed.
   */
  sweep(): number {
    const now = this.deps.clock()
    const { config, store } = this.deps
    let changed = 0
    for (const sess of this.sessions.values()) {
      if (this.deps.protectedIds?.has(sess.id)) continue
      if (sess.source !== 'hook') continue
      const age = now - Date.parse(sess.updatedAt)
      if (!Number.isFinite(age)) continue
      const limit = sess.status === 'running' ? config.staleRunningMs : sess.status === 'idle' || sess.status === 'waiting_input' || sess.status === 'blocked_permission' ? config.staleIdleMs : Infinity
      if (age <= limit) continue
      const mins = Math.round(age / 60_000)
      this.setStatus(sess, 'stale')
      sess.error = `No hook events for ${mins >= 120 ? `${Math.round(mins / 60)} hours` : `${mins} minutes`}. The terminal was probably closed (SessionEnd is often not delivered).`
      delete sess.currentTool
      this.resolveHookApprovals(sess, 'denied')
      this.syncMain(sess)
      store.upsertSession(sess) // updatedAt stays the time of the last real event
      this.deps.publish({ type: 'session.update', session: structuredClone(sess) })
      changed++
    }
    if (now - this.lastRetentionAt > 3_600_000) {
      this.lastRetentionAt = now
      this.enforceRetention(now)
    }
    return changed
  }

  private enforceRetention(now: number): void {
    const cutoff = new Date(now - this.deps.config.retentionMs).toISOString()
    for (const id of this.deps.store.deleteSessionsBefore(cutoff)) this.sessions.delete(id)
    this.deps.store.deleteEventsBefore(cutoff)
  }

  /** Change a session from outside the hook stream (demo fixtures); persists and publishes it. */
  patchSession(id: string, patch: Partial<Pick<Session, 'status' | 'currentTool' | 'error'>>): Session | undefined {
    const sess = this.sessions.get(id)
    if (!sess) return undefined
    if (patch.status) this.setStatus(sess, patch.status)
    if ('currentTool' in patch) {
      if (patch.currentTool) sess.currentTool = patch.currentTool
      else delete sess.currentTool
    }
    sess.updatedAt = this.iso()
    this.syncMain(sess)
    this.deps.store.upsertSession(sess)
    this.deps.publish({ type: 'session.update', session: structuredClone(sess) })
    return sess
  }

  /** Remove a session from the projection (it turned out to belong to the lane). Returns true if something was removed. */
  dropSession(id: string): boolean {
    const existed = this.sessions.delete(id)
    const gone = this.deps.store.deleteSession(id)
    for (const { approval, origin } of this.deps.store.pendingApprovalsForSession(id)) {
      if (origin === 'hook') this.deps.store.setApprovalStatus(approval.id, 'denied', this.iso())
    }
    return existed || gone
  }
}
