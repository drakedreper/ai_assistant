import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { createHostLauncher, createHostPtyFactory, hostArgs, type HostChild } from '../src/terminal/hostClient'
import { FrameDecoder, FrameType, HEADER_BYTES, MAX_DATA_FRAME, MAX_FRAME_BYTES, ProtocolError, encodeFrame, parseResize, parseSpawnRequest } from '../src/terminal/hostProtocol'
import { runPtyHost } from '../src/terminal/ptyHost'
import { PtyUnavailableError, type PtyFactory } from '../src/terminal/pty'
import { FakeKiller, FakePty, createFakePtyFactory } from '../src/terminal/testing'

/**
 * The PTY host protocol, the host process logic (run in-process on fake pipes and a fake PTY) and the daemon's client of it.
 * The real thing (a real child process with a real node-pty and real shells) is in terminal.pty.test.ts.
 */

async function until(cond: () => unknown, label: string, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('the frame codec', () => {
  it('round-trips every kind of payload', () => {
    const d = new FrameDecoder()
    const frames = d.push(Buffer.concat([encodeFrame(FrameType.write, 'héllo ✓'), encodeFrame(FrameType.data, Buffer.from([0, 255, 10])), encodeFrame(FrameType.resize, { cols: 80, rows: 24 }), encodeFrame(FrameType.kill)]))
    expect(frames.map((f) => f.type)).toEqual([FrameType.write, FrameType.data, FrameType.resize, FrameType.kill])
    expect(frames[0]!.payload.toString('utf8')).toBe('héllo ✓')
    expect([...frames[1]!.payload]).toEqual([0, 255, 10])
    expect(parseResize(frames[2]!.payload)).toEqual({ cols: 80, rows: 24 })
    expect(frames[3]!.payload.length).toBe(0)
  })

  it('reassembles frames from any chunking, down to one byte at a time', () => {
    const wire = Buffer.concat([encodeFrame(FrameType.data, Buffer.alloc(300, 7)), encodeFrame(FrameType.exit, { exitCode: 3 })])
    const d = new FrameDecoder()
    const got: number[] = []
    for (const b of wire) for (const f of d.push(Buffer.from([b]))) got.push(f.type)
    expect(got).toEqual([FrameType.data, FrameType.exit])
    expect(d.buffered).toBe(0)
    // and split exactly inside the header
    const d2 = new FrameDecoder()
    expect(d2.push(wire.subarray(0, 3))).toEqual([])
    expect(d2.buffered).toBe(3)
    expect(d2.push(wire.subarray(3)).map((f) => f.type)).toEqual([FrameType.data, FrameType.exit])
  })

  it('refuses an unknown type and an absurd length, and an encoder never produces one', () => {
    expect(() => new FrameDecoder().push(Buffer.from([0x55, 0, 0, 0, 0]))).toThrow(ProtocolError)
    const huge = Buffer.alloc(HEADER_BYTES)
    huge[0] = FrameType.data
    huge.writeUInt32BE(MAX_FRAME_BYTES + 1, 1)
    expect(() => new FrameDecoder().push(huge)).toThrow(ProtocolError)
    expect(() => encodeFrame(FrameType.data, Buffer.alloc(MAX_FRAME_BYTES + 1))).toThrow(ProtocolError)
  })

  it('validates a spawn request strictly: it is a command line the host will run', () => {
    const ok = { file: '/bin/sh', args: ['-l'], cwd: '/tmp', env: { A: 'b' }, cols: 80, rows: 24 }
    expect(parseSpawnRequest(Buffer.from(JSON.stringify(ok)))).toEqual(ok)
    expect(parseSpawnRequest(Buffer.from(JSON.stringify({ ...ok, args: 'cmd /c x', graceMs: 5 })))).toMatchObject({ args: 'cmd /c x', graceMs: 5 })
    const bad: unknown[] = [
      { ...ok, file: '' },
      { ...ok, file: 'a\0b' },
      { ...ok, args: [1] },
      { ...ok, args: ['a\0'] },
      { ...ok, cwd: '' },
      { ...ok, env: null },
      { ...ok, env: [] },
      { ...ok, env: { 'A=B': 'x' } },
      { ...ok, env: { A: 1 } },
      { ...ok, env: { A: 'x\0' } },
      { ...ok, cols: 0 },
      { ...ok, rows: 1.5 },
      { ...ok, cols: 100000 },
      { ...ok, graceMs: -1 },
      'not an object',
      [],
    ]
    for (const b of bad) expect(() => parseSpawnRequest(Buffer.from(JSON.stringify(b))), JSON.stringify(b).slice(0, 60)).toThrow(ProtocolError)
    expect(() => parseSpawnRequest(Buffer.from('{not json'))).toThrow(ProtocolError)
    expect(() => parseResize(Buffer.from('{"cols":0,"rows":5}'))).toThrow(ProtocolError)
  })
})

// ---------------------------------------------------------------- the host, in-process

interface HostRig {
  toHost: PassThrough
  fromHost: PassThrough
  fake: ReturnType<typeof createFakePtyFactory>
  killer: FakeKiller
  diags: string[]
  done: number[]
  frames: Array<{ type: number; payload: Buffer }>
  handle: ReturnType<typeof runPtyHost>
  send(type: Parameters<typeof encodeFrame>[0], payload?: Parameters<typeof encodeFrame>[1]): void
  spawn(over?: Record<string, unknown>): void
  json(type: number): Record<string, unknown>
  of(type: number): Buffer[]
}

function hostRig(o: { factory?: PtyFactory; killerMode?: 'terminate' | 'force' | 'never'; grace?: number } = {}): HostRig {
  const toHost = new PassThrough()
  const fromHost = new PassThrough()
  const fake = createFakePtyFactory(7100)
  const killer = new FakeKiller(() => fake.ptys, o.killerMode ?? 'terminate')
  const diags: string[] = []
  const done: number[] = []
  const frames: Array<{ type: number; payload: Buffer }> = []
  const dec = new FrameDecoder()
  fromHost.on('data', (c: Buffer) => frames.push(...dec.push(c)))
  const handle = runPtyHost({ input: toHost, output: fromHost, ptyFactory: o.factory ?? fake.factory, killer, defaultGraceMs: o.grace ?? 20, diag: (l) => void diags.push(l), onDone: (c) => void done.push(c) })
  const rig: HostRig = {
    toHost,
    fromHost,
    fake,
    killer,
    diags,
    done,
    frames,
    handle,
    send: (type, payload) => void toHost.write(encodeFrame(type, payload)),
    spawn: (over = {}) => rig.send(FrameType.spawn, { file: '/bin/sh', args: [], cwd: '/tmp', env: { A: '1' }, cols: 80, rows: 24, ...over }),
    json: (type) => JSON.parse((frames.find((f) => f.type === type) as { payload: Buffer }).payload.toString('utf8')) as Record<string, unknown>,
    of: (type) => frames.filter((f) => f.type === type).map((f) => f.payload),
  }
  return rig
}

describe('the PTY host process logic', () => {
  it('spawns, reports the pid, relays output in bounded frames, input, resize and kill, then reports the exit and finishes', async () => {
    const h = hostRig()
    h.spawn({ cols: 90, rows: 20 })
    await until(() => h.frames.some((f) => f.type === FrameType.spawned), 'the spawned frame')
    const pty = h.fake.last()
    expect(h.json(FrameType.spawned)).toEqual({ pid: pty.pid })
    expect(h.fake.specs[0]).toMatchObject({ file: '/bin/sh', cwd: '/tmp', cols: 90, rows: 20, env: { A: '1' } })

    pty.emit(Buffer.alloc(200 * 1024, 65))
    pty.emit('héllo')
    await until(() => h.of(FrameType.data).reduce((n, b) => n + b.length, 0) === 200 * 1024 + Buffer.byteLength('héllo'), 'all the output')
    expect(Math.max(...h.of(FrameType.data).map((b) => b.length))).toBeLessThanOrEqual(MAX_DATA_FRAME)

    h.send(FrameType.write, 'ls\r')
    h.send(FrameType.resize, { cols: 100, rows: 30 })
    await until(() => pty.written.length === 1 && pty.resizes.length === 1, 'input and resize')
    expect(pty.text).toBe('ls\r')
    expect(pty.resizes).toEqual([[100, 30]])

    h.send(FrameType.kill)
    await until(() => h.done.length === 1, 'the host to finish')
    expect(pty.killCalls).toBe(1)
    expect(h.json(FrameType.exit)).toEqual({ exitCode: 0 })
    expect(h.done).toEqual([0])
    expect(h.killer.terminated).toEqual([]) // a normal end needs no tree kill from the host: the daemon does that
  })

  it('reports a signal death and a null exit code', async () => {
    const h = hostRig()
    h.spawn()
    await until(() => h.fake.ptys.length === 1 && h.frames.length > 0, 'the spawn')
    h.fake.last().exit(null, 9)
    await until(() => h.done.length === 1, 'finish')
    expect(h.json(FrameType.exit)).toEqual({ exitCode: null, signal: 9 })
  })

  it('answers spawnFailed with unavailable=true when node-pty cannot load, and finishes with 1', async () => {
    const h = hostRig({ factory: () => Promise.reject(new PtyUnavailableError('addon missing')) })
    h.spawn()
    await until(() => h.done.length === 1, 'finish')
    expect(h.json(FrameType.spawnFailed)).toEqual({ message: 'addon missing', unavailable: true })
    expect(h.done).toEqual([1])
  })

  it('answers spawnFailed for any other failure, also one thrown synchronously, and cuts a long message', async () => {
    const h = hostRig({
      factory: () => {
        throw new Error('x'.repeat(1000))
      },
    })
    h.spawn()
    await until(() => h.done.length === 1, 'finish')
    const j = h.json(FrameType.spawnFailed)
    expect(j.unavailable).toBe(false)
    expect((j.message as string).length).toBe(300)
  })

  it('ends the whole tree and finishes when the daemon goes away (input ends): polite, hang up, sweep', async () => {
    const h = hostRig()
    h.spawn()
    await until(() => h.fake.ptys.length === 1 && h.frames.length > 0, 'the spawn')
    const pty = h.fake.last()
    h.toHost.end() // the daemon died: the kernel closed its end
    await until(() => h.done.length === 1, 'the host to finish')
    expect(h.killer.terminated).toEqual([pty.pid])
    expect(pty.killCalls).toBeGreaterThanOrEqual(1)
    expect(h.killer.reaped).toEqual([{ pid: pty.pid, graceMs: 20 }]) // the family sweep, even though the leader left
    expect(h.killer.forced).toEqual([])
  })

  it('kills hard after the grace when the program ignores the polite end, and uses the grace from the spawn frame', async () => {
    const h = hostRig({ killerMode: 'force', grace: 5000 })
    h.spawn({ graceMs: 15 })
    await until(() => h.fake.ptys.length === 1 && h.frames.length > 0, 'the spawn')
    const pty = h.fake.last()
    pty.exitOnKill = undefined // ignores SIGHUP
    h.toHost.end()
    await until(() => h.done.length === 1, 'the host to finish')
    expect(h.killer.terminated).toEqual([pty.pid])
    expect(h.killer.forced).toEqual([pty.pid])
    expect(h.killer.reaped[0]).toEqual({ pid: pty.pid, graceMs: 15 })
  })

  it('reports (without bytes) processes that could not be ended', async () => {
    const h = hostRig()
    h.killer.survivors = [9001, 9002]
    h.spawn()
    await until(() => h.fake.ptys.length === 1 && h.frames.length > 0, 'the spawn')
    h.toHost.end()
    await until(() => h.done.length === 1, 'finish')
    expect(h.diags.join('\n')).toMatch(/2 process\(es\) of the terminal could not be ended/)
  })

  it('a daemon that goes away while the program is still starting gets its tree ended as soon as it exists', async () => {
    let release!: () => void
    const fake = createFakePtyFactory(7200)
    const h = hostRig({
      factory: async (spec) => {
        await new Promise<void>((r) => (release = r))
        return fake.factory(spec)
      },
    })
    h.spawn()
    await until(() => release !== undefined, 'the spawn to be in flight')
    h.toHost.end()
    await new Promise((r) => setTimeout(r, 30))
    expect(h.done).toEqual([]) // still waiting for the spawn result
    release()
    await until(() => h.done.length === 1, 'finish')
    expect(h.killer.terminated).toEqual([fake.last().pid])
  })

  it('a daemon that goes away before any spawn simply finishes', async () => {
    const h = hostRig()
    h.toHost.end()
    await until(() => h.done.length === 1, 'finish')
    expect(h.done).toEqual([0])
    expect(h.killer.terminated).toEqual([])
  })

  it('treats garbage, an oversized frame, a second spawn and a frame only the host may send as a vanished daemon', async () => {
    for (const garbage of [Buffer.from([0x77, 0, 0, 0, 0]), (() => { const b = Buffer.alloc(5); b[0] = FrameType.write; b.writeUInt32BE(MAX_FRAME_BYTES + 1, 1); return b })(), encodeFrame(FrameType.data, 'x'), encodeFrame(FrameType.spawn, { file: '' })]) {
      const h = hostRig()
      h.spawn()
      await until(() => h.fake.ptys.length === 1 && h.frames.length > 0, 'the spawn')
      h.toHost.write(garbage)
      await until(() => h.done.length === 1, 'finish after garbage')
      expect(h.killer.terminated).toEqual([h.fake.last().pid])
    }
    const second = hostRig()
    second.spawn()
    await until(() => second.fake.ptys.length === 1 && second.frames.length > 0, 'the spawn')
    second.spawn() // a second spawn is a protocol violation
    await until(() => second.done.length === 1, 'finish after a second spawn')
    expect(second.fake.ptys).toHaveLength(1)
  })

  it('shutdown() (what SIGTERM does) is the same as the daemon going away', async () => {
    const h = hostRig()
    h.spawn()
    await until(() => h.fake.ptys.length === 1 && h.frames.length > 0, 'the spawn')
    h.handle.shutdown('SIGTERM')
    await until(() => h.done.length === 1, 'finish')
    expect(h.killer.terminated).toEqual([h.fake.last().pid])
  })

  it('stops reading the PTY while the daemon is not keeping up, and resumes when the pipe drains', async () => {
    const h = hostRig()
    h.spawn()
    await until(() => h.fake.ptys.length === 1 && h.frames.length > 0, 'the spawn')
    const pty = h.fake.last() as FakePty & { pause?: () => void; resume?: () => void }
    let paused = 0
    let resumed = 0
    pty.pause = () => void paused++
    pty.resume = () => void resumed++
    // a pipe that is full: write() says false
    const realWrite = h.fromHost.write.bind(h.fromHost)
    h.fromHost.write = ((chunk: Buffer) => (realWrite(chunk), false)) as typeof h.fromHost.write
    pty.emit('a')
    pty.emit('b')
    expect(paused).toBe(1) // once, however much arrives
    h.fromHost.emit('drain')
    expect(resumed).toBe(1)
  })

  it('does not crash on a write error to a vanished daemon', async () => {
    const h = hostRig()
    h.spawn()
    await until(() => h.fake.ptys.length === 1 && h.frames.length > 0, 'the spawn')
    h.fromHost.emit('error', Object.assign(new Error('EPIPE'), { code: 'EPIPE' }))
    h.fake.last().emit('still going')
    h.toHost.end()
    await until(() => h.done.length === 1, 'finish')
  })
})

// ---------------------------------------------------------------- the client, against the in-process host

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly killed: string[] = []
  constructor(readonly pid: number) {
    super()
  }
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killed.push(signal)
    queueMicrotask(() => this.emit('exit', null, signal))
    return true
  }
}

