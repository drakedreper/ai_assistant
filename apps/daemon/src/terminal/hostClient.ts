import { spawn as nodeSpawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import * as nodePath from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Logger } from '../log'
import { buildHostEnv } from './env'
import { FrameDecoder, FrameType, ProtocolError, encodeFrame, parseJson, type Frame } from './hostProtocol'
import { PtyUnavailableError, type PtyFactory, type PtyLike, type PtySpawnSpec } from './pty'

/**
 * The daemon's side of the PTY host (see ptyHost.ts): a PtyFactory whose terminals each live in their OWN child process.
 *
 * Why: node-pty creates every PTY master without close-on-exec, so in one process each terminal's master leaks into the
 * programs of every LATER terminal (a program in terminal B could type into terminal A, and the hang-up safety net was
 * defeated by the extra copies). In its own process each master is the only one, and the host also ends the whole process
 * tree when the daemon dies, even when the daemon is killed with SIGKILL.
 *
 * `createHostPtyFactory` is transport-agnostic: it takes a `launch` function that returns a child-process-like object, so
 * the protocol is unit-tested in one process (a fake child wired to `runPtyHost`), and `createHostLauncher` is the real one
 * (`process.execPath` with the same TypeScript loader the daemon runs under).
 */

/** The slice of a ChildProcess the client uses. */
export interface HostChild {
  readonly pid?: number | undefined
  readonly stdin: Writable | null
  readonly stdout: Readable | null
  readonly stderr: Readable | null
  kill(signal?: NodeJS.Signals): boolean
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  on(event: 'error', listener: (err: Error) => void): unknown
}

export type HostLauncher = () => HostChild

export interface HostPtyFactoryOptions {
  launch: HostLauncher
  /**
   * The host vanished (crashed, was killed) while its program was still believed to run. The program's family is now
   * nobody's child: this is the daemon's chance to end it (the pid is the PTY child's).
   */
  onLost?: (ptyPid: number) => void
  /** How long a host gets to report that its program started (loading node-pty included). */
  startTimeoutMs?: number
  /** Passed to the host: the polite-to-hard grace when it has to end the tree itself. */
  graceMs?: number
  /** A host that reported its program's exit but has not left after this long is killed (default 5 s). */
  lingerMs?: number
  log?: Logger
}

export interface HostPtyFactory {
  create: PtyFactory
  /** Wait (up to `timeoutMs`) for every host to exit, then kill the stragglers. */
  shutdown(timeoutMs?: number): Promise<void>
  hostCount(): number
  /** The process ids of the hosts that are running (tests, diagnostics). */
  hostPids(): number[]
}

/** More than this waiting to be written to a host means it is not reading: treat it as gone. */
const MAX_QUEUED_TO_HOST = 8 * 1024 * 1024
/** Output that arrives before anyone listens (the first prompt of a fast program) is held, up to this much. */
const MAX_BACKLOG = 4 * 1024 * 1024

const isPid = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 1

interface Live {
  child: HostChild
  done: Promise<void>
}

