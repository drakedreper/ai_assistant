import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createBudgetGuard, createFakeBackend, createMockToolBindings, createSecretaryLane, type FakeBackend, type SecretaryLaneImpl } from '@ai-assistant/agent-core'
import {
  FakeFaceProvider,
  FakeTtsProvider,
  createMemoryTransportPair,
  createSimulatorStage,
  systemClock,
  systemTimers,
  type Clock,
  type MemoryPair,
  type SimulatorOptions,
  type SimulatorStage,
  type StageSession,
  type Timers,
} from '@ai-assistant/stage-core'
import { createDaemon, type Daemon } from '../app'
import { loadConfig, type DaemonConfig } from '../config'
import { createProjectResolver } from '../hooks/projects'
import { silentLogger } from '../log'
import { connectSimulator, type SimClient, type SimClientOptions } from './simClient'
import type { StageOverrides } from './feature'
import type { StageConnection } from './hub'
import type { StageHub } from './hub'

/**
 * Test helpers for the stage backend. NOT used by production code: they build a whole daemon around the REAL Secretary
 * lane (zero-token fake backend), real SQLite and the real stage hub, and connect the headless simulator either
 * in-process (a memory transport) or over a real WebSocket on an ephemeral loopback port.
 */

/** A hub accepted a simulator over a memory transport: no socket, no port. */
export interface InProcessStage {
  pair: MemoryPair
  sim: SimulatorStage
  conn: StageConnection
  session: StageSession
}

/** Connect a SimulatorStage to a hub in-process and wait for the hello. The hub must be enabled and have no connection. */
export async function connectInProcess(
  hub: StageHub,
  sim: Partial<Omit<SimulatorOptions, 'transport' | 'clock' | 'timers'>> = {},
  time: { clock?: Clock; timers?: Timers } = {},
): Promise<InProcessStage> {
  const pair = createMemoryTransportPair()
  const conn = hub.accept(pair.backend)
  const stage = createSimulatorStage({ transport: pair.stage, clock: time.clock ?? systemClock, timers: time.timers ?? systemTimers, ...sim })
  stage.start()
  await conn.session.ready()
  // the hub resumes the look right after the hello: wait until it has been delivered
  for (let i = 0; i < 100 && !conn.ready; i++) await new Promise((r) => setTimeout(r, 5))
  await hub.flush()
  return { pair, sim: stage, conn, session: conn.session }
}

export interface StageDaemonOptions {
  dataDir: string
  /** ':memory:' (default) or a file name inside dataDir (restart tests). */
  db?: ':memory:' | string
  config?: Partial<DaemonConfig>
  stage?: StageOverrides
  /** Start the HTTP server on an ephemeral port (default true; needed for the WebSocket). */
  listen?: boolean
}

export interface StageDaemon {
  daemon: Daemon
  lane: SecretaryLaneImpl
  /** The zero-token fake Claude backend: `backend.opened[0].tools` is what the lane handed to the model. */
  backend: FakeBackend
  hub: StageHub
  port: number
  dataDir: string
  cookie: string
  stageToken: string
  wsUrl: string
  /** A signed-in browser-like call through the in-process app. */
  call(path: string, init?: { method?: string; json?: unknown; headers?: Record<string, string>; cookie?: string | false; origin?: string | false }): Promise<Response>
  /** The headless simulator, connected over a real WebSocket with the stage token. */
  connect(opts?: Partial<SimClientOptions>): SimClient
  stop(): Promise<void>
}

/** A daemon with the real lane (fake Claude backend), the stage on, a fast tick and fast fake speech. */
export async function makeStageDaemon(o: StageDaemonOptions): Promise<StageDaemon> {
  mkdirSync(o.dataDir, { recursive: true })
  const base = loadConfig({ DATA_DIR: o.dataDir }, { platform: 'linux', homedir: '/home/test', exists: () => false, moduleDir: '/nowhere' })
  const config: DaemonConfig = {
    ...base,
    port: 0,
    dbFile: o.db && o.db !== ':memory:' ? join(o.dataDir, o.db) : ':memory:',
    logLevel: 'silent',
    stage: { ...base.stage, tickMs: 40, constructsEveryMs: 60, heartbeatMs: 60_000, ...(o.config?.stage ?? {}) },
    ...(({ stage: _s, ...rest }) => rest)(o.config ?? {}),
  }
  let lane!: SecretaryLaneImpl
  const backend = createFakeBackend()
  const budget = createBudgetGuard({ lanes: [{ lane: 'secretary', dailyBudgetUsd: 4 }, { lane: 'reader', dailyBudgetUsd: 1 }, { lane: 'voice', dailyBudgetUsd: 1 }], globalDailyCapUsd: 10 })
  const daemon = createDaemon({
    config,
    budget,
    log: silentLogger,
    lane: (ctx, { stageTools, memoryDigest }) => (lane = createSecretaryLane({ ...ctx, backend, tools: [...createMockToolBindings(), ...stageTools] }, { digest: memoryDigest })),
    resolver: createProjectResolver({ existsSync: () => false, readFileSync: () => '', isDirectory: () => false }),
    stage: { tts: new FakeTtsProvider({ mode: 'sine', msPerChar: 3, minMs: 120 }), face: new FakeFaceProvider(), ...(o.stage ?? {}) },
  })
  const info = o.listen === false ? undefined : await daemon.start()
  const port = info?.port ?? daemon.security.getPort()
  const { code } = daemon.security.issueExchangeCode()
  const exchange = await daemon.app.request('/api/auth/exchange', {
    method: 'POST',
    headers: { Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  })
  const cookie = (exchange.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
  const sd: StageDaemon = {
    daemon,
    lane,
    backend,
    hub: daemon.stage.hub,
    port,
    dataDir: o.dataDir,
    cookie,
    stageToken: daemon.security.stageToken(),
    wsUrl: `ws://127.0.0.1:${port}/ws/stage`,
    async call(path, init = {}) {
      const method = (init.method ?? (init.json !== undefined ? 'POST' : 'GET')).toUpperCase()
      const headers: Record<string, string> = { Host: `127.0.0.1:${port}`, ...(init.headers ?? {}) }
      const ck = init.cookie === undefined ? cookie : init.cookie
      if (ck) headers.Cookie = ck
      if (init.origin !== false && method !== 'GET') headers.Origin = init.origin ?? `http://127.0.0.1:${port}`
      let body: string | undefined
      if (init.json !== undefined) {
        body = JSON.stringify(init.json)
        headers['Content-Type'] = 'application/json'
      }
      return daemon.app.request(path, { method, headers, ...(body !== undefined ? { body } : {}) })
    },
    connect: (opts = {}) => connectSimulator({ url: `ws://127.0.0.1:${port}/ws/stage`, token: daemon.security.stageToken(), ...opts }),
    stop: () => daemon.stop(),
  }
  return sd
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Poll until `fn` returns something truthy (or throw after `timeoutMs`). */
export async function until<T>(label: string, fn: () => T | undefined | false | Promise<T | undefined | false>, timeoutMs = 8000, everyMs = 15): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - start > timeoutMs) throw new Error(`timed out after ${timeoutMs} ms waiting for: ${label}`)
    await sleep(everyMs)
  }
}
