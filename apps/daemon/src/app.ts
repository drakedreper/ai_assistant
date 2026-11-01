import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { createAdaptorServer } from '@hono/node-server'
import { Hono } from 'hono'
import type { BudgetGuard, ChatMessage, LaneDeps, LaneId, SecretaryLane, ToolBinding } from '@ai-assistant/shared'
import { EventBus } from './bus'
import { Commands } from './commands'
import type { DaemonConfig } from './config'
import type { DaemonContext } from './context'
import { resetDemoDb, seedDemo } from './demo'
import { HookProjection, DEFAULT_PROJECTION_CONFIG } from './hooks/projection'
import { createProjectResolver, type ProjectResolver } from './hooks/projects'
import { HookService, type Scheduler } from './hooks/service'
import { guards, securityHeaders } from './http/guards'
import { createIdGen, type IdGen } from './ids'
import { createLogger, type Logger } from './log'
import { hideTerminals, registerRoutes } from './routes'
import { createSecurity, ensurePrivateDir, ensurePrivateFile, hardenDbFiles, type Security } from './security'
import { LANE_DEFAULTS, SnapshotBuilder } from './snapshot'
import { createStageFeature, type StageFeature, type StageOverrides } from './stage/feature'
import { createStaticHandler } from './static'
import { createTerminalFeature, type TerminalFeature, type TerminalOverrides } from './terminal/mount'
import { createLaneStore, createRecordingBudget, hydrateBudget, openStore, type Store } from './store'
import { attachWebSocket, type WsHub } from './ws'

/** What a lane needs from the daemon: LaneDeps minus the parts the composition root chooses (backend, tools). */
export type LaneContext = Omit<LaneDeps, 'backend' | 'tools'>

/** Extra things the lane factory may use that are not part of LaneDeps: the stage tools (STAGE_TOOL_SURFACE) to merge into the lane's tools. */
export interface LaneExtras {
  stageTools: ToolBinding[]
  /**
   * What she remembers about the two of them, for the persona prompt (`LaneOptions.digest`). CLOUD audience: private and
   * sensitive memories are left out (docs/PRIVACY.md). Undefined while the stage backend is off or nothing is remembered.
   */
  memoryDigest: () => string | undefined
}

export interface CreateDaemonOptions {
  config: DaemonConfig
  /** The lane, or a factory that receives the daemon-owned seams (emit, SQLite LaneStore, budget) and the stage tools to merge in. */
  lane: SecretaryLane | ((ctx: LaneContext, extras: LaneExtras) => SecretaryLane)
  /** The underlying BudgetGuard (agent-core's createBudgetGuard). The daemon wraps it to persist spend. */
  budget: BudgetGuard
  /** Inject an already-open store (tests). The daemon only closes stores it opened itself. */
  store?: Store
  log?: Logger
  /** Epoch milliseconds. Injected in tests. */
  clock?: () => number
  /** Timers for the staleness sweep. Injected in tests. */
  scheduler?: Scheduler
  resolver?: ProjectResolver
  newId?: IdGen
  /** Hook staleness thresholds etc. Defaults come from the config. */
  projection?: Partial<typeof DEFAULT_PROJECTION_CONFIG>
  /** Embedded terminals: replace the PTY factory, tree killer, platform or file system (tests). */
  terminals?: TerminalOverrides
  /** The stage backend: replace the TTS, the face provider, the timers, the RNG or the brain notes (tests, real engines later). */
  stage?: StageOverrides
}

export interface StartInfo {
  port: number
  url: string
  /** One-time sign-in link (printed once at startup). Its #fragment carries the terminal proof: never send it anywhere. */
  exchangeUrl: string
  code: string
}