export function createHostPtyFactory(o: HostPtyFactoryOptions): HostPtyFactory {
  const live = new Set<Live>()
  const startTimeoutMs = o.startTimeoutMs ?? 20_000
  const lingerMs = o.lingerMs ?? 5000

  const create: PtyFactory = (spec: PtySpawnSpec) =>
    new Promise<PtyLike>((resolve, reject) => {
      let child: HostChild
      try {
        child = o.launch()
      } catch (err) {
        o.log?.warn('terminal host could not be started', { error: err instanceof Error ? err.message : 'unknown' })
        return reject(new Error('the terminal host could not be started'))
      }
      let markDone: () => void = () => undefined
      const entry: Live = { child, done: new Promise<void>((r) => (markDone = r)) }
      live.add(entry)

      const decoder = new FrameDecoder()
      const dataListeners: Array<(d: Uint8Array) => void> = []
      const exitListeners: Array<(e: { exitCode: number | null; signal?: number }) => void> = []
      let phase: 'starting' | 'running' | 'ended' = 'starting'
      let ptyPid = 0
      let exitReported = false
      let earlyExit: { exitCode: number | null; signal?: number } | undefined
      let lingerTimer: ReturnType<typeof setTimeout> | undefined
      // The `spawned` frame and the first output can arrive in ONE read; the service attaches its listeners a moment after
      // the factory resolved. What arrives in between is held and handed to the first listener, never dropped.
      const backlog: Uint8Array[] = []
      let backlogBytes = 0
      let stderrTail = ''

      const killHost = (): void => {
        try {
          child.kill('SIGKILL')
        } catch {
          /* already gone */
        }
      }
      const fail = (err: Error): void => {
        if (phase !== 'starting') return
        phase = 'ended'
        clearTimeout(startTimer)
        killHost()
        reject(err)
      }
      const reportExit = (e: { exitCode: number | null; signal?: number }): void => {
        if (exitReported) return
        exitReported = true
        phase = 'ended'
        if (exitListeners.length === 0) earlyExit = e
        // The program is over, so the host is about to leave; one that does not is killed rather than left behind.
        lingerTimer = setTimeout(killHost, lingerMs)
        lingerTimer.unref?.()
        for (const l of exitListeners) {
          try {
            l(e)
          } catch {
            /* a listener must not stop the others */
          }
        }
      }
      /** The host is gone (or untrustworthy) while its program was believed to run. */
      const lost = (): void => {
        if (exitReported) return
        reportExit({ exitCode: null })
        try {
          if (ptyPid > 1) o.onLost?.(ptyPid) // only a program that really started has a family to end
        } catch {
          /* nothing more to do */
        }
      }
      const send = (frame: Buffer): void => {
        const w = child.stdin
        if (phase !== 'running' || !w || w.destroyed || !w.writable || w.writableLength > MAX_QUEUED_TO_HOST) throw new Error('the terminal host is gone')
        w.write(frame)
      }

      const pty: PtyLike = {
        get pid() {
          return ptyPid
        },
        onData: (l) => {
          dataListeners.push(l as (d: Uint8Array) => void)
          backlogBytes = 0
          for (const chunk of backlog.splice(0)) (l as (d: Uint8Array) => void)(chunk)
        },
        onExit: (l) => {
          exitListeners.push(l)
          if (earlyExit) {
            const e = earlyExit
            earlyExit = undefined
            l(e)
          }
        },
        write: (data) => send(encodeFrame(FrameType.write, data)),
        resize: (cols, rows) => send(encodeFrame(FrameType.resize, { cols, rows })),
        kill: () => {
          try {
            send(encodeFrame(FrameType.kill))
          } catch {
            /* the host is gone: there is nothing left to hang up */
          }
        },
      }

      const onFrame = (f: Frame): void => {
        if (phase === 'starting') {
          if (f.type === FrameType.spawned) {
            const pid = parseJson(f.payload).pid
            if (!isPid(pid)) throw new ProtocolError('bad pid')
            ptyPid = pid
            phase = 'running'
            clearTimeout(startTimer)
            return resolve(pty)
          }
          if (f.type === FrameType.spawnFailed) {
            const j = parseJson(f.payload)
            const message = typeof j.message === 'string' ? j.message.slice(0, 300) : 'spawn failed'
            return fail(j.unavailable === true ? new PtyUnavailableError(message) : new Error(message))
          }
          throw new ProtocolError('a frame before the program started')
        }
        if (phase !== 'running') return
        if (f.type === FrameType.data) {
          if (dataListeners.length === 0) {
            if (backlogBytes + f.payload.length <= MAX_BACKLOG) {
              backlog.push(f.payload)
              backlogBytes += f.payload.length
            }
            return
          }
          for (const l of dataListeners) l(f.payload)
          return
        }
        if (f.type === FrameType.exit) {
          const j = parseJson(f.payload)
          const exitCode = typeof j.exitCode === 'number' && Number.isInteger(j.exitCode) ? j.exitCode : null
          return reportExit({ exitCode, ...(typeof j.signal === 'number' && Number.isInteger(j.signal) ? { signal: j.signal } : {}) })
        }
        throw new ProtocolError('an unexpected frame')
      }

      const startTimer = setTimeout(() => fail(new Error('the terminal host did not start in time')), startTimeoutMs)
      startTimer.unref?.()

      child.stderr?.on('data', (b: Buffer) => {
        // Only ever read for a host that failed to start: its stderr holds module errors, never terminal bytes.
        stderrTail = (stderrTail + b.toString('utf8')).slice(-400)
      })
      child.stderr?.on('error', () => undefined)
      child.stdin?.on('error', () => undefined)
      child.stdout?.on('error', () => undefined)
      child.stdout?.on('data', (chunk: Buffer) => {
        try {
          for (const f of decoder.push(chunk)) onFrame(f)
        } catch (err) {
          o.log?.warn('terminal host protocol error', { error: err instanceof Error ? err.message : 'unknown' })
          if (phase === 'starting') return fail(new Error('the terminal host answered with something unexpected'))
          killHost()
          lost()
        }
      })
      child.on('error', (err) => {
        o.log?.warn('terminal host error', { error: err.message })
        if (phase === 'starting') return fail(new Error('the terminal host could not be started'))
        killHost()
        lost()
      })
      child.on('exit', (code, signal) => {
        clearTimeout(startTimer)
        if (lingerTimer !== undefined) clearTimeout(lingerTimer)
        live.delete(entry)
        markDone()
        if (phase === 'starting') {
          o.log?.warn('terminal host exited before its program started', { code: code ?? -1, signal: signal ?? '', stderr: stderrTail.replace(/\s+/g, ' ').trim() })
          return fail(new Error('the terminal host exited before the program started'))
        }
        lost() // a no-op when the program's exit was reported first
      })

      try {
        send0(child, encodeFrame(FrameType.spawn, { file: spec.file, args: spec.args, cwd: spec.cwd, env: spec.env, cols: spec.cols, rows: spec.rows, ...(o.graceMs !== undefined ? { graceMs: o.graceMs } : {}) }))
      } catch {
        fail(new Error('the terminal host could not be reached'))
      }
    })

  return {
    create,
    hostCount: () => live.size,
    hostPids: () => [...live].map((l) => l.child.pid).filter((p): p is number => typeof p === 'number'),
    async shutdown(timeoutMs = 3000) {
      const all = [...live]
      if (all.length === 0) return
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([Promise.all(all.map((l) => l.done)), new Promise<void>((r) => (timer = setTimeout(r, timeoutMs)))])
      clearTimeout(timer)
      for (const l of all) {
        if (!live.has(l)) continue
        try {
          l.child.kill('SIGKILL')
        } catch {
          /* gone */
        }
      }
    },
  }
}

