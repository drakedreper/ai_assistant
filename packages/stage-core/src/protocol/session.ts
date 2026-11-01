/**
 * StageSession: the backend side of ONE stage connection over an abstract transport.
 *
 *  - hello and capability negotiation: the stage speaks first; a protocol mismatch (or an invalid hello) is REFUSED and
 *    the transport closed. Nothing is sent before the hello.
 *  - command dispatch: every command is validated against the shared schema, gets an id, and is tracked until the stage
 *    answers command.done / command.failed or the timeout fires. In-flight commands are bounded; extras queue (bounded).
 *  - clock sync: the stage clock offset is estimated from hello.stageClockMs and speak.started.stageMs. Each sample
 *    is (stage time) - (backend receive time), which under-estimates the offset by the one-way delay, so the best
 *    estimate is the LARGEST recent sample (the one with the least delay), like the minimum-delay filter of NTP.
 *  - capability adaptation: constructs the stage cannot draw are skipped (and their data), rigs and character counts are
 *    checked, and the face source follows what the stage can do (ARKit frames from the backend, or its own audio-to-face).
 *  - resume: a StageMirror (kept by the owner across connections) is replayed after the hello of a new connection.
 *  - back-pressure: binary frames are only sent while the transport is under its high-water mark.
 *
 * ROBUSTNESS: `send` never rejects and `dispatch` never throws, whatever the draft is (null, circular, BigInt, a getter that
 * throws, NaN inside an open-ended record): the result is `{ ok: false, reason }`. A transport whose `sendText` throws
 * frees the in-flight slot at once (`transport_error`). A command id that is already in flight is refused (a caller-supplied
 * one) or regenerated (an IdGenerator that repeats itself). A throwing listener never starves the others and its exception
 * never reaches the transport callback. What goes on the wire is serialised ONCE, with a replacer that refuses any
 * non-finite number, so NaN can never travel as `null`. Sizes are counted in UTF-8 bytes. A stage clock outside
 * 0..2^50 ms is ignored (the schema refuses it in `hello` and `speak.*`).
 *
 * PRIVACY: the session never logs. Error reasons name ids and types, never payloads (terminal bytes, text).
 */
import { ARKIT_52, StageCommand, StageEvent, STAGE_CLOCK_MAX_MS, STAGE_PROTOCOL } from '@ai-assistant/shared'
import type { ConstructKind, StageCapabilities, StageCommand as StageCommandT } from '@ai-assistant/shared'
import type { Clock, Timers, TimerHandle } from '../util/clock'
import type { IdGenerator } from '../util/ids'
import type { CommandDraft } from '../util/commands'
import { StageMirror } from './mirror'
import type { StageTransport, Unsubscribe } from './transport'

export type SessionState = 'awaiting_hello' | 'ready' | 'closed'

export interface CommandResult {
  ok: boolean
  /** Why it failed (never contains payload data). */
  reason?: string
  /** Set when the command was deliberately not sent (e.g. the stage cannot draw that construct). */
  skipped?: string
}

export interface StageSessionOptions {
  transport: StageTransport
  clock: Clock
  timers: Timers
  newId: IdGenerator
  /** Kept by the owner across connections so a reconnect can resume. A private one is created otherwise. */
  mirror?: StageMirror
  /** Replay the mirror after the hello of this connection when it has content. Default true. */
  autoResume?: boolean
  /**
   * Supply the replay yourself, e.g. from the authoritative services (`characters.loadCommand`, `scenes.loadCommand`,
   * construct data) followed by `mirror.replayLook()`. When given it replaces `mirror.replay()` on resume.
   */
  resumeCommands?: () => CommandDraft[]
  /** Default 5 s. */
  commandTimeoutMs?: number
  /** For character.load, scene.load and equips that stream assets. Default 30 s. */
  loadTimeoutMs?: number
  /** Default 64. */
  maxInFlight?: number
  /** Default 256. */
  maxQueue?: number
  /** Default 5 s. */
  helloTimeoutMs?: number
  /** Largest text frame accepted from the stage. Default 256 KiB. */
  maxTextBytes?: number
  /** Largest command the backend will send (serialised). Default 2 MiB. */
  maxCommandBytes?: number
  /** Binary frames are held back above this many buffered bytes. Default 512 KiB. */
  highWaterBytes?: number
}

