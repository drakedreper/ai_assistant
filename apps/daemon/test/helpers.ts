import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Approval, BudgetGuard, ChatMessage, LaneId, LaneState, LaneStatus, SecretaryLane, ServerEvent, UserTurn } from '@ai-assistant/shared'
import { createDaemon, type CreateDaemonOptions, type Daemon, type LaneContext } from '../src/app'
import { loadConfig, type DaemonConfig } from '../src/config'
import type { FsLike } from '../src/hooks/projects'
import { createProjectResolver } from '../src/hooks/projects'
import type { Scheduler } from '../src/hooks/service'

export const T0 = Date.parse('2026-11-02T10:00:00.000Z')

export interface TestClock {
  fn: () => number
  now(): number
  advance(ms: number): void
}

export function makeClock(start = T0): TestClock {
  let t = start
  return { fn: () => t, now: () => t, advance: (ms) => void (t += ms) }
}

export function makeTmp(prefix = 'daemon-test-'): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

export function testConfig(dataDir: string, overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  const base = loadConfig({ DATA_DIR: dataDir }, { platform: 'linux', homedir: '/home/test', exists: () => false, moduleDir: '/nowhere' })
  return { ...base, port: 7421, dbFile: ':memory:', logLevel: 'silent', ...overrides }
}

/** A small in-test BudgetGuard (the real one lives in agent-core). */
export function createTestBudget(limits: Partial<Record<LaneId, number>> = {}, globalCap = 10): BudgetGuard {
  const spent: Record<LaneId, number> = { secretary: 0, reader: 0, voice: 0 }
  const daily: Record<LaneId, number> = { secretary: limits.secretary ?? 4, reader: limits.reader ?? 1, voice: limits.voice ?? 1 }
  return {
    check(lane) {
      return spent[lane] < daily[lane] ? { ok: true } : { ok: false, reason: `daily budget for ${lane} used up` }
    },
    record(lane, cost) {
      spent[lane] += cost
    },
    status() {
      const lanes = (Object.keys(daily) as LaneId[]).map((lane) => ({ lane, dailyBudgetUsd: daily[lane], spentTodayUsd: spent[lane] }))
      return { lanes, globalDailyCapUsd: globalCap, globalSpentTodayUsd: spent.secretary + spent.reader + spent.voice }
    },
  }
}

export interface FakeLaneOptions {
  /** Report a backend session id on start, like the real lane does once the SDK session exists. */
  backendSessionId?: string
  /** Whether the fake announces approval.resolved itself (the real lane normally does). */
  announceResolved?: boolean
  costPerTurn?: number
}

/**
 * A tiny SecretaryLane for the daemon tests. It behaves like the real one from the daemon's point of view:
 * persists chat through the LaneStore, emits chat events, and holds approvals until decideApproval.
 * "run: <cmd>" in a user message makes it ask for a tool permission.
 */
export class FakeLane implements SecretaryLane {
  state: LaneState = 'starting'
  error: string | undefined
  readonly sent: UserTurn[] = []
  interrupted = 0
  stopped = false
  failSend: Error | undefined
  readonly pending = new Map<string, Approval>()
  readonly decisions: Array<{ id: string; decision: 'approved' | 'denied' }> = []
  private readonly work: Promise<void>[] = []
  private n = 0

  constructor(
    readonly ctx: LaneContext,
    readonly opts: FakeLaneOptions = {},
  ) {}

  async start(): Promise<void> {
    this.state = 'ready'
    if (this.opts.backendSessionId) this.ctx.store.saveBackendSessionId('secretary', this.opts.backendSessionId)
  }

  async send(turn: UserTurn): Promise<void> {
    if (this.failSend) throw this.failSend
    this.sent.push(turn)
    const now = () => this.ctx.now().toISOString()
    const user: ChatMessage = { id: this.ctx.newId('u'), role: 'user', createdAt: now(), modality: turn.modality, parts: [{ type: 'text', text: turn.text }] }
    this.ctx.store.upsertChat(user)
    this.ctx.emit({ type: 'chat.message', message: user })
    this.work.push(this.reply(turn))
  }

