import { z } from 'zod'
import { Id, IsoDate, IsoDateTime } from './common'

export const Project = z.object({
  id: Id,
  name: z.string(),
  rootPath: z.string(),
  status: z.enum(['active', 'paused', 'done']),
  tags: z.array(z.string()),
  /** Hex color used for session chips and charts. */
  color: z.string(),
  /** Vault hub note for this project, if any. */
  hubNote: z.string().optional(),
})
export type Project = z.infer<typeof Project>

/** Live status of a Claude Code session. `needs you` = waiting_input | blocked_permission. */
export const SessionStatus = z.enum([
  'running',
  'waiting_input',
  'blocked_permission',
  'idle',
  'done',
  'error',
  'stale',
])
export type SessionStatus = z.infer<typeof SessionStatus>

export const AgentNode = z.object({
  id: Id,
  parentId: Id.nullable(),
  /** 'main' for the session's own agent, otherwise the subagent type. */
  type: z.string(),
  status: z.enum(['running', 'waiting', 'done', 'error']),
  lastMessage: z.string(),
})
export type AgentNode = z.infer<typeof AgentNode>

export const Session = z.object({
  id: Id,
  projectId: Id,
  title: z.string(),
  /** hook = observed via Claude Code hooks, sdk = launched by our daemon, import = history backfill */
  source: z.enum(['hook', 'sdk', 'import']),
  kind: z.enum(['interactive', 'background']),
  status: SessionStatus,
  model: z.string(),
  cwd: z.string(),
  branch: z.string().optional(),
  startedAt: IsoDateTime,
  updatedAt: IsoDateTime,
  currentTool: z.string().optional(),
  /** API-equivalent estimate, never a bill. */
  costUsd: z.number(),
  contextPct: z.number().min(0).max(100),
  agents: z.array(AgentNode),
  summary: z.string().optional(),
})
export type Session = z.infer<typeof Session>

export const AgentEvent = z.object({
  id: Id,
  ts: IsoDateTime,
  sessionId: Id,
  agentId: Id.optional(),
  /** Claude Code hook event name, e.g. PostToolUse, SubagentStart, Notification. */
  hookEvent: z.string(),
  toolName: z.string().optional(),
  summary: z.string(),
  level: z.enum(['info', 'warn', 'error']).default('info'),
})
export type AgentEvent = z.infer<typeof AgentEvent>

export const TaskColumn = z.enum(['backlog', 'todo', 'doing', 'review', 'done'])
export type TaskColumn = z.infer<typeof TaskColumn>

export const Task = z.object({
  id: Id,
  projectId: Id.optional(),
  title: z.string(),
  description: z.string().optional(),
  column: TaskColumn,
  priority: z.enum(['low', 'medium', 'high']),
  /** Sessions working on this card (manual link in v1; auto-binding later). */
  sessionIds: z.array(Id),
  source: z.enum(['manual', 'assistant', 'claude_task', 'federated']),
  branch: z.string().optional(),
  prUrl: z.string().optional(),
})
export type Task = z.infer<typeof Task>

/** Anything that waits for the human: a tool permission, a draft to send, a note-change proposal... */
export const Approval = z.object({
  id: Id,
  kind: z.enum(['tool_permission', 'email_draft', 'brain_proposal', 'calendar_event', 'action']),
  title: z.string(),
  detail: z.string(),
  requestedAt: IsoDateTime,
  sessionId: Id.optional(),
  status: z.enum(['pending', 'approved', 'denied']),
  risk: z.enum(['low', 'medium', 'high']),
  /** Autonomy tier of the action (T0..T4); see docs/PERSONA.md and the trust ladder in Settings. */
  tier: z.enum(['T1', 'T2', 'T3', 'T4']),
  /** Monospace preview: the command, the draft, the diff... */
  preview: z.string().optional(),
  /** Where the 'review' button leads. */
  area: z.enum(['work', 'brain', 'life', 'money']),
  /** The thing being decided: proposal id (brain_proposal), mail thread id (email_draft), event id... */
  refId: Id.optional(),
})
export type Approval = z.infer<typeof Approval>

export const CostDay = z.object({
  date: IsoDate,
  /** USD per project id, API-equivalent estimate. */
  byProject: z.record(z.string(), z.number()),
  byModel: z.record(z.string(), z.number()),
})
export type CostDay = z.infer<typeof CostDay>

export const UsageBlock = z.object({
  /** The 5-hour rate-limit window. */
  startedAt: IsoDateTime,
  endsAt: IsoDateTime,
  usedPct: z.number().min(0).max(100),
  costUsd: z.number(),
})
export type UsageBlock = z.infer<typeof UsageBlock>
