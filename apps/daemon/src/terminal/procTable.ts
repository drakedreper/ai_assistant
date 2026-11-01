import { execFileSync as nodeExecFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'

/**
 * A snapshot of the machine's process table, enough to find the whole family of a terminal: the shell the PTY
 * started, everything in its session, and every descendant by parent pid.
 *
 * Why this exists: a terminal's processes are NOT one process group. A job started with `( cmd & )`, a nested shell with
 * job control, `nohup`, `disown` or a program that moves its children into their own groups all leave the leader's
 * group, so signalling `-pid` alone ends only part of the tree. They all stay in the leader's SESSION (the forkpty child
 * is a session leader), and a child that called `setsid` itself is still a child by parent pid until its parent exits.
 *
 * Linux reads /proc (pid, ppid, pgid, session and start time from /proc/PID/stat). Other POSIX systems fall back to
 * `ps` (pid, ppid, pgid and state: no session, no start time). Windows does not use this at all (taskkill /T).
 */

export interface ProcInfo {
  pid: number
  ppid: number
  pgid: number
  /** Session id; undefined where the table does not offer it (the `ps` fallback). */
  sid: number | undefined
  /** An opaque start stamp (clock ticks since boot on Linux): the same pid with another stamp is another process. */
  start: number | undefined
  /** The one-letter state. `Z` (zombie) and `X` (dead) mean the process is gone for every purpose here. */
  state: string
}

export interface ProcessTable {
  snapshot(): ProcInfo[]
  /** One process, read fresh (used right before a signal, to be sure the pid still names the same process). */
  peek(pid: number): ProcInfo | undefined
}

export const isGone = (p: ProcInfo): boolean => p.state === 'Z' || p.state === 'X' || p.state === 'x'

/** A table that sees nothing: for tests, and the default when a caller injects its own signal function. */
export const emptyProcessTable: ProcessTable = { snapshot: () => [], peek: () => undefined }

/**
 * Parse /proc/PID/stat. The command name (field 2) sits in parentheses and may itself contain spaces and parentheses,
 * so everything after the LAST ")" is split instead. Fields after it: state, ppid, pgrp, session, tty_nr, tpgid, ...,
 * starttime (the 20th one).
 */
export function parseProcStat(pid: number, text: string): ProcInfo | undefined {
  const close = text.lastIndexOf(')')
  if (close < 0) return undefined
  const f = text
    .slice(close + 1)
    .trim()
    .split(/\s+/)
  const state = f[0]
  const ppid = Number(f[1])
  const pgid = Number(f[2])
  const sid = Number(f[3])
  const start = Number(f[19])
  if (!state || !Number.isInteger(ppid) || !Number.isInteger(pgid) || !Number.isInteger(sid)) return undefined
  return { pid, ppid, pgid, sid, start: Number.isFinite(start) ? start : undefined, state: state.charAt(0) }
}

/** `ps -A -o pid=,ppid=,pgid=,stat=` output (macOS, the BSDs). */
export function parsePsOutput(text: string): ProcInfo[] {
  const out: ProcInfo[] = []
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)/.exec(line)
    if (!m) continue
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), sid: undefined, start: undefined, state: (m[4] as string).charAt(0) })
  }
  return out
}

export interface ProcfsDeps {
  root?: string
  readdir?: (path: string) => string[]
  readFile?: (path: string) => string
}

/** The Linux table. A process that vanishes while it is being read is simply skipped. */
export function createProcfsTable(deps: ProcfsDeps = {}): ProcessTable {
  const root = deps.root ?? '/proc'
  const readdir = deps.readdir ?? ((p) => readdirSync(p))
  const readFile = deps.readFile ?? ((p) => readFileSync(p, 'latin1'))
  const one = (pid: number): ProcInfo | undefined => {
    try {
      return parseProcStat(pid, readFile(`${root}/${pid}/stat`))
    } catch {
      return undefined
    }
  }
  return {
    snapshot() {
      let names: string[]
      try {
        names = readdir(root)
      } catch {
        return []
      }
      const out: ProcInfo[] = []
      for (const n of names) {
        if (!/^\d+$/.test(n)) continue
        const p = one(Number(n))
        if (p) out.push(p)
      }
      return out
    },
    peek: one,
  }
}

