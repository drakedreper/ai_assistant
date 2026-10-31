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
 * PRIVACY: the session never logs. Error reasons name ids and types, never payloads (terminal bytes, text).
 */
import { ARKIT_52, StageCommand, StageEvent, STAGE_PROTOCOL } from '@ai-assistant/shared'
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
  private readonly loadedCharacters = new Set<string>()
  private readonly counters = { sent: 0, acked: 0, failed: 0, timeouts: 0, rejectedLocally: 0, skipped: 0, invalidEvents: 0, eventsBeforeHello: 0, binarySent: 0, binaryHeldBack: 0 }
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
      fn(this.closedReason ?? 'closed')
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
    if (!Number.isFinite(stageMs)) return
    const sample = stageMs - this.o.clock.now()
    const best = this.offsets.length > 0 ? Math.max(...this.offsets) : undefined
    // a jump of more than 5 s means the stage clock restarted: forget the old window
    if (best !== undefined && Math.abs(sample - best) > 5000) this.offsets = []
    this.offsets.push(sample)
    if (this.offsets.length > 8) this.offsets.shift()
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

  private protocolError(reason: string): void {
    this.counters.invalidEvents++
    for (const fn of [...this.errorListeners]) fn({ reason })
  }

  private handleText(raw: string): void {
    if (this.st === 'closed') return
    if (typeof raw !== 'string' || raw.length > this.opts.maxTextBytes) {
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
    for (const fn of [...this.listeners]) fn(hello)
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
    for (const fn of [...this.listeners]) fn(ev)
  }

  private settle(id: string, result: CommandResult): void {
    const f = this.inFlight.get(id)
    if (!f) return // unknown or already settled (e.g. timed out): ignore
    this.inFlight.delete(id)
    this.o.timers.clearTimeout(f.timer)
    if (result.ok) {
      this.counters.acked++
      if (f.mirrorOnOk) this.mirror.apply(f.cmd)
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

  private dispatch(draft: CommandDraft, opts: SendOptions, resolve: (r: CommandResult) => void): void {
    if (this.st === 'closed') {
      resolve({ ok: false, reason: 'closed' })
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
    const id = draft.id ?? this.o.newId('cmd')
    const parsed = StageCommand.safeParse({ ...draft, id })
    if (!parsed.success) {
      this.counters.rejectedLocally++
      const i = parsed.error.issues[0]
      resolve({ ok: false, reason: `invalid command ${String((draft as { type?: unknown }).type).slice(0, 40)}: ${i ? `${i.path.join('.')} ${i.message}` : 'invalid'}`.slice(0, 200) })
      return
    }
    const adapted = this.adapt(parsed.data)
    if ('skip' in adapted) {
      this.counters.skipped++
      resolve({ ok: true, skipped: adapted.skip })
      return
    }
    if ('fail' in adapted) {
      this.counters.rejectedLocally++
      resolve({ ok: false, reason: adapted.fail })
      return
    }
    const cmd = adapted.cmd
    const wire = JSON.stringify(cmd)
    if (wire.length > this.opts.maxCommandBytes) {
      this.counters.rejectedLocally++
      resolve({ ok: false, reason: `command ${cmd.type} is too large (${wire.length} bytes)` })
      return
    }
    this.trackLoad(cmd)
    if (opts.ack === false) {
      this.o.transport.sendText(wire)
      this.counters.sent++
      this.mirror.apply(cmd)
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
    this.counters.sent++
    this.o.transport.sendText(wire)
  }

  private pump(): void {
    while (this.queue.length > 0 && this.inFlight.size < this.opts.maxInFlight && this.st === 'ready') {
      const q = this.queue.shift()!
      this.dispatch(q.draft, q.opts, q.resolve)
    }
  }

  private trackLoad(cmd: StageCommandT): void {
    if (cmd.type === 'character.load') this.loadedCharacters.add(cmd.character.id)
  }

  /** Fit a command to what the stage can do. */
  private adapt(cmd: StageCommandT): { cmd: StageCommandT } | { skip: string } | { fail: string } {
    const caps = this.caps
    if (!caps) return { cmd }
    switch (cmd.type) {
      case 'character.load': {
        if (!caps.rigFamilies.includes(cmd.character.rigFamily)) return { fail: `rig_unsupported: the stage does not support ${cmd.character.rigFamily} rigs` }
        if (!this.loadedCharacters.has(cmd.character.id) && this.loadedCharacters.size >= caps.maxCharacters) return { fail: `max_characters: the stage shows at most ${caps.maxCharacters}` }
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
    return this.sendMany(this.o.resumeCommands ? this.o.resumeCommands() : this.mirror.replay())
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
    this.o.transport.sendBinary(bytes)
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
    for (const u of this.unsubs.splice(0)) u()
    this.readyReject(new Error(reason))
    if (closeTransport) {
      try {
        this.o.transport.close(code === 'closed' ? 1000 : 4001, reason.slice(0, 120))
      } catch {
        /* closing a dead socket */
      }
    }
    for (const fn of [...this.closeListeners]) fn(reason)
    this.closeListeners.clear()
    this.listeners.clear()
  }
}

export function createStageSession(opts: StageSessionOptions): StageSession {
  return new StageSession(opts)
}

/** ARKit names, re-exported so engine glue can map weights without importing shared. */
export const ARKIT_NAMES: readonly string[] = ARKIT_52
