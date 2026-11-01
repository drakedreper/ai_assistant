/**
 * A scripted AgentBackend that costs zero tokens and never touches the network. It exists for tests, the daemon's
 * e2e script and offline demos, so it is deliberately good enough to demo: it streams emotion-tagged replies in small
 * chunks (the first chunk of every sentence is cut INSIDE the tag on purpose, so the lane's tag parser is always
 * exercised), calls the provided ToolBinding handlers for real, asks for permission when the user wants something
 * outward or destructive, supports barge-in, resume, and reports fake usage.
 *
 * Magic inputs for testing failure paths: "!error" (a retryable error event) and "!crash" (the session dies).
 */
import type { AgentBackend, AgentSession, BackendEvent, Emotion, OpenSessionOptions, PermissionDecision, ToolBinding, ToolResult, UserTurn } from '@ai-assistant/shared'
import { AsyncQueue, abortableSleep, deferred, isAutoTier, truncate } from './util'

export interface FakeBackendOptions {
  /** Pause between streamed chunks. Default 0 (a microtask yield, so a consumer can still interleave). */
  latencyMs?: number
  /** Characters per text_delta after the deliberately split first chunk of a sentence. Default 8. */
  chunkSize?: number
  /** Fixed cost reported per turn in USD. Default: a token-based estimate (a fraction of a cent). */
  costPerTurnUsd?: number
  /** Clock used for greetings and "today". Default: the real clock. */
  now?: () => Date
}

/** The backend plus a window into what the lane asked of it, for assertions. */
export interface FakeBackend extends AgentBackend {
  readonly kind: 'fake'
  /** Every OpenSessionOptions this backend was opened with, oldest first. */
  readonly opened: OpenSessionOptions[]
  /** Every session it handed out, oldest first. */
  readonly sessions: AgentSession[]
}

class TurnCtl {
  interrupted = false
  private readonly end = deferred<void>()
  /** Resolves once the turn has fully ended (its terminal event is queued). */
  readonly finished: Promise<void> = this.end.promise
  private cbs: Array<() => void> = []
  finish(): void {
    this.end.resolve()
  }
  get aborted(): boolean {
    return this.interrupted
  }
  onAbort(cb: () => void): void {
    if (this.interrupted) cb()
    else this.cbs.push(cb)
  }
  interrupt(): void {
    if (this.interrupted) return
    this.interrupted = true
    for (const cb of this.cbs.splice(0)) cb()
  }
}

const p2 = (n: number): string => String(n).padStart(2, '0')
const ymd = (d: Date): string => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
const addDays = (d: Date, n: number): Date => {
  const x = new Date(d)
  x.setDate(x.getDate() + n)
  return x
}
const tokens = (s: string): number => Math.ceil(s.length / 4)

/** Split so the first chunk ends inside the tag ("[ha"), then fixed-size pieces. */
export function chunkSentence(text: string, size: number): string[] {
  const out: string[] = []
  let rest = text
  const lead = /^\s*\[/.exec(text)
  if (lead && text.length > lead[0].length + 2) {
    const cut = lead[0].length + 2
    out.push(text.slice(0, cut))
    rest = text.slice(cut)
  }
  const step = Math.max(1, Math.floor(size))
  for (let i = 0; i < rest.length; i += step) out.push(rest.slice(i, i + step))
  return out
}

const firstLine = (text: string): string => text.split('\n').find((l) => l.trim()) ?? ''

/** Turn a tool result into something sayable: drop banners and ids, soften separators, keep it short. */
function sayable(text: string): string {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l && !/^untrusted content/i.test(l) && !/^mock (data|mode)/i.test(l))
  const head = (lines[0] ?? '').replace(/:$/, '')
  const items = lines
    .slice(1, 3)
    .map((l) => l.replace(/^(?:- |\d+\.\s*)/, '').replace(/\[[^\]]{1,40}\]\s*/g, '').replace(/ \| /g, ', '))
    .map((l) => truncate(l, 110))
  return truncate([head, ...items].filter(Boolean).join('. '), 280)
}

interface ReadCall {
  tool: string
  input: unknown
  label: string
  emotion: Emotion
}

class FakeSession implements AgentSession {
  readonly id: string
  readonly events: AsyncIterable<BackendEvent>
  private readonly queue = new AsyncQueue<BackendEvent>()
  private readonly byName = new Map<string, ToolBinding>()
  private readonly autoAllow: Set<string>
  private chain: Promise<void> = Promise.resolve()
  private active: TurnCtl | undefined
  private closed = false
  private turns = 0
  private toolSeq = 0
  private readonly pending = new Map<string, (d: PermissionDecision) => void>()

