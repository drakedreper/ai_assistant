import { execFile as nodeExecFile, execFileSync as nodeExecFileSync, type ExecFileException } from 'node:child_process'
import { existsSync } from 'node:fs'
import * as nodePath from 'node:path'

/**
 * Ending a terminal means ending the process TREE it started: a shell with a dev server, claude with its tools.
 *
 *   Windows: `taskkill /PID <pid> /T /F`, started with execFile and an ARGUMENT ARRAY (never a shell string, so a
 *            pid can never become a command), from %SystemRoot%\System32. /T is the tree, /F is forced; Windows has
 *            no polite signal for a ConPTY child, so terminate and forceKill are the same call.
 *   Elsewhere: the child of forkpty is a session and process-group leader, so the group id is its pid:
 *            terminate = SIGTERM to the group (-pid), forceKill = SIGKILL to the group.
 *
 * Everything the OS is asked to do is injected so the exact calls are unit-tested (including with a fake win32).
 */

export interface TreeKiller {
  /** Polite first (POSIX SIGTERM to the group); on Windows this is already the forced tree kill. */
  terminate(pid: number): Promise<void>
  forceKill(pid: number): Promise<void>
  /**
   * The same hard kill, synchronously: the last resort from a process 'exit' handler (a crash, or the shutdown
   * watchdog calling process.exit), where nothing asynchronous can run any more.
   */
  forceKillSync(pid: number): void
}

export type ExecFileFn = (file: string, args: readonly string[], options: { windowsHide: boolean; timeout: number }, callback: (error: ExecFileException | null) => void) => unknown
export type ExecFileSyncFn = (file: string, args: readonly string[], options: { windowsHide: boolean; timeout: number; stdio: 'ignore' }) => unknown
export type SignalFn = (pid: number, signal: NodeJS.Signals) => void

export interface TreeKillerDeps {
  platform: NodeJS.Platform
  execFile?: ExecFileFn
  execFileSync?: ExecFileSyncFn
  signal?: SignalFn
  /** %SystemRoot% (Windows). */
  systemRoot?: string | undefined
  fileExists?: (path: string) => boolean
}

const validPid = (pid: number): boolean => Number.isSafeInteger(pid) && pid > 1

/** The path of taskkill: System32 under SystemRoot when it exists there, else the bare name (PATH). */
export function taskkillPath(systemRoot: string | undefined, fileExists: (p: string) => boolean): string {
  if (systemRoot) {
    const p = nodePath.win32.join(systemRoot, 'System32', 'taskkill.exe')
    if (fileExists(p)) return p
  }
  return 'taskkill.exe'
}

export function createTreeKiller(deps: TreeKillerDeps): TreeKiller {
  const exec: ExecFileFn = deps.execFile ?? ((file, args, options, cb) => nodeExecFile(file, [...args], options, (err) => cb(err)))
  const execSync: ExecFileSyncFn = deps.execFileSync ?? ((file, args, options) => nodeExecFileSync(file, [...args], options))
  const signal: SignalFn = deps.signal ?? ((pid, sig) => void process.kill(pid, sig))
  const exists = deps.fileExists ?? existsSync

  if (deps.platform === 'win32') {
    const kill = (pid: number): Promise<void> =>
      new Promise<void>((resolve) => {
        if (!validPid(pid)) return resolve()
        // An error here usually means the process was already gone (taskkill exits 128). Nothing to do about it.
        exec(taskkillPath(deps.systemRoot, exists), ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 8000 }, () => resolve())
      })
    const killSync = (pid: number): void => {
      if (!validPid(pid)) return
      try {
        execSync(taskkillPath(deps.systemRoot, exists), ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5000, stdio: 'ignore' })
      } catch {
        /* already gone */
      }
    }
    return { terminate: kill, forceKill: kill, forceKillSync: killSync }
  }

  const groupSync = (pid: number, sig: NodeJS.Signals): void => {
    if (!validPid(pid)) return
    try {
      signal(-pid, sig)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      // No such group (already gone) is fine; if the group cannot be signalled, still try the leader itself.
      if (code !== 'ESRCH') {
        try {
          signal(pid, sig)
        } catch {
          /* gone */
        }
      }
    }
  }
  const group = (pid: number, sig: NodeJS.Signals): Promise<void> => {
    groupSync(pid, sig)
    return Promise.resolve()
  }
  return { terminate: (pid) => group(pid, 'SIGTERM'), forceKill: (pid) => group(pid, 'SIGKILL'), forceKillSync: (pid) => groupSync(pid, 'SIGKILL') }
}
