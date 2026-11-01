import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { createIdGen } from '../src/ids'
import { silentLogger } from '../src/log'
import { nodeCwdFs } from '../src/terminal/cwd'
import { createRealHostPtyFactory, type HostPtyFactory } from '../src/terminal/hostClient'
import { createTreeKiller } from '../src/terminal/kill'
import { nodeLaunchFs } from '../src/terminal/launch'
import { TerminalService, type TerminalEvent } from '../src/terminal/service'
import { RecordingSink } from '../src/terminal/testing'
import { testConfig } from './helpers'
import { makeTerminalHarness, type TerminalHarness } from './terminalHarness'

/**
 * Real node-pty (forkpty in this Linux sandbox) with tiny node programs, always through a real PTY HOST process (the daemon
 * never loads node-pty itself). Windows (ConPTY, taskkill) cannot be exercised here and is covered only by the
 * injected-collaborator unit tests.
 */

const isWin = process.platform === 'win32'
const base = realpathSync(mkdtempSync(join(tmpdir(), 'term-pty-')))
const home = join(base, 'home')
const project = join(base, 'project')
mkdirSync(home, { recursive: true })
mkdirSync(project, { recursive: true })
afterAll(() => rmSync(base, { recursive: true, force: true }))

const NODE = process.execPath
const fakeClaude = join(base, 'fake-claude.mjs')
writeFileSync(
  fakeClaude,
  `process.stdout.write('FAKE-CLAUDE ready ' + process.stdout.columns + 'x' + process.stdout.rows + '\\r\\n')
process.stdout.on('resize', () => process.stdout.write('RESIZED ' + process.stdout.columns + 'x' + process.stdout.rows + '\\r\\n'))
process.stdin.setEncoding('utf8')
let line = ''
process.stdin.on('data', (d) => { for (const ch of d) { if (ch === '\\r' || ch === '\\n') { if (line.trim()) process.stdout.write('ECHO:' + line + '\\r\\n'); if (line === 'quit') process.exit(7); line = '' } else line += ch } })
if (process.stdin.isTTY) process.stdin.setRawMode(true)
`,
)
const dumpEnv = join(base, 'dump-env.mjs')
writeFileSync(dumpEnv, `process.stdout.write('ENV-JSON:' + JSON.stringify(process.env) + ':END\\r\\n'); setTimeout(() => process.exit(0), 300)`)
const treeParent = join(base, 'tree-parent.mjs')
writeFileSync(
  treeParent,
  `import { spawn } from 'node:child_process'
const c = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' })
process.stdout.write('CHILD-PID:' + c.pid + ' PARENT-PID:' + process.pid + '\\r\\n')
setInterval(() => {}, 1000)`,
)

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
async function until<T>(cond: () => T | null | undefined | false, label: string, ms = 8000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = cond()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

/** Pids of live (not zombie) processes whose whole command line is exactly this. Linux only. */
function running(cmdline: string): number[] {
  const out: number[] = []
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    try {
      const cmd = readFileSync(`/proc/${name}/cmdline`, 'latin1').split('\0').filter(Boolean).join(' ')
      if (cmd !== cmdline) continue
      const stat = readFileSync(`/proc/${name}/stat`, 'latin1')
      const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3)
      if (state !== 'Z' && state !== 'X') out.push(Number(name))
    } catch {
      /* vanished while being read */
    }
  }
  return out
}
const killAll = (cmdline: string): void => {
  for (const pid of running(cmdline)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* gone */
    }
  }
}

