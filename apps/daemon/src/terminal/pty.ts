import type { IPty } from 'node-pty'

/**
 * The seam between the terminal service and node-pty. The service only ever sees `PtyLike`, so unit tests use a fake
 * and a few integration tests use the real thing (ConPTY on Windows, forkpty elsewhere).
 *
 * In the daemon, node-pty is NEVER loaded in the daemon process: every terminal runs in its own PTY host process
 * (src/terminal/ptyHost.ts) that owns exactly one master descriptor, and the service talks to it through the
 * `PtyLike` that src/terminal/hostClient.ts returns. `createNodePtyFactory` is what that host process uses.
 */

export interface PtySpawnSpec {
  file: string
  /** argv, or a ready-made Windows command line (string) for batch wrappers. */
  args: string | string[]
  cwd: string
  env: Record<string, string>
  cols: number
  rows: number
}

export interface PtyLike {
  readonly pid: number
  /** Output. On Windows (ConPTY) it is always a string; elsewhere raw bytes. */
  onData(listener: (data: string | Uint8Array) => void): void
  onExit(listener: (e: { exitCode: number | null; signal?: number }) => void): void
  write(data: string): void
  resize(cols: number, rows: number): void
  /** Ask the pty to end (SIGHUP on POSIX; the process on Windows). Tree killing is the TreeKiller's job. */
  kill(): void
  /** Flow control: stop reading output (the child then blocks on a full buffer) and carry on. Optional. */
  pause?(): void
  resume?(): void
}

export type PtyFactory = (spec: PtySpawnSpec) => PtyLike | Promise<PtyLike>

/** node-pty could not be loaded (a missing or mismatched native addon): terminals are unavailable on this machine. */
export class PtyUnavailableError extends Error {
  override name = 'PtyUnavailableError'
}

class NodePtyAdapter implements PtyLike {
  constructor(private readonly p: IPty) {}
  get pid(): number {
    return this.p.pid
  }
  onData(listener: (data: string | Uint8Array) => void): void {
    this.p.onData(listener as (d: string) => void)
  }
  onExit(listener: (e: { exitCode: number | null; signal?: number }) => void): void {
    this.p.onExit((e) => listener(e))
  }
  write(data: string): void {
    this.p.write(data)
  }
  resize(cols: number, rows: number): void {
    this.p.resize(cols, rows)
  }
  kill(): void {
    this.p.kill()
  }
  pause(): void {
    this.p.pause()
  }
  resume(): void {
    this.p.resume()
  }
}

/**
 * node-pty is loaded on first use, so a machine where its native addon does not load still gets a working daemon
 * (terminals then fail with `pty_unavailable`). `encoding: null` gives raw bytes on POSIX; Windows does not support
 * the option (it warns when set), so it is only passed elsewhere.
 */
export function createNodePtyFactory(platform: NodeJS.Platform = process.platform): PtyFactory {
  let loaded: Promise<typeof import('node-pty')> | undefined
  return async (spec) => {
    loaded ??= import('node-pty').then((m) => ((m as unknown as { default?: typeof m }).default?.spawn ? (m as unknown as { default: typeof m }).default : m))
    let pty: typeof import('node-pty')
    try {
      pty = await loaded
    } catch (err) {
      loaded = undefined
      throw new PtyUnavailableError(err instanceof Error ? err.message : 'node-pty could not be loaded')
    }
    const p = pty.spawn(spec.file, spec.args, {
      name: 'xterm-256color',
      cols: spec.cols,
      rows: spec.rows,
      cwd: spec.cwd,
      env: spec.env,
      ...(platform === 'win32' ? {} : { encoding: null }),
    })
    return new NodePtyAdapter(p)
  }
}
