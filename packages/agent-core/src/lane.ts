/**
 * The Secretary lane: one long-lived streaming session with the persona and the lane's tools, turned into the
 * events the UI understands.
 *
 * What it does for each user message:
 *   1. records the message (store.upsertChat + chat.message), then checks the budget; over budget means a system
 *      notice and NO backend call;
 *   2. sends it to the backend session and consumes BackendEvents, building ONE assistant ChatMessage
 *      incrementally: text parts (emotion tags parsed off, never shown), tool chips running -> done/error, approval
 *      cards when a tool needs a human; every change is persisted and emitted (chat.message for structure,
 *      chat.delta for text);
 *   3. drives the avatar: pose thinking -> speaking -> idle, an expression per tag, a speak per finished sentence;
 *   4. ends the turn exactly once (chat.done, pose idle), records the cost with the budget guard.
 *
 * Failure handling: a backend error becomes a friendly assistant message and, when restarting can help, a bounded
 * automatic restart with backoff (max N tries; timers are injectable). The session id is persisted so a restart
 * resumes the conversation. All state is per instance.
 */
import { TOOL_SURFACE } from '@ai-assistant/shared'
import type {
  AgentSession,
  AvatarEvent,
  BackendErrorKind,
  BackendEvent,
  ChatMessage,
  ChatPart,
  Emotion,
  LaneDeps,
  LaneState,
  LaneStatus,
  OpenSessionOptions,
  SecretaryLane,
  ServerEventDraft,
  ToolBinding,
  ToolSpec,
  UserTurn,
} from '@ai-assistant/shared'
import { EmotionStreamParser } from './emotion'
import type { EmotionEvent } from './emotion'
import { buildDynamicBlock, buildStablePrompt, localDate } from './persona'
import { auditTarget, createPermissionBroker, hasPrivateInput } from './permissions'
import type { PermissionBroker } from './permissions'
import { cloudNote, toolLabel } from './tool-labels'
import { BackendError, deferred, errorText, isAutoTier, oneLine, redactSecrets, truncate } from './util'
import type { Deferred } from './util'

export interface LaneTimers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface LaneOptions {
  /** Automatic restarts before giving up until the user sends another message. Default 3. */
  maxRestarts?: number
  /** Delay before automatic restart number `attempt` (1-based). Default: 1 s doubling, capped at 30 s. */
  backoffMs?: (attempt: number) => number
  /** Injected in tests so backoff and the interrupt wait never need real time. */
  timers?: LaneTimers
  /** How long interrupt() waits for the backend's terminal event before ending the turn itself. Default 5 s. */
  interruptTimeoutMs?: number
  /** Which tools run without a card. Default: tiers T0 and T1 (ADR 0005). */
  isAutoApproved?: (spec: ToolSpec) => boolean
  /** Stable text for the persona prompt's "what you know about the user" section. */
  digest?: () => string | undefined
  /** How many recent messages seed a session that could not be resumed. Default 8; 0 disables. */
  seedMessages?: number
}

/** The lane plus a way for tests and the daemon to wait until nothing is running or queued. */
export interface SecretaryLaneImpl extends SecretaryLane {
  whenIdle(): Promise<void>
}

const LANE = 'secretary' as const
const EXPRESSION_INTENSITY = 0.85

interface ActiveTurn {
  userTurn: UserTurn
  parser: EmotionStreamParser
  message: ChatMessage | undefined
  toolParts: Map<string, number>
  /** Chip text per tool call: present tense while it runs, past tense when it finished. */
  toolLabels: Map<string, { running: string; done: string }>
  /** The next text starts a new text part (after a tag, a tool chip or a flush). */
  newPart: boolean
  speaking: boolean
  interrupted: boolean
  finished: boolean
  done: Deferred<void>
}

