import { StringDecoder } from 'node:string_decoder'
import * as nodePath from 'node:path'
import type { TerminalInfo, TerminalKind, TerminalServerMessage } from '@ai-assistant/shared'
import type { TerminalConfig } from '../config'
import type { Scheduler } from '../hooks/service'
import { realScheduler } from '../hooks/service'
import type { IdGen } from '../ids'
import type { Logger } from '../log'
import { resolveHomeCwd, resolveProjectCwd, resolveTerminalCwd, type CwdContext, type CwdFs, type CwdResult } from './cwd'
import { buildTerminalEnv } from './env'
import { LaunchError, resolveClaudeLaunch, resolveShellLaunch, type LaunchFs, type LaunchSpec } from './launch'
import type { TreeKiller } from './kill'
import { TokenBucket } from './limits'
import { PtyUnavailableError, type PtyFactory, type PtyLike } from './pty'
import { Scrollback } from './scrollback'

/**
 * TerminalService: the embedded terminals (kind 'claude' or 'shell') on a PTY. No HTTP, no sockets, no database here:
 * the PTY factory, the tree killer, the file system, the clock and the timers are injected, so the unit tests drive
 * everything with a fake PTY and a few integration tests use the real node-pty.
 *
 * It enforces: the on/off gate, the cwd rules, the child environment, the concurrent-terminal cap, ONE attached
 * client per terminal, a bounded in-memory scrollback replayed on attach, the input frame cap and rate limit, the
 * idle timeout (detached terminals only), and tree-kill on close, disable and shutdown.
 *
 * Terminal bytes (keystrokes and output) are never logged, never audited and never written to disk.
 */

export type TerminalErrorStatus = 400 | 403 | 404 | 409 | 422 | 429 | 500 | 502 | 503

