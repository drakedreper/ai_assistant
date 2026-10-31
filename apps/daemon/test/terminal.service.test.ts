import { describe, expect, it } from 'vitest'
import { createIdGen } from '../src/ids'
import { silentLogger } from '../src/log'
import { TerminalError, TerminalService, type TerminalEvent } from '../src/terminal/service'
import { PtyUnavailableError } from '../src/terminal/pty'
import { FakeKiller, MemoryFs, RecordingSink, createFakePtyFactory, type FakePty } from '../src/terminal/testing'
import { makeClock, testConfig } from './helpers'

interface Setup {
  service: TerminalService
  fake: ReturnType<typeof createFakePtyFactory>
  killer: FakeKiller
  clock: ReturnType<typeof makeClock>
  events: TerminalEvent[]
  sweeps: Array<() => void>
  fs: MemoryFs
  state: { enabled: boolean; env: Record<string, string> }
}

function setup(opts: { limits?: Partial<ReturnType<typeof testConfig>['terminals']>; platform?: NodeJS.Platform; killerMode?: 'terminate' | 'force' | 'never'; asyncFactory?: boolean } = {}): Setup {
  const platform = opts.platform ?? 'linux'
  const clock = makeClock()
  const fake = createFakePtyFactory()
  const killer = new FakeKiller(() => fake.ptys, opts.killerMode ?? 'terminate')
  const fs = new MemoryFs(platform)
  const win = platform === 'win32'
  const home = win ? 'C:\\Users\\Ana' : '/home/ana'
  const root = win ? 'D:\\dev\\atlas' : '/home/ana/proj'
  fs.addDir(home).addDir(root).addDir(win ? 'D:\\dev\\atlas\\src' : '/home/ana/proj/src').addDir(win ? 'C:\\Windows' : '/etc')
  if (win) fs.addFile('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe').addFile('C:\\Users\\Ana\\.local\\bin\\claude.exe').addFile('C:\\npm\\claude.cmd').addFile('C:\\Windows\\System32\\cmd.exe')
  else fs.addFile('/bin/sh').addFile('/usr/bin/claude')
  const state: { enabled: boolean; env: Record<string, string> } = {
    enabled: true,
    env: win
      ? { SystemRoot: 'C:\\Windows', PATH: 'C:\\Users\\Ana\\.local\\bin', ANTHROPIC_API_KEY: 'sk-ant-planted', DAEMON_PORT: '7421', AI_ASSISTANT_HOOK_TOKEN: 'planted-hook-token' }
      : { PATH: '/usr/bin', SHELL: '/bin/sh', HOME: '/home/ana', ANTHROPIC_API_KEY: 'sk-ant-planted', DAEMON_PORT: '7421', AI_ASSISTANT_HOOK_TOKEN: 'planted-hook-token' },
  }
  const events: TerminalEvent[] = []
  const sweeps: Array<() => void> = []
  const limits = { ...testConfig('/tmp/x').terminals, killGraceMs: 20, scrollbackBytes: 1024, ...opts.limits }
  const factory = opts.asyncFactory ? async (s: Parameters<typeof fake.factory>[0]) => (await new Promise((r) => setTimeout(r, 5)), fake.factory(s)) : fake.factory
  const service = new TerminalService({
    limits,
    platform,
    env: () => state.env,
    home,
    cwdFs: fs,
    launchFs: fs,
    ptyFactory: factory,
    killer,
    clock: clock.fn,
    newId: createIdGen(clock.fn),
    scheduler: { setInterval: (fn) => (sweeps.push(fn), sweeps.length), clearInterval: () => undefined },
    enabled: () => state.enabled,
    projects: () => [{ id: 'p-atlas', name: 'Atlas', rootPath: root }],
    log: silentLogger,
    onEvent: (e) => void events.push(e),
  })
  service.start()
  return { service, fake, killer, clock, events, sweeps, fs, state }
}

const out = (p: FakePty, s: string) => p.emit(s)