interface ClientRig {
  children: FakeChild[]
  lost: number[]
  hosts: ReturnType<typeof hostRig>[]
  factory: ReturnType<typeof createHostPtyFactory>
  spec: Parameters<PtyFactory>[0]
}

/** A client whose "host process" is runPtyHost in this process on the child's pipes. */
function clientRig(o: { startTimeoutMs?: number; connect?: boolean } = {}): ClientRig {
  const children: FakeChild[] = []
  const hosts: ClientRig['hosts'] = []
  const lost: number[] = []
  const factory = createHostPtyFactory({
    startTimeoutMs: o.startTimeoutMs ?? 2000,
    onLost: (pid) => void lost.push(pid),
    graceMs: 20,
    launch: () => {
      const child = new FakeChild(9100 + children.length)
      children.push(child)
      if (o.connect !== false) {
        const fake = createFakePtyFactory(7300 + children.length * 10)
        const killer = new FakeKiller(() => fake.ptys)
        const frames: Array<{ type: number; payload: Buffer }> = []
        const dec = new FrameDecoder()
        child.stdout.on('data', () => undefined)
        const handle = runPtyHost({
          input: child.stdin,
          output: child.stdout,
          ptyFactory: fake.factory,
          killer,
          defaultGraceMs: 20,
          onDone: (code) => queueMicrotask(() => child.emit('exit', code, null)),
        })
        hosts.push({ fake, killer, frames, handle, json: () => ({}), of: () => [], toHost: child.stdin, fromHost: child.stdout, diags: [], done: [], send: () => undefined, spawn: () => undefined })
        void dec
      }
      return child as unknown as HostChild
    },
  })
  return { children, lost, hosts, factory, spec: { file: '/bin/sh', args: [], cwd: '/tmp', env: { A: '1' }, cols: 80, rows: 24 } }
}

