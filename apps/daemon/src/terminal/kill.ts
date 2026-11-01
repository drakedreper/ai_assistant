import { execFile as nodeExecFile, execFileSync as nodeExecFileSync, type ExecFileException } from 'node:child_process'
import { existsSync } from 'node:fs'
import * as nodePath from 'node:path'
import { ancestorsOf, createProcessTable, emptyProcessTable, familyOf, isGone, type ProcInfo, type ProcessTable } from './procTable'

/**
 * Ending a terminal means ending the process TREE it started: a shell with a dev server, claude with its tools.
 *
 *   Windows: `taskkill /PID <pid> /T /F`, started with execFile and an ARGUMENT ARRAY (never a shell string, so a
 *            pid can never become a command), from %SystemRoot%\System32. /T is the tree, /F is forced; Windows has
 *            no polite signal for a ConPTY child, so terminate and forceKill are the same call. taskkill walks the
 *            tree that exists at that moment: a grandchild whose parent already exited is not found (a Job Object
 *            would be the real answer, see the README).
 *   POSIX:   the child of forkpty is a session leader, so its pid is also the session id and its process group id.
 *            The FAMILY is the leader, every process in its session, and every descendant by parent pid (src/terminal/
 *            procTable.ts). terminate = SIGTERM to the leader's group (-pid) and to every other family member (and
 *            SIGCONT to a stopped one, which would otherwise sit on the signal); forceKill = SIGKILL to the same set,
 *            repeated until a pass finds nobody new; reap = wait for the family to go, then SIGKILL what is left.
 *            Not found: a process that already daemonised itself (setsid, double fork) before the terminal ended, since
 *            nothing ties it to the terminal any more.
 *
 * Everything the OS is asked to do is injected so the exact calls are unit-tested (including with a fake win32 and a
 * fake process table).
 */

export interface TreeKiller {
  /** Polite first (POSIX SIGTERM to the whole family); on Windows this is already the forced tree kill. */
  terminate(pid: number): Promise<void>
  forceKill(pid: number): Promise<void>
  /**
   * The same hard kill, synchronously: the last resort from a process 'exit' handler (a crash, or the shutdown
   * watchdog calling process.exit), where nothing asynchronous can run any more.
   */
  forceKillSync(pid: number): void
  /**
   * After the polite phase and the leader's exit: wait up to `graceMs` for the rest of the family to go, then kill
   * whatever is still running. Resolves with the pids that could not be ended (a process of another user, say): an
   * empty list means the family is gone. Windows: nothing more can be enumerated, so it resolves empty at once.
   */
  reap(pid: number, graceMs: number): Promise<number[]>
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
  /**
   * The POSIX process table. Default: /proc (else `ps`); when a caller injects its own `signal` without a table it is
   * EMPTY, so a test that only checks the signals sent never enumerates (or aims at) real processes.
   */
  table?: ProcessTable
  /** Pids that must never be signalled besides this process and its ancestors. */
  protect?: () => Iterable<number>
  /** This process (default process.pid). */
  ownPid?: number
  sleep?: (ms: number) => Promise<void>
  sleepSync?: (ms: number) => void
  now?: () => number
  /** How often reap looks again while it waits (default 50 ms). */
  pollMs?: number
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

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
/** A real, blocking pause for the exit handler (the event loop is gone there). */
const realSleepSync = (ms: number): void => {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    /* no SharedArrayBuffer: go without the pause */
  }
}

/** How long a remembered family stays interesting (a kill that never reaped would otherwise leave it behind). */
const REMEMBER_MS = 5 * 60_000
/** Passes of "find the family, SIGKILL it" before giving up on a family that keeps growing. */
const HARD_ROUNDS = 6
const HARD_PAUSE_MS = 40