const FRIENDLY: Record<BackendErrorKind, string> = {
  refusal: 'Sorry, I cannot help with that one. Want to try it another way?',
  auth: 'I cannot reach Claude: the API key was rejected or is missing. Check the Claude connection in Settings.',
  billing: 'Claude says the account is out of credit. Add credit or switch the connection in Settings, and I will be back.',
  budget: 'I hit this session\'s spending cap, so I stopped. Raise the budget in Settings, or send another message and I will start a fresh session.',
  rate_limit: 'Claude is rate limiting me right now. Give it a minute and try again.',
  overloaded: 'Claude is overloaded at the moment. Try again in a moment.',
  invalid_request: 'Claude rejected that request, so I could not answer. Try rephrasing it.',
  process: 'Something went wrong on my side and I lost the thread. I am reconnecting; try again in a moment.',
  unknown: 'Something went wrong and I could not finish that. I am reconnecting; try again in a moment.',
}

/** Failures after which the session itself is still fine, so there is nothing to restart. */
const SESSION_SURVIVES: ReadonlySet<BackendErrorKind> = new Set(['refusal', 'rate_limit', 'overloaded', 'invalid_request'])

const defaultTimers: LaneTimers = {
  setTimeout: (fn, ms) => {
    const h = setTimeout(fn, ms)
    h.unref?.()
    return h
  },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
}