describe('the daemon-side host client', () => {
  it('hands back a PtyLike that really drives the program: pid, output as bytes, input, resize, kill, exit once', async () => {
    const r = clientRig()
    const pty = await r.factory.create(r.spec)
    const fake = r.hosts[0]!.fake
    expect(pty.pid).toBe(fake.last().pid)
    expect(r.factory.hostCount()).toBe(1)

    const chunks: Uint8Array[] = []
    pty.onData((d) => chunks.push(typeof d === 'string' ? Buffer.from(d) : d))
    fake.last().emit('abc')
    fake.last().emit(Buffer.from([0xc3, 0xa9]))
    await until(() => Buffer.concat(chunks).toString('utf8') === 'abcé', 'the output')
    expect(chunks.every((c) => c instanceof Uint8Array)).toBe(true)

    pty.write('ls -l\r')
    pty.resize(120, 40)
    await until(() => fake.last().text === 'ls -l\r' && fake.last().resizes.length === 1, 'input and resize')
    expect(fake.last().resizes).toEqual([[120, 40]])

    const exits: unknown[] = []
    pty.onExit((e) => void exits.push(e))
    pty.kill()
    await until(() => exits.length === 1, 'the exit')
    expect(exits).toEqual([{ exitCode: 0 }])
    await until(() => r.factory.hostCount() === 0, 'the host to be gone')
    expect(r.lost).toEqual([]) // a normal end is not a lost host
  })

  it('rejects with PtyUnavailableError when node-pty cannot be loaded in the host, and with a plain Error otherwise', async () => {
    const unavailable = createHostPtyFactory({
      launch: () => {
        const child = new FakeChild(9200)
        runPtyHost({ input: child.stdin, output: child.stdout, ptyFactory: () => Promise.reject(new PtyUnavailableError('nope')), killer: new FakeKiller(), onDone: (c) => queueMicrotask(() => child.emit('exit', c, null)) })
        return child as unknown as HostChild
      },
    })
    await expect(unavailable.create({ file: 'x', args: [], cwd: '/', env: {}, cols: 80, rows: 24 })).rejects.toBeInstanceOf(PtyUnavailableError)
    const plain = createHostPtyFactory({
      launch: () => {
        const child = new FakeChild(9201)
        runPtyHost({ input: child.stdin, output: child.stdout, ptyFactory: () => Promise.reject(new Error('chdir failed')), killer: new FakeKiller(), onDone: (c) => queueMicrotask(() => child.emit('exit', c, null)) })
        return child as unknown as HostChild
      },
    })
    const err = await Promise.resolve(plain.create({ file: 'x', args: [], cwd: '/', env: {}, cols: 80, rows: 24 })).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(PtyUnavailableError)
    expect((err as Error).message).toBe('chdir failed')
  })

  it('a host that vanishes while its program runs is reported as an exit with no code, once, and the daemon is told to reap', async () => {
    const r = clientRig()
    const pty = await r.factory.create(r.spec)
    const exits: unknown[] = []
    pty.onExit((e) => void exits.push(e))
    r.children[0]!.emit('exit', null, 'SIGKILL') // crashed or killed from outside
    r.children[0]!.emit('exit', null, 'SIGKILL')
    expect(exits).toEqual([{ exitCode: null }])
    expect(r.lost).toEqual([pty.pid])
    expect(() => pty.write('x')).toThrow(/gone/)
    expect(() => pty.resize(80, 24)).toThrow(/gone/)
    expect(() => pty.kill()).not.toThrow()
  })

  it('rejects when the host exits before the program started, when it never answers, and when it cannot even be launched', async () => {
    const early = clientRig({ connect: false })
    const p1 = early.factory.create(early.spec)
    early.children[0]!.emit('exit', 1, null)
    await expect(p1).rejects.toThrow(/exited before/)
    expect(early.factory.hostCount()).toBe(0)

    const silent = clientRig({ connect: false, startTimeoutMs: 30 })
    await expect(silent.factory.create(silent.spec)).rejects.toThrow(/did not start in time/)
    expect(silent.children[0]!.killed).toEqual(['SIGKILL'])

    const broken = createHostPtyFactory({
      launch: () => {
        throw new Error('spawn EAGAIN')
      },
    })
    await expect(broken.create({ file: 'x', args: [], cwd: '/', env: {}, cols: 80, rows: 24 })).rejects.toThrow(/could not be started/)

    const errored = clientRig({ connect: false })
    const p2 = errored.factory.create(errored.spec)
    errored.children[0]!.emit('error', new Error('ENOENT'))
    await expect(p2).rejects.toThrow(/could not be started/)
  })

  it('treats garbage from the host as a lost host: the host is killed and the program\'s family is the daemon\'s to end', async () => {
    const r = clientRig()
    const pty = await r.factory.create(r.spec)
    const exits: unknown[] = []
    pty.onExit((e) => void exits.push(e))
    r.children[0]!.stdout.write(Buffer.from([0x99, 0, 0, 0, 0]))
    await until(() => exits.length === 1, 'the exit')
    expect(r.children[0]!.killed).toContain('SIGKILL')
    expect(r.lost).toEqual([pty.pid])

    const r2 = clientRig({ connect: false })
    const p = r2.factory.create(r2.spec)
    r2.children[0]!.stdout.write(Buffer.from([0x99, 0, 0, 0, 0]))
    await expect(p).rejects.toThrow(/unexpected/)
  })

  it('shutdown waits for the hosts to leave and kills the ones that do not', async () => {
    const r = clientRig()
    const pty = await r.factory.create(r.spec)
    const stuck = clientRig({ connect: false })
    // a host that never answers its spawn would be rejected by its timeout; make one that did answer but will not leave
    expect(r.factory.hostCount()).toBe(1)
    pty.kill() // the program ends, the host leaves by itself
    await r.factory.shutdown(1000)
    expect(r.factory.hostCount()).toBe(0)
    expect(r.children[0]!.killed).toEqual([]) // nothing had to be killed

    const live = clientRig()
    await live.factory.create(live.spec)
    // the host will not exit by itself: make its pty ignore the kill frame and never finish
    live.hosts[0]!.fake.last().exitOnKill = undefined
    const t0 = Date.now()
    await live.factory.shutdown(60)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(55)
    expect(live.children[0]!.killed).toEqual(['SIGKILL'])
    void stuck
  })

  it('sends the grace period to the host and nothing but the three fields of the program', async () => {
    let sent: Buffer | undefined
    const factory = createHostPtyFactory({
      graceMs: 1234,
      launch: () => {
        const child = new FakeChild(9300)
        child.stdin.on('data', (b: Buffer) => (sent = b))
        return child as unknown as HostChild
      },
      startTimeoutMs: 20,
    })
    await Promise.resolve(factory.create({ file: '/bin/sh', args: ['-l'], cwd: '/tmp', env: { K: 'v' }, cols: 100, rows: 30 })).catch(() => undefined)
    const dec = new FrameDecoder().push(sent as Buffer)
    expect(dec[0]!.type).toBe(FrameType.spawn)
    expect(JSON.parse(dec[0]!.payload.toString('utf8'))).toEqual({ file: '/bin/sh', args: ['-l'], cwd: '/tmp', env: { K: 'v' }, cols: 100, rows: 30, graceMs: 1234 })
  })
})