  constructor(
    id: string,
    private readonly opts: Required<Pick<FakeBackendOptions, 'latencyMs' | 'chunkSize' | 'now'>> & Pick<FakeBackendOptions, 'costPerTurnUsd'>,
    open: OpenSessionOptions,
  ) {
    this.id = id
    this.events = this.queue
    for (const b of open.tools) this.byName.set(b.spec.name, b)
    this.autoAllow = new Set(open.autoAllow ?? open.tools.filter((b) => isAutoTier(b.spec.tier)).map((b) => b.spec.name))
    this.queue.push({ type: 'session', sessionId: id })
  }

  send(turn: UserTurn): void {
    if (this.closed) return
    this.chain = this.chain.then(() => this.run(turn)).catch(() => undefined)
  }

  async interrupt(): Promise<void> {
    const t = this.active
    if (!t) return
    t.interrupt()
    await t.finished
  }

  resolvePermission(requestId: string, decision: PermissionDecision): void {
    const resolve = this.pending.get(requestId)
    if (!resolve) return
    this.pending.delete(requestId)
    resolve(decision)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const t = this.active
    t?.interrupt()
    await t?.finished
    this.queue.end()
  }

  // ------------------------------------------------------------------ one turn

  private push(ev: BackendEvent): void {
    this.queue.push(ev)
  }

  private async yieldOrSleep(t: TurnCtl): Promise<boolean> {
    if (this.opts.latencyMs > 0) return abortableSleep(this.opts.latencyMs, t)
    await Promise.resolve()
    return !t.interrupted
  }

  /** Stream one sentence as deltas. False when interrupted (nothing more is pushed after that). */
  private async stream(t: TurnCtl, sentence: string, spokenSoFar: { text: string }): Promise<boolean> {
    const text = spokenSoFar.text ? ` ${sentence}` : sentence
    spokenSoFar.text += text
    for (const chunk of chunkSentence(text, this.opts.chunkSize)) {
      if (t.interrupted) return false
      this.push({ type: 'text_delta', text: chunk })
      if (!(await this.yieldOrSleep(t))) return false
    }
    return !t.interrupted
  }

  private needsApproval(name: string): boolean {
    return !this.byName.has(name) || !this.autoAllow.has(name)
  }

  private awaitDecision(t: TurnCtl, requestId: string): Promise<PermissionDecision> {
    return new Promise<PermissionDecision>((resolve) => {
      this.pending.set(requestId, resolve)
      t.onAbort(() => {
        if (this.pending.delete(requestId)) resolve({ behavior: 'deny', message: 'The turn was interrupted.' })
      })
    })
  }

  /**
   * tool_start, then (if the tool needs a decision) permission_request and the wait, then the real handler.
   * The order mirrors the SDK: the tool_use block shows up first, the permission question follows.
   */
  private async callTool(t: TurnCtl, tool: string, input: unknown, meta?: { title: string; description: string }): Promise<{ outcome: 'ran'; result: ToolResult } | { outcome: 'denied'; message: string } | { outcome: 'unavailable' }> {
    const toolUseId = `fake-tool-${++this.toolSeq}`
    const binding = this.byName.get(tool)
    this.push({ type: 'tool_start', toolUseId, tool, input })
    if (this.needsApproval(tool)) {
      this.push({ type: 'permission_request', requestId: toolUseId, tool, input, ...(meta ? { title: meta.title, description: meta.description } : {}) })
      const decision = await this.awaitDecision(t, toolUseId)
      if (decision.behavior === 'deny') {
        this.push({ type: 'tool_end', toolUseId, ok: false, summary: truncate(decision.message, 120) })
        return { outcome: 'denied', message: decision.message }
      }
    }
    if (!binding) {
      this.push({ type: 'tool_end', toolUseId, ok: false, summary: 'tool not available in this lane' })
      return { outcome: 'unavailable' }
    }
    let result: ToolResult
    try {
      result = await binding.handler(input)
    } catch {
      result = { text: 'The tool failed.', isError: true }
    }
    this.push({ type: 'tool_end', toolUseId, ok: !result.isError, ...(result.isError ? { summary: truncate(firstLine(result.text), 120) } : {}) })
    return { outcome: 'ran', result }
  }