/** The first write to a fresh host (the stream may not be a real pipe in tests, so it is checked like any other). */
function send0(child: HostChild, frame: Buffer): void {
  const w = child.stdin
  if (!w || w.destroyed || !w.writable) throw new Error('no stdin')
  w.write(frame)
}

// ---------------------------------------------------------------- the real launcher

export interface HostLauncherOptions {
  /** The daemon's environment; the host gets it minus every secret (buildHostEnv). Default process.env. */
  env?: Readonly<Record<string, string | undefined>>
  execPath?: string
  /** The host script. Default: ptyHost next to this module (same extension, so .ts under tsx and .js once compiled). */
  script?: string
  /** The tsx loader URL. Default: resolved from this package. */
  loaderUrl?: string
  cwd?: string
  spawn?: typeof nodeSpawn
}

/**
 * The argv (after the node binary) that starts the host script. TypeScript is run through the tsx loader, always by its
 * ABSOLUTE url: the daemon itself may have been started with a bare `--import tsx` that only resolves from its own working
 * directory, and the host runs from another one.
 */
export function hostArgs(script: string, resolveLoader: () => string): string[] {
  if (!/\.[cm]?ts$/.test(script)) return [script]
  return ['--import', resolveLoader(), script]
}

export function createHostLauncher(o: HostLauncherOptions = {}): HostLauncher {
  const here = fileURLToPath(import.meta.url)
  const script = o.script ?? nodePath.join(nodePath.dirname(here), `ptyHost${nodePath.extname(here)}`)
  const spawnFn = o.spawn ?? nodeSpawn
  const resolveLoader = (): string => o.loaderUrl ?? pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href
  return () => {
    const args = hostArgs(script, resolveLoader)
    return spawnFn(o.execPath ?? process.execPath, args, {
      cwd: o.cwd ?? tmpdir(),
      env: buildHostEnv(o.env ?? process.env),
      // Nothing but the three pipes: the program the host starts gets its own descriptors 0, 1 and 2 from the PTY.
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    }) as unknown as HostChild
  }
}

/** The factory the daemon uses: real host processes, and the daemon ends the orphans of a host that vanished. */
export function createRealHostPtyFactory(o: { onLost?: (ptyPid: number) => void; log?: Logger; graceMs?: number; startTimeoutMs?: number; launcher?: HostLauncherOptions } = {}): HostPtyFactory {
  return createHostPtyFactory({
    launch: createHostLauncher(o.launcher),
    ...(o.onLost ? { onLost: o.onLost } : {}),
    ...(o.log ? { log: o.log } : {}),
    ...(o.graceMs !== undefined ? { graceMs: o.graceMs } : {}),
    ...(o.startTimeoutMs !== undefined ? { startTimeoutMs: o.startTimeoutMs } : {}),
  })
}
