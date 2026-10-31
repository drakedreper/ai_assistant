import {
  AuthExchangeRequest,
  ChatRequest,
  ClaudeModeRequest,
  DaemonHealth,
  DaemonRoutes,
  DecisionRequest,
  OnOffRequest,
  PersonaPatchRequest,
  ServerEvent,
  Snapshot,
  Task,
  TaskCreateRequest,
  TaskMoveRequest,
  TrustModeRequest,
  WsHello,
  type ApiClient,
  type ConnectionState,
  type SettingsSnapshot,
  type TaskColumn,
  type TrustRule,
  type Unsubscribe,
} from '@ai-assistant/shared'

/**
 * The ApiClient for the real local daemon (apps/daemon): REST for reads and commands, ONE WebSocket for live events.
 *
 * Data flow (see apps/daemon/README.md, "WebSocket"):
 *   1. GET /api/snapshot  -> a full Snapshot (validated) with `seq`, and the daemon's epoch in X-Daemon-Epoch.
 *   2. /ws?since=<seq>&epoch=<epoch>  -> `hello`, then live events; anything published since the snapshot is replayed.
 *   3. Every event carries a seq. A jump (gap), a different epoch (daemon restarted) or a hello that says `resync`
 *      means the local copy cannot be trusted: refetch the snapshot and hand the store a synthetic `snapshot.reset`.
 *
 * Security: the browser authenticates with the HttpOnly session cookie the daemon sets (same origin only, no CORS).
 * The only secret this file ever handles is the one-time sign-in code in the address bar, which is exchanged once and
 * removed from the URL. No token is ever put in a query string, a log line or storage.
 *
 * Commands never throw into the UI (the screens fire them with `void` and keep optimistic state): a failure becomes a
 * visible notice (see onNotice) and, when the server may disagree with the screen, a snapshot refresh. The one
 * exception is createTask, which has to return a Task and therefore rejects.
 */

/** What the Work screen says about a permission or question raised inside a terminal Claude Code session. */
export const TERMINAL_ONLY_COPY = 'Answer this in your terminal. Mira can only watch hook sessions.'

const SIGN_IN_NOTE =
  'This browser is not signed in to the daemon. Open the sign-in link it printed when it started, or restart the daemon for a new one.'
const UNREACHABLE_NOTE = 'The daemon is not reachable. Is it still running?'
const REFUSED_NOTE =
  'The daemon refused this address. Open it exactly as printed (http://127.0.0.1:PORT or http://localhost:PORT), or through the Vite dev server.'

export class DaemonHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'DaemonHttpError'
  }
}

/** The request never produced an answer: daemon down, connection refused, timeout. */
export class DaemonUnreachableError extends Error {
  constructor(message = UNREACHABLE_NOTE) {
    super(message)
    this.name = 'DaemonUnreachableError'
  }
}

/** The daemon answered, but not with something this app version understands. */
export class DaemonProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DaemonProtocolError'
  }
}

export interface DaemonStatus {
  state: ConnectionState
  /** Plain-words reason the link is not online (not signed in, daemon down...), or null. */
  note: string | null
  /** The daemon's Claude backend, known once it said hello. */
  backend: 'fake' | 'sdk' | null
}

export interface DaemonNotice {
  id: number
  level: 'error' | 'info'
  text: string
}

export interface DaemonClientOptions {
  /** Origin of the daemon as the browser reaches it. Default: the page origin (the daemon serves the UI; Vite proxies in dev). */
  baseUrl?: string
  fetch?: typeof fetch
  WebSocket?: typeof WebSocket
  /** Per-request timeout for commands. */
  timeoutMs?: number
  /** How often to ping over the socket. */
  heartbeatMs?: number
  /** No frame for this long means the socket is dead (half-open after sleep or a network change). */
  staleAfterMs?: number
  /** Reconnect delay: base * 2^attempt, capped, with jitter. */
  backoff?: { baseMs: number; capMs: number }
  random?: () => number
}

const MAX_QUEUED_EVENTS = 2000
const CONNECT_TIMEOUT_MS = 10_000

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function describeIssue(issue: { path: ReadonlyArray<PropertyKey>; message: string } | undefined): string {
  if (!issue) return 'unknown mismatch'
  const path = issue.path.map(String).join('.')
  return `${path || 'root'}: ${issue.message}`.slice(0, 160)
}

