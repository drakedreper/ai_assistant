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