export interface SessionStats {
  sent: number
  acked: number
  failed: number
  timeouts: number
  rejectedLocally: number
  skipped: number
  invalidEvents: number
  eventsBeforeHello: number
  binarySent: number
  binaryHeldBack: number
  /** `sendText` / `sendBinary` threw (a closing socket, a custom transport with a bug). */
  transportErrors: number
  /** A listener threw (and was isolated). */
  listenerErrors: number
  inFlight: number
  queued: number
}

export type ProtocolErrorHandler = (info: { reason: string }) => void

interface InFlight {
  cmd: StageCommandT
  resolve: (r: CommandResult) => void
  timer: TimerHandle
  mirrorOnOk: boolean
}
interface Queued {
  draft: CommandDraft
  opts: SendOptions
  resolve: (r: CommandResult) => void
}

export interface SendOptions {
  /** Wait for command.done / failed (default). `false` fires and forgets (high-rate commands such as gaze). */
  ack?: boolean
  timeoutMs?: number
}

const LOAD_TYPES = new Set(['character.load', 'scene.load', 'character.equip', 'character.outfit', 'scene.object'])

export class StageSession {
  private st: SessionState = 'awaiting_hello'
  private caps: StageCapabilities | undefined
  readonly mirror: StageMirror
  private readonly opts: Required<Pick<StageSessionOptions, 'commandTimeoutMs' | 'loadTimeoutMs' | 'maxInFlight' | 'maxQueue' | 'helloTimeoutMs' | 'maxTextBytes' | 'maxCommandBytes' | 'highWaterBytes'>>
  private readonly inFlight = new Map<string, InFlight>()
  private readonly queue: Queued[] = []
  private readonly listeners = new Set<(ev: StageEvent) => void>()
  private readonly errorListeners = new Set<ProtocolErrorHandler>()
  private readonly closeListeners = new Set<(reason: string) => void>()
  private readonly unsubs: Unsubscribe[] = []
  private readyResolve!: (c: StageCapabilities) => void
  private readyReject!: (e: Error) => void
  private readonly readyPromise: Promise<StageCapabilities>
  private helloTimer: TimerHandle | undefined
  private offsets: number[] = []
  private readonly unsupportedConstructs = new Set<string>()
  /** Characters the stage confirmed (command.done), or that were sent without waiting for an answer. */
  private readonly loadedCharacters = new Set<string>()
  /** character.load commands still waiting for their answer: command id -> character id. They hold a slot until answered. */
  private readonly pendingLoads = new Map<string, string>()
  private clockResets = 0
  private readonly counters = { sent: 0, acked: 0, failed: 0, timeouts: 0, rejectedLocally: 0, skipped: 0, invalidEvents: 0, eventsBeforeHello: 0, binarySent: 0, binaryHeldBack: 0, transportErrors: 0, listenerErrors: 0 }
  private readonly pendingBeforeReady: Queued[] = []
  private closedReason: string | undefined

  constructor(private readonly o: StageSessionOptions) {
    this.mirror = o.mirror ?? new StageMirror()
    this.opts = {
      commandTimeoutMs: o.commandTimeoutMs ?? 5000,
      loadTimeoutMs: o.loadTimeoutMs ?? 30_000,
      maxInFlight: o.maxInFlight ?? 64,
      maxQueue: o.maxQueue ?? 256,
      helloTimeoutMs: o.helloTimeoutMs ?? 5000,
      maxTextBytes: o.maxTextBytes ?? 256 * 1024,
      maxCommandBytes: o.maxCommandBytes ?? 2 * 1024 * 1024,
      highWaterBytes: o.highWaterBytes ?? 512 * 1024,
    }
    this.readyPromise = new Promise<StageCapabilities>((res, rej) => {
      this.readyResolve = res
      this.readyReject = rej
    })
    // a rejection nobody awaits must not crash the process
    this.readyPromise.catch(() => undefined)
    this.unsubs.push(o.transport.onText((d) => this.handleText(d)))
    if (o.transport.onClose) this.unsubs.push(o.transport.onClose((r) => this.finish(r ?? 'transport closed', false)))
    this.helloTimer = o.timers.setTimeout(() => {
      if (this.st === 'awaiting_hello') this.refuse('hello_timeout', `no hello within ${this.opts.helloTimeoutMs} ms`)
    }, this.opts.helloTimeoutMs)
  }