export interface Daemon {
  readonly app: Hono
  readonly ctx: DaemonContext
  readonly bus: EventBus
  readonly store: Store
  readonly security: Security
  readonly lane: SecretaryLane
  readonly commands: Commands
  /** The embedded terminals (off until the user switches them on in Settings). */
  readonly terminals: TerminalFeature
  /** The live 3D assistant backend: characters, wardrobe, scene, mood, behaviour and the stage socket (on by default). */
  readonly stage: StageFeature
  /** Listen on 127.0.0.1 (config.port, 0 for an ephemeral port), attach the WebSocket hub, start the lane. */
  start(): Promise<StartInfo>
  /** Graceful shutdown: interrupt and stop the lane, stop timers, close sockets, drain hooks, close the DB. */
  stop(): Promise<void>
  address(): AddressInfo | undefined
}

const GREETING_ID = 'c-greeting'

/**
 * The composition root. Builds the store, bus, security, hook projection, snapshot builder and routes around an
 * injected Secretary lane, so the whole daemon can be exercised with a fake lane and zero tokens.
 */
export function createDaemon(opts: CreateDaemonOptions): Daemon {
  const { config } = opts
  const clock = opts.clock ?? Date.now
  const now = () => new Date(clock())
  const newId = opts.newId ?? createIdGen(clock)

  const ownsStore = !opts.store
  if (!opts.store && config.demo) resetDemoDb(config.dbFile)
  // The data folder is private (POSIX: 0700) and the database files 0600: chat text, tasks and the audit log live there.
  // The empty database file is created first with the right mode, so SQLite gives its -wal and -shm files the same one.
  if (!opts.store && config.dbFile !== ':memory:') {
    ensurePrivateDir(config.dataDir)
    ensurePrivateFile(config.dbFile)
  }
  const store = opts.store ?? openStore({ file: config.dbFile })
  if (!opts.store) hardenDbFiles(config.dbFile)
  // Nothing is mid-turn when a daemon starts, so a pending approval that holds private text (what she wanted to remember) belongs
  // to a turn that died with the previous process. It can never be answered: close it and drop the sentence. (The boot-time loop
  // further down closes every other pending lane approval, but only flips its status, and only looks at the newest 500.)
  store.closeOrphanedPrivateApprovals(new Date(clock()).toISOString())

  const security = createSecurity({
    dataDir: config.dataDir,
    port: config.port,
    devOrigins: config.allowedDevOrigins,
    exchangeCodeTtlMs: config.exchangeCodeTtlMs,
    sessionTtlMs: config.sessionTtlMs,
    now: clock,
  })
  // Exact secrets the daemon holds; every log line and stored summary is masked against them: the hook and stage tokens,
  // the pending sign-in code, the session tokens issued by this run and the API key. main.ts does NOT inject its own
  // logger any more (the one it used knew only the API key): this is the logger of the daemon.
  const literals = () => [...security.secretLiterals(), ...(config.apiKey ? [config.apiKey] : [])]
  const log = opts.log ?? createLogger({ level: config.logLevel, literals })

  const bus = new EventBus({ bufferSize: config.busBufferSize, now })

  const protectedIds = config.demo ? seedDemo(store, now()) : undefined

  // Spend: replay today's persisted usage into the guard, then wrap it so new spend is persisted.
  hydrateBudget(opts.budget, store, now())
  const budget = createRecordingBudget(opts.budget, store, {
    now,
    laneModels: Object.fromEntries((Object.keys(LANE_DEFAULTS) as LaneId[]).map((id) => [id, LANE_DEFAULTS[id].model])) as Record<LaneId, string>,
  })

  let lane: SecretaryLane | undefined
  let commands: Commands | undefined
  let wsHub: WsHub | undefined
  let server: Server | undefined
  let terminals: TerminalFeature | undefined
  let stage: StageFeature | undefined
  let unsubscribeRevoked: (() => void) | undefined

  const snapshots = new SnapshotBuilder({ config, store, bus, budget, lane: () => lane, now, terminals: () => terminals, stage: () => stage })

  const announceReset = (): void => {
    bus.publishLazy((seq) => ({ type: 'snapshot.reset', snapshot: { ...snapshots.build(), seq } }))
  }

  const projection = new HookProjection({
    store,
    publish: (d) => void bus.publish(d),
    announceProjectsChanged: announceReset,
    resolver: opts.resolver ?? createProjectResolver(),
    clock,
    newId,
    config: {
      ...DEFAULT_PROJECTION_CONFIG,
      staleRunningMs: config.staleRunningMs,
      staleIdleMs: config.staleIdleMs,
      retentionMs: config.retentionDays * 24 * 3_600_000,
      ...opts.projection,
    },
    literals,
    log,
    ...(protectedIds ? { protectedIds } : {}),
  })

  const hooks = new HookService({
    store,
    projection,
    clock,
    log,
    literals,
    sweepIntervalMs: config.sweepIntervalMs,
    ...(opts.scheduler ? { scheduler: opts.scheduler } : {}),
  })

  // The lane reports its backend session id; hook events of that session are then dropped, and a session that was
  // projected a moment too early (SessionStart can beat the lane's own report) is removed again.
  const onOwnedSession = (sessionId: string): void => {
    if (projection.dropSession(sessionId)) announceReset()
  }

  const laneStore = createLaneStore(store, { now, newId, onOwnedSession })
  const laneCtx: LaneContext = {
    store: laneStore,
    budget,
    getPersona: () => snapshots.persona(),
    getClaude: () => snapshots.claude(),
    emit(draft) {
      bus.publish(draft)
      // Spend changes when a turn ends: refresh the Settings chip.
      if (draft.type === 'chat.done') queueMicrotask(() => commands?.publishSettings())
    },
    now,
    newId,
    cwd: join(config.dataDir, 'agent'),
    env: { ...(config.apiKey ? { apiKey: config.apiKey } : {}), ...(config.claudeExecutable ? { claudeExecutable: config.claudeExecutable } : {}) },
  }
  // The stage backend exists before the lane: its tools are merged into the lane's tools by the lane factory, and it
  // listens to the same bus the lane publishes on (chat, avatar, approvals).
  stage = createStageFeature({
    config,
    store,
    bus,
    security,
    log,
    now,
    clock,
    newId,
    persona: () => snapshots.persona(),
    // Forgetting something she remembered also ends the old Claude conversation (it holds what she wrote down).
    onMemoryForgotten: () => void lane?.startFresh().catch(() => undefined),
    ...(opts.stage ? { overrides: opts.stage } : {}),
  })
  const theLane: SecretaryLane = typeof opts.lane === 'function' ? opts.lane(laneCtx, { stageTools: stage.toolBindings(), memoryDigest: () => stage?.hub.memoryDigest() }) : opts.lane
  lane = theLane

  const ctx: DaemonContext = {
    config,
    store,
    bus,
    security,
    log,
    now,
    clock,
    newId,
    lane: theLane,
    budget,
    projection,
    hooks,
    snapshots,
    ws: () => wsHub,
    startedAt: clock(),
    announceReset,
  }
  commands = new Commands(ctx)
  commands.onInterrupt = () => void stage?.hub.bargeIn()
  terminals = createTerminalFeature({
    config,
    store,
    security,
    bus,
    log,
    now,
    clock,
    newId,
    settings: () => snapshots.settings(),
    announceReset,
    ...(opts.terminals ? { overrides: opts.terminals } : {}),
  })

  // ---------------------------------------------------------------- boot-time state
  // A pending approval from a previous run belongs to a Claude turn that no longer exists: close it.
  for (const a of store.listApprovals(500)) {
    if (a.status === 'pending' && store.getApproval(a.id)?.origin === 'lane') store.setApprovalStatus(a.id, 'denied', now().toISOString())
  }
  if (store.countChat() === 0) {
    const persona = snapshots.persona()
    const greeting: ChatMessage = {
      id: GREETING_ID,
      role: 'assistant',
      createdAt: now().toISOString(),
      modality: 'text',
      parts: [
        {
          type: 'text',
          emotion: 'happy',
          text:
            config.backend === 'fake'
              ? `Hi, I'm ${persona.name}. I'm running on the zero-token stand-in right now, so my replies are scripted. Everything else you see here is wired up for real.`
              : `Hi, I'm ${persona.name}. I'm up and running on your PC. What shall we work on?`,
        },
      ],
    }
    store.upsertChat(greeting)
  }

  // ---------------------------------------------------------------- HTTP
  const app = new Hono()
  app.use('*', securityHeaders())
  app.use('*', guards(security, log))
  registerRoutes(app, ctx, commands)
  terminals.registerRoutes(app)
  stage.registerRoutes(app)
  const serveStatic = createStaticHandler({ root: config.webDist, security })
  app.get('*', serveStatic)

  let stopped = false

  const daemon: Daemon = {
    app,
    ctx,
    bus,
    store,
    security,
    lane: theLane,
    commands,
    terminals,
    stage,

    address: () => (server?.address() as AddressInfo | null) ?? undefined,

    async start() {
      if (server) throw new Error('daemon already started')
      ensurePrivateDir(join(config.dataDir, 'agent'))

      const s = createAdaptorServer({ fetch: app.fetch, overrideGlobalObjects: false }) as Server
      // Loopback only, but still: do not let a stalled local client hold a connection open for minutes.
      s.headersTimeout = 15_000
      s.requestTimeout = 60_000
      s.maxHeadersCount = 100
      await new Promise<void>((resolve, reject) => {
        s.once('error', (err: NodeJS.ErrnoException) => {
          reject(err.code === 'EADDRINUSE' ? new Error(`Port ${config.port} is already in use. Is another daemon running? Set DAEMON_PORT to use a different one.`) : err)
        })
        s.listen(config.port, config.host, () => resolve())
      })
      server = s
      const port = (s.address() as AddressInfo).port
      security.setPort(port)

      wsHub = attachWebSocket({
        server: s,
        bus,
        security,
        hello: () => ({ backend: config.backend, version: config.version }),
        options: { maxClients: config.wsMaxClients, heartbeatMs: config.wsHeartbeatMs, maxBufferedBytes: config.wsMaxBufferedBytes },
        log,
        // A dev-origin page (Vite) may read the feed but not the details of the embedded terminals.
        transform: (event, ownOrigin) => hideTerminals(event, ownOrigin, config.terminals.allowDevOrigins),
      })
      // Signing out (this browser or every browser, or `revoke` on the command line) also closes what that session had open.
      unsubscribeRevoked = security.onSessionsRevoked(() => {
        wsHub?.dropRevoked()
        terminals?.upgrade.dropRevoked()
      })
      terminals?.attach(s)
      stage?.attach(s)
      stage?.start()
      hooks.start()

      try {
        await theLane.start()
      } catch (err) {
        // The daemon stays up with the lane in `error`; health and Settings show why.
        log.error('lane failed to start', { error: err instanceof Error ? err.message : 'unknown' })
      }

      const { code } = security.issueExchangeCode()
      // The terminal proof rides in the FRAGMENT of the sign-in link: a fragment is never sent to any server (not in the
      // request, not in Referer), so only the page that opens the link ever has it. The page stores it for its own origin.
      return { port, url: `http://127.0.0.1:${port}`, exchangeUrl: `http://127.0.0.1:${port}/?code=${code}#tp=${security.terminalProof()}`, code }
    },

    async stop() {
      if (stopped) return
      stopped = true
      unsubscribeRevoked?.()
      hooks.stop()
      // Terminals first: every PTY and its whole process tree is killed before the sockets and the database go away.
      await terminals?.shutdown().catch((err: unknown) => log.warn('terminal shutdown failed', { error: err instanceof Error ? err.message : 'unknown' }))
      // The stage next: its socket is closed (going away) and the mood is saved before the database goes.
      await stage?.shutdown().catch((err: unknown) => log.warn('stage shutdown failed', { error: err instanceof Error ? err.message : 'unknown' }))
      await wsHub?.close().catch(() => {})
      if (server) {
        const s = server
        await new Promise<void>((resolve) => {
          s.close(() => resolve())
          s.closeAllConnections()
        })
      }
      try {
        await theLane.interrupt()
      } catch {
        /* nothing in flight */
      }
      try {
        await theLane.stop()
      } catch (err) {
        log.warn('lane stop failed', { error: err instanceof Error ? err.message : 'unknown' })
      }
      await hooks.drain()
      if (ownsStore) store.close()
    },
  }
  return daemon
}
