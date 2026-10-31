import { z } from 'zod'
import { Persona } from './schemas/settings'
import { TaskColumn } from './schemas/work'

/**
 * The daemon's wire contract. The web DaemonClient and the daemon both import this, so they cannot drift.
 * Everything binds to 127.0.0.1. Browser calls authenticate with an HttpOnly cookie (exchanged once from the
 * URL the daemon prints at startup); Claude Code hooks authenticate with a separate bearer token.
 */
export const DEFAULT_DAEMON_PORT = 7421

export const DaemonRoutes = {
  health: '/api/health',
  snapshot: '/api/snapshot',
  authExchange: '/api/auth/exchange',
  chat: '/api/chat',
  chatInterrupt: '/api/chat/interrupt',
  approvalDecision: (id: string) => `/api/approvals/${encodeURIComponent(id)}/decision`,
  proposalDecision: (id: string) => `/api/proposals/${encodeURIComponent(id)}/decision`,
  tasks: '/api/tasks',
  task: (id: string) => `/api/tasks/${encodeURIComponent(id)}`,
  trustMode: (ruleId: string) => `/api/settings/trust/${encodeURIComponent(ruleId)}`,
  claudeMode: '/api/settings/claude-mode',
  guestMode: '/api/settings/guest',
  webcam: '/api/settings/webcam',
  persona: '/api/settings/persona',
  learned: (id: string) => `/api/learned/${encodeURIComponent(id)}`,
  /** Embedded terminals (highest-risk surface: see apps/daemon/README.md). All need terminals enabled in Settings. */
  terminals: '/api/terminals',
  terminal: (id: string) => `/api/terminals/${encodeURIComponent(id)}`,
  /** POST: mint a single-use, short-lived ticket bound to this terminal. */
  terminalTicket: (id: string) => `/api/terminals/${encodeURIComponent(id)}/ticket`,
  terminalsEnabled: '/api/settings/terminals',
  /** WebSocket for one terminal. No secrets in the URL: the first text frame must be {type:'auth', ticket}. */
  terminalWs: (id: string) => `/ws/terminal/${encodeURIComponent(id)}`,
  /** WebSocket for a stage (Unreal/Unity/simulator). Authenticates with `Authorization: Bearer <stage token>`; loopback only. */
  stageWs: '/ws/stage',
  /** WebSocket. Query: ?since=<seq>&epoch=<epoch> to resume. */
  ws: '/ws',
  /** Claude Code http hooks POST here. Bearer = hook token. Always answers 200 fast (fail-open). */
  hook: (event: string) => `/hooks/${encodeURIComponent(event)}`,
} as const

export const AuthExchangeRequest = z.object({ code: z.string().min(16) })

export const ChatRequest = z.object({
  text: z.string().min(1).max(8000),
  modality: z.enum(['text', 'voice']).default('text'),
})
export type ChatRequest = z.infer<typeof ChatRequest>

export const DecisionRequest = z.object({ decision: z.enum(['approved', 'denied', 'rejected']) })
export const TaskCreateRequest = z.object({
  title: z.string().min(1).max(200),
  projectId: z.string().optional(),
  column: TaskColumn.optional(),
})
export const TaskMoveRequest = z.object({ column: TaskColumn })
export const TaskPatchRequest = z.object({
  column: TaskColumn.optional(),
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  priority: z.enum(['low', 'medium', 'high']).optional(),
})
export type TaskPatchRequest = z.infer<typeof TaskPatchRequest>

/** Error body returned by every non-2xx API response. */
export const ApiError = z.object({ error: z.string(), message: z.string(), details: z.unknown().optional() })
export type ApiError = z.infer<typeof ApiError>

export const AuthExchangeResponse = z.object({ ok: z.literal(true) })
export const TrustModeRequest = z.object({ mode: z.enum(['ask', 'auto']) })
export const ClaudeModeRequest = z.object({ mode: z.enum(['api-key', 'local-login']) })
export const OnOffRequest = z.object({ on: z.boolean() })
export const PersonaPatchRequest = Persona.partial()

/** First message on every WebSocket. If `epoch` differs from the client's, the client must refetch the snapshot. */
export const WsHello = z.object({
  type: z.literal('hello'),
  /** Latest sequence number at connect time. */
  seq: z.number().int().nonnegative(),
  /** Random per daemon process. A restart changes it, so sequence numbers are never compared across runs. */
  epoch: z.string(),
  backend: z.enum(['fake', 'sdk']),
  version: z.string(),
  /** True when the requested resume point cannot be served (older than the replay buffer, or a different epoch). Refetch the snapshot. */
  resync: z.boolean().optional(),
  reason: z.string().optional(),
})
export type WsHello = z.infer<typeof WsHello>