  // -------------------------------------------------------------------------------------------------- state

  get state(): SessionState {
    return this.st
  }
  get capabilities(): StageCapabilities | undefined {
    return this.caps
  }
  get closeReason(): string | undefined {
    return this.closedReason
  }

  /** Resolves with the stage's capabilities once the hello is accepted; rejects if refused or closed first. */
  ready(): Promise<StageCapabilities> {
    return this.readyPromise
  }

  onEvent(fn: (ev: StageEvent) => void): Unsubscribe {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
  onProtocolError(fn: ProtocolErrorHandler): Unsubscribe {
    this.errorListeners.add(fn)
    return () => this.errorListeners.delete(fn)
  }
  onClose(fn: (reason: string) => void): Unsubscribe {
    if (this.st === 'closed') {
      this.notify([fn], this.closedReason ?? 'closed')
      return () => undefined
    }
    this.closeListeners.add(fn)
    return () => this.closeListeners.delete(fn)
  }

  stats(): SessionStats {
    return { ...this.counters, inFlight: this.inFlight.size, queued: this.queue.length + this.pendingBeforeReady.length }
  }

  /** For transports without onClose: the owner reports the socket closing. */
  notifyClosed(reason = 'transport closed'): void {
    this.finish(reason, false)
  }

  // ---------------------------------------------------------------------------------------------- capabilities

  supports(kind: ConstructKind | string): boolean {
    return !!this.caps && this.caps.constructs.includes(kind)
  }

  /** Where the face comes from for this stage: its own audio-to-face, or ARKit frames from the backend. */
  faceSource(): 'stage' | 'backend' {
    const f = this.caps?.face
    if (!f) return 'stage'
    if (f.audioToFaceOnStage) return 'stage'
    if (f.arkit52 || f.visemes) return 'backend'
    return 'stage'
  }

  // ----------------------------------------------------------------------------------------------- clock sync

  private addClockSample(stageMs: number): void {
    // a stage clock below 0 or beyond 2^50 ms is broken; one sample of it would put every later frame out of range
    if (!Number.isFinite(stageMs) || stageMs < 0 || stageMs > STAGE_CLOCK_MAX_MS) return
    const sample = stageMs - this.o.clock.now()
    const best = this.offsets.length > 0 ? Math.max(...this.offsets) : undefined
    // a jump of more than 5 s means the stage clock restarted: forget the old window (and tell whoever scheduled in the old one)
    if (best !== undefined && Math.abs(sample - best) > 5000) {
      this.offsets = []
      this.clockResets++
    }
    this.offsets.push(sample)
    if (this.offsets.length > 8) this.offsets.shift()
  }

  /**
   * How many times the stage clock jumped (a restart, a reset): times scheduled before a jump (frames, the planned end of
   * an utterance) were stamped in the old clock and no longer mean anything. The speech pipeline watches this.
   */
  clockEpoch(): number {
    return this.clockResets
  }

  /** Estimated stage clock minus backend clock, in ms (0 before the hello). */
  clockOffsetMs(): number {
    return this.offsets.length > 0 ? Math.max(...this.offsets) : 0
  }
  /** Spread of the recent samples: a rough measure of network jitter. */
  clockJitterMs(): number {
    return this.offsets.length > 1 ? Math.max(...this.offsets) - Math.min(...this.offsets) : 0
  }
  clockSamples(): number {
    return this.offsets.length
  }
  /** The stage clock "now". */
  stageNow(): number {
    return this.o.clock.now() + this.clockOffsetMs()
  }
  toStageTime(backendMs: number): number {
    return backendMs + this.clockOffsetMs()
  }
  toBackendTime(stageMs: number): number {
    return stageMs - this.clockOffsetMs()
  }

  // -------------------------------------------------------------------------------------------------- inbound

  /** Call listeners; one that throws neither starves the others nor reaches the transport callback that got us here. */
  private notify<A extends unknown[]>(listeners: Iterable<(...args: A) => void>, ...args: A): void {
    for (const fn of [...listeners]) {
      try {
        fn(...args)
      } catch {
        this.counters.listenerErrors++
      }
    }
  }

  private protocolError(reason: string): void {
    this.counters.invalidEvents++
    this.notify(this.errorListeners, { reason })
  }

  private handleText(raw: string): void {
    if (this.st === 'closed') return
    if (typeof raw !== 'string' || exceedsBytes(raw, this.opts.maxTextBytes)) {
      this.protocolError('text frame too large or not text')
      return
    }
    let obj: unknown
    try {
      obj = JSON.parse(raw)
    } catch {
      this.protocolError('not valid JSON')
      return
    }
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
      this.protocolError('event must be an object')
      return
    }
    const type = (obj as { type?: unknown }).type
    if (type === 'hello') {
      this.handleHello(obj)
      return
    }
    if (this.st === 'awaiting_hello') {
      this.counters.eventsBeforeHello++
      return
    }
    const parsed = StageEvent.safeParse(obj)
    if (!parsed.success) {
      this.protocolError(`invalid ${typeof type === 'string' ? type.slice(0, 40) : 'event'}`)
      return
    }
    this.dispatchEvent(parsed.data)
  }

