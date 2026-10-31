import { buildSnapshot } from '@ai-assistant/shared/fixtures'
import type {
  ApiClient,
  ChatMessage,
  Emotion,
  ServerEvent,
  Session,
  Snapshot,
  Task,
  TaskColumn,
  Unsubscribe,
} from '@ai-assistant/shared'
import { scriptReply } from './chatScript'

type Draft<T> = T extends unknown ? Omit<T, 'seq' | 'ts'> : never

/** Deterministic fake short git sha, so approved proposals show a believable, reversible commit. */
const fakeSha = (seed: string): string => {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619)
  return (h >>> 0).toString(16).padStart(8, '0').slice(0, 7)
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

const SIM_TOOLS: Array<[string, string]> = [
  ['Read', 'Read src/server.ts'],
  ['Grep', 'Searched for "WebSocket"'],
  ['Edit', 'Edited src/routes/health.ts'],
  ['Bash', 'Ran pnpm test (12 passed)'],
  ['Write', 'Wrote tests/health.test.ts'],
  ['Read', 'Read package.json'],
]

/**
 * In-memory ApiClient used by the mockup. It builds the fixture snapshot and then behaves like the
 * future daemon: it pushes live events (agent activity, chat tokens, approvals) over `subscribe`.
 * Pass `{ simulate: false }` (or add ?static to the URL) for a frozen, screenshot-friendly mockup.
 */
export class FixtureClient implements ApiClient {
  private snap: Snapshot
  private handlers = new Set<(e: ServerEvent) => void>()
  private seq = 0
  private n = 0
  private streamToken = 0
  private currentMsgId: string | null = null
  private timers: ReturnType<typeof setInterval>[] = []

  constructor(opts: { simulate?: boolean; now?: Date } = {}) {
    this.snap = buildSnapshot(opts.now ?? new Date())
    if (opts.simulate !== false) this.startSimulator()
  }

  // ---- ApiClient: reads ----
  async getSnapshot(): Promise<Snapshot> {
    return structuredClone(this.snap)
  }

