import { describe, expect, it } from 'vitest'
import { createTreeKiller } from '../src/terminal/kill'
import { ancestorsOf, createProcfsTable, createProcessTable, createPsTable, emptyProcessTable, familyOf, parseProcStat, parsePsOutput, type ProcInfo, type ProcessTable } from '../src/terminal/procTable'

/**
 * The family of a terminal and how it is ended. Everything here runs on fake process tables and recorded signals (the real
 * thing, with real shells and the 14 process shapes of the adversarial review, is in terminal.pty.test.ts).
 */

const P = (pid: number, ppid: number, pgid: number, sid: number | undefined, state = 'S', start: number | undefined = pid * 10): ProcInfo => ({ pid, ppid, pgid, sid, start, state })

class FakeTable implements ProcessTable {
  constructor(public procs: ProcInfo[]) {}
  snapshot(): ProcInfo[] {
    return this.procs.map((p) => ({ ...p }))
  }
  peek(pid: number): ProcInfo | undefined {
    const p = this.procs.find((x) => x.pid === pid)
    return p ? { ...p } : undefined
  }
  remove(...pids: number[]): void {
    this.procs = this.procs.filter((p) => !pids.includes(p.pid))
  }
}

/** The machine the family tests share: daemon 100 -> host 200 -> shell 500 (a session leader) and its family. */
function machine(): ProcInfo[] {
  return [
    P(1, 0, 1, 1),
    P(50, 1, 50, 50), // the user's own shell, the daemon's session leader
    P(100, 50, 100, 50), // the daemon
    P(200, 100, 100, 50), // the PTY host (the shell's PARENT, not part of its family)
    P(500, 200, 500, 500), // the PTY child: session leader
    P(510, 500, 510, 500), // a foreground job (its own group)
    P(520, 1, 515, 500), // `( cmd & )`: orphaned, other group, same session
    P(530, 500, 530, 530), // a child that called setsid itself, its parent still alive
    P(531, 530, 530, 530), // and its own child
    P(540, 1, 540, 540), // a process that daemonised before the terminal ended: out of reach
    P(900, 50, 900, 50), // someone else entirely
  ]
}

describe('parseProcStat', () => {
  it('reads pid, ppid, group, session, state and the start stamp', () => {
    const line = '4242 (bash) S 4100 4242 4242 34816 4242 4194560 1000 0 0 0 5 1 0 0 20 0 1 0 987654 12345678 900 18446744073709551615 1 1 0 0 0 0 65536 3670020 1266777851 0 0 0 17 2 0 0 0 0 0'
    expect(parseProcStat(4242, line)).toEqual({ pid: 4242, ppid: 4100, pgid: 4242, sid: 4242, start: 987654, state: 'S' })
  })

  it('survives a command name with spaces and parentheses', () => {
    const line = '77 (a (weird) name) R 1 77 77 0 -1 4194304 1 0 0 0 0 0 0 0 20 0 1 0 555 1 1 18446744073709551615'
    expect(parseProcStat(77, line)).toMatchObject({ pid: 77, ppid: 1, pgid: 77, sid: 77, state: 'R', start: 555 })
  })

  it('reads a zombie and refuses garbage', () => {
    expect(parseProcStat(9, '9 (sleep) Z 1 9 9 0 -1 4 0 0 0 0 0 0 0 0 20 0 1 0 5 0 0 0')).toMatchObject({ state: 'Z' })
    for (const bad of ['', 'no parens at all', '12 (x)', '12 (x) S a b c']) expect(parseProcStat(12, bad)).toBeUndefined()
  })
})