  private handleHello(obj: object): void {
    const proto = (obj as { protocol?: unknown }).protocol
    if (proto !== STAGE_PROTOCOL) {
      this.refuse('protocol_mismatch', `stage speaks ${typeof proto === 'string' ? proto.slice(0, 40) : 'an unknown protocol'}, this backend speaks ${STAGE_PROTOCOL}`)
      return
    }
    const parsed = StageEvent.safeParse(obj)
    if (!parsed.success || parsed.data.type !== 'hello') {
      this.refuse('invalid_hello', 'the stage hello is malformed')
      return
    }
    const hello = parsed.data
    const again = this.st === 'ready'
    this.caps = hello.capabilities
    this.addClockSample(hello.stageClockMs)
    if (this.helloTimer !== undefined) {
      this.o.timers.clearTimeout(this.helloTimer)
      this.helloTimer = undefined
    }
    if (again) {
      // the stage restarted its own session on the same connection: it lost its state
      this.loadedCharacters.clear()
      this.unsupportedConstructs.clear()
    }
    this.st = 'ready'
    this.readyResolve(hello.capabilities)
    this.notify(this.listeners, hello)
    if ((this.o.autoResume ?? true) && (this.o.resumeCommands || this.mirror.hasContent())) void this.resume()
    const waiting = this.pendingBeforeReady.splice(0)
    for (const q of waiting) this.dispatch(q.draft, q.opts, q.resolve)
  }

  private dispatchEvent(ev: StageEvent): void {
    switch (ev.type) {
      case 'command.done':
        this.settle(ev.id, { ok: true })
        break
      case 'command.failed':
        this.settle(ev.id, { ok: false, reason: ev.reason })
        break
      case 'speak.started':
        this.addClockSample(ev.stageMs)
        break
      default:
        break
    }
    this.notify(this.listeners, ev)
  }

  private settle(id: string, result: CommandResult): void {
    const f = this.inFlight.get(id)
    if (!f) return // unknown or already settled (e.g. timed out): ignore
    this.inFlight.delete(id)
    this.o.timers.clearTimeout(f.timer)
    // a character.load holds a stage slot while it is in flight, and keeps it only if the stage accepted it
    const loading = this.pendingLoads.get(id)
    if (loading !== undefined) {
      this.pendingLoads.delete(id)
      if (result.ok) this.loadedCharacters.add(loading)
    }
    if (result.ok) {
      this.counters.acked++
      if (f.mirrorOnOk) {
        try {
          this.mirror.apply(f.cmd)
        } catch {
          /* a mirror that cannot take a command must not break the acknowledgement path */
        }
      }
    } else this.counters.failed++
    f.resolve(result)
    this.pump()
  }

  // ------------------------------------------------------------------------------------------------- outbound