const services: TerminalService[] = []
const hostFactories: HostPtyFactory[] = []
function realService(override: { command?: string[]; limits?: Record<string, unknown> } = {}) {
  const events: TerminalEvent[] = []
  const cfg = testConfig(base).terminals
  const killer = createTreeKiller({ platform: process.platform })
  const hosts = createRealHostPtyFactory({ onLost: (pid) => void killer.forceKill(pid).catch(() => undefined), graceMs: 1500 })
  hostFactories.push(hosts)
  const service = new TerminalService({
    limits: { ...cfg, killGraceMs: 1500, ...(override.command ? { claudeCommandOverride: JSON.stringify(override.command) } : {}), ...override.limits },
    platform: process.platform,
    env: () => process.env,
    home,
    cwdFs: nodeCwdFs,
    launchFs: nodeLaunchFs,
    ptyFactory: hosts.create,
    killer,
    clock: Date.now,
    newId: createIdGen(),
    enabled: () => true,
    projects: () => [{ id: 'p', name: 'Project', rootPath: project }],
    log: silentLogger,
    onEvent: (e) => void events.push(e),
  })
  services.push(service)
  return { service, events, hosts }
}
afterEach(async () => {
  for (const s of services.splice(0)) await s.shutdown()
  for (const h of hostFactories.splice(0)) await h.shutdown()
})