  private plan(text: string): { reads: ReadCall[]; action?: 'send' | 'edit' | 'spend' | 'remember'; reply?: Array<[Emotion, string]> } {
    const lower = text.toLowerCase()
    const now = this.opts.now()
    const reads: ReadCall[] = []
    const has = (re: RegExp) => re.test(lower)

    if (has(/\b(calendar|agenda|schedule|meetings?|today|tomorrow|this week)\b/)) {
      const from = has(/\btomorrow\b/) ? addDays(now, 1) : now
      const to = has(/\bthis week\b/) ? addDays(now, 6) : from
      reads.push({ tool: 'calendar_agenda', input: { from: ymd(from), to: ymd(to) }, label: 'your calendar', emotion: 'happy' })
    }
    if (has(/\b(what needs me|needs me|sessions?|agents?|claude code|blocked|worklog|mission control)\b/)) {
      reads.push({ tool: 'worklog_status', input: {}, label: 'your sessions', emotion: 'neutral' })
    }
    if (has(/\b(notes?|strategy|brain|vault|journal|positioning|q4)\b/)) {
      reads.push({ tool: 'brain_search', input: { query: text, limit: 3 }, label: 'your notes', emotion: 'thinking' })
    }
    if (has(/\b(money|runway|budget|finances?|bills?|savings|net worth)\b/)) {
      reads.push({ tool: 'finance_summary', input: {}, label: 'your finances', emotion: 'relaxed' })
    }
    if (has(/\b(mail|e-?mails?|inbox)\b/) && !has(/\bsend\b/)) {
      reads.push({ tool: 'mail_search', input: { query: text, limit: 3 }, label: 'your mail', emotion: 'neutral' })
    }
    if (has(/\b(news|headlines)\b/)) {
      reads.push({ tool: 'news_briefing', input: {}, label: 'the news', emotion: 'neutral' })
    }

    let action: 'send' | 'edit' | 'spend' | 'remember' | undefined
    // "(please) remember that I take my tea without sugar": writes to her character memory (a T2 tool, so it asks first).
    // Only the imperative at the start of a message: "do you remember that meeting" must not write anything.
    if (has(/^\s*(?:(?:please|pls),?\s+)?(?:(?:can|could|would) you\s+)?remember (?:that|this)\b[:,]?\s+\S/)) action = 'remember'
    else if (has(/\b(spend|pay|transfer|wire)\b/)) action = 'spend'
    else if (has(/\bsend\b/)) action = 'send'
    else if (has(/\b(delete|remove|rm)\b/)) action = 'edit'

    if (reads.length > 0 || action) return { reads, ...(action ? { action } : {}) }

    const hour = now.getHours()
    const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
    if (has(/\b(are you (a )?(human|real|person|ai)|do you have feelings)\b/)) {
      return { reads, reply: [['neutral', "No, I am an AI, built on Claude and running on this PC."], ['relaxed', 'I am warm in tone, but I am not a person.']] }
    }
    if (has(/\b(good ?night|going to bed)\b/)) return { reads, reply: [['relaxed', 'Goodnight. Lights low, agents quiet.']] }
    if (has(/\b(thanks|thank you|cheers)\b/)) return { reads, reply: [['shy', 'Happy to help.']] }
    if (has(/\b(sad|tired|awful|rough day|stressed|anxious)\b/)) {
      return { reads, reply: [['sad', 'I am sorry it has been a rough one.'], ['relaxed', 'No pressure from me. Tell me what would help right now.']] }
    }
    if (has(/\b(hi|hello|hey|good (morning|afternoon|evening))\b/)) {
      return { reads, reply: [['happy', `${greeting}!`], ['relaxed', 'I am running in offline demo mode, so I only know a few tricks.'], ['neutral', 'Ask about your calendar, what needs you, your notes or your runway.']] }
    }
    return {
      reads,
      reply: [
        ['thinking', 'I am in offline demo mode, so I cannot really think that through.'],
        ['neutral', 'Ask me about today, what needs you, your notes on strategy, or your runway, and I will use my tools.'],
      ],
    }
  }

  private async run(turn: UserTurn): Promise<void> {
    if (this.closed) return
    const t = new TurnCtl()
    this.active = t
    try {
      await this.script(t, turn)
    } finally {
      this.active = undefined
      for (const [id, resolve] of this.pending) {
        this.pending.delete(id)
        resolve({ behavior: 'deny', message: 'The turn ended.' })
      }
      t.finish()
    }
  }