describe('create: what is launched and how', () => {
  it('starts a shell in the home folder with a sanitised environment', async () => {
    const t = setup()
    const info = await t.service.create({ kind: 'shell', cols: 120, rows: 40 })
    expect(info).toMatchObject({ kind: 'shell', cwd: '/home/ana', cols: 120, rows: 40, state: 'running', exitCode: null })
    expect(info.id).toMatch(/^term-/)
    expect(info.title).toBe('sh \u00b7 ana')
    const spec = t.fake.specs[0]!
    expect(spec).toMatchObject({ file: '/bin/sh', args: [], cwd: '/home/ana', cols: 120, rows: 40 })
    expect(spec.env.TERM).toBe('xterm-256color')
    expect(spec.env.HOME).toBe('/home/ana')
    expect(JSON.stringify(spec.env)).not.toMatch(/planted|7421/)
  })

  it('starts claude from PATH, and from CLAUDE_EXECUTABLE', async () => {
    const t = setup()
    await t.service.create({ kind: 'claude' })
    expect(t.fake.specs[0]).toMatchObject({ file: '/usr/bin/claude', args: [] })
    expect(t.fake.specs[0]!.env).not.toHaveProperty('ANTHROPIC_API_KEY')
    t.fs.addFile('/opt/claude')
    const svc = new TerminalService({ ...(t.service as unknown as { o: ConstructorParameters<typeof TerminalService>[0] }).o, claudeExecutable: '/opt/claude' })
    await svc.create({ kind: 'claude' })
    expect(t.fake.specs[1]).toMatchObject({ file: '/opt/claude' })
  })

  it('reports claude_not_found as 422 with install help, and spawns nothing', async () => {
    const t = setup()
    t.state.env = { PATH: '/nowhere' }
    const err = await t.service.create({ kind: 'claude' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TerminalError)
    expect(err).toMatchObject({ status: 422, code: 'claude_not_found' })
    expect((err as TerminalError).message).toMatch(/CLAUDE_EXECUTABLE/)
    expect(t.fake.specs).toHaveLength(0)
    expect(t.events).toContainEqual({ type: 'refused', kind: 'claude', code: 'claude_not_found' })
  })

  it('uses the test-only TERMINAL_CLAUDE_COMMAND override', async () => {
    const t = setup({ limits: { claudeCommandOverride: '["/usr/bin/node","/tmp/fake-claude.mjs"]' } })
    t.state.env = { PATH: '/nowhere' }
    await t.service.create({ kind: 'claude' })
    expect(t.fake.specs[0]).toMatchObject({ file: '/usr/bin/node', args: ['/tmp/fake-claude.mjs'] })
  })

  it('a project starts in its root; a folder must stay inside that project', async () => {
    const t = setup()
    const a = await t.service.create({ kind: 'shell', projectId: 'p-atlas' })
    expect(a).toMatchObject({ cwd: '/home/ana/proj', projectId: 'p-atlas' })
    expect(a.title).toBe('sh \u00b7 Atlas')
    const b = await t.service.create({ kind: 'shell', projectId: 'p-atlas', cwd: '/home/ana/proj/src' })
    expect(b.cwd).toBe('/home/ana/proj/src')
    await expect(t.service.create({ kind: 'shell', projectId: 'p-atlas', cwd: '/home/ana' })).rejects.toMatchObject({ status: 400, code: 'cwd_outside' })
    await expect(t.service.create({ kind: 'shell', projectId: 'nope' })).rejects.toMatchObject({ status: 400, code: 'unknown_project' })
  })

  it('refuses a folder outside the roots, a UNC path and traversal, and spawns nothing', async () => {
    const t = setup()
    for (const [cwd, code] of [['/etc', 'cwd_outside'], ['\\\\srv\\share', 'cwd_unc'], ['/home/ana/../../etc', 'cwd_traversal'], ['relative', 'cwd_not_absolute'], ['/home/ana/missing', 'cwd_not_found']] as const) {
      await expect(t.service.create({ kind: 'shell', cwd }), cwd).rejects.toMatchObject({ status: 400, code })
    }
    expect(t.fake.specs).toHaveLength(0)
    expect(t.events.filter((e) => e.type === 'refused')).toHaveLength(5)
  })

  it('validates cols, rows and kind', async () => {
    const t = setup()
    await expect(t.service.create({ kind: 'shell', cols: 5 })).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(t.service.create({ kind: 'shell', rows: 500 })).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(t.service.create({ kind: 'shell', cols: 80.5 })).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(t.service.create({ kind: 'bash' as never })).rejects.toMatchObject({ code: 'invalid_request' })
    const ok = await t.service.create({ kind: 'shell' })
    expect(ok).toMatchObject({ cols: 100, rows: 30 })
  })

  it('answers 403 terminals_disabled while the switch is off', async () => {
    const t = setup()
    t.state.enabled = false
    await expect(t.service.create({ kind: 'shell' })).rejects.toMatchObject({ status: 403, code: 'terminals_disabled' })
    expect(t.fake.specs).toHaveLength(0)
  })

  it('kills a process that finished starting after the switch went off or shutdown began', async () => {
    const t = setup({ asyncFactory: true })
    const p = t.service.create({ kind: 'shell' })
    t.state.enabled = false
    await expect(p).rejects.toMatchObject({ code: 'terminals_disabled' })
    expect(t.killer.forced).toEqual([t.fake.ptys[0]!.pid])
    expect(t.service.list()).toHaveLength(0)

    t.state.enabled = true
    const q = t.service.create({ kind: 'shell' })
    void t.service.shutdown()
    await expect(q).rejects.toMatchObject({ code: 'shutting_down' })
    expect(t.service.list().every((x) => x.state === 'exited')).toBe(true)
  })

  it('maps a failed spawn to 502 and a missing node-pty to 500, without leaking the error text', async () => {
    const t = setup()
    t.fake.failNext(new Error('posix_spawnp failed: /secret/path'))
    const a = await t.service.create({ kind: 'shell' }).catch((e: unknown) => e)
    expect(a).toMatchObject({ status: 502, code: 'spawn_failed' })
    expect((a as Error).message).not.toMatch(/secret/)
    t.fake.failNext(new PtyUnavailableError('Cannot find module pty.node'))
    const b = await t.service.create({ kind: 'shell' }).catch((e: unknown) => e)
    expect(b).toMatchObject({ status: 500, code: 'pty_unavailable' })
    expect((b as Error).message).not.toMatch(/pty\.node/)
    expect(t.service.runningCount()).toBe(0)
  })
})

describe('create: Windows-style platform', () => {
  it('starts PowerShell in the home folder, claude.exe from PATH, and wraps a claude.cmd', async () => {
    const t = setup({ platform: 'win32' })
    const sh = await t.service.create({ kind: 'shell' })
    expect(sh.cwd).toBe('C:\\Users\\Ana')
    expect(t.fake.specs[0]).toMatchObject({ file: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', args: ['-NoLogo'] })
    await t.service.create({ kind: 'claude', projectId: 'p-atlas' })
    expect(t.fake.specs[1]).toMatchObject({ file: 'C:\\Users\\Ana\\.local\\bin\\claude.exe', cwd: 'D:\\dev\\atlas' })
    t.state.env = { ...t.state.env, PATH: 'C:\\npm' }
    await t.service.create({ kind: 'claude' })
    expect(t.fake.specs[2]).toMatchObject({ file: 'C:\\Windows\\System32\\cmd.exe', args: '/d /s /c ""C:\\npm\\claude.cmd""' })
    expect(JSON.stringify(t.fake.specs.map((s) => s.env))).not.toMatch(/planted|7421/i)
  })

  it('accepts a case-different folder and refuses a UNC one', async () => {
    const t = setup({ platform: 'win32' })
    await expect(t.service.create({ kind: 'shell', cwd: 'd:\\DEV\\atlas\\SRC' })).resolves.toMatchObject({ cwd: 'D:\\dev\\atlas\\src' })
    await expect(t.service.create({ kind: 'shell', cwd: '\\\\server\\share' })).rejects.toMatchObject({ code: 'cwd_unc' })
    await expect(t.service.create({ kind: 'shell', cwd: 'C:\\Windows' })).rejects.toMatchObject({ code: 'cwd_outside' })
  })
})

describe('limits: concurrent terminals', () => {
  it('allows the configured number, refuses one more with 429, and frees a slot when one exits', async () => {
    const t = setup({ limits: { maxTerminals: 2 } })
    await t.service.create({ kind: 'shell' })
    await t.service.create({ kind: 'shell' })
    await expect(t.service.create({ kind: 'shell' })).rejects.toMatchObject({ status: 429, code: 'terminal_limit' })
    expect(t.events).toContainEqual({ type: 'refused', kind: 'shell', code: 'terminal_limit' })
    t.fake.ptys[0]!.exit(0)
    await expect(t.service.create({ kind: 'shell' })).resolves.toMatchObject({ state: 'running' })
  })

  it('reserves slots while processes are still starting (no race past the cap)', async () => {
    const t = setup({ limits: { maxTerminals: 2 }, asyncFactory: true })
    const results = await Promise.allSettled([1, 2, 3, 4].map(() => t.service.create({ kind: 'shell' })))
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2)
    expect(results.filter((r) => r.status === 'rejected' && (r.reason as TerminalError).code === 'terminal_limit')).toHaveLength(2)
    expect(t.fake.ptys).toHaveLength(2)
  })
})

describe('attach, replay and one client', () => {
  it('sends ready, then the scrollback, then live output', async () => {
    const t = setup()
    const { id } = await t.service.create({ kind: 'shell' })
    const pty = t.fake.last()
    out(pty, 'before ')
    out(pty, 'attach')
    const sink = new RecordingSink()
    t.service.attach(id, sink)
    expect(sink.controls).toEqual([{ type: 'ready', replayBytes: 13 }])
    expect(sink.text).toBe('before attach')
    out(pty, ' and after')
    expect(sink.text).toBe('before attach and after')
  })

  it('refuses a second client with a clear 409 and lets it in after the first detaches', async () => {
    const t = setup()
    const { id } = await t.service.create({ kind: 'shell' })
    const first = t.service.attach(id, new RecordingSink())
    expect(() => t.service.attach(id, new RecordingSink())).toThrowError(/Another window is already connected/)
    try {
      t.service.attach(id, new RecordingSink())
    } catch (e) {
      expect(e).toMatchObject({ status: 409, code: 'already_attached' })
    }
    expect(t.service.isAttached(id)).toBe(true)
    first.detach()
    expect(t.service.isAttached(id)).toBe(false)
    const second = new RecordingSink()
    t.service.attach(id, second)
    out(t.fake.last(), 'hi')
    expect(second.text).toBe('hi')
  })

  it('answers 404 for an unknown terminal', () => {
    const t = setup()
    expect(() => t.service.attach('nope', new RecordingSink())).toThrowError(TerminalError)
  })

  it('bounds the scrollback and replays only the tail', async () => {
    const t = setup({ limits: { scrollbackBytes: 100 } })
    const { id } = await t.service.create({ kind: 'shell' })
    for (let i = 0; i < 50; i++) out(t.fake.last(), `line-${String(i).padStart(2, '0')}\n`)
    const sink = new RecordingSink()
    t.service.attach(id, sink)
    expect(sink.controls[0]).toEqual({ type: 'ready', replayBytes: 100 })
    expect(Buffer.concat(sink.chunks).length).toBe(100)
    expect(sink.text.endsWith('line-49\n')).toBe(true)
  })

  it('replays a large scrollback in bounded chunks', async () => {
    const t = setup({ limits: { scrollbackBytes: 200_000 } })
    const { id } = await t.service.create({ kind: 'shell' })
    out(t.fake.last(), 'x'.repeat(150_000))
    const sink = new RecordingSink()
    t.service.attach(id, sink)
    expect(sink.chunks.length).toBeGreaterThan(1)
    expect(Math.max(...sink.chunks.map((c) => c.length))).toBeLessThanOrEqual(32 * 1024)
    expect(Buffer.concat(sink.chunks).length).toBe(150_000)
  })

  it('accepts raw bytes from the pty (POSIX) as well as strings (ConPTY)', async () => {
    const t = setup()
    const { id } = await t.service.create({ kind: 'shell' })
    t.fake.last().emit(new Uint8Array([0x68, 0x69, 0xc3, 0xa9]))
    t.fake.last().emit('!')
    const sink = new RecordingSink()
    t.service.attach(id, sink)
    expect(sink.text).toBe('hié!')
  })

  it('drops a slow client without stopping the terminal, and the client can reattach', async () => {
    const t = setup()
    const { id } = await t.service.create({ kind: 'shell' })
    const slow = new RecordingSink()
    slow.failAfter = 1
    t.service.attach(id, slow)
    out(t.fake.last(), 'one')
    out(t.fake.last(), 'two') // second chunk: the sink refuses
    expect(t.service.isAttached(id)).toBe(false)
    out(t.fake.last(), 'three')
    expect(t.service.get(id)!.state).toBe('running')
    const again = new RecordingSink()
    t.service.attach(id, again)
    expect(again.text).toBe('onetwothree')
  })

  it('drops a client that is too slow during the replay itself', async () => {
    const t = setup({ limits: { scrollbackBytes: 200_000 } })
    const { id } = await t.service.create({ kind: 'shell' })
    out(t.fake.last(), 'x'.repeat(150_000))
    const slow = new RecordingSink()
    slow.failAfter = 1
    t.service.attach(id, slow)
    expect(slow.chunks).toHaveLength(1)
    expect(t.service.isAttached(id)).toBe(false)
  })
})

describe('input', () => {
  it('forwards keystrokes to the pty as text, even when a character is split across frames', async () => {
    const t = setup()
    const { id } = await t.service.create({ kind: 'shell' })
    const a = t.service.attach(id, new RecordingSink())
    expect(a.write(Buffer.from('ls\r'))).toBe('ok')
    const euro = Buffer.from('\u20ac') // e2 82 ac
    expect(a.write(euro.subarray(0, 1))).toBe('ok')
    expect(a.write(euro.subarray(1))).toBe('ok')
    expect(t.fake.last().text).toBe('ls\r\u20ac')
  })

  it('refuses a frame above the cap', async () => {
    const t = setup({ limits: { maxInputFrameBytes: 1024 } })
    const { id } = await t.service.create({ kind: 'shell' })
    const a = t.service.attach(id, new RecordingSink())
    expect(a.write(Buffer.alloc(1025, 0x61))).toBe('too_large')
    expect(a.write(Buffer.alloc(1024, 0x61))).toBe('ok')
    expect(t.fake.last().text.length).toBe(1024)
  })

  it('rate limits sustained input and recovers as the bucket refills', async () => {
    const t = setup({ limits: { inputBurstBytes: 4096, inputBytesPerSec: 2048 } })
    const { id } = await t.service.create({ kind: 'shell' })
    const a = t.service.attach(id, new RecordingSink())
    let accepted = 0
    let limited = 0
    for (let i = 0; i < 20; i++) (a.write(Buffer.alloc(512, 0x61)) === 'ok' ? accepted++ : limited++)
    expect(accepted).toBeGreaterThan(0)
    expect(limited).toBeGreaterThan(0)
    expect(accepted * 512).toBeLessThanOrEqual(4096)
    const before = t.fake.last().text.length
    expect(a.write(Buffer.from('x'))).toBe('rate_limited')
    expect(t.fake.last().text.length).toBe(before) // nothing was written
    t.clock.advance(2000)
    expect(a.write(Buffer.from('x'))).toBe('ok')
  })

  it('counts a flood of tiny frames against the budget too', async () => {
    const t = setup({ limits: { inputBurstBytes: 10_000, inputBytesPerSec: 1000 } })
    const { id } = await t.service.create({ kind: 'shell' })
    const a = t.service.attach(id, new RecordingSink())
    let accepted = 0
    for (let i = 0; i < 1000; i++) if (a.write(Buffer.from('a')) === 'ok') accepted++
    expect(accepted).toBeLessThan(60)
  })

  it('refuses input after the client detached or the process exited', async () => {
    const t = setup()
    const { id } = await t.service.create({ kind: 'shell' })
    const a = t.service.attach(id, new RecordingSink())
    a.detach()
    expect(a.write(Buffer.from('x'))).toBe('closed')
    const b = t.service.attach(id, new RecordingSink())
    t.fake.last().exit(0)
    expect(b.write(Buffer.from('x'))).toBe('closed')
  })
})

describe('resize', () => {
  it('resizes the pty within bounds and ignores nonsense', async () => {
    const t = setup()
    const { id } = await t.service.create({ kind: 'shell' })
    const a = t.service.attach(id, new RecordingSink())
    expect(a.resize(140, 50)).toBe(true)
    expect(t.fake.last().resizes).toEqual([[140, 50]])
    expect(t.service.get(id)).toMatchObject({ cols: 140, rows: 50 })
    expect(a.resize(140, 50)).toBe(true)
    expect(t.fake.last().resizes).toHaveLength(1) // unchanged: no call
    for (const [c, r] of [[9, 30], [501, 30], [80, 4], [80, 201], [80.5, 30], [Number.NaN, 30]] as const) expect(a.resize(c, r), `${c}x${r}`).toBe(false)
    expect(t.fake.last().resizes).toHaveLength(1)
  })

  it('the service API validates too', async () => {
    const t = setup()
    const { id } = await t.service.create({ kind: 'shell' })
    t.service.resize(id, 90, 25)
    expect(t.fake.last().resizes).toEqual([[90, 25]])
    expect(() => t.service.resize(id, 5, 25)).toThrowError(TerminalError)
    expect(() => t.service.resize('nope', 90, 25)).toThrowError(TerminalError)
    t.fake.last().exit(0)
    expect(() => t.service.resize(id, 90, 25)).toThrowError(/exited/)
  })
})

describe('lifecycle: exit codes and the list', () => {
  it('keeps an exited terminal listed with its exit code until it is removed', async () => {
    const t = setup()
    const { id } = await t.service.create({ kind: 'shell' })
    t.fake.last().exit(3)
    expect(t.service.get(id)).toMatchObject({ state: 'exited', exitCode: 3 })
    expect(t.service.list()).toHaveLength(1)
    expect(t.events.map((e) => e.type)).toEqual(['opened', 'exited'])
    t.service.remove(id)
    expect(t.service.list()).toHaveLength(0)
    expect(t.events.at(-1)).toEqual({ type: 'removed', id })
  })

  it('reports a signal death the way shells do (128 + signal) and a null code as null', async () => {
    const t = setup()
    const a = await t.service.create({ kind: 'shell' })
    t.fake.ptys[0]!.exit(0, 9)
    expect(t.service.get(a.id)).toMatchObject({ exitCode: 137 })
    const b = await t.service.create({ kind: 'shell' })
    t.fake.ptys[1]!.exit(null)
    expect(t.service.get(b.id)).toMatchObject({ exitCode: null })
  })

  it('tells the attached client about the exit and ends the connection', async () => {
    const t = setup()
    const { id } = await t.service.create({ kind: 'shell' })
    const sink = new RecordingSink()
    t.service.attach(id, sink)
    t.fake.last().exit(5)
    expect(sink.controls.at(-1)).toEqual({ type: 'exit', exitCode: 5 })
    expect(sink.ended).toEqual(['exited'])
    expect(t.service.isAttached(id)).toBe(false)
  })

  it('lets a late client attach to an exited terminal: replay, exit, end', async () => {
    const t = setup()
    const { id } = await t.service.create({ kind: 'shell' })
    out(t.fake.last(), 'last words')
    t.fake.last().exit(0)
    const sink = new RecordingSink()
    t.service.attach(id, sink)
    expect(sink.controls).toEqual([{ type: 'ready', replayBytes: 10 }, { type: 'exit', exitCode: 0 }])
    expect(sink.text).toBe('last words')
    expect(sink.ended).toEqual(['exited'])
    expect(t.service.isAttached(id)).toBe(false)
  })

  it('refuses to remove a running terminal, and ignores output after the exit', async () => {
    const t = setup()
    const { id } = await t.service.create({ kind: 'shell' })
    expect(() => t.service.remove(id)).toThrowError(/still running/)
    t.fake.last().exit(0)
    out(t.fake.last(), 'ghost')
    const sink = new RecordingSink()
    t.service.attach(id, sink)
    expect(sink.text).toBe('')
  })

  it('forgets the oldest exited terminals beyond the cap', async () => {
    const t = setup({ limits: { maxExitedKept: 2, maxTerminals: 8 } })
    const ids: string[] = []
    for (let i = 0; i < 4; i++) {
      ids.push((await t.service.create({ kind: 'shell' })).id)
      t.clock.advance(1000)
    }
    for (const p of t.fake.ptys) p.exit(0)
    expect(t.service.list().map((x) => x.id)).toEqual(ids.slice(2))
  })
})

describe('close and kill tree', () => {
  it('a user close kills the tree through the injected killer, forgets the entry and says so', async () => {
    const t = setup()
    const { id } = await t.service.create({ kind: 'shell' })
    const pid = t.fake.last().pid
    await t.service.close(id)
    expect(t.killer.terminated).toEqual([pid])
    expect(t.killer.forced).toEqual([])
    expect(t.service.list()).toHaveLength(0)
    expect(t.events.map((e) => e.type)).toEqual(['opened', 'closed', 'removed'])
    expect(t.events[1]).toMatchObject({ type: 'closed', reason: 'user' })
    expect(t.fake.last().killCalls).toBeGreaterThanOrEqual(1)
  })

  it('escalates to a forced tree kill when the process ignores the polite one', async () => {
    const t = setup({ killerMode: 'force' })
    const { id } = await t.service.create({ kind: 'shell' })
    t.fake.last().exitOnKill = undefined // ignores SIGHUP/kill()
    const pid = t.fake.last().pid
    await t.service.close(id)
    expect(t.killer.terminated).toEqual([pid])
    expect(t.killer.forced).toEqual([pid])
  })

  it('never leaves a running entry behind when the OS never reports an exit', async () => {
    const t = setup({ killerMode: 'never' })
    const { id } = await t.service.create({ kind: 'shell' })
    t.fake.last().exitOnKill = undefined
    await t.service.close(id, 'idle')
    expect(t.service.get(id)).toMatchObject({ state: 'exited', exitCode: null })
  })

  it('concurrent closes kill once', async () => {
    const t = setup()
    const { id } = await t.service.create({ kind: 'shell' })
    await Promise.all([t.service.close(id).catch(() => undefined), t.service.close(id).catch(() => undefined)])
    expect(t.killer.terminated).toHaveLength(1)
  })

  it('a user close that races an idle close waits for it and reports only one close', async () => {
    const t = setup({ limits: { idleTimeoutMs: 1000 } })
    const { id } = await t.service.create({ kind: 'shell' })
    t.clock.advance(2000)
    t.sweeps[0]!() // the idle close starts
    await t.service.close(id) // the user closes at the same moment
    await new Promise((r) => setTimeout(r, 10))
    expect(t.events.filter((e) => e.type === 'closed')).toEqual([expect.objectContaining({ reason: 'idle' })])
    expect(t.service.list()).toHaveLength(0)
    expect(t.killer.terminated).toHaveLength(1)
  })

  it('closing an exited terminal just removes it; an unknown id is a 404', async () => {
    const t = setup()
    const { id } = await t.service.create({ kind: 'shell' })
    t.fake.last().exit(0)
    await t.service.close(id)
    expect(t.killer.terminated).toHaveLength(0)
    expect(t.service.list()).toHaveLength(0)
    await expect(t.service.close('nope')).rejects.toMatchObject({ status: 404 })
  })

  it('notifies an attached client when its terminal is closed', async () => {
    const t = setup()
    const { id } = await t.service.create({ kind: 'shell' })
    const sink = new RecordingSink()
    t.service.attach(id, sink)
    await t.service.close(id)
    expect(sink.controls.at(-1)).toMatchObject({ type: 'exit' })
    expect(sink.ended).toEqual(['closed'])
  })

  it('closeAll("disabled") kills everything and empties the list', async () => {
    const t = setup()
    for (let i = 0; i < 3; i++) await t.service.create({ kind: 'shell' })
    await t.service.closeAll('disabled')
    expect(t.killer.terminated).toHaveLength(3)
    expect(t.service.list()).toHaveLength(0)
    expect(t.events.filter((e) => e.type === 'closed').every((e) => e.type === 'closed' && e.reason === 'disabled')).toBe(true)
  })

  it('shutdown kills every pty and its tree and refuses new terminals', async () => {
    const t = setup()
    await t.service.create({ kind: 'shell' })
    await t.service.create({ kind: 'claude' })
    const pids = t.fake.ptys.map((p) => p.pid)
    await t.service.shutdown()
    expect(t.killer.terminated.sort()).toEqual(pids.sort())
    expect(t.service.runningCount()).toBe(0)
    expect(t.service.list().every((x) => x.state === 'exited')).toBe(true)
    await expect(t.service.create({ kind: 'shell' })).rejects.toMatchObject({ status: 503, code: 'shutting_down' })
    expect(t.events.filter((e) => e.type === 'closed')).toHaveLength(2)
  })
})

describe('the last-resort kill', () => {
  it('killAllNow hard-kills every running tree synchronously and skips exited ones', async () => {
    const t = setup({ limits: { maxTerminals: 4 } })
    await t.service.create({ kind: 'shell' })
    await t.service.create({ kind: 'shell' })
    await t.service.create({ kind: 'shell' })
    t.fake.ptys[1]!.exit(0)
    t.service.killAllNow()
    expect(t.killer.forcedSync.sort()).toEqual([t.fake.ptys[0]!.pid, t.fake.ptys[2]!.pid].sort())
    expect(t.service.runningCount()).toBe(2) // nothing is awaited or updated: it is for a dying process
  })
})

describe('idle timeout', () => {
  it('closes a detached terminal after the idle time, never an attached one', async () => {
    const t = setup({ limits: { idleTimeoutMs: 60_000 } })
    const detached = await t.service.create({ kind: 'shell' })
    const attached = await t.service.create({ kind: 'shell' })
    t.service.attach(attached.id, new RecordingSink())
    t.clock.advance(59_000)
    t.sweeps[0]!()
    expect(t.service.runningCount()).toBe(2)
    t.clock.advance(2_000)
    t.sweeps[0]!()
    await new Promise((r) => setTimeout(r, 10))
    expect(t.service.get(detached.id)).toMatchObject({ state: 'exited' })
    expect(t.service.get(attached.id)).toMatchObject({ state: 'running' })
    expect(t.events).toContainEqual(expect.objectContaining({ type: 'closed', reason: 'idle' }))
  })

  it('the clock restarts when a client detaches or types, and on attach', async () => {
    const t = setup({ limits: { idleTimeoutMs: 60_000 } })
    const { id } = await t.service.create({ kind: 'shell' })
    t.clock.advance(50_000)
    const a = t.service.attach(id, new RecordingSink())
    t.clock.advance(3_600_000) // attached for an hour: never idle
    t.sweeps[0]!()
    expect(t.service.runningCount()).toBe(1)
    a.write(Buffer.from('x'))
    a.detach()
    t.clock.advance(59_000)
    t.sweeps[0]!()
    expect(t.service.runningCount()).toBe(1)
    t.clock.advance(2_000)
    t.sweeps[0]!()
    await new Promise((r) => setTimeout(r, 10))
    expect(t.service.runningCount()).toBe(0)
  })
})