describe.skipIf(isWin)('the real PTY (Linux sandbox)', () => {
  it('runs the test claude command: output, typing, resize, exit code', async () => {
    const { service } = realService({ command: [NODE, fakeClaude] })
    const info = await service.create({ kind: 'claude', cwd: home, cols: 90, rows: 20 })
    expect(info).toMatchObject({ kind: 'claude', state: 'running', cwd: home })
    const sink = new RecordingSink()
    const a = service.attach(info.id, sink)
    await until(() => sink.text.includes('FAKE-CLAUDE ready 90x20'), 'the banner with the initial size')
    expect(a.write(Buffer.from('hello world\r'))).toBe('ok')
    await until(() => sink.text.includes('ECHO:hello world'), 'typed text echoed by the program')
    expect(a.resize(120, 40)).toBe(true)
    await until(() => sink.text.includes('RESIZED 120x40'), 'the program to see the resize')
    a.write(Buffer.from('quit\r'))
    await until(() => service.get(info.id)?.state === 'exited', 'the program to exit')
    expect(service.get(info.id)).toMatchObject({ state: 'exited', exitCode: 7 })
    expect(sink.controls.at(-1)).toEqual({ type: 'exit', exitCode: 7 })
  })

  it('starts the program in the requested folder', async () => {
    const { service } = realService()
    const info = await service.create({ kind: 'shell', projectId: 'p' })
    expect(info.cwd).toBe(project)
    const sink = new RecordingSink()
    const a = service.attach(info.id, sink)
    a.write(Buffer.from('pwd\r'))
    await until(() => sink.text.includes(project), 'pwd output')
  })

  it('a real shell runs commands and shows output', async () => {
    const { service } = realService()
    const info = await service.create({ kind: 'shell' })
    const sink = new RecordingSink()
    const a = service.attach(info.id, sink)
    a.write(Buffer.from('echo $((6*7))-done\r'))
    await until(() => /(^|\n|\r)42-done/.test(sink.text), 'the shell to print 42-done')
  })

  it('a planted daemon secret never reaches the child process', async () => {
    const planted = { ANTHROPIC_API_KEY: 'sk-ant-api03-PLANTED-PTY-SECRET', AI_ASSISTANT_HOOK_TOKEN: 'PLANTED-HOOK-TOKEN-ABCDEFGHIJKLMNOPQRSTUVWXYZ', DAEMON_PORT: '45454', STAGE_TOKEN: 'PLANTED-STAGE-TOKEN', EXCHANGE_CODE: 'PLANTED-EXCHANGE', MIRA_X: 'PLANTED-MIRA', MY_OWN_VAR: 'kept-for-the-user' }
    const saved: Record<string, string | undefined> = {}
    for (const [k, v] of Object.entries(planted)) {
      saved[k] = process.env[k]
      process.env[k] = v
    }
    try {
      const { service } = realService({ command: [NODE, dumpEnv] })
      const info = await service.create({ kind: 'claude', cwd: home })
      const sink = new RecordingSink()
      service.attach(info.id, sink)
      await until(() => sink.text.includes(':END'), 'the environment dump')
      const json = /ENV-JSON:(.*?):END/s.exec(sink.text.replace(/\r\n/g, ''))?.[1] ?? ''
      const env = JSON.parse(json) as Record<string, string>
      expect(Object.keys(env)).toContain('PATH')
      expect(env.MY_OWN_VAR).toBe('kept-for-the-user')
      expect(env.TERM).toBe('xterm-256color')
      for (const k of ['ANTHROPIC_API_KEY', 'AI_ASSISTANT_HOOK_TOKEN', 'DAEMON_PORT', 'STAGE_TOKEN', 'EXCHANGE_CODE', 'MIRA_X']) expect(env[k], k).toBeUndefined()
      expect(sink.text).not.toContain('PLANTED')
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })

  it('closing a terminal kills the whole process tree (parent and grandchild)', async () => {
    const { service } = realService({ command: [NODE, treeParent] })
    const info = await service.create({ kind: 'claude', cwd: home })
    const sink = new RecordingSink()
    service.attach(info.id, sink)
    const pids = await until(() => /CHILD-PID:(\d+) PARENT-PID:(\d+)/.exec(sink.text), 'the pids')
    const child = Number(pids[1])
    const parent = Number(pids[2])
    expect(alive(child)).toBe(true)
    expect(alive(parent)).toBe(true)
    await service.close(info.id)
    await until(() => !alive(parent) && !alive(child), 'both processes to be gone', 5000)
    expect(service.list()).toHaveLength(0)
  })

  it('killAllNow (the process-exit last resort) hard-kills real trees synchronously', async () => {
    const { service } = realService({ command: [NODE, treeParent] })
    const info = await service.create({ kind: 'claude', cwd: home })
    const sink = new RecordingSink()
    service.attach(info.id, sink)
    const m = await until(() => /CHILD-PID:(\d+) PARENT-PID:(\d+)/.exec(sink.text), 'the pids')
    const [child, parent] = [Number(m[1]), Number(m[2])]
    service.killAllNow()
    await until(() => !alive(parent) && !alive(child), 'both processes to be gone', 5000)
  })

  it('a graceful shutdown kills every terminal tree', async () => {
    const { service } = realService({ command: [NODE, treeParent], limits: { maxTerminals: 3 } })
    const found: Array<[number, number]> = []
    for (let i = 0; i < 2; i++) {
      const info = await service.create({ kind: 'claude', cwd: home })
      const sink = new RecordingSink()
      service.attach(info.id, sink)
      const m = await until(() => /CHILD-PID:(\d+) PARENT-PID:(\d+)/.exec(sink.text), 'pids')
      found.push([Number(m[1]), Number(m[2])])
    }
    await service.shutdown()
    await until(() => found.every(([c, p]) => !alive(c) && !alive(p)), 'every process to be gone', 5000)
  })

  it('a tree kill also reaches a background child of a real shell', async () => {
    const { service } = realService()
    const info = await service.create({ kind: 'shell' })
    const sink = new RecordingSink()
    const a = service.attach(info.id, sink)
    a.write(Buffer.from("sh -c 'sleep 300 & echo BGPID:$!; wait' &\r"))
    // the shell is interactive, so the job gets its own process group; SIGHUP on close still reaches it
    const m = await until(() => /BGPID:(\d+)/.exec(sink.text), 'the background pid')
    const bg = Number(m[1])
    expect(alive(bg)).toBe(true)
    await service.close(info.id)
    await until(() => !alive(bg), 'the background process to be gone', 6000)
  })

  it('replays real output to a client that attaches later, bounded', async () => {
    const { service } = realService({ command: [NODE, fakeClaude], limits: { scrollbackBytes: 64 * 16 } })
    const info = await service.create({ kind: 'claude', cwd: home })
    const first = new RecordingSink()
    const a = service.attach(info.id, first)
    await until(() => first.text.includes('FAKE-CLAUDE ready'), 'banner')
    for (let i = 0; i < 100; i++) a.write(Buffer.from(`line number ${i}\r`))
    await until(() => first.text.includes('ECHO:line number 99'), 'the last echo')
    a.detach()
    const second = new RecordingSink()
    service.attach(info.id, second)
    expect(Buffer.concat(second.chunks).length).toBeLessThanOrEqual(64 * 16)
    expect(second.text).toContain('ECHO:line number 99')
    expect(second.text).not.toContain('FAKE-CLAUDE')
  })

  it('a program that cannot be started ends as an exited terminal with the error visible, not a crash', async () => {
    const { service } = realService({ command: ['/nonexistent/definitely-not-here'] })
    const info = await service.create({ kind: 'claude', cwd: home })
    const sink = new RecordingSink()
    service.attach(info.id, sink)
    await until(() => service.get(info.id)?.state === 'exited', 'the failed program to end')
    expect(service.get(info.id)?.exitCode).not.toBe(0)
    expect(service.runningCount()).toBe(0)
  })
})

describe.skipIf(isWin)('the whole daemon on the real PTY', () => {
  const open: TerminalHarness[] = []
  const sockets: WebSocket[] = []
  afterEach(async () => {
    for (const s of sockets.splice(0)) s.terminate()
    for (const h of open.splice(0)) await h.cleanup()
  })

  it('POST, ticket, WebSocket: type into a real shell and read the output, then close it', async () => {
    const h = await makeTerminalHarness({ listen: true, real: { home, projectRoot: project } })
    open.push(h)
    const created = await h.call('/api/terminals', { json: { kind: 'shell', projectId: 'p-atlas' } })
    expect(created.status).toBe(201)
    const info = (await created.json()) as { id: string; cwd: string }
    expect(info.cwd).toBe(project)
    const ticket = await h.ticket(info.id)
    const ws = new WebSocket(`ws://127.0.0.1:${h.port}/ws/terminal/${info.id}`, { headers: { Origin: h.origin, Cookie: h.cookie } })
    sockets.push(ws)
    const chunks: Buffer[] = []
    const texts: string[] = []
    ws.on('message', (d, bin) => (bin ? chunks.push(Buffer.from(d as Buffer)) : texts.push(d.toString())))
    await new Promise((r) => ws.once('open', r))
    ws.send(JSON.stringify({ type: 'auth', ticket }))
    await until(() => texts.length > 0, 'ready')
    ws.send(Buffer.from('echo daemon-$((20+22))\r'))
    await until(() => /daemon-42/.test(Buffer.concat(chunks).toString()), 'the typed command to run', 10_000)
    const pid = h.daemon.terminals.service.list().length
    expect(pid).toBe(1)
    const del = await h.call(`/api/terminals/${info.id}`, { method: 'DELETE' })
    expect(del.status).toBe(204)
    expect(h.daemon.terminals.service.runningCount()).toBe(0)
  })

  it('claude_not_found comes back as a clear 422 through the API when claude is not installed', async () => {
    const saved = process.env.PATH
    process.env.PATH = base // a folder without claude
    try {
      const h = await makeTerminalHarness({ real: { home, projectRoot: project } })
      open.push(h)
      const res = await h.call('/api/terminals', { json: { kind: 'claude' } })
      expect(res.status).toBe(422)
      expect(await res.json()).toMatchObject({ error: 'claude_not_found' })
    } finally {
      process.env.PATH = saved
    }
  })

  it('a graceful daemon stop kills a real running shell', async () => {
    const h = await makeTerminalHarness({ listen: true, real: { home, projectRoot: project } })
    const info = (await (await h.call('/api/terminals', { json: { kind: 'shell' } })).json()) as { id: string }
    const sink = new RecordingSink()
    const a = h.daemon.terminals.service.attach(info.id, sink)
    a.write(Buffer.from('echo SHELLPID:$$:\r'))
    const m = await until(() => /SHELLPID:(\d+):/.exec(sink.text.replace(/\r?\n/g, '')), 'the shell pid')
    const pid = Number(m[1])
    expect(alive(pid)).toBe(true)
    await h.daemon.stop()
    await until(() => !alive(pid), 'the shell to be gone after the daemon stopped', 5000)
    h.daemon.terminals.service.list().forEach((t) => expect(t.state).toBe('exited'))
    rmSync(h.dataDir, { recursive: true, force: true })
  })
})


// ---------------------------------------------------------------- the three HIGH findings of the adversarial review

const masterProbe = join(base, 'master-probe.cjs')
writeFileSync(
  masterProbe,
  `const cp = require('node:child_process')
const own = require('node:fs').readdirSync('/proc/self/fd').filter((f) => { try { return require('node:fs').readlinkSync('/proc/self/fd/' + f) === '/dev/ptmx' } catch { return false } }).length
const sub = cp.execFileSync('sh', ['-c', 'ls -l /proc/$$/fd | grep -c ptmx || true'], { encoding: 'utf8' }).trim()
process.stdout.write('MASTERS own=' + own + ' child=' + sub + '\\r\\n')
setInterval(() => {}, 1000)`,
)
describe.skipIf(isWin)('PTY master descriptors never cross from one terminal into another (PTY-MASTER-FD-INHERITANCE)', () => {
  it('no program of a later terminal holds the master of an earlier one: shells, a claude program and its subprocess', async () => {
    const { service, hosts } = realService({ command: [NODE, masterProbe], limits: { maxTerminals: 6 } })
    for (let i = 0; i < 3; i++) {
      const info = await service.create({ kind: 'shell' })
      service.attach(info.id, new RecordingSink())
    }
    const claude = await service.create({ kind: 'claude', cwd: home })
    const claudeSink = new RecordingSink()
    service.attach(claude.id, claudeSink)
    const m = await until(() => /MASTERS own=(\d+) child=(\d+)/.exec(claudeSink.text), 'the claude program\'s own report')
    expect(m[1]).toBe('0')
    expect(m[2]).toBe('0')
    // the host processes each own exactly one master and nothing else is shared
    const masters = (pid: number): number => readdirSync(`/proc/${pid}/fd`).filter((f) => { try { return readlinkSync(`/proc/${pid}/fd/${f}`) === '/dev/ptmx' } catch { return false } }).length
    for (const pid of hosts.hostPids()) expect(masters(pid), `host ${pid}`).toBe(1)
    expect(hosts.hostCount()).toBe(4)
    // and the daemon process itself (this one) holds none
    expect(masters(process.pid)).toBe(0)
  })

  it('a shell opened after another cannot see the other\'s master, so it cannot type into it or read from it', async () => {
    const { service } = realService({ limits: { maxTerminals: 3 } })
    const a = await service.create({ kind: 'shell' })
    const sinkA = new RecordingSink()
    const attA = service.attach(a.id, sinkA)
    attA.write(Buffer.from('A_SECRET=terminal-A-private; echo READY-A\r'))
    await until(() => /READY-A/.test(sinkA.text.replace(/echo READY-A/g, '')), 'terminal A to be ready')
    const b = await service.create({ kind: 'shell' })
    const sinkB = new RecordingSink()
    const attB = service.attach(b.id, sinkB)
    // the reviewers' own recipe: find a /dev/ptmx descriptor in this shell and write a command into it
    attB.write(Buffer.from("FD=$(ls -l /proc/$$/fd | awk '/ptmx/ {print $9}' | head -1); echo FDCOUNT-$(ls -l /proc/$$/fd | grep -c ptmx)-END FD=[$FD]\r"))
    await until(() => /FDCOUNT-\d+-END/.test(sinkB.text.replace(/FDCOUNT-\$\(/g, '')), 'the fd report')
    expect(/FDCOUNT-(\d+)-END FD=\[(\d*)\]/.exec(sinkB.text)).toMatchObject({ 1: '0', 2: '' })
    attB.write(Buffer.from("[ -n \"$FD\" ] && printf 'echo CROSS-INJECTED-$((6*7))-END\\n' >&$FD; echo DONE-B\r"))
    await until(() => /DONE-B/.test(sinkB.text.replace(/echo DONE-B/g, '')), 'B to finish its attempt')
    await new Promise((r) => setTimeout(r, 300))
    expect(sinkA.text).not.toContain('CROSS-INJECTED')
  })
})

/** The process shapes of the review: [what it is, what to type, the sleep that proves it is alive, ends with the terminal?] */
const SHAPES: Array<[string, string, number, boolean]> = [
  ['a plain background job', 'sleep 781001 &', 781001, true],
  ['a foreground job', 'sleep 781002', 781002, true],
  ['nohup in the background', 'nohup sleep 781003 >/dev/null 2>&1 &', 781003, true],
  ['a subshell job: ( cmd & )', '(sleep 781004 &)', 781004, true],
  ['a background job ignoring HUP and TERM', `sh -c 'trap "" HUP TERM; sleep 781006' &`, 781006, true],
  ['a foreground job ignoring HUP, TERM and INT', `sh -c 'trap "" HUP TERM INT; sleep 781007'`, 781007, true],
  ['an interactive shell ignoring HUP and TERM with a background job', `trap '' HUP TERM; sleep 781009 &`, 781009, true],
  ['a foreground job ignoring only HUP', `sh -c 'trap "" HUP; sleep 781010'`, 781010, true],
  ['exec: the PTY child itself is the program', 'exec sleep 781011', 781011, true],
  ['a nested shell with job control', `sh -c 'set -m; sleep 781012 & wait'`, 781012, true],
  ['a job moved into its own group by a Claude-like parent', `node -e "require('child_process').spawn('sleep',['781014'],{detached:false,stdio:'ignore'}); setInterval(()=>{},1000)"`, 781014, true],
  // The documented residual: a process that has already left the terminal's session and been re-parented to init.
  ['setsid in the background (deliberately daemonised)', 'setsid sleep 781020 >/dev/null 2>&1 &', 781020, false],
  ['setsid -f (deliberately daemonised)', 'setsid -f sleep 781021', 781021, false],
]

describe.skipIf(isWin)('closing a terminal ends its whole process tree (TREE-KILL-PROCESS-GROUP-ONLY)', () => {
  it('every ordinary shape dies on close; only a process that deliberately daemonised itself survives (and is documented)', async () => {
    for (const [, , leaf] of SHAPES) killAll(`sleep ${leaf}`)
    const { service } = realService({ limits: { maxTerminals: 16 } })
    try {
      const ids: string[] = []
      for (const [, cmd] of SHAPES) {
        const info = await service.create({ kind: 'shell' })
        ids.push(info.id)
        const att = service.attach(info.id, new RecordingSink())
        // the shell needs a moment before it reads the line
        await new Promise((r) => setTimeout(r, 120))
        att.write(Buffer.from(`${cmd}\r`))
      }
      for (const [label, , leaf] of SHAPES) await until(() => running(`sleep ${leaf}`).length > 0, `${label} to be running`, 12_000)
      await Promise.all(ids.map((id) => service.close(id)))
      for (const [label, , leaf, ends] of SHAPES) {
        if (ends) await until(() => running(`sleep ${leaf}`).length === 0, `${label} to be gone after the close`, 8000)
      }
      for (const [label, , leaf, ends] of SHAPES) {
        if (!ends) expect(running(`sleep ${leaf}`).length, `${label} is the documented residual and is still running`).toBeGreaterThan(0)
      }
      expect(service.list()).toHaveLength(0)
    } finally {
      for (const [, , leaf] of SHAPES) killAll(`sleep ${leaf}`)
    }
  }, 60_000)

  it('the switch (closeAll) and a graceful shutdown end the same shapes', async () => {
    const ordinary = SHAPES.filter(([, , , ends]) => ends).slice(0, 8)
    for (const [, , leaf] of ordinary) killAll(`sleep ${leaf}`)
    const { service } = realService({ limits: { maxTerminals: 16 } })
    try {
      for (const [, cmd] of ordinary) {
        const info = await service.create({ kind: 'shell' })
        const att = service.attach(info.id, new RecordingSink())
        await new Promise((r) => setTimeout(r, 120))
        att.write(Buffer.from(`${cmd}\r`))
      }
      for (const [label, , leaf] of ordinary) await until(() => running(`sleep ${leaf}`).length > 0, `${label} to be running`, 12_000)
      await service.closeAll('disabled')
      for (const [label, , leaf] of ordinary) await until(() => running(`sleep ${leaf}`).length === 0, `${label} to be gone after switching off`, 8000)
    } finally {
      for (const [, , leaf] of ordinary) killAll(`sleep ${leaf}`)
    }
  }, 60_000)

  it('records processes that could not be ended on the closed event instead of hiding them', async () => {
    // a real family member the killer is not allowed to signal is hard to build here; the event wiring is covered with a fake killer in terminal.service.test.ts
    const { service, events } = realService()
    const info = await service.create({ kind: 'shell' })
    await service.close(info.id)
    expect(events.find((e) => e.type === 'closed')).toMatchObject({ type: 'closed', reason: 'user' })
    expect(events.find((e) => e.type === 'closed' && 'survivors' in e)).toBeUndefined()
  })
})

describe.skipIf(isWin)('the terminals die with the daemon, however it dies (DAEMON-DEATH-ORPHANS)', () => {
  async function daemonLike(cmds: string[]): Promise<{ pid: number; stop: () => void }> {
    const helper = join(base, `daemon-like-${Math.random().toString(36).slice(2)}.mts`)
    writeFileSync(
      helper,
      `import { createRealHostPtyFactory } from ${JSON.stringify(join(process.cwd(), 'src/terminal/hostClient.ts'))}
const hosts = createRealHostPtyFactory({ graceMs: 400 })
const cmds = JSON.parse(process.argv[2])
const env = { PATH: process.env.PATH, HOME: process.argv[3], TERM: 'xterm' }
for (const c of cmds) {
  const pty = await hosts.create({ file: '/bin/sh', args: [], cwd: process.argv[3], env, cols: 80, rows: 24 })
  pty.onData(() => {})
  await new Promise((r) => setTimeout(r, 150))
  pty.write(c + '\\r')
}
process.stdout.write('READY\\n')
setInterval(() => {}, 1000)
`,
    )
    const loader = (await import('node:url')).pathToFileURL((await import('node:module')).createRequire(import.meta.url).resolve('tsx')).href
    const child = spawn(process.execPath, ['--import', loader, helper, JSON.stringify(cmds), home], { stdio: ['ignore', 'pipe', 'inherit'] })
    let out = ''
    child.stdout.on('data', (b) => (out += b))
    await until(() => out.includes('READY'), 'the daemon-like process to start its terminals', 30_000)
    return { pid: child.pid as number, stop: () => void child.kill('SIGKILL') }
  }

  it('SIGKILL of the daemon (no cleanup code runs) ends every terminal tree, also with a later HUP-immune terminal in the mix', async () => {
    const shapes: Array<[string, number]> = [
      ['sleep 781101', 781101],
      ['sleep 781102', 781102],
      ['(sleep 781103 &)', 781103],
      [`trap '' HUP; sleep 781104 &`, 781104], // the review's poison: a later terminal whose process outlives a hang-up
      ['nohup sleep 781105 >/dev/null 2>&1 &', 781105],
      [`sh -c 'trap "" HUP TERM INT; sleep 781106'`, 781106],
    ]
    for (const [, leaf] of shapes) killAll(`sleep ${leaf}`)
    const d = await daemonLike(shapes.map(([c]) => c))
    try {
      for (const [, leaf] of shapes) await until(() => running(`sleep ${leaf}`).length > 0, `sleep ${leaf} to be running`, 12_000)
      d.stop() // SIGKILL
      for (const [, leaf] of shapes) await until(() => running(`sleep ${leaf}`).length === 0, `sleep ${leaf} to be gone after the daemon was killed`, 12_000)
    } finally {
      for (const [, leaf] of shapes) killAll(`sleep ${leaf}`)
    }
  }, 60_000)

  it('a host that is killed from outside ends its program\'s family through the daemon (onLost)', async () => {
    killAll('sleep 781201')
    const { service, hosts } = realService()
    try {
      const info = await service.create({ kind: 'shell' })
      const att = service.attach(info.id, new RecordingSink())
      await new Promise((r) => setTimeout(r, 120))
      att.write(Buffer.from(`trap '' HUP; sleep 781201 &\r`))
      await until(() => running('sleep 781201').length > 0, 'the job to run')
      process.kill(hosts.hostPids()[0] as number, 'SIGKILL')
      await until(() => service.get(info.id)?.state === 'exited', 'the terminal to be reported as ended')
      expect(service.get(info.id)?.exitCode).toBeNull()
      await until(() => running('sleep 781201').length === 0, 'the orphaned job to be killed by the daemon', 8000)
    } finally {
      killAll('sleep 781201')
    }
  }, 40_000)
})