export function createPsTable(run: (file: string, args: string[]) => string = (file, args) => nodeExecFileSync(file, args, { encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024 * 1024 })): ProcessTable {
  let last: ProcInfo[] = []
  const snapshot = (): ProcInfo[] => {
    try {
      last = parsePsOutput(run('ps', ['-A', '-o', 'pid=,ppid=,pgid=,stat=']))
    } catch {
      last = []
    }
    return last
  }
  return { snapshot, peek: (pid) => last.find((p) => p.pid === pid) }
}

/** The best table for this machine. Windows has none (taskkill /T does the walking there). */
export function createProcessTable(platform: NodeJS.Platform = process.platform, procExists: (p: string) => boolean = existsSync): ProcessTable {
  if (platform === 'win32') return emptyProcessTable
  return platform === 'linux' && procExists('/proc/self/stat') ? createProcfsTable() : createPsTable()
}

export interface FamilyOptions {
  /** The start stamp the root had when it was first seen: a recycled pid with another stamp is not the root. */
  rootStart?: number | undefined
  /** Members seen earlier (pid -> start stamp): still part of the family while they live, even once orphaned. */
  remembered?: ReadonlyMap<number, number | undefined>
  /** Never part of a family, whatever the table says (this process, its ancestors). */
  protect?: ReadonlySet<number>
}

/**
 * The family of a terminal whose PTY child is `root`: the root, every process in its session, every process whose
 * parent chain leads to a member, and everything remembered from an earlier look that is still running. Zombies and
 * protected pids are left out. Pure.
 *
 * A pid that is in use as a session id cannot be handed out again by the kernel, so "session == root" stays true even
 * after the leader itself has exited; the start stamp guards the other direction (a pid recycled for a NEW process: that
 * process and its session are not the terminal's).
 */
export function familyOf(table: readonly ProcInfo[], root: number, o: FamilyOptions = {}): ProcInfo[] {
  const byPid = new Map<number, ProcInfo>()
  for (const p of table) byPid.set(p.pid, p)
  const protect = o.protect ?? new Set<number>()
  const members = new Map<number, ProcInfo>()
  const add = (p: ProcInfo): boolean => {
    if (members.has(p.pid) || protect.has(p.pid) || p.pid <= 1 || isGone(p)) return false
    members.set(p.pid, p)
    return true
  }

  // Never a family that contains us: the root is not us or one of our ancestors, and no protected process lives in
  // the root's session (a wrongly named root would otherwise take the daemon's own session down with it).
  if (protect.has(root)) return []
  for (const q of protect) {
    const sid = byPid.get(q)?.sid
    if (sid !== undefined && sid === root) return []
  }

  const r = byPid.get(root)
  // The pid now names another process than the root we knew (it was recycled): its session is not ours either.
  const recycled = r !== undefined && o.rootStart !== undefined && r.start !== o.rootStart
  if (r && !recycled) add(r)
  if (!recycled) {
    for (const p of table) {
      // Without a session column (the `ps` fallback) the leader's own process group stands in for it.
      if (p.sid === root || (p.sid === undefined && p.pgid === root)) add(p)
    }
  }
  if (o.remembered) {
    for (const [pid, start] of o.remembered) {
      const p = byPid.get(pid)
      if (p && (start === undefined || p.start === start)) add(p)
    }
  }
  // Descendants by parent pid, to a fixed point (children of children, and of the processes found just above).
  const children = new Map<number, ProcInfo[]>()
  for (const p of table) {
    const list = children.get(p.ppid)
    if (list) list.push(p)
    else children.set(p.ppid, [p])
  }
  const queue = [...members.keys()]
  while (queue.length > 0) {
    const pid = queue.pop() as number
    for (const c of children.get(pid) ?? []) if (add(c)) queue.push(c.pid)
  }
  return [...members.values()]
}

/** This process and its ancestors: a family must never contain them, whatever the table says. */
export function ancestorsOf(table: readonly ProcInfo[], pid: number): Set<number> {
  const byPid = new Map<number, ProcInfo>()
  for (const p of table) byPid.set(p.pid, p)
  const out = new Set<number>([pid])
  let cur = byPid.get(pid)
  for (let i = 0; cur && cur.ppid > 0 && i < 64; i++) {
    out.add(cur.ppid)
    cur = byPid.get(cur.ppid)
  }
  return out
}