  private async script(t: TurnCtl, turn: UserTurn): Promise<void> {
    const spoken = { text: '' }
    const lower = turn.text.toLowerCase()
    if (/!crash\b/.test(lower)) {
      // The session dies without a terminal event: the lane must notice the stream ending.
      this.closed = true
      this.queue.end()
      return
    }
    if (/!error\b/.test(lower)) {
      this.push({ type: 'error', message: 'Simulated backend failure (!error).', retryable: true, kind: 'process', costUsd: 0 })
      return
    }

    const plan = this.plan(turn.text)
    const say = (emotion: Emotion, s: string) => this.stream(t, `[${emotion}] ${s}`, spoken)

    if (plan.reply) {
      for (const [emotion, s] of plan.reply) if (!(await say(emotion, s))) break
    } else {
      const ack = plan.reads.length > 0 ? `Let me check ${plan.reads.map((r) => r.label).join(' and ')}.` : 'That one needs your okay first.'
      let go = await say('thinking', ack)

      for (const r of plan.reads) {
        if (!go) break
        if (!this.byName.has(r.tool)) {
          // Not bound in this lane: say so, and never pretend or invoke anything.
          go = await say('sad', `I do not have a tool for ${r.label} right now.`)
          continue
        }
        const outcome = await this.callTool(t, r.tool, r.input)
        if (t.interrupted) {
          go = false
          break
        }
        if (outcome.outcome === 'ran') {
          go = outcome.result.isError ? await say('sad', `I could not do that: ${truncate(firstLine(outcome.result.text), 120)}`) : await say(r.emotion, sayable(outcome.result.text))
        } else {
          go = await say('sad', outcome.outcome === 'denied' ? 'I was not allowed to look that up.' : 'I do not have that tool right now.')
        }
      }

      if (go && plan.action) {
        const remembered = (/remember (?:that|this)\b[:,]?\s+([\s\S]+)$/i.exec(turn.text)?.[1] ?? '').trim().slice(0, 300)
        const spec =
          plan.action === 'remember'
            ? { tool: 'character_remember', input: { kind: 'preference', text: remembered, importance: 3 }, title: 'Remember something about you', description: 'The assistant wants to write something down in her memory.' }
            : plan.action === 'send'
              ? { tool: 'mail_send', input: { draftId: 'draft-priya-reply' }, title: 'Send the reply to Priya', description: 'The assistant wants to send a drafted email.' }
              : plan.action === 'edit'
                ? { tool: 'brain_upsert_note', input: { path: '50-inbox/scratch.md', bodyPatch: '(removed)' }, title: 'Edit note 50-inbox/scratch.md', description: 'The assistant wants to change a note in your vault.' }
                : { tool: 'finance_move_money', input: {}, title: 'Move money', description: 'The assistant wants to move money.' }
        if (plan.reads.length > 0) go = await say('thinking', 'That last part needs your okay first.')
        if (go) {
          const out = await this.callTool(t, spec.tool, spec.input, { title: spec.title, description: spec.description })
          if (t.interrupted) go = false
          else if (out.outcome === 'ran') go = await say(out.result.isError ? 'sad' : 'happy', out.result.isError ? `That did not work: ${truncate(firstLine(out.result.text), 120)}` : plan.action === 'remember' ? 'Okay, I will remember that.' : 'Done. It went through the mock tool, so nothing really changed.')
          else if (out.outcome === 'denied') go = await say('neutral', plan.action === 'remember' ? 'Okay, I will not write that down.' : 'Okay, I will not do that.')
          else go = await say('sad', 'I cannot do that one at all.')
        }
      }
    }

    if (this.queue.isEnded) return
    this.turns++
    const input = tokens(turn.text) + tokens(turn.context ?? '') + 24
    const output = tokens(spoken.text)
    const cacheRead = this.turns > 1 ? 900 : 0
    const cacheCreate = this.turns === 1 ? 900 : 0
    const cost = this.opts.costPerTurnUsd ?? Math.round(((input * 3 + output * 15 + cacheRead * 0.3 + cacheCreate * 3.75) / 1e6) * 1e6) / 1e6
    this.push({ type: 'turn_end', costUsd: cost, usage: { input, output, cacheRead, cacheCreate }, ...(t.interrupted ? { interrupted: true } : {}) })
  }
}

export function createFakeBackend(opts: FakeBackendOptions = {}): FakeBackend {
  const resolved = {
    latencyMs: Math.max(0, opts.latencyMs ?? 0),
    chunkSize: opts.chunkSize ?? 8,
    now: opts.now ?? (() => new Date()),
    ...(opts.costPerTurnUsd !== undefined ? { costPerTurnUsd: opts.costPerTurnUsd } : {}),
  }
  const opened: OpenSessionOptions[] = []
  const sessions: AgentSession[] = []
  let counter = 0
  return {
    kind: 'fake',
    opened,
    sessions,
    async open(open: OpenSessionOptions): Promise<AgentSession> {
      opened.push(open)
      const id = open.resumeSessionId ?? `fake-${open.lane}-${++counter}`
      const session = new FakeSession(id, resolved, open)
      sessions.push(session)
      return session
    },
  }
}