  /**
   * Send a command. Resolves when the stage acknowledges it (or immediately for `ack: false`). Never rejects: failures
   * are results. Commands sent before the hello wait for it.
   */
  send(draft: CommandDraft, opts: SendOptions = {}): Promise<CommandResult> {
    return new Promise<CommandResult>((resolve) => {
      if (this.st === 'closed') {
        resolve({ ok: false, reason: 'closed' })
        return
      }
      if (this.st === 'awaiting_hello') {
        if (this.pendingBeforeReady.length >= this.opts.maxQueue) {
          resolve({ ok: false, reason: 'queue_full' })
          return
        }
        this.pendingBeforeReady.push({ draft, opts, resolve })
        return
      }
      this.dispatch(draft, opts, resolve)
    })
  }

  /** Send several in order; resolves when all are answered. */
  sendMany(drafts: readonly CommandDraft[], opts: SendOptions = {}): Promise<CommandResult[]> {
    return Promise.all(drafts.map((d) => this.send(d, opts)))
  }

  /** Never throws: whatever is wrong with a draft (or with the transport) comes back as a failed result. */
  private dispatch(draft: CommandDraft, opts: SendOptions, resolve: (r: CommandResult) => void): void {
    try {
      this.dispatchChecked(draft, opts ?? {}, resolve)
    } catch {
      this.counters.rejectedLocally++
      resolve({ ok: false, reason: 'invalid command: it could not be processed' })
    }
  }

  private rejectLocally(resolve: (r: CommandResult) => void, reason: string): void {
    this.counters.rejectedLocally++
    resolve({ ok: false, reason: reason.slice(0, 200) })
  }

  /** A command id that is not in flight: the caller's own (refused when it is already in use) or a generated one. */
  private allocateId(callerId: unknown): string | undefined {
    if (callerId !== undefined && callerId !== null) {
      if (typeof callerId !== 'string' || callerId.length === 0 || callerId.length > 128) return undefined
      return this.inFlight.has(callerId) ? undefined : callerId
    }
    let id = this.o.newId('cmd')
    // an IdGenerator that repeats itself must not orphan the command already waiting under that id
    for (let i = 0; i < 8 && this.inFlight.has(id); i++) id = this.o.newId('cmd')
    return this.inFlight.has(id) ? undefined : id
  }

  private dispatchChecked(draft: CommandDraft, opts: SendOptions, resolve: (r: CommandResult) => void): void {
    if (this.st === 'closed') {
      resolve({ ok: false, reason: 'closed' })
      return
    }
    if (typeof draft !== 'object' || draft === null || Array.isArray(draft)) {
      this.rejectLocally(resolve, 'invalid command: a command must be an object')
      return
    }
    if (this.inFlight.size >= this.opts.maxInFlight) {
      if (this.queue.length >= this.opts.maxQueue) {
        resolve({ ok: false, reason: 'queue_full' })
        return
      }
      this.queue.push({ draft, opts, resolve })
      return
    }
    const callerId = (draft as { id?: unknown }).id
    const id = this.allocateId(callerId)
    if (id === undefined) {
      const dup = typeof callerId === 'string' && callerId.length > 0 && callerId.length <= 128
      this.rejectLocally(resolve, dup ? `duplicate command id "${callerId.slice(0, 40)}": a command with that id is still waiting for its answer` : 'invalid command id')
      return
    }
    const parsed = StageCommand.safeParse({ ...draft, id })
    if (!parsed.success) {
      const i = parsed.error.issues[0]
      this.rejectLocally(resolve, `invalid command ${String((draft as { type?: unknown }).type).slice(0, 40)}: ${i ? `${i.path.join('.')} ${i.message}` : 'invalid'}`)
      return
    }
    const adapted = this.adapt(parsed.data)
    if ('skip' in adapted) {
      this.counters.skipped++
      resolve({ ok: true, skipped: adapted.skip })
      return
    }
    if ('fail' in adapted) {
      this.rejectLocally(resolve, adapted.fail)
      return
    }
    const cmd = adapted.cmd
    const wire = serialise(cmd)
    if (wire === undefined) {
      this.rejectLocally(resolve, `command ${cmd.type} cannot be serialised (a cycle, a BigInt or a number that is not finite)`)
      return
    }
    if (exceedsBytes(wire, this.opts.maxCommandBytes)) {
      this.rejectLocally(resolve, `command ${cmd.type} is too large (${utf8Length(wire)} bytes)`)
      return
    }
    if (opts.ack === false) {
      try {
        this.o.transport.sendText(wire)
      } catch {
        this.counters.transportErrors++
        resolve({ ok: false, reason: 'transport_error' })
        return
      }
      this.counters.sent++
      if (cmd.type === 'character.load') this.loadedCharacters.add(cmd.character.id)
      try {
        this.mirror.apply(cmd)
      } catch {
        /* the mirror is a convenience for resume; it must not turn a sent command into a failure */
      }
      resolve({ ok: true })
      return
    }
    // register BEFORE sending: a transport may deliver the acknowledgement synchronously
    const timeoutMs = opts.timeoutMs ?? (LOAD_TYPES.has(cmd.type) ? this.opts.loadTimeoutMs : this.opts.commandTimeoutMs)
    const timer = this.o.timers.setTimeout(() => {
      const f = this.inFlight.get(cmd.id)
      if (!f) return
      this.counters.timeouts++
      this.settle(cmd.id, { ok: false, reason: 'timeout' })
    }, timeoutMs)
    this.inFlight.set(cmd.id, { cmd, resolve, timer, mirrorOnOk: true })
    if (cmd.type === 'character.load') this.pendingLoads.set(cmd.id, cmd.character.id)
    this.counters.sent++
    try {
      this.o.transport.sendText(wire)
    } catch {
      // not sent (or the stage's handler threw): free the slot now instead of holding it until the timeout
      this.counters.transportErrors++
      if (this.inFlight.delete(cmd.id)) {
        this.o.timers.clearTimeout(timer)
        this.pendingLoads.delete(cmd.id)
        this.counters.sent--
        resolve({ ok: false, reason: 'transport_error' })
        this.pump()
      }
    }
  }

