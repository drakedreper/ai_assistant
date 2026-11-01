import { createBudgetGuard, createFakeBackend, createMockToolBindings, createSecretaryLane } from '../src'
import type { BudgetGuardImpl, FakeBackend, FakeBackendOptions, LaneOptions, SecretaryLaneImpl } from '../src'
import { buildSnapshot } from '@ai-assistant/shared/fixtures'
import type {
  AgentBackend,
  Approval,
  AuditEntry,
  BackendEvent,
  ChatMessage,
  ClaudeConnection,
  LaneDeps,
  LaneId,
  LaneStore,
  Persona,
  ServerEventDraft,
  ToolBinding,
} from '@ai-assistant/shared'

/** 08:15 local on a Monday, so greetings and "today" are stable. */
export const NOW = new Date(2026, 10, 2, 8, 15, 0)

export class MemoryStore implements LaneStore {
  sessionIds = new Map<LaneId, string>()
  chat = new Map<string, ChatMessage>()
  order: string[] = []
  approvals = new Map<string, Approval>()
  auditLog: Array<Omit<AuditEntry, 'id'>> = []
  upserts = 0

  loadBackendSessionId(lane: LaneId): string | undefined {
    return this.sessionIds.get(lane)
  }
  clearBackendSessionId(lane: LaneId): void {
    this.sessionIds.delete(lane)
  }
  saveBackendSessionId(lane: LaneId, id: string): void {
    this.sessionIds.set(lane, id)
  }
  upsertChat(message: ChatMessage): void {
    if (!this.chat.has(message.id)) this.order.push(message.id)
    this.chat.set(message.id, structuredClone(message))
    this.upserts++
  }
  recentChat(limit: number): ChatMessage[] {
    return this.order.slice(-limit).map((id) => this.chat.get(id)!)
  }
  saveApproval(approval: Approval): void {
    this.approvals.set(approval.id, structuredClone(approval))
  }
  setApprovalStatus(id: string, status: 'approved' | 'denied'): void {
    const a = this.approvals.get(id)
    if (a) a.status = status
  }
  audit(entry: Omit<AuditEntry, 'id'>): void {
    this.auditLog.push(structuredClone(entry))
  }
  /** Chat in order, as the UI would list it. */
  messages(): ChatMessage[] {
    return this.order.map((id) => this.chat.get(id)!)
  }
}

export interface Harness {
  /** Move `date` to move the lane's, the budget's and the tools' sense of "now". */
  clock: { date: Date }
  lane: SecretaryLaneImpl
  store: MemoryStore
  backend: FakeBackend
  budget: BudgetGuardImpl
  deps: LaneDeps
  emitted: ServerEventDraft[]
  claude: ClaudeConnection
  persona: Persona
  tools: ToolBinding[]
  types(): string[]
  of<T extends ServerEventDraft['type']>(type: T): Array<Extract<ServerEventDraft, { type: T }>>
  avatar(): Array<Extract<ServerEventDraft, { type: 'avatar' }>['event']>
  /** The text of the last assistant message the UI would show, tags and all. */
  lastAssistantText(): string
  mark(): number
}

export interface HarnessOptions {
  backend?: AgentBackend
  fake?: FakeBackendOptions
  lane?: LaneOptions
  tools?: ToolBinding[]
  store?: MemoryStore
  dailyBudgetUsd?: number
  globalDailyCapUsd?: number
  mode?: 'api-key' | 'local-login'
  apiKey?: string | undefined
}

export function makeHarness(o: HarnessOptions = {}): Harness {
  const settings = buildSnapshot(NOW).settings
  const claude = structuredClone(settings.claude)
  claude.mode = o.mode ?? 'api-key'
  const persona = structuredClone(settings.persona)
  const store = o.store ?? new MemoryStore()
  const clock = { date: NOW }
  const backend = (o.backend as FakeBackend | undefined) ?? createFakeBackend({ now: () => clock.date, ...o.fake })
  const tools = o.tools ?? createMockToolBindings({ now: () => NOW })
  const budget = createBudgetGuard({
    lanes: claude.lanes.map((l) => ({ lane: l.id, dailyBudgetUsd: l.id === 'secretary' ? (o.dailyBudgetUsd ?? l.dailyBudgetUsd) : l.dailyBudgetUsd })),
    globalDailyCapUsd: o.globalDailyCapUsd ?? claude.globalDailyCapUsd,
    now: () => clock.date,
  })
  const emitted: ServerEventDraft[] = []
  let n = 0
  const deps: LaneDeps = {
    backend,
    store,
    budget,
    getPersona: () => persona,
    getClaude: () => claude,
    tools,
    emit: (d) => emitted.push(structuredClone(d)),
    now: () => clock.date,
    newId: (prefix) => `${prefix}-${++n}`,
    cwd: process.cwd(),
    env: { apiKey: 'sk-ant-test-0000000000000000', ...(o.apiKey !== undefined ? { apiKey: o.apiKey } : {}) },
  }
  const lane = createSecretaryLane(deps, { backoffMs: () => 1, ...o.lane })
  return {
    clock,
    lane,
    store,
    backend: backend as FakeBackend,
    budget,
    deps,
    emitted,
    claude,
    persona,
    tools,
    types: () => emitted.map((e) => e.type),
    of: (type) => emitted.filter((e): e is never => e.type === type) as never,
    avatar: () => emitted.filter((e) => e.type === 'avatar').map((e) => (e as Extract<ServerEventDraft, { type: 'avatar' }>).event),
    lastAssistantText: () => {
      const msgs = store.messages().filter((m) => m.role === 'assistant')
      const last = msgs[msgs.length - 1]
      return last ? last.parts.map((p) => (p.type === 'text' ? p.text : '')).join(' ').trim() : ''
    },
    mark: () => emitted.length,
  }
}