describe('the client never drops what arrives before its listener is attached', () => {
  /** A host that answers the spawn frame with the given frames written in ONE chunk, as a busy pipe can deliver them. */
  function scripted(frames: Buffer[], opts: { exits?: boolean } = {}) {
    const children: FakeChild[] = []
    const lost: number[] = []
    const factory = createHostPtyFactory({
      lingerMs: 40,
      startTimeoutMs: 1000,
      onLost: (pid) => void lost.push(pid),
      launch: () => {
        const child = new FakeChild(9500 + children.length)
        children.push(child)
        child.stdin.once('data', () => {
          child.stdout.write(Buffer.concat(frames))
          if (opts.exits) queueMicrotask(() => child.emit('exit', 0, null))
        })
        return child as unknown as HostChild
      },
    })
    return { factory, children, lost }
  }
  const spec = { file: 'x', args: [], cwd: '/', env: {}, cols: 80, rows: 24 }

  it('the first output, delivered in the same read as `spawned`, still reaches the first listener (a prompt, a banner)', async () => {
    const r = scripted([encodeFrame(FrameType.spawned, { pid: 4242 }), encodeFrame(FrameType.data, 'FIRST-PROMPT$ '), encodeFrame(FrameType.data, 'more')])
    const pty = await r.factory.create(spec)
    await new Promise((res) => setTimeout(res, 10)) // the service attaches a moment after the factory resolved
    const got: string[] = []
    pty.onData((d) => void got.push(Buffer.from(d).toString('utf8')))
    expect(got).toEqual(['FIRST-PROMPT$ ', 'more'])
    pty.onData(() => undefined) // a second listener does not replay it
    expect(got).toHaveLength(2)
  })

  it('an exit that arrives before any listener is delivered to the first one, once', async () => {
    const r = scripted([encodeFrame(FrameType.spawned, { pid: 4343 }), encodeFrame(FrameType.data, 'bye'), encodeFrame(FrameType.exit, { exitCode: 7 })])
    const pty = await r.factory.create(spec)
    const exits: unknown[] = []
    const data: string[] = []
    pty.onData((d) => void data.push(Buffer.from(d).toString('utf8')))
    pty.onExit((e) => void exits.push(e))
    pty.onExit((e) => void exits.push(`second:${JSON.stringify(e)}`)) // a later listener is not told a second time
    expect(data).toEqual(['bye'])
    expect(exits).toEqual([{ exitCode: 7 }])
  })

  it('holds a bounded amount: a program that floods before anyone listens cannot fill the daemon', async () => {
    const big = Buffer.alloc(64 * 1024, 65)
    const r = scripted([encodeFrame(FrameType.spawned, { pid: 4444 }), ...Array.from({ length: 80 }, () => encodeFrame(FrameType.data, big))]) // 5 MiB
    const pty = await r.factory.create(spec)
    await new Promise((res) => setTimeout(res, 10))
    let bytes = 0
    pty.onData((d) => void (bytes += d.length))
    expect(bytes).toBeLessThanOrEqual(4 * 1024 * 1024)
    expect(bytes).toBeGreaterThan(0)
  })

  it('a host that reported its program\'s exit but does not leave is killed after the linger time, and one that leaves is left alone', async () => {
    const lingering = scripted([encodeFrame(FrameType.spawned, { pid: 4545 }), encodeFrame(FrameType.exit, { exitCode: 0 })])
    const pty = await lingering.factory.create(spec)
    pty.onExit(() => undefined)
    await new Promise((res) => setTimeout(res, 120))
    expect(lingering.children[0]!.killed).toEqual(['SIGKILL'])

    const polite = scripted([encodeFrame(FrameType.spawned, { pid: 4646 }), encodeFrame(FrameType.exit, { exitCode: 0 })], { exits: true })
    const p2 = await polite.factory.create(spec)
    p2.onExit(() => undefined)
    await new Promise((res) => setTimeout(res, 120))
    expect(polite.children[0]!.killed).toEqual([])
    expect(polite.lost).toEqual([])
  })

  it('a host that failed to start is not a lost program: nothing is reaped for pid 0', async () => {
    const r = scripted([encodeFrame(FrameType.spawnFailed, { message: 'chdir failed', unavailable: false })], { exits: true })
    await expect(r.factory.create(spec)).rejects.toThrow(/chdir failed/)
    await new Promise((res) => setTimeout(res, 20))
    expect(r.lost).toEqual([])
  })
})