function pageOrigin(): string {
  if (typeof location === 'undefined') throw new Error('DaemonClient needs a baseUrl outside a browser')
  return location.origin
}

/** Parse a response body leniently: an HTML page or an empty body is `undefined`, not an exception. */
function parseJson(text: string): unknown {
  if (!text) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

function errorFields(data: unknown): { code: string; message: string } {
  const o = data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : {}
  return {
    code: typeof o.error === 'string' ? o.error : 'error',
    message: typeof o.message === 'string' ? o.message : '',
  }
}

interface HttpResult {
  status: number
  headers: Headers
  data: unknown
}

/**
 * A 502/503/504 that is not one of the daemon's own JSON errors comes from something in front of it (the Vite dev
 * proxy when the daemon is down), so it means "unreachable", not "the daemon refused". The daemon's own 503 carries
 * `{error, message}` and is reported as is.
 */
function isGatewayFailure(r: HttpResult): boolean {
  return (r.status === 502 || r.status === 503 || r.status === 504) && errorFields(r.data).code === 'error'
}

async function httpCall(
  f: typeof fetch,
  base: string,
  method: string,
  path: string,
  body: unknown,
  timeoutMs: number,
): Promise<HttpResult> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await f(new URL(path, base).toString(), {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      signal: ctl.signal,
      headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    // Read the body inside the timeout window: a daemon that sends headers and then stalls must not hang the UI.
    const text = await res.text()
    return { status: res.status, headers: res.headers, data: parseJson(text) }
  } catch {
    throw new DaemonUnreachableError()
  } finally {
    clearTimeout(timer)
  }
}

// ------------------------------------------------------------------------------------------------ sign-in and probe

export type ExchangeOutcome =
  | { kind: 'none' }
  | { kind: 'ok' }
  | { kind: 'failed'; reason: 'invalid' | 'rate_limited' | 'unreachable' | 'other'; message: string }

/** Remove only the one-time `code` from the address bar, in place (no new history entry, so it is never in history). */
export function stripCodeFromAddressBar(): void {
  if (typeof location === 'undefined' || typeof history === 'undefined') return
  try {
    const url = new URL(location.href)
    if (!url.searchParams.has('code')) return
    url.searchParams.delete('code')
    history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`)
  } catch {
    /* an odd URL must never break start-up */
  }
}

/**
 * If the address carries `?code=...` (the link the daemon prints once), swap it for the session cookie via
 * POST /api/auth/exchange, then strip it from the address bar whatever the outcome. The code is single use and
 * short lived, but it is a credential, so it does not stay in the URL or in history.
 */
export async function exchangeSignInCode(opts: { baseUrl?: string; fetch?: typeof fetch } = {}): Promise<ExchangeOutcome> {
  if (typeof location === 'undefined') return { kind: 'none' }
  const code = new URLSearchParams(location.search).get('code')
  if (code === null) return { kind: 'none' }
  const f = opts.fetch ?? ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a))
  try {
    const body = AuthExchangeRequest.safeParse({ code })
    if (!body.success) return { kind: 'failed', reason: 'invalid', message: 'That sign-in link is incomplete. Restart the daemon for a new one.' }
    const r = await httpCall(f, opts.baseUrl ?? pageOrigin(), 'POST', DaemonRoutes.authExchange, body.data, 6000)
    if (r.status >= 200 && r.status < 300) return { kind: 'ok' }
    if (r.status === 429) return { kind: 'failed', reason: 'rate_limited', message: 'Too many sign-in attempts. Wait a minute, then restart the daemon for a new link.' }
    if (r.status === 401) return { kind: 'failed', reason: 'invalid', message: 'That sign-in link was already used or has expired. Restart the daemon for a new one.' }
    return { kind: 'failed', reason: 'other', message: errorFields(r.data).message || `The daemon refused the sign-in (HTTP ${r.status}).` }
  } catch {
    return { kind: 'failed', reason: 'unreachable', message: 'Could not reach the daemon to sign in. Is it running?' }
  } finally {
    stripCodeFromAddressBar()
  }
}

export type ProbeResult =
  | { kind: 'daemon'; health: DaemonHealth }
  /** A daemon answered 401: it is there, but this browser has no session cookie. */
  | { kind: 'signin_required' }
  /** A daemon answered 403 (Host or Origin check): it is there, but refuses this address. */
  | { kind: 'refused' }
  | { kind: 'none' }

/**
 * Is there a daemon behind this origin? GET /api/health answers a DaemonHealth when signed in and a JSON
 * `{error: 'unauthorized'}` when not. Anything else (HTML from a static host, a refused connection, a proxy error)
 * means no.
 */
export async function probeDaemon(opts: { baseUrl?: string; fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<ProbeResult> {
  const f = opts.fetch ?? ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a))
  try {
    const r = await httpCall(f, opts.baseUrl ?? pageOrigin(), 'GET', DaemonRoutes.health, undefined, opts.timeoutMs ?? 1500)
    if (r.status === 200) {
      const health = DaemonHealth.safeParse(r.data)
      return health.success ? { kind: 'daemon', health: health.data } : { kind: 'none' }
    }
    const { code } = errorFields(r.data)
    if (r.status === 401 && code === 'unauthorized') return { kind: 'signin_required' }
    if (r.status === 403 && (code === 'forbidden_host' || code === 'forbidden_origin')) return { kind: 'refused' }
    return { kind: 'none' }
  } catch {
    return { kind: 'none' }
  }
}

// ------------------------------------------------------------------------------------------------ the client

export class DaemonClient implements ApiClient {
  private readonly base: string
  private readonly fetchFn: typeof fetch
  private readonly WS: typeof WebSocket
  private readonly timeoutMs: number
  private readonly heartbeatMs: number
  private readonly staleAfterMs: number
  private readonly backoffBase: number
  private readonly backoffCap: number
  private readonly random: () => number

  private readonly handlers = new Set<(e: ServerEvent) => void>()
  private readonly connHandlers = new Set<(s: ConnectionState) => void>()
  private readonly statusHandlers = new Set<(s: DaemonStatus) => void>()
  private readonly noticeHandlers = new Set<(n: DaemonNotice) => void>()

  private st: DaemonStatus = { state: 'connecting', note: null, backend: null }
  private noticeSeq = 0

  // stream position
  private lastSeq: number | undefined
  private epoch: string | undefined
  /** True from the moment we know the local copy may have diverged until a snapshot has been delivered. */
  private needsSnapshot = false
  private resyncing = false
  private queue: ServerEvent[] = []
  private queueOverflow = false
  private lastBadEventResync = 0

  // socket lifecycle
  private wanted = false
  private socket: WebSocket | undefined
  private attempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private connectTimer: ReturnType<typeof setTimeout> | undefined
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined
  private lastFrameAt = 0
  private diagnosing = false
  private listening = false

  constructor(opts: DaemonClientOptions = {}) {
    this.base = opts.baseUrl ?? pageOrigin()
    this.fetchFn = opts.fetch ?? ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a))
    this.WS = opts.WebSocket ?? (globalThis.WebSocket as typeof WebSocket)
    this.timeoutMs = opts.timeoutMs ?? 15_000
    this.heartbeatMs = opts.heartbeatMs ?? 25_000
    this.staleAfterMs = opts.staleAfterMs ?? 90_000
    this.backoffBase = opts.backoff?.baseMs ?? 500
    this.backoffCap = opts.backoff?.capMs ?? 15_000
    this.random = opts.random ?? Math.random
  }

  // ---------------------------------------------------------------- ApiClient: reads and events

  async getSnapshot(): Promise<Snapshot> {
    return this.fetchSnapshot()
  }

  subscribe(handler: (event: ServerEvent) => void): Unsubscribe {
    this.handlers.add(handler)
    this.connect()
    return () => {
      this.handlers.delete(handler)
      if (this.handlers.size === 0) this.stop()
    }
  }

  /** Calls the handler right away with the current state, then on every change. */
  onConnection(handler: (state: ConnectionState) => void): Unsubscribe {
    this.connHandlers.add(handler)
    handler(this.st.state)
    return () => this.connHandlers.delete(handler)
  }

  /** State plus the reason, for the banner and the Live badge. Calls the handler right away too. */
  onStatus(handler: (status: DaemonStatus) => void): Unsubscribe {
    this.statusHandlers.add(handler)
    handler(this.st)
    return () => this.statusHandlers.delete(handler)
  }

  /** Command failures, worded for a person. */
  onNotice(handler: (notice: DaemonNotice) => void): Unsubscribe {
    this.noticeHandlers.add(handler)
    return () => this.noticeHandlers.delete(handler)
  }

  status(): DaemonStatus {
    return this.st
  }

  /** Stop everything (socket, timers, listeners). The client can be subscribed again afterwards. */
  dispose(): void {
    this.handlers.clear()
    this.stop()
  }

  // ---------------------------------------------------------------- ApiClient: commands

  async sendChat(text: string, modality: 'text' | 'voice' = 'text'): Promise<void> {
    const r = await this.attemptCommand(
      'send your message',
      () => this.json('POST', DaemonRoutes.chat, ChatRequest.parse({ text, modality })),
      // The composer has already cleared itself, so quote what was typed: it is the only copy the person has.
      text,
    )
    if (!r.ok) {
      // The store flipped to "thinking" before sending. Nothing is coming, so release it.
      this.deliverLocal({ type: 'chat.done', messageId: 'local-send-failed' })
      this.deliverLocal({ type: 'avatar', event: { type: 'pose', state: 'idle' } })
    }
  }

  async interruptChat(): Promise<void> {
    await this.attemptCommand('stop the reply', () => this.json('POST', DaemonRoutes.chatInterrupt, {}))
  }

  async decideApproval(id: string, decision: 'approved' | 'denied'): Promise<void> {
    await this.attemptCommand('record that decision', () =>
      this.json('POST', DaemonRoutes.approvalDecision(id), DecisionRequest.parse({ decision })),
    )
  }

  async decideProposal(id: string, decision: 'approved' | 'rejected'): Promise<void> {
    await this.attemptCommand('record that decision', () =>
      this.json('POST', DaemonRoutes.proposalDecision(id), DecisionRequest.parse({ decision })),
    )
  }

  async moveTask(id: string, column: TaskColumn): Promise<void> {
    await this.attemptCommand('move that card', () => this.json('PATCH', DaemonRoutes.task(id), TaskMoveRequest.parse({ column })))
  }

  async createTask(input: { title: string; projectId?: string; column?: TaskColumn }): Promise<Task> {
    const r = await this.attemptCommand('add that card', async () => {
      const data = await this.json('POST', DaemonRoutes.tasks, TaskCreateRequest.parse(input))
      const task = Task.safeParse(data)
      if (!task.success) throw new DaemonProtocolError('The daemon returned a card this app does not understand.')
      return task.data
    })
    if (!r.ok) throw r.error
    return r.value
  }

  async setTrustMode(ruleId: string, mode: TrustRule['mode']): Promise<void> {
    await this.attemptCommand('change that trust rule', () =>
      this.json('PUT', DaemonRoutes.trustMode(ruleId), TrustModeRequest.parse({ mode })),
    )
  }

  async setClaudeMode(mode: 'api-key' | 'local-login'): Promise<void> {
    await this.attemptCommand('change the Claude sign-in mode', () => this.json('PUT', DaemonRoutes.claudeMode, ClaudeModeRequest.parse({ mode })))
  }

  async setGuestMode(on: boolean): Promise<void> {
    await this.attemptCommand('change guest mode', () => this.json('PUT', DaemonRoutes.guestMode, OnOffRequest.parse({ on })))
  }

  async setWebcam(on: boolean): Promise<void> {
    await this.attemptCommand('change the camera setting', () => this.json('PUT', DaemonRoutes.webcam, OnOffRequest.parse({ on })))
  }

  async updatePersona(patch: Partial<SettingsSnapshot['persona']>): Promise<void> {
    await this.attemptCommand('save her persona', () => this.json('PUT', DaemonRoutes.persona, PersonaPatchRequest.parse(patch)))
  }

  async forgetFact(id: string): Promise<void> {
    await this.attemptCommand('forget that', () => this.json('DELETE', DaemonRoutes.learned(id), undefined))
  }

  // ---------------------------------------------------------------- HTTP

  /** One request. Non-2xx becomes a DaemonHttpError; a 401 also takes the link offline with the sign-in note. */
  private async json(method: string, path: string, body: unknown, timeoutMs = this.timeoutMs): Promise<unknown> {
    const r = await httpCall(this.fetchFn, this.base, method, path, body, timeoutMs)
    this.ensureOk(r)
    return r.data
  }

  private ensureOk(r: HttpResult): void {
    if (r.status >= 200 && r.status < 300) return
    if (isGatewayFailure(r)) throw new DaemonUnreachableError()
    const { code, message } = errorFields(r.data)
    if (r.status === 401) this.markUnauthorized()
    throw new DaemonHttpError(r.status, code, message || `The daemon answered HTTP ${r.status}.`)
  }

  private markUnauthorized(): void {
    this.setStatus({ state: 'offline', note: SIGN_IN_NOTE })
  }

  private async fetchSnapshot(): Promise<Snapshot> {
    const r = await httpCall(this.fetchFn, this.base, 'GET', DaemonRoutes.snapshot, undefined, 20_000)
    this.ensureOk(r)
    const parsed = Snapshot.safeParse(r.data)
    if (!parsed.success) {
      throw new DaemonProtocolError(
        `The daemon's data does not match this app (${describeIssue(parsed.error.issues[0])}). They are probably different versions: rebuild the web app.`,
      )
    }
    const epoch = r.headers.get('X-Daemon-Epoch') ?? parsed.data.epoch
    if (epoch) this.epoch = epoch
    if (parsed.data.seq !== undefined) this.lastSeq = parsed.data.seq
    return parsed.data
  }

  // ---------------------------------------------------------------- command failures

  private async attemptCommand<T>(
    what: string,
    fn: () => Promise<T>,
    /** What the person typed, quoted back (shortened) in the notice. Shown on screen only, never logged. */
    subject?: string,
  ): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
    try {
      return { ok: true, value: await fn() }
    } catch (error) {
      this.reportFailure(what, error, subject)
      return { ok: false, error }
    }
  }

  private notice(level: DaemonNotice['level'], text: string): void {
    const n: DaemonNotice = { id: ++this.noticeSeq, level, text }
    for (const h of [...this.noticeHandlers]) h(n)
  }

  private reportFailure(what: string, error: unknown, subject?: string): void {
    const quoted = subject ? ` You wrote: \u201c${subject.length > 80 ? `${subject.slice(0, 80)}\u2026` : subject}\u201d` : ''
    if (error instanceof DaemonHttpError) {
      if (error.status === 401) {
        this.notice('error', `Could not ${what}: this browser is signed out of the daemon.${quoted}`)
        return
      }
      if (error.code === 'not_answerable_here') {
        // Nothing is wrong and the server state did not change: just say where to answer it.
        this.notice('info', TERMINAL_ONLY_COPY)
        return
      }
      this.notice(error.code === 'already_resolved' ? 'info' : 'error', `Could not ${what}: ${error.message}${quoted}`)
      // The screen may have moved ahead of the server (a stale card, a closed approval). Show the server's truth.
      void this.resync('command_failed')
      return
    }
    if (error instanceof DaemonUnreachableError) {
      this.notice('error', `Could not ${what}: the daemon is not reachable. Nothing was sent.${quoted}`)
      return
    }
    if (error instanceof Error && error.name === 'ZodError') {
      this.notice('error', `Could not ${what}: that input is not valid (for example a message over 8000 characters).${quoted}`)
      return
    }
    this.notice('error', `Could not ${what}: ${error instanceof Error ? error.message.slice(0, 160) : 'unexpected error'}${quoted}`)
  }

  // ---------------------------------------------------------------- status

  private setStatus(patch: Partial<DaemonStatus>): void {
    const prev = this.st
    const next: DaemonStatus = { ...prev, ...patch }
    if (next.state === prev.state && next.note === prev.note && next.backend === prev.backend) return
    this.st = next
    for (const h of [...this.statusHandlers]) h(next)
    if (next.state !== prev.state) for (const h of [...this.connHandlers]) h(next.state)
  }

  // ---------------------------------------------------------------- socket lifecycle

  private connect(): void {
    this.wanted = true
    this.listen()
    if (!this.socket && this.reconnectTimer === undefined) this.openSocket()
  }

  private stop(): void {
    this.wanted = false
    this.unlisten()
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    this.dropSocket()
  }

  private wsUrl(): string {
    const u = new URL(DaemonRoutes.ws, this.base)
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
    // Resume where we left off. `since` without a verifiable epoch would only force a resync, so send neither.
    if (this.lastSeq !== undefined && this.epoch) {
      u.searchParams.set('since', String(this.lastSeq))
      u.searchParams.set('epoch', this.epoch)
    }
    return u.toString()
  }

  private openSocket(): void {
    if (!this.wanted || this.socket) return
    this.setStatus({ state: 'connecting' })
    let ws: WebSocket
    try {
      if (this.lastSeq !== undefined && !this.epoch) this.needsSnapshot = true
      ws = new this.WS(this.wsUrl())
    } catch {
      this.setStatus({ state: 'offline' })
      this.scheduleReconnect()
      return
    }
    this.socket = ws
    let gotHello = false
    this.lastFrameAt = Date.now()
    this.connectTimer = setTimeout(() => {
      if (this.socket === ws && !gotHello) this.lose(false)
    }, CONNECT_TIMEOUT_MS)

    ws.onmessage = (m: MessageEvent) => {
      if (this.socket !== ws) return
      this.lastFrameAt = Date.now()
      if (!gotHello) {
        gotHello = this.onFirstFrame(m.data)
        return
      }
      this.onFrame(m.data)
    }
    ws.onclose = () => {
      if (this.socket !== ws) return
      this.lose(gotHello)
    }
    ws.onerror = () => {
      /* onclose always follows; nothing useful is exposed here */
    }
  }

  /** The socket ended (closed, timed out or went stale). Go offline, find out why, and try again with backoff. */
  private lose(hadHello: boolean): void {
    this.dropSocket()
    if (!this.wanted) return
    this.setStatus({ state: 'offline' })
    if (!hadHello || this.st.note === null) void this.diagnose()
    this.scheduleReconnect()
  }

  private dropSocket(): void {
    if (this.connectTimer !== undefined) clearTimeout(this.connectTimer)
    this.connectTimer = undefined
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = undefined
    const ws = this.socket
    if (!ws) return
    this.socket = undefined
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null
    try {
      ws.close()
    } catch {
      /* already closed */
    }
  }

  /** Exponential backoff with jitter, capped (about 15 s). */
  private backoff(attempt: number): number {
    const exp = Math.min(this.backoffCap, this.backoffBase * 2 ** attempt)
    return Math.round(exp * (0.5 + this.random() * 0.5))
  }

  private scheduleReconnect(): void {
    if (!this.wanted || this.reconnectTimer !== undefined) return
    const delay = this.backoff(this.attempt++)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      this.openSocket()
    }, delay)
  }

  /** The tab woke up or the network came back: do not wait out the backoff. */
  private readonly kick = (): void => {
    if (!this.wanted || this.socket) return
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    this.attempt = 0
    this.openSocket()
  }

  private readonly onVisibility = (): void => {
    if (typeof document !== 'undefined' && !document.hidden) this.kick()
  }

  private listen(): void {
    if (this.listening || typeof window === 'undefined') return
    this.listening = true
    window.addEventListener('online', this.kick)
    document.addEventListener('visibilitychange', this.onVisibility)
  }

  private unlisten(): void {
    if (!this.listening || typeof window === 'undefined') return
    this.listening = false
    window.removeEventListener('online', this.kick)
    document.removeEventListener('visibilitychange', this.onVisibility)
  }

  /** After a failed connect, ask the REST side why, so the banner can say more than "reconnecting". */
  private async diagnose(): Promise<void> {
    if (this.diagnosing) return
    this.diagnosing = true
    try {
      const r = await httpCall(this.fetchFn, this.base, 'GET', DaemonRoutes.health, undefined, 2500)
      if (this.st.state === 'online') return
      if (r.status === 401) this.markUnauthorized()
      else if (r.status === 403) this.setStatus({ note: REFUSED_NOTE })
      else if (r.status >= 200 && r.status < 300) this.setStatus({ note: null })
      else if (isGatewayFailure(r)) this.setStatus({ note: UNREACHABLE_NOTE })
      else this.setStatus({ note: `The daemon answered HTTP ${r.status}.` })
    } catch {
      if (this.st.state !== 'online') this.setStatus({ note: UNREACHABLE_NOTE })
    } finally {
      this.diagnosing = false
    }
  }

  // ---------------------------------------------------------------- frames

  /** The first frame must be the hello. Returns whether it was. */
  private onFirstFrame(data: unknown): boolean {
    const raw = this.parseFrame(data)
    if (raw === undefined) return false
    const parsed = WsHello.safeParse(raw)
    if (!parsed.success) {
      this.setStatus({ note: 'The daemon speaks a different protocol version than this app. Rebuild the web app.' })
      this.lose(false)
      return false
    }
    if (this.connectTimer !== undefined) clearTimeout(this.connectTimer)
    this.connectTimer = undefined
    const hello = parsed.data
    const serverSaysResync = hello.resync === true
    const epochChanged = this.epoch !== undefined && hello.epoch !== this.epoch
    this.attempt = 0
    this.setStatus({ state: 'online', note: null, backend: hello.backend })
    this.startHeartbeat()
    if (serverSaysResync || epochChanged || this.needsSnapshot || this.lastSeq === undefined) {
      void this.resync(serverSaysResync ? 'server' : epochChanged ? 'epoch' : 'pending')
    } else {
      this.epoch = hello.epoch
    }
    return true
  }

  private parseFrame(data: unknown): Record<string, unknown> | undefined {
    if (typeof data !== 'string') return undefined
    const raw = parseJson(data)
    return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined
  }

  private onFrame(data: unknown): void {
    const raw = this.parseFrame(data)
    if (!raw) return
    if (raw.type === 'pong') return
    if (raw.type === 'hello') return
    const parsed = ServerEvent.safeParse(raw)
    if (!parsed.success) {
      this.onBadEvent(raw)
      return
    }
    this.handleEvent(parsed.data)
  }

  /** A frame this app cannot read. Skip it but do not trust the local copy: refresh (rate limited). */
  private onBadEvent(raw: Record<string, unknown>): void {
    if (typeof raw.seq === 'number' && this.lastSeq !== undefined && raw.seq > this.lastSeq) this.lastSeq = raw.seq
    const t = Date.now()
    if (t - this.lastBadEventResync < 5000) return
    this.lastBadEventResync = t
    void this.resync('bad_event')
  }

  private handleEvent(ev: ServerEvent): void {
    if (this.resyncing) {
      if (this.queue.length < MAX_QUEUED_EVENTS) this.queue.push(ev)
      else this.queueOverflow = true
      return
    }
    if (this.lastSeq !== undefined) {
      if (ev.seq <= this.lastSeq) return // already reflected (replay overlap, duplicate)
      // A reset replaces everything, so a jump before it does not matter.
      if (ev.type !== 'snapshot.reset' && ev.seq > this.lastSeq + 1) {
        this.queue.push(ev)
        void this.resync('gap')
        return
      }
    }
    this.lastSeq = ev.seq
    this.deliver(ev)
  }

  private deliver(ev: ServerEvent): void {
    for (const h of [...this.handlers]) {
      try {
        h(ev)
      } catch (err) {
        console.error('A live-event handler threw', err instanceof Error ? err.message : err)
      }
    }
  }

  /** Events made up on this side (seq 0): they are never counted in the stream position. */
  private deliverLocal(draft: { type: 'chat.done'; messageId: string } | { type: 'avatar'; event: Extract<ServerEvent, { type: 'avatar' }>['event'] }): void {
    this.deliver({ ...draft, seq: 0, ts: new Date().toISOString() } as ServerEvent)
  }

  // ---------------------------------------------------------------- resync

  /**
   * Refetch the snapshot and hand it to the store as a synthetic `snapshot.reset`. Events that arrive meanwhile are
   * queued and applied afterwards (those the snapshot already contains are skipped by seq).
   */
  private async resync(_reason: string): Promise<void> {
    this.needsSnapshot = true
    if (this.resyncing) return
    this.resyncing = true
    let delivered = false
    try {
      for (let attempt = 0; this.wanted || this.handlers.size > 0; attempt++) {
        try {
          const snap = await this.fetchSnapshot()
          this.deliver({ type: 'snapshot.reset', seq: snap.seq ?? this.lastSeq ?? 0, ts: snap.now, snapshot: snap })
          this.needsSnapshot = false
          delivered = true
          break
        } catch (err) {
          if (err instanceof DaemonHttpError && err.status === 401) break
          if (attempt >= 4) {
            // Give up on this connection; the next hello will see needsSnapshot and try again.
            this.queue = []
            if (this.socket) this.lose(true)
            break
          }
          await sleep(this.backoff(attempt))
        }
      }
    } finally {
      this.resyncing = false
    }
    if (!delivered) return
    const queued = this.queue.splice(0)
    for (const ev of queued) this.handleEvent(ev)
    if (this.queueOverflow) {
      this.queueOverflow = false
      void this.resync('overflow')
    }
  }

  // ---------------------------------------------------------------- heartbeat

  private startHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer)
    const ws = this.socket
    if (!ws) return
    this.heartbeatTimer = setInterval(() => {
      if (this.socket !== ws) return
      if (Date.now() - this.lastFrameAt > this.staleAfterMs) {
        this.lose(true)
        return
      }
      try {
        ws.send('{"type":"ping"}')
      } catch {
        this.lose(true)
      }
    }, this.heartbeatMs)
  }
}