export async function until(cond: () => boolean, label = 'condition', ms = 3000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 2))
  }
}

/** Drain every event a session produces until `stop` says to stop (or it ends). */
export async function collect(session: { events: AsyncIterable<BackendEvent> }, stop: (e: BackendEvent) => boolean, ms = 3000): Promise<BackendEvent[]> {
  const out: BackendEvent[] = []
  const it = session.events[Symbol.asyncIterator]()
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const r = await Promise.race([it.next(), new Promise<IteratorResult<BackendEvent>>((res) => setTimeout(() => res({ value: undefined, done: true }), Math.max(1, deadline - Date.now())))])
    if (r.done) break
    out.push(r.value)
    if (stop(r.value)) break
  }
  return out
}

export const isTerminal = (e: BackendEvent): boolean => e.type === 'turn_end' || e.type === 'error'

// ---------------------------------------------------------------------------------------------- lane test tools

import type { AgentSession, OpenSessionOptions, PermissionDecision, UserTurn } from '@ai-assistant/shared'
import { AsyncQueue } from '../src/util'

/** A session the test drives by hand: it pushes BackendEvents and inspects what the lane asked of it. */
export class ManualSession implements AgentSession {
  readonly events: AsyncIterable<BackendEvent>
  readonly queue = new AsyncQueue<BackendEvent>()
  sent: UserTurn[] = []
  decisions: Array<[string, PermissionDecision]> = []
  interrupts = 0
  closed = false
  onSend: ((turn: UserTurn) => void) | undefined
  onInterrupt: (() => void | Promise<void>) | undefined

  constructor(readonly id: string) {
    this.events = this.queue
  }
  push(...events: BackendEvent[]): void {
    for (const e of events) this.queue.push(e)
  }
  end(): void {
    this.queue.end()
  }
  send(turn: UserTurn): void {
    this.sent.push(turn)
    this.onSend?.(turn)
  }
  async interrupt(): Promise<void> {
    this.interrupts++
    await this.onInterrupt?.()
  }
  resolvePermission(requestId: string, decision: PermissionDecision): void {
    this.decisions.push([requestId, decision])
  }
  async close(): Promise<void> {
    this.closed = true
    this.queue.end()
  }
}

export class ManualBackend implements AgentBackend {
  readonly kind = 'fake' as const
  sessions: ManualSession[] = []
  opened: OpenSessionOptions[] = []
  /** Return an Error to make open() fail. */
  failOpen: ((opts: OpenSessionOptions, attempt: number) => Error | undefined) | undefined
  private attempts = 0

  async open(opts: OpenSessionOptions): Promise<ManualSession> {
    this.opened.push(opts)
    const err = this.failOpen?.(opts, ++this.attempts)
    if (err) throw err
    const session = new ManualSession(opts.resumeSessionId ?? `manual-${this.sessions.length + 1}`)
    this.sessions.push(session)
    session.push({ type: 'session', sessionId: session.id })
    return session
  }
  get last(): ManualSession {
    return this.sessions[this.sessions.length - 1]!
  }
}

/** Timers the test fires by hand, so backoff and interrupt waits never need real time. */
export function fakeTimers() {
  const items: Array<{ fn: () => void; ms: number; cleared: boolean; fired: boolean }> = []
  return {
    items,
    setTimeout: (fn: () => void, ms: number) => {
      const item = { fn, ms, cleared: false, fired: false }
      items.push(item)
      return item
    },
    clearTimeout: (h: unknown) => {
      if (h) (h as { cleared: boolean }).cleared = true
    },
    pending: () => items.filter((i) => !i.cleared && !i.fired),
    /** Fire the oldest pending timer. */
    fire: () => {
      const next = items.find((i) => !i.cleared && !i.fired)
      if (!next) throw new Error('no pending timer')
      next.fired = true
      next.fn()
    },
  }
}

/** A compact, readable trace of what the UI would see, in order. */
export function trace(events: ServerEventDraft[]): string[] {
  return events.map((e) => {
    switch (e.type) {
      case 'chat.message':
        return `chat.message:${e.message.role}`
      case 'avatar':
        return e.event.type === 'pose' ? `avatar:pose:${e.event.state}` : e.event.type === 'expression' ? `avatar:expression:${e.event.emotion}` : e.event.type === 'speak' ? `avatar:speak:${e.event.emotion}` : `avatar:${e.event.type}`
      default:
        return e.type
    }
  })
}

export const turnOf = (text: string, modality: 'text' | 'voice' = 'text'): UserTurn => ({ text, modality })

/** Every visible string the UI could render for chat: messages, deltas and what was persisted. */
export function visibleChatText(h: Harness): string[] {
  const out: string[] = []
  for (const e of h.emitted) {
    if (e.type === 'chat.delta') out.push(e.text)
    if (e.type === 'chat.message') for (const p of e.message.parts) if (p.type === 'text') out.push(p.text)
  }
  for (const m of h.store.messages()) for (const p of m.parts) if (p.type === 'text') out.push(p.text)
  return out
}

export const TAG_RE = /\[(?:neutral|happy|sad|angry|relaxed|surprised|shy|thinking)\](?!\()/i
