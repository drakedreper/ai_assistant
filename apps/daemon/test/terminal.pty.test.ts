import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { createIdGen } from '../src/ids'
import { silentLogger } from '../src/log'
import { nodeCwdFs } from '../src/terminal/cwd'
import { createTreeKiller } from '../src/terminal/kill'
import { nodeLaunchFs } from '../src/terminal/launch'
import { createNodePtyFactory } from '../src/terminal/pty'
import { TerminalService, type TerminalEvent } from '../src/terminal/service'
import { RecordingSink } from '../src/terminal/testing'
import { testConfig } from './helpers'
import { makeTerminalHarness, type TerminalHarness } from './terminalHarness'

/**
 * Real node-pty (forkpty in this Linux sandbox) with tiny node programs. Windows (ConPTY, taskkill) cannot be
 * exercised here and is covered only by the injected-collaborator unit tests.
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

const services: TerminalService[] = []
function realService(override: { command?: string[]; limits?: Record<string, unknown> } = {}) {
  const events: TerminalEvent[] = []
  const cfg = testConfig(base).terminals
  const service = new TerminalService({
    limits: { ...cfg, killGraceMs: 1500, ...(override.command ? { claudeCommandOverride: JSON.stringify(override.command) } : {}), ...override.limits },
    platform: process.platform,
    env: () => process.env,
    home,
    cwdFs: nodeCwdFs,
    launchFs: nodeLaunchFs,
    ptyFactory: createNodePtyFactory(),
    killer: createTreeKiller({ platform: process.platform }),
    clock: Date.now,
    newId: createIdGen(),
    enabled: () => true,
    projects: () => [{ id: 'p', name: 'Project', rootPath: project }],
    log: silentLogger,
    onEvent: (e) => void events.push(e),
  })
  services.push(service)
  return { service, events }
}
afterEach(async () => {
  for (const s of services.splice(0)) await s.shutdown()
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