export class TerminalError extends Error {
  override name = 'TerminalError'
  constructor(
    readonly status: TerminalErrorStatus,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

export type TerminalCloseReason = 'user' | 'idle' | 'disabled' | 'shutdown'

export type TerminalEvent =
  | { type: 'opened'; info: TerminalInfo }
  /** The process ended by itself (the user typed exit, claude quit, it crashed). */
  | { type: 'exited'; info: TerminalInfo }
  /** The daemon killed a running terminal. */
  | { type: 'closed'; info: TerminalInfo; reason: TerminalCloseReason }
  /** An entry left the list (user removed it, the cap forgot it, terminals were switched off). */
  | { type: 'removed'; id: string }
  /** A request was refused before anything started. `code` is the stable error code. */
  | { type: 'refused'; kind: TerminalKind; code: string }

/** Where a terminal's output goes. The WebSocket layer implements it; tests use a recorder. */
export interface TerminalSink {
  /** Called in order. False means the client was too slow and is dropped (the terminal keeps running). */
  output(chunk: Buffer): boolean
  control(msg: TerminalServerMessage): void
  /** The terminal ended, or the daemon is closing it: finish the connection. */
  end(reason: 'exited' | 'closed'): void
}

export type WriteResult = 'ok' | 'rate_limited' | 'too_large' | 'closed'

export interface TerminalAttachment {
  readonly id: string
  write(data: Uint8Array): WriteResult
  resize(cols: number, rows: number): boolean
  detach(): void
}

export interface ServiceProject {
  id: string
  name: string
  rootPath: string
}

export interface TerminalServiceOptions {
  limits: TerminalConfig
  platform: NodeJS.Platform
  /** The daemon's own environment (read at every spawn). */
  env: () => Readonly<Record<string, string | undefined>>
  home: string
  cwdFs: CwdFs
  launchFs: LaunchFs
  ptyFactory: PtyFactory
  killer: TreeKiller
  clock: () => number
  newId: IdGen
  scheduler?: Scheduler
  /** The on/off switch the user controls in Settings. */
  enabled: () => boolean
  projects: () => ServiceProject[]
  /** CLAUDE_EXECUTABLE */
  claudeExecutable?: string | undefined
  log: Logger
  onEvent?: (e: TerminalEvent) => void
}

interface Attached {
  sink: TerminalSink
  bucket: TokenBucket
  active: boolean
}

interface Rec {
  id: string
  kind: TerminalKind
  title: string
  cwd: string
  projectId: string | undefined
  cols: number
  rows: number
  createdAt: string
  createdMs: number
  state: 'running' | 'exited'
  exitCode: number | null
  pty: PtyLike
  scrollback: Scrollback
  decoder: StringDecoder
  client: Attached | null
  lastActivity: number
  closeReason: TerminalCloseReason | undefined
  killing: Promise<void> | undefined
  exitWaiters: Array<() => void>
}

const REPLAY_CHUNK = 32 * 1024
/** Every frame costs at least this many bytes of the input budget, so a flood of tiny frames is limited too. */
const FRAME_OVERHEAD = 256
const IDLE_SWEEP_MS = 30_000

const intInRange = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max

export class TerminalService {
  private readonly terms = new Map<string, Rec>()
  private reserved = 0
  private timer: unknown
  private stopped = false
  private readonly scheduler: Scheduler

  constructor(private readonly o: TerminalServiceOptions) {
    this.scheduler = o.scheduler ?? realScheduler
  }

  /** Start the idle sweep. */
  start(): void {
    if (this.timer !== undefined) return
    this.timer = this.scheduler.setInterval(() => this.sweepIdle(), IDLE_SWEEP_MS)
  }

  enabled(): boolean {
    return this.o.enabled()
  }

  // ---------------------------------------------------------------- reads

  list(): TerminalInfo[] {
    return [...this.terms.values()].map((r) => this.info(r))
  }

  get(id: string): TerminalInfo | undefined {
    const r = this.terms.get(id)
    return r ? this.info(r) : undefined
  }

  runningCount(): number {
    let n = 0
    for (const r of this.terms.values()) if (r.state === 'running') n++
    return n
  }

  isAttached(id: string): boolean {
    return this.terms.get(id)?.client != null
  }

  private info(r: Rec): TerminalInfo {
    return {
      id: r.id,
      kind: r.kind,
      title: r.title,
      cwd: r.cwd,
      ...(r.projectId !== undefined ? { projectId: r.projectId } : {}),
      cols: r.cols,
      rows: r.rows,
      createdAt: r.createdAt,
      state: r.state,
      exitCode: r.exitCode,
    }
  }

  private emit(e: TerminalEvent): void {
    try {
      this.o.onEvent?.(e)
    } catch (err) {
      this.o.log.warn('terminal event handler failed', { error: err instanceof Error ? err.message : 'unknown' })
    }
  }

  // ---------------------------------------------------------------- create

  async create(req: { kind: TerminalKind; projectId?: string | undefined; cwd?: string | undefined; cols?: number | undefined; rows?: number | undefined }): Promise<TerminalInfo> {
    if (this.stopped) throw new TerminalError(503, 'shutting_down', 'The daemon is shutting down.')
    if (!this.o.enabled()) throw new TerminalError(403, 'terminals_disabled', 'Embedded terminals are switched off. Turn them on in Settings, Privacy.')
    if (req.kind !== 'claude' && req.kind !== 'shell') throw new TerminalError(400, 'invalid_request', 'kind must be "claude" or "shell".')
    const cols = req.cols ?? 100
    const rows = req.rows ?? 30
    if (!intInRange(cols, 10, 500) || !intInRange(rows, 5, 200)) throw new TerminalError(400, 'invalid_request', 'cols must be 10 to 500 and rows 5 to 200.')
    if (this.runningCount() + this.reserved >= this.o.limits.maxTerminals) {
      this.emit({ type: 'refused', kind: req.kind, code: 'terminal_limit' })
      throw new TerminalError(429, 'terminal_limit', `At most ${this.o.limits.maxTerminals} terminals can run at once. Close one first.`)
    }

    this.reserved++
    try {
      const { cwd, project } = this.resolveStart(req)
      const launch = this.resolveLaunch(req.kind)
      const env = buildTerminalEnv(this.o.env(), { platform: this.o.platform })
      let pty: PtyLike
      try {
        pty = await this.o.ptyFactory({ file: launch.file, args: launch.args, cwd, env, cols, rows })
      } catch (err) {
        if (err instanceof PtyUnavailableError) {
          this.o.log.error('terminal backend unavailable', { error: err.message })
          this.emit({ type: 'refused', kind: req.kind, code: 'pty_unavailable' })
          throw new TerminalError(500, 'pty_unavailable', 'The terminal backend (node-pty) could not be loaded on this PC. Reinstall dependencies for this Node version.')
        }
        this.o.log.warn('terminal spawn failed', { kind: req.kind, error: err instanceof Error ? err.message : 'unknown' })
        this.emit({ type: 'refused', kind: req.kind, code: 'spawn_failed' })
        throw new TerminalError(502, 'spawn_failed', 'The terminal process could not be started.')
      }
      // The daemon may have started shutting down, or the user switched terminals off, while the process was starting.
      if (this.stopped || !this.o.enabled()) {
        await this.killOrphan(pty)
        if (this.stopped) throw new TerminalError(503, 'shutting_down', 'The daemon is shutting down.')
        throw new TerminalError(403, 'terminals_disabled', 'Embedded terminals are switched off. Turn them on in Settings, Privacy.')
      }
      return this.register(req.kind, launch, cwd, project, cols, rows, pty)
    } finally {
      this.reserved--
    }
  }

  private resolveStart(req: { kind: TerminalKind; projectId?: string | undefined; cwd?: string | undefined }): { cwd: string; project: ServiceProject | undefined } {
    const projects = this.o.projects()
    const ctx: CwdContext = { platform: this.o.platform, home: this.o.home, projectRoots: projects.map((p) => p.rootPath), fs: this.o.cwdFs }
    let result: CwdResult
    let project: ServiceProject | undefined
    if (req.projectId !== undefined) {
      project = projects.find((p) => p.id === req.projectId)
      if (!project) {
        this.emit({ type: 'refused', kind: req.kind, code: 'unknown_project' })
        throw new TerminalError(400, 'unknown_project', 'projectId does not match any project.')
      }
      result = req.cwd !== undefined ? resolveTerminalCwd(req.cwd, ctx, [project.rootPath]) : resolveProjectCwd(project.rootPath, ctx)
    } else if (req.cwd !== undefined) {
      result = resolveTerminalCwd(req.cwd, ctx)
    } else {
      result = resolveHomeCwd(ctx)
    }
    if (!result.ok) {
      this.emit({ type: 'refused', kind: req.kind, code: result.code })
      throw new TerminalError(400, result.code, result.message)
    }
    return { cwd: result.cwd, project }
  }

  private resolveLaunch(kind: TerminalKind): LaunchSpec {
    try {
      if (kind === 'claude') {
        return resolveClaudeLaunch({
          env: this.o.env(),
          platform: this.o.platform,
          fs: this.o.launchFs,
          claudeExecutable: this.o.claudeExecutable,
          commandOverride: this.o.limits.claudeCommandOverride,
        })
      }
      return resolveShellLaunch({ env: this.o.env(), platform: this.o.platform, fs: this.o.launchFs })
    } catch (err) {
      if (err instanceof LaunchError) {
        this.emit({ type: 'refused', kind, code: err.code })
        throw new TerminalError(err.code === 'claude_not_found' ? 422 : 500, err.code, err.message)
      }
      throw err
    }
  }

  private register(kind: TerminalKind, launch: LaunchSpec, cwd: string, project: ServiceProject | undefined, cols: number, rows: number, pty: PtyLike): TerminalInfo {
    const f = this.o.platform === 'win32' ? nodePath.win32 : nodePath.posix
    const place = project?.name || f.basename(cwd) || cwd
    const now = this.o.clock()
    const rec: Rec = {
      id: this.o.newId('term'),
      kind,
      title: `${launch.title} · ${place}`.slice(0, 120),
      cwd,
      projectId: project?.id,
      cols,
      rows,
      createdAt: new Date(now).toISOString(),
      createdMs: now,
      state: 'running',
      exitCode: null,
      pty,
      scrollback: new Scrollback(this.o.limits.scrollbackBytes),
      decoder: new StringDecoder('utf8'),
      client: null,
      lastActivity: now,
      closeReason: undefined,
      killing: undefined,
      exitWaiters: [],
    }
    this.terms.set(rec.id, rec)
    pty.onData((d) => this.onData(rec, d))
    pty.onExit((e) => this.onExit(rec, e))
    this.o.log.info('terminal opened', { id: rec.id, kind })
    const info = this.info(rec)
    this.emit({ type: 'opened', info })
    return info
  }

  private async killOrphan(pty: PtyLike): Promise<void> {
    try {
      await this.o.killer.forceKill(pty.pid)
      pty.kill()
    } catch {
      /* already gone */
    }
  }

  // ---------------------------------------------------------------- pty events

  private onData(rec: Rec, data: string | Uint8Array): void {
    if (rec.state !== 'running') return
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data.buffer, data.byteOffset, data.byteLength)
    rec.scrollback.push(buf)
    const c = rec.client
    if (c && c.active && !c.sink.output(buf)) this.dropClient(rec, c)
  }

  private onExit(rec: Rec, e: { exitCode: number | null; signal?: number }): void {
    if (rec.state === 'exited') return
    let code: number | null = typeof e.exitCode === 'number' ? e.exitCode : null
    // Killed by a signal: report it the way shells do (128 + signal) instead of a misleading 0.
    if (typeof e.signal === 'number' && e.signal > 0 && (code === 0 || code === null)) code = 128 + e.signal
    this.markExited(rec, code)
  }

  private markExited(rec: Rec, exitCode: number | null): void {
    if (rec.state === 'exited') return
    rec.state = 'exited'
    rec.exitCode = exitCode
    rec.lastActivity = this.o.clock()
    const c = rec.client
    rec.client = null
    if (c && c.active) {
      c.active = false
      c.sink.control({ type: 'exit', exitCode })
      c.sink.end(rec.closeReason ? 'closed' : 'exited')
    }
    const waiters = rec.exitWaiters.splice(0)
    for (const w of waiters) w()
    this.o.log.info('terminal exited', { id: rec.id, kind: rec.kind, exitCode: exitCode ?? -1 })
    if (rec.closeReason === undefined) {
      this.emit({ type: 'exited', info: this.info(rec) })
      this.pruneExited()
    }
  }

  private pruneExited(): void {
    const exited = [...this.terms.values()].filter((r) => r.state === 'exited')
    const extra = exited.length - this.o.limits.maxExitedKept
    if (extra <= 0) return
    exited.sort((a, b) => a.createdMs - b.createdMs)
    for (const r of exited.slice(0, extra)) this.forget(r)
  }

  private forget(rec: Rec): void {
    if (!this.terms.delete(rec.id)) return
    rec.scrollback.clear()
    this.emit({ type: 'removed', id: rec.id })
  }

  // ---------------------------------------------------------------- attach

  /**
   * Connect a client. Exactly one client per terminal: a second attach is refused with a clear error. The client
   * first gets `ready` with the replay size, then the scrollback as binary chunks, then live output; all in the same
   * synchronous step, so no byte is lost or duplicated between the replay and the live stream.
   */
  attach(id: string, sink: TerminalSink): TerminalAttachment {
    const rec = this.terms.get(id)
    if (!rec) throw new TerminalError(404, 'not_found', 'No such terminal.')
    if (rec.client) throw new TerminalError(409, 'already_attached', 'Another window is already connected to this terminal. Close it, or wait a few seconds, then reconnect.')
    const { limits } = this.o
    const handle: Attached = { sink, bucket: new TokenBucket(limits.inputBurstBytes, limits.inputBytesPerSec, this.o.clock), active: true }
    rec.client = handle
    rec.lastActivity = this.o.clock()

    const replay = rec.scrollback.snapshot()
    sink.control({ type: 'ready', replayBytes: replay.length })
    for (let off = 0; off < replay.length && handle.active; off += REPLAY_CHUNK) {
      if (!sink.output(replay.subarray(off, Math.min(replay.length, off + REPLAY_CHUNK)))) this.dropClient(rec, handle)
    }
    if (handle.active && rec.state === 'exited') {
      handle.active = false
      rec.client = null
      sink.control({ type: 'exit', exitCode: rec.exitCode })
      sink.end('exited')
    }

    return {
      id,
      write: (data) => {
        if (!handle.active || rec.state !== 'running') return 'closed'
        if (data.length > limits.maxInputFrameBytes) return 'too_large'
        if (!handle.bucket.take(data.length + FRAME_OVERHEAD)) return 'rate_limited'
        rec.lastActivity = this.o.clock()
        try {
          const text = rec.decoder.write(Buffer.from(data.buffer, data.byteOffset, data.byteLength))
          if (text.length > 0) rec.pty.write(text)
        } catch {
          return 'closed'
        }
        return 'ok'
      },
      resize: (cols, rows) => {
        if (!handle.active || rec.state !== 'running') return false
        if (!intInRange(cols, 10, 500) || !intInRange(rows, 5, 200)) return false
        rec.lastActivity = this.o.clock()
        if (cols === rec.cols && rows === rec.rows) return true
        try {
          rec.pty.resize(cols, rows)
        } catch {
          return false
        }
        rec.cols = cols
        rec.rows = rows
        return true
      },
      detach: () => {
        handle.active = false
        if (rec.client === handle) {
          rec.client = null
          rec.lastActivity = this.o.clock()
        }
      },
    }
  }

  private dropClient(rec: Rec, c: Attached): void {
    c.active = false
    if (rec.client === c) {
      rec.client = null
      rec.lastActivity = this.o.clock()
    }
  }

  // ---------------------------------------------------------------- resize without a client (service API)

  resize(id: string, cols: number, rows: number): void {
    const rec = this.terms.get(id)
    if (!rec) throw new TerminalError(404, 'not_found', 'No such terminal.')
    if (!intInRange(cols, 10, 500) || !intInRange(rows, 5, 200)) throw new TerminalError(400, 'invalid_request', 'cols must be 10 to 500 and rows 5 to 200.')
    if (rec.state !== 'running') throw new TerminalError(409, 'terminal_exited', 'That terminal has exited.')
    rec.pty.resize(cols, rows)
    rec.cols = cols
    rec.rows = rows
  }

  // ---------------------------------------------------------------- close

  /**
   * Kill the terminal's whole process tree. `user`: the entry is also removed from the list. Other reasons keep an
   * exited entry (with its exit code) until the user removes it.
   */
  async close(id: string, reason: TerminalCloseReason = 'user'): Promise<void> {
    const rec = this.terms.get(id)
    if (!rec) throw new TerminalError(404, 'not_found', 'No such terminal.')
    const wasRunning = rec.state === 'running'
    // Someone else (the idle sweep, the switch) is already closing it: wait for that, do not report a second close.
    const alreadyClosing = rec.killing !== undefined
    if (wasRunning) {
      await this.kill(rec, reason)
      if (!alreadyClosing) this.emit({ type: 'closed', info: this.info(rec), reason })
    }
    if (reason === 'user') this.forget(rec)
    else this.pruneExited()
  }

  /** Kill every running terminal. `disabled` also empties the list. */
  async closeAll(reason: Exclude<TerminalCloseReason, 'user'>): Promise<void> {
    const running = [...this.terms.values()].filter((r) => r.state === 'running')
    await Promise.all(
      running.map(async (r) => {
        await this.kill(r, reason)
        this.emit({ type: 'closed', info: this.info(r), reason })
      }),
    )
    if (reason === 'disabled') for (const r of [...this.terms.values()]) this.forget(r)
  }

  private kill(rec: Rec, reason: TerminalCloseReason): Promise<void> {
    if (rec.killing) return rec.killing
    rec.closeReason = rec.closeReason ?? reason
    const { killGraceMs } = this.o.limits
    rec.killing = (async () => {
      const pid = rec.pty.pid
      try {
        await this.o.killer.terminate(pid)
      } catch (err) {
        this.o.log.warn('terminal terminate failed', { id: rec.id, error: err instanceof Error ? err.message : 'unknown' })
      }
      try {
        rec.pty.kill()
      } catch {
        /* the pty is already closed */
      }
      if (await this.waitExit(rec, killGraceMs)) return
      try {
        await this.o.killer.forceKill(pid)
        rec.pty.kill()
      } catch {
        /* gone */
      }
      if (await this.waitExit(rec, killGraceMs)) return
      // The OS never told us it ended. Do not leave a "running" entry that nothing can stop.
      this.o.log.warn('terminal did not report an exit after a forced kill', { id: rec.id })
      this.markExited(rec, null)
    })()
    return rec.killing
  }

  private waitExit(rec: Rec, ms: number): Promise<boolean> {
    if (rec.state === 'exited') return Promise.resolve(true)
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        const i = rec.exitWaiters.indexOf(done)
        if (i >= 0) rec.exitWaiters.splice(i, 1)
        resolve(false)
      }, ms)
      timer.unref()
      const done = (): void => {
        clearTimeout(timer)
        resolve(true)
      }
      rec.exitWaiters.push(done)
    })
  }

  /** Remove an exited terminal from the list (a running one must be closed instead). */
  remove(id: string): void {
    const rec = this.terms.get(id)
    if (!rec) throw new TerminalError(404, 'not_found', 'No such terminal.')
    if (rec.state === 'running') throw new TerminalError(409, 'terminal_running', 'That terminal is still running. Close it first.')
    this.forget(rec)
  }

  // ---------------------------------------------------------------- idle and shutdown

  /** Close running terminals that have had no client attached (and no keystroke) for the idle timeout. */
  sweepIdle(): void {
    const t = this.o.clock()
    for (const rec of this.terms.values()) {
      if (rec.state !== 'running' || rec.client || rec.killing) continue
      if (t - rec.lastActivity < this.o.limits.idleTimeoutMs) continue
      this.o.log.info('closing an idle terminal', { id: rec.id })
      void this.close(rec.id, 'idle').catch(() => undefined)
    }
  }

  /**
   * Hard-kill every running terminal's tree RIGHT NOW, synchronously. Only for a process 'exit' handler (a crash, or
   * the shutdown watchdog's process.exit): nothing is awaited, nothing is reported, no state is updated.
   */
  killAllNow(): void {
    for (const rec of this.terms.values()) {
      if (rec.state !== 'running') continue
      try {
        this.o.killer.forceKillSync(rec.pty.pid)
      } catch {
        /* gone */
      }
    }
  }

  /** Graceful daemon shutdown: refuse new terminals, kill every PTY and its tree, stop the timer. */
  async shutdown(): Promise<void> {
    this.stopped = true
    if (this.timer !== undefined) this.scheduler.clearInterval(this.timer)
    this.timer = undefined
    await this.closeAll('shutdown')
  }
}