  private pump(): void {
    while (this.queue.length > 0 && this.inFlight.size < this.opts.maxInFlight && this.st === 'ready') {
      const q = this.queue.shift()!
      this.dispatch(q.draft, q.opts, q.resolve)
    }
  }

  /** Fit a command to what the stage can do. */
  private adapt(cmd: StageCommandT): { cmd: StageCommandT } | { skip: string } | { fail: string } {
    const caps = this.caps
    if (!caps) return { cmd }
    switch (cmd.type) {
      case 'character.load': {
        if (!caps.rigFamilies.includes(cmd.character.rigFamily)) return { fail: `rig_unsupported: the stage does not support ${cmd.character.rigFamily} rigs` }
        // a slot is held by a character the stage accepted AND by one whose answer is still pending; a load the stage FAILED holds none
        const occupied = new Set<string>([...this.loadedCharacters, ...this.pendingLoads.values()])
        if (!occupied.has(cmd.character.id) && occupied.size >= caps.maxCharacters) return { fail: `max_characters: the stage shows at most ${caps.maxCharacters}` }
        return { cmd }
      }
      case 'scene.construct': {
        if (cmd.op === 'remove') {
          if (this.unsupportedConstructs.delete(cmd.construct.id)) return { skip: 'unsupported_construct' }
          return { cmd }
        }
        if (!caps.constructs.includes(cmd.construct.kind)) {
          this.unsupportedConstructs.add(cmd.construct.id)
          return { skip: 'unsupported_construct' }
        }
        this.unsupportedConstructs.delete(cmd.construct.id)
        return { cmd }
      }
      case 'scene.data':
      case 'construct.terminal.write':
        return this.unsupportedConstructs.has(cmd.constructId) ? { skip: 'unsupported_construct' } : { cmd }
      case 'scene.load': {
        const keep = cmd.scene.constructs.filter((c) => caps.constructs.includes(c.kind))
        for (const c of cmd.scene.constructs) if (!caps.constructs.includes(c.kind)) this.unsupportedConstructs.add(c.id)
        for (const c of keep) this.unsupportedConstructs.delete(c.id)
        if (keep.length === cmd.scene.constructs.length) return { cmd }
        return { cmd: { ...cmd, scene: { ...cmd.scene, constructs: keep } } }
      }
      case 'perform.speak': {
        if (cmd.faceSource === 'backend' && !(caps.face.arkit52 || caps.face.visemes)) return { cmd: { ...cmd, faceSource: 'stage' } }
        return { cmd }
      }
      default:
        return { cmd }
    }
  }

