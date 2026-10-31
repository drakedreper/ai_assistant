import { request as httpRequest } from 'node:http'
import type { ServerEvent } from '@ai-assistant/shared'
import { createDaemon, type Daemon } from '../src/app'
import type { TerminalConfig } from '../src/config'
import { createProjectResolver } from '../src/hooks/projects'
import { createLogger } from '../src/log'
import { FakeKiller, MemoryFs, createFakePtyFactory, type FakePtyFactory } from '../src/terminal/testing'
import { FakeLane, createTestBudget, makeClock, makeTmp, testConfig, type TestClock } from './helpers'

/** A daemon with the terminal feature on a fake PTY and an in-memory file system. Test support only. */

export interface TerminalHarnessOptions {
  limits?: Partial<TerminalConfig>
  /** Listen on a real loopback port (needed for WebSocket tests). */
  listen?: boolean
  /** Switch terminals on after sign-in (default true). */
  enable?: boolean
  dbFile?: string
  dataDir?: string
  env?: Record<string, string>
  heartbeatMs?: number
  projects?: boolean
  /**
   * Use the REAL node-pty, tree killer and file system (Linux sandbox tests). `home` is the folder terminals start
   * in by default; `projectRoot` is registered as the project "p-atlas". Nothing is faked except the lane.
   */
  real?: { home: string; projectRoot: string }
}

export interface CallInit {
  method?: string
  json?: unknown
  body?: string
  headers?: Record<string, string>
  cookie?: string | false
  origin?: string | false
  host?: string | false
  contentType?: string | false
}

export interface TerminalHarness {
  daemon: Daemon
  fake: FakePtyFactory
  killer: FakeKiller
  fs: MemoryFs
  clock: TestClock
  dataDir: string
  events: ServerEvent[]
  logs: string[]
  cookie: string
  port: number
  origin: string
  call(path: string, init?: CallInit): Promise<Response>
  /** Create a terminal through the API and return its info. */
  create(body?: Record<string, unknown>): Promise<{ id: string; [k: string]: unknown }>
  ticket(id: string): Promise<string>
  setEnabled(on: boolean): Promise<Response>
  cleanup(): Promise<void>
}

export async function makeTerminalHarness(opts: TerminalHarnessOptions = {}): Promise<TerminalHarness> {
  const tmp = opts.dataDir ? { dir: opts.dataDir, cleanup: () => undefined } : makeTmp('term-daemon-')
  const clock = makeClock()
  const base = testConfig(tmp.dir)
  const config = testConfig(tmp.dir, {
    port: 0,
    ...(opts.dbFile ? { dbFile: opts.dbFile } : {}),
    terminals: { ...base.terminals, killGraceMs: 20, scrollbackBytes: 4096, authTimeoutMs: 400, ...opts.limits },
  })
  const fake = createFakePtyFactory()
  const killer = new FakeKiller(() => fake.ptys)
  const fs = new MemoryFs('linux').addDir('/home/ana').addDir('/home/ana/proj').addDir('/home/ana/proj/src').addDir('/etc').addFile('/bin/sh').addFile('/usr/bin/claude')
  const logs: string[] = []
  const log = createLogger({ level: 'debug', sink: (l) => void logs.push(l) })

  const daemon = createDaemon({
    config,
    budget: createTestBudget(),
    clock: clock.fn,
    log,
    lane: (ctx) => new FakeLane(ctx),
    resolver: createProjectResolver({ existsSync: () => false, readFileSync: () => '', isDirectory: () => false }),
    terminals: opts.real
      ? { home: opts.real.home, ...(opts.heartbeatMs ? { heartbeatMs: opts.heartbeatMs } : {}) }
      : {
          ptyFactory: fake.factory,
          killer,
          platform: 'linux',
          env: () => ({ PATH: '/usr/bin', SHELL: '/bin/sh', ...opts.env }),
          home: '/home/ana',
          cwdFs: fs,
          launchFs: fs,
          ...(opts.heartbeatMs ? { heartbeatMs: opts.heartbeatMs } : {}),
        },
  })
  const events: ServerEvent[] = []
  daemon.bus.subscribe((e) => void events.push(e))
  if (opts.projects !== false) {
    daemon.store.upsertProject({ id: 'p-atlas', name: 'Atlas', rootPath: opts.real?.projectRoot ?? '/home/ana/proj', status: 'active', tags: [], color: '#2dd4bf' })
  }

  let port = config.port
  let origin = `http://127.0.0.1:${port}`
  if (opts.listen) {
    const info = await daemon.start()
    port = info.port
    origin = `http://127.0.0.1:${port}`
  }

  const h: TerminalHarness = {
    daemon,
    fake,
    killer,
    fs,
    clock,
    dataDir: tmp.dir,
    events,
    logs,
    cookie: '',
    port,
    origin,

    async call(path, init = {}) {
      const method = (init.method ?? (init.json !== undefined || init.body !== undefined ? 'POST' : 'GET')).toUpperCase()
      const headers: Record<string, string> = { ...init.headers }
      const p = daemon.security.getPort()
      if (init.host !== false) headers.Host = init.host ?? `127.0.0.1:${p}`
      const cookie = init.cookie === undefined ? h.cookie : init.cookie
      if (cookie) headers.Cookie = cookie
      const safe = method === 'GET' || method === 'HEAD'
      if (init.origin !== false) {
        const o = init.origin ?? (safe ? undefined : `http://127.0.0.1:${p}`)
        if (o) headers.Origin = o
      }
      let body = init.body
      if (init.json !== undefined) {
        body = JSON.stringify(init.json)
        if (init.contentType !== false) headers['Content-Type'] = init.contentType ?? 'application/json'
      } else if (body !== undefined && init.contentType) {
        headers['Content-Type'] = init.contentType
      }
      return daemon.app.request(path, { method, headers, ...(body !== undefined ? { body } : {}) })
    },

    async create(body = { kind: 'shell' }) {
      const res = await h.call('/api/terminals', { json: body })
      if (res.status !== 201) throw new Error(`create answered ${res.status}: ${await res.text()}`)
      return (await res.json()) as { id: string }
    },

    async ticket(id) {
      const res = await h.call(`/api/terminals/${encodeURIComponent(id)}/ticket`, { method: 'POST' })
      if (res.status !== 200) throw new Error(`ticket answered ${res.status}`)
      return ((await res.json()) as { ticket: string }).ticket
    },

    setEnabled: (on) => h.call('/api/settings/terminals', { method: 'PUT', json: { on } }),

    async cleanup() {
      await daemon.stop()
      tmp.cleanup()
    },
  }

  // Sign in the way a browser does.
  const { code } = daemon.security.issueExchangeCode()
  if (opts.listen) {
    const res = await rawHttp(port, 'POST', '/api/auth/exchange', { code }, { Origin: origin })
    if (res.status !== 200) throw new Error(`sign-in failed: ${res.status}`)
    h.cookie = String(res.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? ''
  } else {
    const res = await h.call('/api/auth/exchange', { json: { code }, cookie: false })
    if (res.status !== 200) throw new Error(`sign-in failed: ${res.status}`)
    h.cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
  }
  if (opts.enable !== false) {
    const r = await h.setEnabled(true)
    if (r.status !== 200) throw new Error(`enable answered ${r.status}`)
  }
  return h
}

export function rawHttp(
  port: number,
  method: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: Record<string, string[] | string | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers: { ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}), ...headers } }, (res) => {
      let data = ''
      res.on('data', (c) => (data += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers as Record<string, string[] | string | undefined>, body: data }))
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}