interface Remembered {
  rootStart: number | undefined
  members: Map<number, number | undefined>
  at: number
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
    return { terminate: kill, forceKill: kill, forceKillSync: killSync, reap: () => Promise.resolve([]) }
  }

  const table: ProcessTable = deps.table ?? (deps.signal ? emptyProcessTable : createProcessTable(deps.platform))
  const sleep = deps.sleep ?? realSleep
  const sleepSync = deps.sleepSync ?? realSleepSync
  const now = deps.now ?? Date.now
  const pollMs = deps.pollMs ?? 50
  const ownPid = deps.ownPid ?? process.pid
  const remembered = new Map<number, Remembered>()

  const errCode = (err: unknown): string | undefined => (err as NodeJS.ErrnoException | undefined)?.code

  /**
   * SIGxxx to the leader's group; if the group cannot be signalled, to the leader itself. Says which one got it:
   * 'group' (everything in the leader's group), 'leader' (only the leader) or 'none' (already gone).
   */
  const signalGroup = (pid: number, sig: NodeJS.Signals): 'group' | 'leader' | 'none' => {
    try {
      signal(-pid, sig)
      return 'group'
    } catch (err) {
      // No such group (already gone) is fine; if the group cannot be signalled, still try the leader itself.
      if (errCode(err) === 'ESRCH') return 'none'
      try {
        signal(pid, sig)
        return 'leader'
      } catch {
        return 'none'
      }
    }
  }

  /** The family now, remembering everyone seen so a member that is orphaned or re-sessioned later is still ours. */
  const look = (root: number): { family: ProcInfo[]; table: ProcInfo[] } => {
    const snap = table.snapshot()
    const t = now()
    for (const [k, v] of remembered) if (t - v.at > REMEMBER_MS) remembered.delete(k)
    let mem = remembered.get(root)
    const family = familyOf(snap, root, {
      rootStart: mem?.rootStart,
      remembered: mem?.members,
      protect: new Set([...ancestorsOf(snap, ownPid), ...(deps.protect?.() ?? [])]),
    })
    if (family.length > 0 || mem) {
      if (!mem) {
        mem = { rootStart: snap.find((p) => p.pid === root)?.start, members: new Map(), at: t }
        remembered.set(root, mem)
      }
      for (const p of family) mem.members.set(p.pid, p.start)
    }
    return { family, table: snap }
  }

  /** Signal one member, but only if the pid still names the process the table showed (it may have been recycled). */
  const sendTo = (p: ProcInfo, sig: NodeJS.Signals): 'sent' | 'gone' | 'denied' => {
    const cur = table.peek(p.pid)
    if (!cur || isGone(cur)) return 'gone'
    if (p.start !== undefined && cur.start !== p.start) return 'gone'
    try {
      signal(p.pid, sig)
      return 'sent'
    } catch (err) {
      return errCode(err) === 'ESRCH' ? 'gone' : 'denied'
    }
  }

  const terminate = (pid: number): void => {
    if (!validPid(pid)) return
    const reached = signalGroup(pid, 'SIGTERM')
    const { family } = look(pid)
    for (const p of family) {
      // The group signal reached everything in the leader's group; a leader-only fallback reached just the leader.
      const covered = (reached === 'group' && p.pgid === pid) || (reached === 'leader' && p.pid === pid)
      if (!covered) sendTo(p, 'SIGTERM')
      // A stopped job (Ctrl-Z) holds on to SIGTERM until it is continued.
      if (p.state === 'T' || p.state === 't') sendTo(p, 'SIGCONT')
    }
  }

  /** One hard pass. Returns how many family members were signalled (0 for an empty or unknown family). */
  const hardPass = (pid: number, withGroup: boolean): { signalled: number; denied: number } => {
    if (withGroup) signalGroup(pid, 'SIGKILL')
    const { family } = look(pid)
    let signalled = 0
    let denied = 0
    for (const p of family) {
      const r = sendTo(p, 'SIGKILL')
      if (r === 'sent') signalled++
      else if (r === 'denied') denied++
    }
    return { signalled, denied }
  }

  const hardKill = async (pid: number): Promise<void> => {
    if (!validPid(pid)) return
    let r = hardPass(pid, true)
    // Whoever forked while the first pass ran is found by the next one.
    for (let round = 1; r.signalled > 0 && round < HARD_ROUNDS; round++) {
      await sleep(HARD_PAUSE_MS)
      r = hardPass(pid, false)
    }
  }

  const hardKillSync = (pid: number): void => {
    if (!validPid(pid)) return
    let r = hardPass(pid, true)
    for (let round = 1; r.signalled > 0 && round < HARD_ROUNDS; round++) {
      sleepSync(HARD_PAUSE_MS)
      r = hardPass(pid, false)
    }
  }

  /** Is anything remembered from earlier still running? (A cheap look at known pids, no scan of the whole table.) */
  const rememberedStillRunning = (pid: number): boolean => {
    const mem = remembered.get(pid)
    if (!mem) return false
    for (const [mp, start] of mem.members) {
      const cur = table.peek(mp)
      if (cur && !isGone(cur) && (start === undefined || cur.start === start)) return true
    }
    return false
  }

  return {
    terminate: (pid) => {
      terminate(pid)
      return Promise.resolve()
    },
    forceKill: async (pid) => {
      await hardKill(pid)
      if (look(pid).family.length === 0) remembered.delete(pid)
    },
    forceKillSync: (pid) => {
      hardKillSync(pid)
    },
    async reap(pid, graceMs) {
      if (!validPid(pid)) return []
      const deadline = now() + Math.max(0, graceMs)
      for (;;) {
        // Known members are checked every poll; one full look confirms nothing else (a newly forked child, an orphan
        // in the session) is left once the known ones are gone.
        if (!rememberedStillRunning(pid) && look(pid).family.length === 0) {
          remembered.delete(pid)
          return []
        }
        if (now() >= deadline) break
        await sleep(pollMs)
      }
      // They had their chance (SIGTERM at the start of the close, SIGHUP from the hang-up): now it is SIGKILL.
      for (let round = 0; round < HARD_ROUNDS; round++) {
        const r = hardPass(pid, round === 0)
        if (r.signalled === 0) break
        await sleep(HARD_PAUSE_MS)
      }
      const left = look(pid).family.map((p) => p.pid)
      remembered.delete(pid)
      return left
    },
  }
}