  private async reply(turn: UserTurn): Promise<void> {
    await Promise.resolve()
    const id = this.ctx.newId('a')
    const msg: ChatMessage = { id, role: 'assistant', createdAt: this.ctx.now().toISOString(), modality: 'text', parts: [{ type: 'text', text: '', emotion: 'happy' }] }
    this.ctx.emit({ type: 'chat.message', message: structuredClone(msg) })
    const words = `You said: ${turn.text.slice(0, 40)}`.split(' ')
    let text = ''
    for (const w of words) {
      const chunk = `${w} `
      text += chunk
      this.ctx.emit({ type: 'chat.delta', messageId: id, text: chunk })
    }
    msg.parts = [{ type: 'text', text: text.trim(), emotion: 'happy' }]
    this.ctx.store.upsertChat(msg)
    if (turn.text.startsWith('run:')) {
      const approval: Approval = {
        id: `ap-lane-${++this.n}`,
        kind: 'tool_permission',
        title: 'Mira wants to run a command',
        detail: 'The Secretary lane asks to use a tool.',
        requestedAt: this.ctx.now().toISOString(),
        status: 'pending',
        risk: 'medium',
        tier: 'T4',
        preview: turn.text.slice(4).trim(),
        area: 'work',
      }
      this.pending.set(approval.id, approval)
      this.ctx.store.saveApproval(approval)
      this.ctx.emit({ type: 'approval.new', approval: structuredClone(approval) })
    }
    this.ctx.budget.record('secretary', this.opts.costPerTurn ?? 0.02)
    this.ctx.emit({ type: 'chat.done', messageId: id })
  }

  async interrupt(): Promise<void> {
    this.interrupted++
  }

  decideApproval(id: string, decision: 'approved' | 'denied'): boolean {
    const a = this.pending.get(id)
    if (!a) return false
    this.pending.delete(id)
    this.decisions.push({ id, decision })
    this.ctx.store.setApprovalStatus(id, decision)
    if (this.opts.announceResolved !== false) this.ctx.emit({ type: 'approval.resolved', id, status: decision })
    return true
  }

  status(): LaneStatus {
    return { state: this.state, backend: 'sdk', ...(this.error ? { error: this.error } : {}) }
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.state = 'stopped'
  }

  async settle(): Promise<void> {
    await Promise.all(this.work)
  }
}

export interface TestDaemonOptions {
  demo?: boolean
  config?: Partial<DaemonConfig>
  laneOptions?: FakeLaneOptions
  dataDir?: string
  budget?: BudgetGuard
  clock?: TestClock
  fs?: FsLike
  scheduler?: Scheduler
  projection?: CreateDaemonOptions['projection']
  /** Sign the test browser in (default true). */
  signIn?: boolean
  /** Keep the data dir on cleanup (used by restart tests that build a second daemon on the same files). */
  keepDir?: boolean
}

export interface CallInit {
  method?: string
  json?: unknown
  body?: string
  headers?: Record<string, string>
  /** Cookie header: default is the signed-in session; false sends none. */
  cookie?: string | false
  /** Origin header: default is the daemon's own origin for non-GET requests, none for GET; false sends none. */
  origin?: string | false
  /** Host header: default 127.0.0.1:PORT; false sends none. */
  host?: string | false
  contentType?: string | false
}

export interface TestDaemon {
  daemon: Daemon
  lane: FakeLane
  clock: TestClock
  dataDir: string
  port: number
  events: ServerEvent[]
  call(path: string, init?: CallInit): Promise<Response>
  hook(event: string, payload: unknown, opts?: { token?: string | false; raw?: string; headers?: Record<string, string> }): Promise<Response>
  /** Send a hook and wait until it has been projected. */
  hookAndDrain(event: string, payload: unknown): Promise<void>
  signIn(): Promise<string>
  cookie: string | undefined
  cleanup(): Promise<void>
}