  /** Replay what the stage should show (after a reconnect). Resolves with every command's result. */
  resume(): Promise<CommandResult[]> {
    if (this.st === 'closed') return Promise.resolve([])
    let drafts: CommandDraft[]
    try {
      drafts = this.o.resumeCommands ? this.o.resumeCommands() : this.mirror.replay()
    } catch {
      return Promise.resolve([]) // an owner callback that throws must not take the connection down
    }
    return this.sendMany(Array.isArray(drafts) ? drafts : [])
  }

  // -------------------------------------------------------------------------------------------------- binary

  bufferedAmount(): number {
    return this.o.transport.bufferedAmount?.() ?? 0
  }

  /** True while the transport is open and under its high-water mark. */
  canSendBinary(): boolean {
    return this.st === 'ready' && this.bufferedAmount() < this.opts.highWaterBytes
  }

  /** Send a binary frame if the transport has room. Returns false (nothing sent) under back-pressure or when closed. */
  sendBinary(bytes: Uint8Array): boolean {
    if (!this.canSendBinary()) {
      if (this.st === 'ready') this.counters.binaryHeldBack++
      return false
    }
    try {
      this.o.transport.sendBinary(bytes)
    } catch {
      this.counters.transportErrors++
      return false
    }
    this.counters.binarySent++
    return true
  }

  // --------------------------------------------------------------------------------------------------- closing

  private refuse(code: string, message: string): void {
    this.finish(`${code}: ${message}`, true, code)
    this.readyReject(new Error(`${code}: ${message}`))
  }

  /** Close the connection from our side. */
  close(reason = 'closed by backend'): void {
    this.finish(reason, true)
  }

  private finish(reason: string, closeTransport: boolean, code = 'closed'): void {
    if (this.st === 'closed') return
    this.st = 'closed'
    this.closedReason = reason
    if (this.helloTimer !== undefined) this.o.timers.clearTimeout(this.helloTimer)
    this.helloTimer = undefined
    for (const [id, f] of [...this.inFlight]) {
      this.o.timers.clearTimeout(f.timer)
      this.inFlight.delete(id)
      f.resolve({ ok: false, reason: 'closed' })
    }
    for (const q of this.queue.splice(0)) q.resolve({ ok: false, reason: 'closed' })
    for (const q of this.pendingBeforeReady.splice(0)) q.resolve({ ok: false, reason: 'closed' })
    this.pendingLoads.clear()
    for (const u of this.unsubs.splice(0)) u()
    this.readyReject(new Error(reason))
    if (closeTransport) {
      try {
        this.o.transport.close(code === 'closed' ? 1000 : 4001, reason.slice(0, 120))
      } catch {
        /* closing a dead socket */
      }
    }
    this.notify(this.closeListeners, reason)
    this.closeListeners.clear()
    this.listeners.clear()
  }
}

/** UTF-8 length of a string (what a WebSocket frame costs), without allocating the bytes. */
export function utf8Length(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 4
      i++
    } else n += 3
  }
  return n
}

/** Is `s` longer than `maxBytes` in UTF-8? Cheap when it clearly is not (each UTF-16 unit takes at most 3 bytes) or clearly is (at least 1). */
function exceedsBytes(s: string, maxBytes: number): boolean {
  if (s.length > maxBytes) return true
  return s.length * 3 > maxBytes && utf8Length(s) > maxBytes
}

/**
 * The JSON text of a command, or undefined when it cannot be written EXACTLY: a cycle, a BigInt, a throwing `toJSON` or
 * getter, or a number that is not finite (JSON.stringify would silently write NaN and Infinity as `null`).
 */
export function serialise(cmd: unknown): string | undefined {
  try {
    return JSON.stringify(cmd, (_key, v: unknown) => {
      if (typeof v === 'number' && !Number.isFinite(v)) throw new RangeError('a number that is not finite')
      return v
    })
  } catch {
    return undefined
  }
}

export function createStageSession(opts: StageSessionOptions): StageSession {
  return new StageSession(opts)
}

/** ARKit names, re-exported so engine glue can map weights without importing shared. */
export const ARKIT_NAMES: readonly string[] = ARKIT_52