export function createSecretaryLane(deps: LaneDeps, opts: LaneOptions = {}): SecretaryLaneImpl {
  const maxRestarts = opts.maxRestarts ?? 3
  const backoffMs = opts.backoffMs ?? ((n: number) => Math.min(30_000, 1000 * 2 ** (n - 1)))
  const timers = opts.timers ?? defaultTimers
  const interruptTimeoutMs = opts.interruptTimeoutMs ?? 5000
  const seedMessages = opts.seedMessages ?? 8
  const isAuto = opts.isAutoApproved ?? ((spec: ToolSpec) => isAutoTier(spec.tier))

  // The lane's tools: its own lane, never a locked one. The broker and the backend enforce the same rule again.
  const tools: ToolBinding[] = deps.tools.filter((b) => (b.spec.lanes as readonly string[]).includes(LANE) && !b.spec.locked)
  const autoNames = tools.filter((b) => isAuto(b.spec)).map((b) => b.spec.name)
  const autoSet = new Set(autoNames)
  const broker: PermissionBroker = createPermissionBroker({ lane: LANE, store: deps.store, tools, emit: (d) => emit(d), now: deps.now, newId: deps.newId, cwd: deps.cwd, assistantName: () => deps.getPersona().name })

  let phase: 'new' | 'running' | 'stopped' = 'new'
  let state: LaneState = 'stopped'
  let lastError: string | undefined
  let lastKind: BackendErrorKind | undefined
  /** Why a tool call did not run, by backend request id, for the chip text ("denied", "blocked"...). */
  const outcomes = new Map<string, string>()
  let session: AgentSession | undefined
  let sessionGen = 0
  /** The local date the session was opened on. A session older than that is renewed (see pump). */
  let sessionDay = ''
  let backendSessionId: string | undefined
  let turn: ActiveTurn | undefined
  const queue: UserTurn[] = []
  let orphanTerminals = 0
  let restartAttempts = 0
  let restartTimer: unknown
  let opening: Promise<void> | undefined
  let starting: Promise<void> | undefined
  let pumping = false
  let lastContext: string | undefined
  let seed: string | undefined
  let idleWaiters: Array<() => void> = []

  // ------------------------------------------------------------------ small helpers

  function emit(draft: ServerEventDraft): void {
    try {
      deps.emit(draft)
    } catch {
      // A broken subscriber must never take the lane down.
    }
  }

  const nowIso = (): string => deps.now().toISOString()

  function persist(message: ChatMessage): void {
    try {
      deps.store.upsertChat(structuredClone(message))
    } catch {
      // Persistence trouble must not stop the conversation; the live events still flow.
    }
  }

  /** Persist and announce a whole message (new, or its structure changed). */
  function commit(message: ChatMessage): void {
    persist(message)
    emit({ type: 'chat.message', message: structuredClone(message) })
  }

  function avatar(event: AvatarEvent): void {
    emit({ type: 'avatar', event })
  }

  function audit(entry: Parameters<typeof deps.store.audit>[0]): void {
    try {
      deps.store.audit(entry)
    } catch {
      // see persist()
    }
  }

  function notice(role: 'assistant' | 'system', text: string, emotion?: Emotion): void {
    const message: ChatMessage = {
      id: deps.newId(role === 'system' ? 's' : 'a'),
      role,
      createdAt: nowIso(),
      modality: 'text',
      parts: [{ type: 'text', text, ...(emotion ? { emotion } : {}) }],
    }
    commit(message)
    if (emotion) avatar({ type: 'expression', emotion, intensity: EXPRESSION_INTENSITY })
  }

  function resolveIdle(): void {
    if (turn || queue.length > 0 || pumping || opening) return
    const waiters = idleWaiters
    idleWaiters = []
    for (const w of waiters) w()
  }

  // ------------------------------------------------------------------ session lifecycle

  function closeSession(): void {
    const s = session
    session = undefined
    sessionGen++
    if (s) void s.close().catch(() => undefined)
  }

  function scheduleRestart(announce: boolean): void {
    if (phase !== 'running') return
    if (restartTimer !== undefined) return
    restartAttempts++
    if (restartAttempts > maxRestarts) {
      lastError = lastError ?? 'The connection to Claude could not be restored.'
      if (announce) notice('system', 'I lost my connection to Claude and could not restore it. Send me a message and I will try again.')
      return
    }
    restartTimer = timers.setTimeout(() => {
      restartTimer = undefined
      if (phase === 'running' && !session) void openSession()
    }, backoffMs(restartAttempts))
  }

  function failOpen(e: unknown): void {
    const typed = e instanceof BackendError ? e : undefined
    session = undefined
    state = 'error'
    lastKind = typed?.kind ?? 'process'
    lastError = truncate(redactSecrets(oneLine(errorText(e))), 200)
    if (typed?.retryable ?? true) scheduleRestart(!pumping)
  }

  function openSession(): Promise<void> {
    if (opening) return opening
    opening = doOpen()
      // Whatever goes wrong while opening is a lane failure to report, never an unhandled rejection in the daemon.
      .catch((e: unknown) => failOpen(e))
      .finally(() => {
        opening = undefined
        resolveIdle()
      })
    return opening
  }

  async function doOpen(): Promise<void> {
    state = 'starting'
    lastError = undefined
    lastKind = undefined
    const claude = deps.getClaude()
    const cfg = claude.lanes.find((l) => l.id === LANE)
    if (cfg && !cfg.enabled) {
      state = 'stopped'
      lastError = 'The Secretary lane is switched off in Settings.'
      return
    }
    const persona = deps.getPersona()
    const base: OpenSessionOptions = {
      lane: LANE,
      systemPrompt: buildStablePrompt(persona, opts.digest?.()),
      model: cfg?.model ?? 'claude-sonnet-5-5',
      effort: cfg?.effort ?? 'medium',
      cwd: deps.cwd,
      tools,
      autoAllow: autoNames,
      authMode: claude.mode,
      ...(cfg && cfg.dailyBudgetUsd > 0 ? { maxBudgetUsd: cfg.dailyBudgetUsd } : {}),
      ...(deps.env.apiKey && claude.mode === 'api-key' ? { apiKey: deps.env.apiKey } : {}),
      ...(deps.env.claudeExecutable && claude.mode === 'local-login' ? { claudeExecutable: deps.env.claudeExecutable } : {}),
    }
    let resumeId: string | undefined
    try {
      resumeId = deps.store.loadBackendSessionId(LANE)
    } catch {
      resumeId = undefined
    }

    let opened: AgentSession | undefined
    let resumed = false
    try {
      opened = await deps.backend.open(resumeId ? { ...base, resumeSessionId: resumeId } : base)
      resumed = resumeId !== undefined
    } catch (e) {
      // A transient failure or a credential problem says nothing about the old conversation, so it is kept for the
      // next attempt; only an unexplained refusal to resume is taken to mean the conversation is gone.
      const transient = e instanceof BackendError && (e.retryable || e.kind === 'auth')
      if (resumeId && !transient) {
        // The old conversation could not be resumed (expired, moved): start a fresh one rather than stay broken.
        try {
          opened = await deps.backend.open(base)
        } catch (e2) {
          failOpen(e2)
          return
        }
      } else {
        failOpen(e)
        return
      }
    }
    if (phase === 'stopped') {
      void opened.close().catch(() => undefined)
      return
    }
    session = opened
    sessionDay = localDate(deps.now())
    const gen = ++sessionGen
    state = 'ready'
    lastContext = undefined
    seed = resumed ? undefined : buildSeed()
    void consume(opened, gen)
  }

  /** A short digest of recent chat for a session that starts without its history. */
  function buildSeed(): string | undefined {
    if (seedMessages <= 0) return undefined
    let recent: ChatMessage[]
    try {
      recent = deps.store.recentChat(seedMessages)
    } catch {
      return undefined
    }
    const lines: string[] = []
    for (const m of recent) {
      if (m.role === 'system') continue
      const text = m.parts
        .filter((p): p is Extract<ChatPart, { type: 'text' }> => p.type === 'text')
        .map((p) => p.text)
        .join(' ')
      if (text.trim()) lines.push(`${m.role === 'user' ? 'User' : 'You'}: ${truncate(oneLine(text), 240)}`)
    }
    return lines.length ? `Earlier in this conversation (oldest first; for continuity only):\n${lines.join('\n')}` : undefined
  }

  async function consume(s: AgentSession, gen: number): Promise<void> {
    try {
      for await (const ev of s.events) {
        if (gen !== sessionGen) return
        onEvent(ev)
      }
    } catch (e) {
      if (gen === sessionGen && phase === 'running') onFailure({ message: errorText(e), retryable: true, kind: 'process' })
      return
    }
    if (gen === sessionGen && phase === 'running') onFailure({ message: 'The Claude session ended unexpectedly.', retryable: true, kind: 'process' })
  }

  // ------------------------------------------------------------------ building the assistant message

  function ensureMessage(t: ActiveTurn): ChatMessage {
    if (!t.message) {
      t.message = { id: deps.newId('a'), role: 'assistant', createdAt: nowIso(), modality: 'text', parts: [] }
    }
    return t.message
  }

  function appendText(t: ActiveTurn, text: string, emotion: Emotion): void {
    const msg = ensureMessage(t)
    const last = msg.parts[msg.parts.length - 1]
    if (t.newPart || !last || last.type !== 'text') {
      msg.parts.push({ type: 'text', text, emotion })
      t.newPart = false
      commit(msg)
    } else {
      last.text += text
      persist(msg)
      emit({ type: 'chat.delta', messageId: msg.id, text })
    }
  }

  function handleParsed(t: ActiveTurn, events: EmotionEvent[]): void {
    for (const e of events) {
      if (e.type === 'emotion') {
        t.newPart = true
        avatar({ type: 'expression', emotion: e.emotion, intensity: EXPRESSION_INTENSITY })
      } else if (e.type === 'text') {
        appendText(t, e.text, e.emotion)
      } else {
        if (!t.speaking) {
          t.speaking = true
          avatar({ type: 'pose', state: 'speaking' })
        }
        avatar({ type: 'speak', text: e.text, emotion: e.emotion })
      }
    }
  }

  function flushParser(t: ActiveTurn): void {
    handleParsed(t, t.parser.flush())
    t.newPart = true
  }

  // ------------------------------------------------------------------ turns

  function newTurn(userTurn: UserTurn): ActiveTurn {
    return {
      userTurn,
      parser: new EmotionStreamParser({ unknownTags: 'strip' }),
      message: undefined,
      toolParts: new Map(),
      toolLabels: new Map(),
      newPart: true,
      speaking: false,
      interrupted: false,
      finished: false,
      done: deferred<void>(),
    }
  }

  function contextFor(userTurn: UserTurn): string | undefined {
    const pieces: string[] = []
    const block = buildDynamicBlock(deps.getPersona(), deps.now())
    if (block !== lastContext) {
      pieces.push(block)
      lastContext = block
    }
    if (seed) {
      pieces.push(seed)
      seed = undefined
    }
    if (userTurn.modality === 'voice') pieces.push('This message was spoken aloud; answer in one or two short spoken sentences.')
    return pieces.length ? pieces.join('\n') : undefined
  }

  function begin(userTurn: UserTurn): void {
    const s = session
    if (!s) return
    const t = newTurn(userTurn)
    turn = t
    state = 'busy'
    outcomes.clear()
    avatar({ type: 'pose', state: 'thinking' })
    const context = contextFor(userTurn)
    try {
      s.send({ ...userTurn, ...(context ? { context } : {}) })
    } catch (e) {
      onFailure({ message: errorText(e), retryable: true, kind: 'process' })
    }
  }

  async function pump(): Promise<void> {
    if (pumping) return
    pumping = true
    try {
      while (!turn && queue.length > 0 && phase === 'running') {
        const next = queue.shift()!
        const budget = deps.budget.check(LANE)
        if (!budget.ok) {
          queue.length = 0
          notice('system', budget.reason)
          break
        }
        // A long-lived session is renewed once per day (resuming the same conversation). That keeps the SDK's own
        // per-session cost cap in step with the DAILY budget, and lets persona edits take effect.
        if (session && sessionDay !== localDate(deps.now())) closeSession()
        if (!session) {
          if (restartTimer !== undefined) {
            timers.clearTimeout(restartTimer)
            restartTimer = undefined
          }
          await openSession()
          if (!session) {
            queue.length = 0
            if (state === 'stopped') notice('system', lastError ?? 'The Secretary lane is switched off.')
            else notice('assistant', FRIENDLY[lastKind ?? 'process'], 'sad')
            break
          }
        }
        begin(next)
      }
    } catch (e) {
      queue.length = 0
      lastError = truncate(redactSecrets(oneLine(errorText(e))), 200)
      notice('assistant', FRIENDLY.unknown, 'sad')
    } finally {
      pumping = false
      resolveIdle()
    }
  }

  function finishTurn(t: ActiveTurn, how: 'done' | 'interrupted' | 'error', kind?: BackendErrorKind): void {
    if (t.finished) return
    t.finished = true
    if (how === 'interrupted') t.parser.reset()
    else flushParser(t)
    if (how === 'error') {
      const text = FRIENDLY[kind ?? 'unknown']
      const msg = ensureMessage(t)
      msg.parts.push({ type: 'text', text, emotion: 'sad' })
      commit(msg)
      avatar({ type: 'expression', emotion: 'sad', intensity: EXPRESSION_INTENSITY })
      avatar({ type: 'speak', text, emotion: 'sad' })
    }
    // Anything still waiting for a human can no longer be answered: the backend stopped waiting.
    broker.expireAll(how === 'interrupted' ? 'The turn was interrupted.' : 'The turn ended before this was answered.')
    if (t.message) emit({ type: 'chat.done', messageId: t.message.id })
    avatar({ type: 'pose', state: 'idle' })
    if (turn === t) turn = undefined
    if (state === 'busy') state = 'ready'
    t.done.resolve()
    void pump()
  }

  // ------------------------------------------------------------------ backend events

  function onEvent(ev: BackendEvent): void {
    if (ev.type === 'session') {
      if (ev.sessionId !== backendSessionId) {
        backendSessionId = ev.sessionId
        try {
          deps.store.saveBackendSessionId(LANE, ev.sessionId)
        } catch {
          // Without persistence the next start simply begins a new conversation.
        }
      }
      return
    }

    // Events of a turn we already ended locally (an interrupt the backend was slow to confirm) are drained.
    if (orphanTerminals > 0) {
      if (ev.type === 'turn_end' || ev.type === 'error') {
        if (ev.costUsd) deps.budget.record(LANE, ev.costUsd)
        orphanTerminals--
      } else if (ev.type === 'permission_request') {
        session?.resolvePermission(ev.requestId, { behavior: 'deny', message: 'The turn was interrupted.' })
      }
      return
    }

    const t = turn
    switch (ev.type) {
      case 'text_delta': {
        if (!t || t.interrupted || t.finished) return
        handleParsed(t, t.parser.push(ev.text))
        return
      }

      case 'tool_start': {
        if (!t || t.interrupted || t.finished) return
        flushParser(t) // the spoken acknowledgement before a tool must not wait for the tool to finish
        t.speaking = false
        avatar({ type: 'pose', state: 'thinking' })
        const msg = ensureMessage(t)
        t.toolParts.set(ev.toolUseId, msg.parts.length)
        t.toolLabels.set(ev.toolUseId, { running: toolLabel(ev.tool, ev.input, 'running'), done: toolLabel(ev.tool, ev.input, 'done') })
        msg.parts.push({ type: 'tool', tool: ev.tool, summary: t.toolLabels.get(ev.toolUseId)!.running, status: 'running' })
        commit(msg)
        if (autoSet.has(ev.tool)) {
          const spec = TOOL_SURFACE.find((s) => s.name === ev.tool)
          const cloud = cloudNote(ev.tool)
          audit({
            at: nowIso(),
            actor: 'mira',
            action: `tool:${ev.tool}`,
            target: auditTarget(ev.tool, ev.input),
            outcome: 'auto',
            ...(cloud ? { sentToCloud: cloud } : {}),
            ...((spec && (spec.server === 'mail' || spec.server === 'finance')) || hasPrivateInput(ev.tool) ? { sensitive: true } : {}),
          })
        }
        return
      }

      case 'tool_end': {
        // The backend stopped waiting on a human for this call (timeout, interrupt): close its card.
        const pendingCard = broker.approvalFor(ev.toolUseId)
        if (pendingCard && broker.expire(pendingCard, 'The request was closed without an answer.')) outcomes.set(ev.toolUseId, 'no answer')
        if (!t) return
        const index = t.toolParts.get(ev.toolUseId)
        const part = index === undefined ? undefined : t.message?.parts[index]
        if (!t.message || !part || part.type !== 'tool') return
        part.status = ev.ok ? 'done' : 'error'
        const label = t.toolLabels.get(ev.toolUseId)
        if (ev.ok) {
          if (label) part.summary = label.done
        } else {
          const why = outcomes.get(ev.toolUseId) ?? (t.interrupted ? 'interrupted' : ev.summary ? `failed: ${truncate(oneLine(ev.summary), 80)}` : 'failed')
          part.summary = `${label?.running ?? part.summary} (${why})`
        }
        commit(t.message)
        return
      }

      case 'permission_request': {
        if (!t || t.interrupted || t.finished) {
          session?.resolvePermission(ev.requestId, { behavior: 'deny', message: 'There is no active turn to attach this request to.' })
          return
        }
        const out = broker.request(ev)
        if (out.kind === 'denied') {
          outcomes.set(ev.requestId, 'blocked')
          session?.resolvePermission(ev.requestId, out.decision)
          return
        }
        const msg = ensureMessage(t)
        if (!msg.parts.some((p) => p.type === 'approval' && p.approvalId === out.approval.id)) {
          msg.parts.push({ type: 'approval', approvalId: out.approval.id })
          commit(msg)
        }
        avatar({ type: 'lookAt', target: 'screen' })
        return
      }

      case 'turn_end': {
        if (ev.costUsd) deps.budget.record(LANE, ev.costUsd)
        if (!t || t.finished) return // a late result for a turn that already ended: only its cost matters
        const interrupted = t.interrupted || ev.interrupted === true
        if (!interrupted) restartAttempts = 0
        finishTurn(t, interrupted ? 'interrupted' : 'done')
        return
      }

      case 'error': {
        onFailure({ message: ev.message, retryable: ev.retryable, ...(ev.kind ? { kind: ev.kind } : {}), ...(ev.costUsd ? { costUsd: ev.costUsd } : {}) })
        return
      }
    }
  }

  function onFailure(err: { message: string; retryable: boolean; kind?: BackendErrorKind; costUsd?: number }): void {
    if (err.costUsd) deps.budget.record(LANE, err.costUsd)
    const kind = err.kind ?? 'unknown'
    const survives = SESSION_SURVIVES.has(kind)
    // When the session is lost, whatever was queued behind the failed turn cannot run. Take it out first so that
    // ending the failed turn does not start the next one on a dead session.
    const dropped = survives ? 0 : queue.splice(0).length
    const t = turn
    if (t) finishTurn(t, 'error', kind)
    else broker.expireAll('The session failed.')
    if (survives) {
      if (state !== 'stopped') state = 'ready'
      return
    }

    state = 'error'
    lastKind = kind
    lastError = truncate(redactSecrets(oneLine(err.message)), 200)
    closeSession()
    if (dropped > 0) notice('system', dropped === 1 ? 'Your next message was not sent because I lost the connection. Please send it again.' : `${dropped} queued messages were not sent because I lost the connection. Please send them again.`)
    if (err.retryable) scheduleRestart(true)
    resolveIdle()
  }

  // ------------------------------------------------------------------ public API

  async function start(): Promise<void> {
    if (phase === 'stopped') throw new Error('The Secretary lane has been stopped.')
    phase = 'running'
    if (!starting) {
      starting = openSession().finally(() => {
        starting = undefined
      })
    }
    return starting
  }

  return {
    start,

    async send(userTurn) {
      if (phase === 'new') await start()
      if (phase === 'stopped') throw new Error('The Secretary lane has been stopped.')
      const user: ChatMessage = {
        id: deps.newId('u'),
        role: 'user',
        createdAt: nowIso(),
        modality: userTurn.modality,
        parts: [{ type: 'text', text: userTurn.text }],
      }
      commit(user)
      queue.push(userTurn)
      await pump()
    },

    async interrupt() {
      const t = turn
      if (!t || t.interrupted || t.finished) return
      t.interrupted = true
      const s = session
      try {
        await s?.interrupt()
      } catch {
        // The session may already be gone; the wait below still ends the turn.
      }
      if (!t.finished) {
        let handle: unknown
        const timeout = new Promise<void>((resolve) => {
          handle = timers.setTimeout(resolve, interruptTimeoutMs)
        })
        await Promise.race([t.done.promise, timeout])
        if (handle !== undefined) timers.clearTimeout(handle)
      }
      if (!t.finished) {
        // The backend never confirmed. End the turn here; its terminal event, if it ever arrives, is drained.
        orphanTerminals++
        finishTurn(t, 'interrupted')
      }
    },

    decideApproval(id, decision) {
      if (!broker.owns(id)) return false
      const result = broker.decide(id, decision)
      if (result) {
        if (decision === 'denied') outcomes.set(result.requestId, 'denied')
        session?.resolvePermission(result.requestId, result.decision)
      }
      return true
    },

    status(): LaneStatus {
      return {
        state,
        backend: deps.backend.kind,
        ...(lastError ? { error: lastError } : {}),
        ...(backendSessionId ? { backendSessionId } : {}),
      }
    },

    async stop() {
      if (phase === 'stopped') return
      phase = 'stopped'
      if (restartTimer !== undefined) {
        timers.clearTimeout(restartTimer)
        restartTimer = undefined
      }
      queue.length = 0
      const t = turn
      if (t) {
        t.interrupted = true
        finishTurn(t, 'interrupted')
      }
      broker.expireAll('The assistant is shutting down.')
      const s = session
      session = undefined
      sessionGen++
      if (s) await s.close().catch(() => undefined)
      state = 'stopped'
      resolveIdle()
    },

    whenIdle() {
      if (!turn && queue.length === 0 && !pumping && !opening) return Promise.resolve()
      return new Promise<void>((resolve) => {
        idleWaiters.push(resolve)
      })
    },
  }
}