describe('parsePsOutput and the table factories', () => {
  it('reads `ps -A -o pid=,ppid=,pgid=,stat=` lines (no session, no start stamp)', () => {
    const out = ['    1     0     1 Ss', '  300     1   300 S+', '  301   300   300 Z', 'garbage', ''].join('\n')
    expect(parsePsOutput(out)).toEqual([
      { pid: 1, ppid: 0, pgid: 1, sid: undefined, start: undefined, state: 'S' },
      { pid: 300, ppid: 1, pgid: 300, sid: undefined, start: undefined, state: 'S' },
      { pid: 301, ppid: 300, pgid: 300, sid: undefined, start: undefined, state: 'Z' },
    ])
  })

  it('the procfs table skips what vanishes while it is read, and non-numeric entries', () => {
    const files: Record<string, string> = {
      '/p/1/stat': '1 (init) S 0 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 10 0 0 0',
      '/p/20/stat': '20 (sh) S 1 20 20 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 20 0 0 0',
    }
    const t = createProcfsTable({
      root: '/p',
      readdir: () => ['1', '20', '30', 'self', 'cpuinfo'],
      readFile: (path) => {
        const v = files[path]
        if (v === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        return v
      },
    })
    expect(t.snapshot().map((p) => p.pid)).toEqual([1, 20])
    expect(t.peek(20)).toMatchObject({ pid: 20, sid: 20 })
    expect(t.peek(30)).toBeUndefined()
  })

  it('a ps failure is an empty table, Windows has none, and the real Linux table sees this very process', () => {
    expect(createPsTable(() => { throw new Error('ps missing') }).snapshot()).toEqual([])
    expect(createProcessTable('win32')).toBe(emptyProcessTable)
    if (process.platform === 'linux') {
      const me = createProcessTable('linux').peek(process.pid)
      expect(me).toMatchObject({ pid: process.pid, ppid: process.ppid })
      expect(me?.start).toBeGreaterThan(0)
    }
  })
})

describe('familyOf', () => {
  it('is the leader, its session and every descendant, and nobody else', () => {
    const fam = familyOf(machine(), 500, { protect: ancestorsOf(machine(), 100) })
    expect(fam.map((p) => p.pid).sort((a, b) => a - b)).toEqual([500, 510, 520, 530, 531])
  })

  it('finds a setsid child through its parent while the parent lives, but not one that daemonised earlier', () => {
    const fam = familyOf(machine(), 500).map((p) => p.pid)
    expect(fam).toContain(530)
    expect(fam).toContain(531)
    expect(fam).not.toContain(540) // already re-parented to init in its own session: nothing ties it to the terminal any more
  })

  it('still finds the session after the leader itself has exited', () => {
    const procs = machine().filter((p) => p.pid !== 500)
    const fam = familyOf(procs, 500).map((p) => p.pid)
    expect(fam).toEqual(expect.arrayContaining([510, 520]))
    expect(fam).not.toContain(200)
  })

  it('leaves out zombies, pid 0 and 1, and protected processes', () => {
    const procs = [...machine(), P(560, 500, 560, 500, 'Z')]
    const fam = familyOf(procs, 500, { protect: new Set([510]) }).map((p) => p.pid)
    expect(fam).not.toContain(560)
    expect(fam).not.toContain(510)
    expect(fam).not.toContain(1)
  })

  it('does not take a recycled pid for the root: that process and its session are another\'s (start stamp)', () => {
    const procs = machine().map((p) => (p.pid === 500 ? { ...p, start: 12345 } : p))
    // pid 500 was recycled by a NEW session leader: neither it nor the processes of its session belong to the terminal
    expect(familyOf(procs, 500, { rootStart: 5000 })).toEqual([])
    // without a recorded stamp (first contact) the table is trusted
    expect(familyOf(procs, 500).map((p) => p.pid)).toContain(500)
    // and when the old leader is simply gone, its session is still found by the number (the kernel cannot hand that pid out again)
    const gone = machine().filter((p) => p.pid !== 500)
    expect(familyOf(gone, 500, { rootStart: 5000 }).map((p) => p.pid)).toEqual(expect.arrayContaining([510, 520]))
  })

  it('keeps remembered members while they live, even orphaned into another session, and drops a recycled one', () => {
    const before = familyOf(machine(), 500)
    const remembered = new Map(before.map((p) => [p.pid, p.start]))
    // 530 got orphaned and its parent (the leader) is gone: nothing but the memory finds it now
    const later = machine().filter((p) => p.pid !== 500).map((p) => (p.pid === 530 ? { ...p, ppid: 1 } : p))
    expect(familyOf(later, 500, { remembered }).map((p) => p.pid)).toContain(530)
    // a recycled pid (another start stamp) is not the remembered process
    const recycled = later.map((p) => (p.pid === 530 ? { ...p, start: 777 } : p))
    expect(familyOf(recycled, 500, { remembered }).map((p) => p.pid)).not.toContain(530)
  })

  it('without a session column (the ps fallback) the leader\'s own group stands in for it', () => {
    const procs = [P(300, 10, 300, undefined), P(301, 300, 300, undefined), P(302, 1, 300, undefined), P(400, 10, 400, undefined)]
    expect(familyOf(procs, 300).map((p) => p.pid).sort()).toEqual([300, 301, 302])
  })

  it('refuses to build a family that contains the daemon: its own session or ancestors named as the root', () => {
    const procs = machine()
    expect(familyOf(procs, 100, { protect: ancestorsOf(procs, 100) })).toEqual([]) // the root is us
    expect(familyOf(procs, 50, { protect: ancestorsOf(procs, 100) })).toEqual([]) // the root is our session leader
  })

  it('ancestorsOf walks the parent chain and stops at a loop or the top', () => {
    expect([...ancestorsOf(machine(), 531)].sort((a, b) => a - b)).toEqual([1, 50, 100, 200, 500, 530, 531].filter((p) => [531, 530, 500, 200, 100, 50, 1].includes(p)))
    const loop = [P(5, 6, 5, 5), P(6, 5, 6, 6)]
    expect(ancestorsOf(loop, 5).size).toBeLessThanOrEqual(3)
  })
})

describe('the POSIX tree killer', () => {
  function rig(procs: ProcInfo[], opts: { deny?: number[]; killsOnSigkill?: boolean; ownPid?: number } = {}) {
    const table = new FakeTable(procs)
    const sent: Array<[number, string]> = []
    let clock = 0
    const sleeps: number[] = []
    const ticks: Array<(t: number) => void> = []
    const killer = createTreeKiller({
      platform: 'linux',
      table,
      ownPid: opts.ownPid ?? 100,
      signal: (pid, sig) => {
        sent.push([pid, sig])
        if (pid > 0 && opts.deny?.includes(pid)) throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
        if (opts.killsOnSigkill !== false && sig === 'SIGKILL') {
          if (pid < 0) table.procs = table.procs.filter((p) => p.pgid !== -pid)
          else table.remove(pid)
        }
      },
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms)
        clock += ms
        for (const t of ticks) t(clock)
      },
      sleepSync: (ms) => void (clock += ms),
      pollMs: 50,
    })
    return { killer, table, sent, sleeps, clock: () => clock, onTick: (fn: (t: number) => void) => void ticks.push(fn) }
  }

  it('terminate: the leader\'s group first, then every other family member, and nobody outside the family', async () => {
    const r = rig(machine())
    await r.killer.terminate(500)
    expect(r.sent[0]).toEqual([-500, 'SIGTERM'])
    const byPid = r.sent.slice(1).filter(([, s]) => s === 'SIGTERM').map(([p]) => p).sort((a, b) => a - b)
    expect(byPid).toEqual([510, 520, 530, 531])
    const touched = new Set(r.sent.map(([p]) => Math.abs(p)))
    for (const outsider of [1, 50, 100, 200, 540, 900]) expect(touched.has(outsider)).toBe(false)
  })

  it('terminate sends SIGCONT to a stopped job, which would otherwise hold on to SIGTERM', async () => {
    const r = rig([...machine(), P(570, 500, 570, 500, 'T')])
    await r.killer.terminate(500)
    expect(r.sent).toContainEqual([570, 'SIGTERM'])
    expect(r.sent).toContainEqual([570, 'SIGCONT'])
    expect(r.sent.filter(([p, s]) => s === 'SIGCONT').map(([p]) => p)).toEqual([570])
  })

  it('terminate falls back to signalling members one by one when the group cannot be signalled', async () => {
    const table = new FakeTable(machine())
    const sent: Array<[number, string]> = []
    const killer = createTreeKiller({
      platform: 'linux',
      table,
      ownPid: 100,
      signal: (pid, sig) => {
        sent.push([pid, sig])
        if (pid < 0) throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
      },
    })
    await killer.terminate(500)
    // group refused (EPERM): the leader itself is tried, and so is every other member including those of its own group
    expect(sent.filter(([p, s]) => s === 'SIGTERM' && p > 0).map(([p]) => p).sort((a, b) => a - b)).toEqual([500, 510, 520, 530, 531])
  })

  it('never signals a pid whose process changed since the table was read (a recycled pid)', async () => {
    const table = new FakeTable(machine())
    const sent: Array<[number, string]> = []
    const killer = createTreeKiller({
      platform: 'linux',
      table: {
        snapshot: () => table.snapshot(),
        // by the time we signal, pid 520 belongs to a different process
        peek: (pid) => (pid === 520 ? { ...(table.peek(520) as ProcInfo), start: 99999 } : table.peek(pid)),
      },
      ownPid: 100,
      signal: (pid, sig) => void sent.push([pid, sig]),
    })
    await killer.terminate(500)
    expect(sent.map(([p]) => p)).not.toContain(520)
    expect(sent.map(([p]) => p)).toContain(510)
  })

  it('never includes the daemon, its host or its ancestors, even when the root is wrong', async () => {
    const r = rig(machine())
    await r.killer.terminate(50) // the daemon's session leader named as a root
    await r.killer.forceKill(50)
    expect(r.sent.filter(([p]) => Math.abs(p) !== 50)).toEqual([])
    for (const [p] of r.sent) expect(Math.abs(p)).toBe(50) // only the (refused) group signals of the legacy path, never a member
  })

  it('refuses pid 0, 1, negative and fractional pids', async () => {
    const r = rig(machine())
    for (const bad of [0, 1, -5, 1.5, Number.NaN, 2 ** 60]) {
      await r.killer.terminate(bad)
      await r.killer.forceKill(bad)
      r.killer.forceKillSync(bad)
      expect(await r.killer.reap(bad, 100)).toEqual([])
    }
    expect(r.sent).toEqual([])
  })

  it('forceKill: group SIGKILL, every member, then another pass for whoever forked meanwhile', async () => {
    const r = rig(machine(), { killsOnSigkill: true })
    let passes = 0
    const origSnapshot = r.table.snapshot.bind(r.table)
    r.table.snapshot = () => {
      passes++
      // a new child appears after the first look
      if (passes === 2) r.table.procs.push(P(600, 500, 600, 500))
      return origSnapshot()
    }
    await r.killer.forceKill(500)
    expect(r.sent[0]).toEqual([-500, 'SIGKILL'])
    expect(r.sent.some(([p, s]) => p === 600 && s === 'SIGKILL')).toBe(true)
    expect(r.table.procs.some((p) => p.sid === 500)).toBe(false)
  })

  it('forceKillSync does the same without awaiting anything', () => {
    const r = rig(machine())
    r.killer.forceKillSync(500)
    expect(r.sent[0]).toEqual([-500, 'SIGKILL'])
    expect(r.table.procs.some((p) => p.sid === 500)).toBe(false)
  })

  it('reap returns at once when nothing of the family is left', async () => {
    const r = rig(machine().filter((p) => p.sid !== 500 && p.pid !== 531))
    expect(await r.killer.reap(500, 2000)).toEqual([])
    expect(r.sent).toEqual([])
    expect(r.sleeps).toEqual([])
  })

  it('reap waits for stragglers that leave by themselves and does not kill them', async () => {
    const r = rig(machine())
    await r.killer.terminate(500)
    r.sent.length = 0
    // the family leaves while reap waits (the polite signal worked): 100 ms into the grace
    r.onTick((t) => {
      if (t >= 100) r.table.procs = r.table.procs.filter((p) => ![500, 510, 520, 530, 531].includes(p.pid))
    })
    expect(await r.killer.reap(500, 2000)).toEqual([])
    expect(r.sent.filter(([, s]) => s === 'SIGKILL')).toEqual([])
    expect(r.clock()).toBeLessThan(500) // it did not sit out the whole grace
  })

  it('reap kills what outlives the grace (a job that ignores SIGHUP and SIGTERM) and reports what cannot be killed', async () => {
    const r = rig(machine(), { deny: [520] })
    await r.killer.terminate(500)
    r.sent.length = 0
    const left = await r.killer.reap(500, 300)
    expect(r.clock()).toBeGreaterThanOrEqual(300) // it waited for the grace first
    expect(r.sent.some(([p, s]) => p === 510 && s === 'SIGKILL')).toBe(true)
    expect(left).toEqual([520]) // EPERM: a process of another user, say
  })

  it('reap counts zombies as gone (a parent that never reaps must not keep a close waiting)', async () => {
    const r = rig([P(1, 0, 1, 1), P(500, 1, 500, 500, 'Z'), P(510, 1, 515, 500, 'Z')])
    expect(await r.killer.reap(500, 5000)).toEqual([])
    expect(r.sleeps).toEqual([])
  })

  it('remembers members found by terminate, so a member orphaned later is still reaped', async () => {
    const r = rig(machine())
    await r.killer.terminate(500)
    // the leader dies and 530 is orphaned into init: only the memory still ties it to the terminal
    r.table.procs = r.table.procs.filter((p) => p.pid !== 500).map((p) => (p.pid === 530 ? { ...p, ppid: 1 } : p))
    r.sent.length = 0
    await r.killer.reap(500, 100)
    expect(r.sent.some(([p, s]) => p === 530 && s === 'SIGKILL')).toBe(true)
  })

  it('an injected signal function without a table never enumerates real processes (legacy unit-test contract)', async () => {
    const sent: Array<[number, string]> = []
    const killer = createTreeKiller({ platform: 'linux', signal: (p, s) => void sent.push([p, s]) })
    await killer.terminate(500)
    await killer.forceKill(500)
    expect(sent).toEqual([
      [-500, 'SIGTERM'],
      [-500, 'SIGKILL'],
    ])
    expect(await killer.reap(500, 10)).toEqual([])
  })

  it('Windows: reap resolves empty at once and never starts a third taskkill (a recycled pid could be anyone)', async () => {
    const calls: Array<readonly string[]> = []
    const killer = createTreeKiller({ platform: 'win32', fileExists: () => false, execFile: (_f, args, _o, cb) => (calls.push(args), cb(null)) })
    await killer.terminate(900)
    expect(await killer.reap(900, 1000)).toEqual([])
    expect(calls).toEqual([['/PID', '900', '/T', '/F']])
  })
})