  subscribe(handler: (e: ServerEvent) => void): Unsubscribe {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  // ---- chat ----
  async sendChat(text: string, modality: 'text' | 'voice' = 'text'): Promise<void> {
    const msg: ChatMessage = {
      id: this.id('u'),
      role: 'user',
      createdAt: new Date().toISOString(),
      modality,
      parts: [{ type: 'text', text }],
    }
    this.snap.chat.push(msg)
    this.emit({ type: 'chat.message', message: structuredClone(msg) })
    void this.reply(text)
  }

  async interruptChat(): Promise<void> {
    this.streamToken++
    // Close the in-flight message so the UI clears its streaming state (barge-in).
    if (this.currentMsgId) this.emit({ type: 'chat.done', messageId: this.currentMsgId })
    this.emit({ type: 'avatar', event: { type: 'pose', state: 'idle' } })
  }

  private async reply(text: string): Promise<void> {
    const token = ++this.streamToken
    this.emit({ type: 'avatar', event: { type: 'pose', state: 'thinking' } })
    await sleep(650)
    if (token !== this.streamToken) return

    const msg: ChatMessage = {
      id: this.id('a'),
      role: 'assistant',
      createdAt: new Date().toISOString(),
      modality: 'text',
      parts: [],
    }
    this.snap.chat.push(msg)
    this.currentMsgId = msg.id
    const push = () => this.emit({ type: 'chat.message', message: structuredClone(msg) })

    for (const step of scriptReply(text, this.snap)) {
      if (token !== this.streamToken) return
      if (step.kind === 'tool') {
        msg.parts.push({ type: 'tool', tool: step.tool, summary: step.summary, status: 'running' })
        push()
        await sleep(520)
        const last = msg.parts[msg.parts.length - 1]
        if (last?.type === 'tool') last.status = 'done'
        push()
      } else if (step.kind === 'part') {
        msg.parts.push(step.part)
        push()
        await sleep(260)
      } else {
        msg.parts.push({ type: 'text', text: '', emotion: step.emotion })
        push()
        this.emit({ type: 'avatar', event: { type: 'expression', emotion: step.emotion, intensity: 0.85 } })
        this.emit({ type: 'avatar', event: { type: 'pose', state: 'speaking' } })
        this.emit({ type: 'avatar', event: { type: 'speak', text: step.text, emotion: step.emotion } })
        const words = step.text.split(' ')
        for (let i = 0; i < words.length; i += 2) {
          if (token !== this.streamToken) return
          const chunk = words.slice(i, i + 2).join(' ') + (i + 2 < words.length ? ' ' : '')
          const last = msg.parts[msg.parts.length - 1]
          if (last?.type === 'text') last.text += chunk
          this.emit({ type: 'chat.delta', messageId: msg.id, text: chunk })
          await sleep(70)
        }
        await sleep(160)
      }
    }
    this.currentMsgId = null
    this.emit({ type: 'chat.done', messageId: msg.id })
    this.emit({ type: 'avatar', event: { type: 'pose', state: 'idle' } })
  }

  /** Mira speaks unprompted (used by approvals and the simulator). */
  private say(text: string, emotion: Emotion): void {
    const msg: ChatMessage = {
      id: this.id('a'),
      role: 'assistant',
      createdAt: new Date().toISOString(),
      modality: 'text',
      parts: [{ type: 'text', text, emotion }],
    }
    this.snap.chat.push(msg)
    this.emit({ type: 'chat.message', message: structuredClone(msg) })
    this.emit({ type: 'avatar', event: { type: 'expression', emotion, intensity: 0.8 } })
  }

  // ---- decisions ----
  async decideApproval(id: string, decision: 'approved' | 'denied'): Promise<void> {
    const ap = this.snap.approvals.find((a) => a.id === id)
    if (!ap || ap.status !== 'pending') return
    ap.status = decision
    this.emit({ type: 'approval.resolved', id, status: decision })

    if (ap.sessionId) {
      const s = this.snap.sessions.find((x) => x.id === ap.sessionId)
      if (s && s.status === 'blocked_permission') {
        s.status = decision === 'approved' ? 'running' : 'waiting_input'
        s.updatedAt = new Date().toISOString()
        if (decision === 'approved') s.currentTool = 'Bash'
        this.emitSession(s)
      }
    }
    if (ap.kind === 'brain_proposal' && ap.refId) {
      const p = this.snap.proposals.find((x) => x.id === ap.refId)
      if (p && p.status === 'pending') {
        p.status = decision === 'approved' ? 'approved' : 'rejected'
        p.decidedAt = new Date().toISOString()
        if (decision === 'approved') p.commit = fakeSha(p.id + p.decidedAt)
        this.emit({ type: 'proposal.update', proposal: structuredClone(p) })
      }
    }
    this.say(
      decision === 'approved'
        ? ap.kind === 'email_draft'
          ? 'Sent. I will tell you when they reply.'
          : 'Done. I told it to go ahead.'
        : 'Denied. I asked it to find another way.',
      decision === 'approved' ? 'happy' : 'neutral',
    )
  }

  async decideProposal(id: string, decision: 'approved' | 'rejected'): Promise<void> {
    const p = this.snap.proposals.find((x) => x.id === id)
    if (!p || p.status !== 'pending') return
    p.status = decision
    p.decidedAt = new Date().toISOString()
    if (decision === 'approved') p.commit = fakeSha(p.id + p.decidedAt)
    this.emit({ type: 'proposal.update', proposal: structuredClone(p) })
    const ap = this.snap.approvals.find((a) => a.refId === id && a.status === 'pending')
    if (ap) {
      ap.status = decision === 'approved' ? 'approved' : 'denied'
      this.emit({ type: 'approval.resolved', id: ap.id, status: ap.status as 'approved' | 'denied' })
    }
    this.say(
      decision === 'approved'
        ? 'Applied, and committed to your vault so you can undo it any time.'
        : 'Rejected. I will not bring that wording back unless you ask.',
      decision === 'approved' ? 'happy' : 'neutral',
    )
  }

  async moveTask(id: string, column: TaskColumn): Promise<void> {
    const t = this.snap.tasks.find((x) => x.id === id)
    if (!t) return
    t.column = column
    this.emit({ type: 'task.update', task: structuredClone(t) })
  }

  async createTask(input: { title: string; projectId?: string; column?: TaskColumn }): Promise<Task> {
    const t: Task = {
      id: this.id('t'),
      title: input.title,
      column: input.column ?? 'todo',
      priority: 'medium',
      sessionIds: [],
      source: 'manual',
      ...(input.projectId ? { projectId: input.projectId } : {}),
    }
    this.snap.tasks.push(t)
    this.emit({ type: 'task.update', task: structuredClone(t) })
    return t
  }

  // ---- settings ----
  async setTrustMode(ruleId: string, mode: 'ask' | 'auto'): Promise<void> {
    const r = this.snap.settings.trustRules.find((x) => x.id === ruleId)
    if (!r || r.locked) return
    r.mode = mode
    if (mode === 'auto') r.promotionSuggested = false
    this.emitSettings()
  }
  async setClaudeMode(mode: 'api-key' | 'local-login'): Promise<void> {
    this.snap.settings.claude.mode = mode
    this.emitSettings()
  }
  async setGuestMode(on: boolean): Promise<void> {
    this.snap.settings.guestMode = on
    this.emitSettings()
  }
  async setWebcam(on: boolean): Promise<void> {
    this.snap.settings.webcam.enabled = on
    this.emitSettings()
  }
  async updatePersona(patch: Partial<Snapshot['settings']['persona']>): Promise<void> {
    Object.assign(this.snap.settings.persona, patch)
    this.emitSettings()
  }
  async forgetFact(id: string): Promise<void> {
    this.snap.learned = this.snap.learned.filter((f) => f.id !== id)
    this.emit({ type: 'learned.update', learned: structuredClone(this.snap.learned) })
  }

  // ---- internals ----
  private id(prefix: string): string {
    return `${prefix}-${Date.now().toString(36)}-${++this.n}`
  }

  private emit(draft: Draft<ServerEvent>): void {
    const e = { ...draft, seq: ++this.seq, ts: new Date().toISOString() } as ServerEvent
    for (const h of this.handlers) h(e)
  }

  private emitSession(s: Session): void {
    this.emit({ type: 'session.update', session: structuredClone(s) })
  }

  private emitSettings(): void {
    this.emit({ type: 'settings.update', settings: structuredClone(this.snap.settings) })
  }

  /** Makes the mockup feel alive: agents tick, costs creep up, and one new approval arrives. */
  private startSimulator(): void {
    let tick = 0
    this.timers.push(
      setInterval(() => {
        tick++
        const running = this.snap.sessions.filter((s) => s.status === 'running')
        const s = running[tick % Math.max(running.length, 1)]
        if (s) {
          const [tool, summary] = SIM_TOOLS[tick % SIM_TOOLS.length] as [string, string]
          s.currentTool = tool
          s.updatedAt = new Date().toISOString()
          s.costUsd = +(s.costUsd + 0.01 + (tick % 4) * 0.01).toFixed(2)
          s.contextPct = Math.min(92, s.contextPct + (tick % 3 === 0 ? 1 : 0))
          const main = s.agents[0]
          if (main) main.lastMessage = summary
          this.emitSession(s)
          this.emit({
            type: 'agent.event',
            event: {
              id: this.id('ev'),
              ts: new Date().toISOString(),
              sessionId: s.id,
              agentId: 'main',
              hookEvent: 'PostToolUse',
              toolName: tool,
              summary,
              level: 'info',
            },
          })
        }
        // One new approval arrives ~40 s in, so the Needs-you queue visibly reacts.
        if (tick === 8 && !this.snap.approvals.some((a) => a.id === 'ap-npm-install')) {
          const d = this.snap.sessions.find((x) => x.id === 's-daemon')
          if (d && d.status === 'running') {
            d.status = 'blocked_permission'
            d.currentTool = 'Bash'
            this.emitSession(d)
            const ap = {
              id: 'ap-npm-install',
              kind: 'tool_permission' as const,
              title: 'Daemon session wants to install a package',
              detail: 'Session "Scaffold daemon health endpoint" asks to run a shell command.',
              requestedAt: new Date().toISOString(),
              sessionId: d.id,
              status: 'pending' as const,
              risk: 'low' as const,
              tier: 'T4' as const,
              preview: 'pnpm add hono @hono/node-server',
              area: 'work' as const,
            }
            this.snap.approvals.push(ap)
            this.emit({ type: 'approval.new', approval: structuredClone(ap) })
            this.say('Heads up: the daemon session wants to install hono. Low risk, but it is your call.', 'thinking')
          }
        }
      }, 5000),
    )
  }
}