export const DaemonHealth = z.object({
  ok: z.literal(true),
  version: z.string(),
  epoch: z.string(),
  uptimeSec: z.number(),
  backend: z.enum(['fake', 'sdk']),
  lane: z.enum(['starting', 'ready', 'busy', 'error', 'stopped']),
  hooksReceived: z.number().int(),
  lastHookAt: z.string().nullable(),
  sessions: z.number().int(),
  dataDir: z.string(),
})
export type DaemonHealth = z.infer<typeof DaemonHealth>

/**
 * A Claude Code hook payload as it arrives. Only the common fields are modelled; everything else is kept
 * verbatim (the format moves fast: 12 events in 2025, 33 now), so projections are tolerant by design.
 */
export const HookPayload = z
  .object({
    session_id: z.string(),
    hook_event_name: z.string().optional(),
    cwd: z.string().optional(),
    transcript_path: z.string().optional(),
    permission_mode: z.string().optional(),
    agent_id: z.string().optional(),
    agent_type: z.string().optional(),
    tool_name: z.string().optional(),
    tool_use_id: z.string().optional(),
    tool_input: z.unknown().optional(),
    tool_response: z.unknown().optional(),
    prompt: z.string().optional(),
    message: z.string().optional(),
    notification_type: z.string().optional(),
    model: z.string().optional(),
    source: z.string().optional(),
    reason: z.string().optional(),
    last_assistant_message: z.string().optional(),
    error: z.unknown().optional(),
    parent_agent_id: z.string().optional(),
  })
  .passthrough()
export type HookPayload = z.infer<typeof HookPayload>

/** Hook events the installer registers. PreToolUse is deliberately absent: a slow receiver there blocks the tool. */
export const NON_BLOCKING_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Notification',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'SessionEnd',
] as const

// ---------------------------------------------------------------------------------------------------------------
// Embedded terminals
// ---------------------------------------------------------------------------------------------------------------

export const TerminalKind = z.enum(['claude', 'shell'])
export type TerminalKind = z.infer<typeof TerminalKind>

export const TerminalInfo = z.object({
  id: z.string(),
  kind: TerminalKind,
  title: z.string(),
  cwd: z.string(),
  projectId: z.string().optional(),
  cols: z.number().int(),
  rows: z.number().int(),
  createdAt: z.string(),
  state: z.enum(['running', 'exited']),
  exitCode: z.number().int().nullable().optional(),
})
export type TerminalInfo = z.infer<typeof TerminalInfo>

export const TerminalCreateRequest = z.object({
  kind: TerminalKind,
  /** Start in a known project's root. Preferred over cwd. */
  projectId: z.string().optional(),
  /** Must resolve inside a known project root or the user's home; anything else is refused. */
  cwd: z.string().optional(),
  cols: z.number().int().min(10).max(500).default(100),
  rows: z.number().int().min(5).max(200).default(30),
})
export type TerminalCreateRequest = z.infer<typeof TerminalCreateRequest>

export const TerminalTicketResponse = z.object({ ticket: z.string(), expiresInSec: z.number() })
export type TerminalTicketResponse = z.infer<typeof TerminalTicketResponse>

/**
 * Terminal WebSocket framing. Terminal bytes (output and keystrokes) travel as BINARY frames; everything else is
 * one of these JSON text frames. The first client frame must be `auth`, within a few seconds, or the socket closes.
 */
export const TerminalClientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('auth'), ticket: z.string() }),
  z.object({ type: z.literal('resize'), cols: z.number().int().min(10).max(500), rows: z.number().int().min(5).max(200) }),
])
export type TerminalClientMessage = z.infer<typeof TerminalClientMessage>

export const TerminalServerMessage = z.discriminatedUnion('type', [
  /** Sent after auth. `replayBytes` of scrollback follow as binary frames. */
  z.object({ type: z.literal('ready'), replayBytes: z.number().int().nonnegative() }),
  z.object({ type: z.literal('exit'), exitCode: z.number().int().nullable() }),
  z.object({ type: z.literal('error'), message: z.string() }),
])
export type TerminalServerMessage = z.infer<typeof TerminalServerMessage>