describe('starting the real host process', () => {
  it('runs TypeScript through the absolute tsx loader, and plain JavaScript as it is', () => {
    expect(hostArgs('/x/ptyHost.ts', () => 'file:///loader.mjs')).toEqual(['--import', 'file:///loader.mjs', '/x/ptyHost.ts'])
    expect(hostArgs('/x/ptyHost.mts', () => 'file:///loader.mjs')).toEqual(['--import', 'file:///loader.mjs', '/x/ptyHost.mts'])
    expect(hostArgs('/x/ptyHost.js', () => { throw new Error('not needed') })).toEqual(['/x/ptyHost.js'])
  })

  it('spawns with three pipes, hidden on Windows, from a neutral folder, and with an environment free of every secret', () => {
    const calls: Array<{ file: string; args: readonly string[]; options: Record<string, unknown> }> = []
    const launch = createHostLauncher({
      env: { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-ant-planted', AI_ASSISTANT_HOOK_TOKEN: 'planted-hook', DAEMON_PORT: '1', STAGE_TOKEN: 'planted-stage', DATA_DIR: '/d', TERMINAL_MAX: '4', NODE_PATH: '/modules', NODE_OPTIONS: '--use-openssl-ca', HOME: '/home/x' },
      execPath: '/usr/bin/node',
      script: '/x/ptyHost.ts',
      loaderUrl: 'file:///tsx/loader.mjs',
      cwd: '/neutral',
      spawn: ((file: string, args: readonly string[], options: Record<string, unknown>) => {
        calls.push({ file, args, options })
        return new FakeChild(1) as never
      }) as never,
    })
    launch()
    const c = calls[0]!
    expect(c.file).toBe('/usr/bin/node')
    expect(c.args).toEqual(['--import', 'file:///tsx/loader.mjs', '/x/ptyHost.ts'])
    expect(c.options).toMatchObject({ cwd: '/neutral', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    expect(c.options).not.toHaveProperty('shell')
    expect(c.options).not.toHaveProperty('detached')
    const env = c.options.env as Record<string, string>
    expect(env).toMatchObject({ PATH: '/usr/bin', HOME: '/home/x', NODE_PATH: '/modules', NODE_OPTIONS: '--use-openssl-ca' }) // the host runs under the daemon's own loader setup
    for (const k of ['ANTHROPIC_API_KEY', 'AI_ASSISTANT_HOOK_TOKEN', 'DAEMON_PORT', 'STAGE_TOKEN', 'DATA_DIR', 'TERMINAL_MAX']) expect(env[k], k).toBeUndefined()
  })
})