describe.skipIf(process.platform !== 'linux')('the real process table and a real session', () => {
  it('finds the whole family of a real session leader: group-escaping jobs included', async () => {
    const { spawn } = await import('node:child_process')
    const marker = String(7000000 + (process.pid % 1000))
    // A session leader (setsid) with: a subshell background job (orphaned, other group) and a nested job-controlled shell.
    const leader = spawn('setsid', ['sh', '-c', `(sleep ${marker}1 &) ; sh -c 'set -m; sleep ${marker}2 & wait' & exec sleep ${marker}0`], { stdio: 'ignore' })
    const table = createProcessTable('linux')
    try {
      let fam: ProcInfo[] = []
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 50))
        fam = familyOf(table.snapshot(), leader.pid as number, { protect: ancestorsOf(table.snapshot(), process.pid) })
        if (fam.length >= 3) break
      }
      expect(fam.length).toBeGreaterThanOrEqual(3)
      const killer = createTreeKiller({ platform: 'linux' })
      await killer.terminate(leader.pid as number)
      const left = await killer.reap(leader.pid as number, 800)
      expect(left).toEqual([])
      const after = familyOf(table.snapshot(), leader.pid as number)
      expect(after).toEqual([])
    } finally {
      try {
        process.kill(-(leader.pid as number), 'SIGKILL')
      } catch {
        /* gone */
      }
    }
  })
})