export async function makeDaemon(opts: TestDaemonOptions = {}): Promise<TestDaemon> {
  const tmp = opts.dataDir ? { dir: opts.dataDir, cleanup: () => {} } : makeTmp()
  const clock = opts.clock ?? makeClock()
  const config = testConfig(tmp.dir, { demo: opts.demo ?? false, ...opts.config })
  let lane!: FakeLane
  const daemon = createDaemon({
    config,
    budget: opts.budget ?? createTestBudget(),
    clock: clock.fn,
    lane: (ctx) => (lane = new FakeLane(ctx, opts.laneOptions)),
    resolver: createProjectResolver(opts.fs ?? { existsSync: () => false, readFileSync: () => '', isDirectory: () => false }),
    ...(opts.scheduler ? { scheduler: opts.scheduler } : {}),
    ...(opts.projection ? { projection: opts.projection } : {}),
  })
  const events: ServerEvent[] = []
  daemon.bus.subscribe((e) => void events.push(e))
  await lane.start()

  const port = config.port
  const td: TestDaemon = {
    daemon,
    lane,
    clock,
    dataDir: tmp.dir,
    port,
    events,
    cookie: undefined,

    async call(path, init = {}) {
      const method = (init.method ?? (init.json !== undefined || init.body !== undefined ? 'POST' : 'GET')).toUpperCase()
      const headers: Record<string, string> = { ...init.headers }
      const p = daemon.security.getPort()
      if (init.host !== false) headers.Host = init.host ?? `127.0.0.1:${p}`
      const cookie = init.cookie === undefined ? td.cookie : init.cookie
      if (cookie) headers.Cookie = cookie
      const safe = method === 'GET' || method === 'HEAD'
      if (init.origin !== false) {
        const origin = init.origin ?? (safe ? undefined : `http://127.0.0.1:${p}`)
        if (origin) headers.Origin = origin
      }
      let body: string | undefined = init.body
      if (init.json !== undefined) {
        body = JSON.stringify(init.json)
        if (init.contentType !== false) headers['Content-Type'] = init.contentType ?? 'application/json'
      } else if (body !== undefined && init.contentType !== false && init.contentType !== undefined) {
        headers['Content-Type'] = init.contentType
      }
      return daemon.app.request(path, { method, headers, ...(body !== undefined ? { body } : {}) })
    },

    async hook(event, payload, o = {}) {
      const headers: Record<string, string> = { Host: `127.0.0.1:${daemon.security.getPort()}`, 'Content-Type': 'application/json', ...o.headers }
      if (o.token !== false) headers.Authorization = `Bearer ${o.token ?? daemon.security.hookToken()}`
      return daemon.app.request(`/hooks/${event}`, { method: 'POST', headers, body: o.raw ?? JSON.stringify(payload) })
    },

    async hookAndDrain(event, payload) {
      const res = await td.hook(event, payload)
      if (res.status !== 200) throw new Error(`hook ${event} returned ${res.status}`)
      await daemon.ctx.hooks.drain()
    },

    async signIn() {
      const { code } = daemon.security.issueExchangeCode()
      const res = await td.call('/api/auth/exchange', { json: { code }, cookie: false })
      if (res.status !== 200) throw new Error(`sign-in failed: ${res.status}`)
      const set = res.headers.get('set-cookie') ?? ''
      td.cookie = set.split(';')[0]
      return td.cookie ?? ''
    },

    async cleanup() {
      await daemon.stop()
      if (!opts.keepDir) tmp.cleanup()
    },
  }
  if (opts.signIn !== false) await td.signIn()
  return td
}

export async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T
}

/** Realistic Claude Code hook payloads (field names from docs/research; shapes not verified against a live client). */
export const payloads = {
  sid: 'sess-0001',
  base(sessionId: string, event: string, extra: Record<string, unknown> = {}) {
    return {
      session_id: sessionId,
      transcript_path: `C:\\Users\\you\\.claude\\projects\\C--dev-atlas\\${sessionId}.jsonl`,
      cwd: 'C:\\dev\\atlas',
      permission_mode: 'default',
      hook_event_name: event,
      ...extra,
    }
  },
}
