import { z } from 'zod'
import { AvatarEvent, Briefing, ChatMessage, LearnedFact } from './assistant'
import { BrainLayer, MemoryEntry, Note, Proposal } from './brain'
import { StageLive, TerminalInfo } from '../daemon'
import { StageSnapshot } from '../stage'
import { Id, IsoDateTime } from './common'
import { CalendarEvent, Contact, MailThread } from './life'
import { FinanceSnapshot } from './money'
import { SettingsSnapshot, TrustRule } from './settings'
import {
  AgentEvent,
  Approval,
  CostDay,
  Project,
  Session,
  Task,
  TaskColumn,
  UsageBlock,
} from './work'
import { WorldSnapshot } from './world'

/** Everything the UI needs to render, in one object. The daemon's GET /snapshot returns exactly this. */
export const Snapshot = z.object({
  now: IsoDateTime,
  /** Sequence number of the last event already reflected in this snapshot, so a refetch lines up with the event stream. */
  seq: z.number().int().nonnegative().optional(),
  /** Daemon process epoch the seq belongs to (also in the X-Daemon-Epoch header). A different epoch means seq values are not comparable. */
  epoch: z.string().optional(),
  /** Screens whose data is still sample data, so the UI can say so honestly. Absent = nothing is mock (or this is the mockup). */
  mockSections: z.array(z.enum(['briefing', 'brain', 'life', 'money', 'world'])).optional(),
  briefing: Briefing,
  /** Embedded terminals currently known to the daemon (daemon mode only). */
  terminals: z.array(TerminalInfo).optional(),
  /** The live 3D assistant backend (daemon mode only). */
  stage: StageSnapshot.optional(),
  learned: z.array(LearnedFact),
  chat: z.array(ChatMessage),
  projects: z.array(Project),
  sessions: z.array(Session),
  events: z.array(AgentEvent),
  tasks: z.array(Task),
  approvals: z.array(Approval),
  costDays: z.array(CostDay),
  usageBlock: UsageBlock,
  notes: z.array(Note),
  proposals: z.array(Proposal),
  memory: z.array(MemoryEntry),
  calendar: z.array(CalendarEvent),
  mail: z.array(MailThread),
  contacts: z.array(Contact),
  finance: FinanceSnapshot,
  world: WorldSnapshot,
  settings: SettingsSnapshot,
})
export type Snapshot = z.infer<typeof Snapshot>

/**
 * Live events pushed over the single authenticated WebSocket.
 * `seq` is monotonic so the UI can detect gaps and resync after sleep/reconnect.
 */
const base = { seq: z.number().int().nonnegative(), ts: IsoDateTime }
export const ServerEvent = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('chat.message'), message: ChatMessage }),
  z.object({
    ...base,
    type: z.literal('chat.delta'),
    messageId: Id,
    /** Append `text` to the last text part of the message. */
    text: z.string(),
  }),
  z.object({ ...base, type: z.literal('chat.done'), messageId: Id }),
  z.object({ ...base, type: z.literal('avatar'), event: AvatarEvent }),
  z.object({ ...base, type: z.literal('session.update'), session: Session }),
  z.object({ ...base, type: z.literal('agent.event'), event: AgentEvent }),
  z.object({ ...base, type: z.literal('approval.new'), approval: Approval }),
  z.object({
    ...base,
    type: z.literal('approval.resolved'),
    id: Id,
    status: z.enum(['approved', 'denied']),
  }),
  z.object({ ...base, type: z.literal('task.update'), task: Task }),
  z.object({ ...base, type: z.literal('task.removed'), id: Id }),
  z.object({ ...base, type: z.literal('project.update'), project: Project }),
  z.object({ ...base, type: z.literal('proposal.update'), proposal: Proposal }),
  z.object({ ...base, type: z.literal('settings.update'), settings: SettingsSnapshot }),
  z.object({ ...base, type: z.literal('learned.update'), learned: z.array(LearnedFact) }),
  /** Live state of the stage backend (mood, posture, gaze, connection). `live.rev` changes when GET /api/stage should be refetched. */
  z.object({ ...base, type: z.literal('stage.live'), live: StageLive }),
  /** The client refetched the snapshot (reconnect after sleep, daemon restart, sequence gap). Replace everything. */
  z.object({ ...base, type: z.literal('snapshot.reset'), snapshot: Snapshot }),
])
export type ServerEvent = z.infer<typeof ServerEvent>

export type Unsubscribe = () => void

/** Link state between the UI and whatever serves it. The fixture client is always 'online'. */
export type ConnectionState = 'connecting' | 'online' | 'offline'

/**
 * The only surface the UI talks to. The mockup implements it with an in-memory FixtureClient;
 * Phase 1 implements it with a WebSocket+REST client against the daemon. Swapping is one line.
 */
export interface ApiClient {
  getSnapshot(): Promise<Snapshot>
  subscribe(handler: (event: ServerEvent) => void): Unsubscribe
  /** Optional: report connection state changes (the daemon client does; the fixture client does not need to). */
  onConnection?(handler: (state: ConnectionState) => void): Unsubscribe

  sendChat(text: string, modality?: 'text' | 'voice'): Promise<void>
  /** Barge-in: stop the current reply. */
  interruptChat(): Promise<void>

  decideApproval(id: string, decision: 'approved' | 'denied'): Promise<void>
  decideProposal(id: string, decision: 'approved' | 'rejected'): Promise<void>
  moveTask(id: string, column: TaskColumn): Promise<void>
  createTask(input: { title: string; projectId?: string; column?: TaskColumn }): Promise<Task>

  setTrustMode(ruleId: string, mode: TrustRule['mode']): Promise<void>
  setClaudeMode(mode: 'api-key' | 'local-login'): Promise<void>
  setGuestMode(on: boolean): Promise<void>
  setWebcam(on: boolean): Promise<void>
  updatePersona(patch: Partial<SettingsSnapshot['persona']>): Promise<void>
  forgetFact(id: string): Promise<void>
}

export { BrainLayer }
