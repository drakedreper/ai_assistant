/**
 * Contracts between the Claude "lanes" (packages/agent-core), the daemon (apps/daemon) and the tests.
 * Everything here is SDK-independent: a backend can be the real Claude Agent SDK, or a scripted fake
 * that costs zero tokens (used by tests, the e2e script and offline demos).
 */
import type { ServerEvent } from './schemas/api'
import type { ChatMessage } from './schemas/assistant'
import type { AuditEntry, ClaudeConnection, Persona } from './schemas/settings'
import type { Approval } from './schemas/work'
import type { ToolSpec } from './tools'

type Distribute<T> = T extends unknown ? Omit<T, 'seq' | 'ts'> : never
/** A ServerEvent before the daemon stamps it with seq and ts. Lanes emit drafts; the daemon owns sequencing. */
export type ServerEventDraft = Distribute<ServerEvent>

export type LaneId = 'secretary' | 'reader' | 'voice'

// ---------------------------------------------------------------- backend events

export interface TokenUsage {
  input: number
  output: number
  cacheRead?: number
  cacheCreate?: number
}

/** What a backend reports while a turn runs. The lane turns these into chat parts, avatar events and approvals. */
export type BackendEvent =
  /** The backend's own session id; persist it so the lane can resume after a restart. */
  | { type: 'session'; sessionId: string }
  /** A raw streamed text fragment, tags and all (e.g. "[happy] Good morning"). The lane parses it. */
  | { type: 'text_delta'; text: string }
  | { type: 'tool_start'; toolUseId: string; tool: string; input: unknown }
  | { type: 'tool_end'; toolUseId: string; ok: boolean; summary?: string }
  /** The backend needs a human decision before running a tool (SDK canUseTool). Answer with resolvePermission. */
  | { type: 'permission_request'; requestId: string; tool: string; input: unknown; title?: string; description?: string }
  | { type: 'turn_end'; costUsd?: number; usage?: TokenUsage; interrupted?: boolean }
  | { type: 'error'; message: string; retryable: boolean }

export interface UserTurn {
  text: string
  modality: 'text' | 'voice'
  /** Webcam snapshots etc. Only sent when the user explicitly shares one. */
  images?: Array<{ mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'; dataBase64: string }>
}

export type PermissionDecision = { behavior: 'allow' } | { behavior: 'deny'; message: string }

export interface ToolResult {
  text: string
  isError?: boolean
}

/** A tool the assistant may call, with the code that runs it. The spec carries lane/tier/readOnly metadata. */
export interface ToolBinding {
  spec: ToolSpec
  handler: (input: unknown) => Promise<ToolResult>
}

export interface OpenSessionOptions {
  lane: LaneId
  /** Persona + digest. Kept stable so the prompt cache holds. */
  systemPrompt: string
  model: string
  effort: 'low' | 'medium' | 'high'
  /** Working directory (an agent directory inside the vault, or a scratch dir). */
  cwd: string
  /** Resume a previous backend session. */
  resumeSessionId?: string
  tools: ToolBinding[]
  /** Hard cap for this session, enforced by the backend when it can. */
  maxBudgetUsd?: number
  authMode: 'api-key' | 'local-login'
  /** Only used when authMode is api-key. Never logged. */
  apiKey?: string
  /** Path to the user's own installed claude binary (local-login), or undefined for the SDK-bundled one. */
  claudeExecutable?: string
}

/** A long-lived streaming conversation. One user turn in, a stream of BackendEvents out. */
export interface AgentSession {
  readonly id: string
  send(turn: UserTurn): void
  /** Stop the current turn (barge-in). The turn ends with turn_end{interrupted:true}. */
  interrupt(): Promise<void>
  resolvePermission(requestId: string, decision: PermissionDecision): void
  /** One iterator for the life of the session; completes when the session closes. */
  readonly events: AsyncIterable<BackendEvent>
  close(): Promise<void>
}

export interface AgentBackend {
  readonly kind: 'fake' | 'sdk'
  open(opts: OpenSessionOptions): Promise<AgentSession>
}

// ---------------------------------------------------------------- budgets

export interface BudgetStatus {
  lane: LaneId
  dailyBudgetUsd: number
  spentTodayUsd: number
}

/** Daemon-level spend control: per-lane daily budgets plus a global cap. Estimates, not a bill. */
export interface BudgetGuard {
  check(lane: LaneId): { ok: true } | { ok: false; reason: string }
  record(lane: LaneId, costUsd: number): void
  status(): { lanes: BudgetStatus[]; globalDailyCapUsd: number; globalSpentTodayUsd: number }
}

// ---------------------------------------------------------------- lane

/** Persistence seam implemented by the daemon (SQLite). The lane never touches a database itself. */
export interface LaneStore {
  loadBackendSessionId(lane: LaneId): string | undefined
  saveBackendSessionId(lane: LaneId, id: string): void
  /** Insert or replace by message id. */
  upsertChat(message: ChatMessage): void
  recentChat(limit: number): ChatMessage[]
  saveApproval(approval: Approval): void
  setApprovalStatus(id: string, status: 'approved' | 'denied'): void
  audit(entry: Omit<AuditEntry, 'id'>): void
}

export interface LaneDeps {
  backend: AgentBackend
  store: LaneStore
  budget: BudgetGuard
  getPersona(): Persona
  getClaude(): ClaudeConnection
  tools: ToolBinding[]
  /** Push a live event to the UI. The daemon stamps seq/ts and fans out. */
  emit(draft: ServerEventDraft): void
  now(): Date
  newId(prefix: string): string
  cwd: string
  env: { apiKey?: string; claudeExecutable?: string }
}

export type LaneState = 'starting' | 'ready' | 'busy' | 'error' | 'stopped'

export interface LaneStatus {
  state: LaneState
  backend: 'fake' | 'sdk'
  error?: string
  backendSessionId?: string
}

/**
 * The Secretary lane: one long-lived streaming session with the persona, the brain/calendar/mail/finance/worklog
 * tools, tool permissions routed to approval cards, emotion tags parsed into avatar events, and budget checks.
 */
export interface SecretaryLane {
  start(): Promise<void>
  /** Resolves when the turn has been accepted; the reply streams through deps.emit. */
  send(turn: UserTurn): Promise<void>
  interrupt(): Promise<void>
  /** True when the approval belonged to this lane (so the daemon knows it was handled). */
  decideApproval(id: string, decision: 'approved' | 'denied'): boolean
  status(): LaneStatus
  stop(): Promise<void>
}
