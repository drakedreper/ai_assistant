import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import * as nodePath from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_DAEMON_PORT } from '@ai-assistant/shared'

/** Raised for an invalid environment. The message never contains secret values. */
export class ConfigError extends Error {
  override name = 'ConfigError'
}

export interface BudgetConfig {
  secretaryDailyUsd: number
  readerDailyUsd: number
  voiceDailyUsd: number
  globalDailyUsd: number
}

/** Limits for the embedded terminals (apps/daemon/src/terminal). The first three and the test override come from environment variables, the rest are fixed defaults (tests override them). */
export interface TerminalConfig {
  /** Running terminals at once. */
  maxTerminals: number
  /** A running terminal with NO client attached is closed after this long (attached terminals are never idle-closed). */
  idleTimeoutMs: number
  /** Per-terminal output ring buffer replayed on attach. Memory only, never written to disk. */
  scrollbackBytes: number
  /** TEST ONLY (TERMINAL_CLAUDE_COMMAND): a command to run instead of the user's `claude`. JSON array or one path. */
  claudeCommandOverride?: string
  /**
   * TERMINAL_ALLOW_DEV_ORIGINS=1: let the Vite dev server's origin (DEV_ORIGINS) use terminals too. Off by default:
   * the session cookie is shared by every port on 127.0.0.1, so any OTHER app that happens to run on an allowlisted dev
   * port (5173 is everyone's Vite default) could otherwise drive a terminal. Terminals answer to the daemon's own
   * address only unless this is set.
   */
  allowDevOrigins: boolean
  /** Largest client frame (keystrokes or a paste chunk). Bigger frames close the socket (1009). */
  maxInputFrameBytes: number
  /** Token bucket for keystrokes: burst size and sustained rate. */
  inputBurstBytes: number
  inputBytesPerSec: number
  /** A client whose unsent buffer passes this is dropped (the terminal keeps running). It counts the control replies too. */
  maxBufferedBytes: number
  /** Text frames (resize) per socket: a token bucket. An overrun closes the socket (4429). */
  textFrameBurst: number
  textFramesPerSec: number
  /** Keystroke frames the input bucket dropped, within 10 s, before the socket is closed (4429) as abusive. */
  maxDroppedInputFrames: number
  ticketTtlMs: number
  /** The first frame must be the auth frame within this long. */
  authTimeoutMs: number
  /** Exited terminals kept in the list (oldest are forgotten beyond this). */
  maxExitedKept: number
  /** How long a terminal gets to exit after a polite kill before the whole tree is killed hard. */
  killGraceMs: number
}

/**
 * The stage backend (apps/daemon/src/stage): the character, her wardrobe and scene, and the `mira-stage/1` socket.
 * Everything here has a fixed default (tests override); the only on/off switch is the persisted Settings one.
 */
export interface StageConfig {
  /** The value of the stage switch until the user sets it: ON in daemon mode. */
  defaultOn: boolean
  /** The behaviour loop (idle profile, gaze, gestures, camera, constructs). */
  tickMs: number
  /** The stage must send `hello` within this long after the socket opens. */
  helloTimeoutMs: number
  /** A stage socket is pinged this often; one that misses a pong is dropped. */
  heartbeatMs: number
  /** A stage whose unsent buffer passes this is dropped (slow consumer). */
  maxBufferedBytes: number
  /** Largest message accepted from the stage. */
  maxMessageBytes: number
  /** Seed of the behaviour variation (gaze, gestures): the same seed gives the same performance. */
  seed: number
  /** Construct feeds (session orbit, knowledge graph) are recomputed at most this often. */
  constructsEveryMs: number
  /** The mood is written to SQLite at most this often (and on shutdown). */
  moodPersistEveryMs: number
}

export interface DaemonConfig {
  /**
   * Loopback. There is deliberately no setting for this EXCEPT container mode (MIRA_CONTAINER=1, which the Docker image sets):
   * inside a container a published port only reaches a process that listens on the container's own interface, so the host is
   * then 0.0.0.0 (all interfaces of the container). docker-compose.yml publishes the port on the host's 127.0.0.1 only.
   * ADR 0009 explains what that changes and what it does not.
   */
  readonly host: '127.0.0.1' | '0.0.0.0'
  /** MIRA_CONTAINER=1: the daemon runs inside the Docker image (see `host`, and `peerAllowed` in net/peer.ts). */
  readonly containerMode: boolean
  /** 0 is accepted by createDaemon for tests (ephemeral port); the environment can only set 1..65535. */
  port: number
  dataDir: string
  /** SQLite file. ':memory:' is allowed for tests. */
  dbFile: string
  backend: 'fake' | 'sdk'
  authMode: 'api-key' | 'local-login'
  /** How Secretary conversations with Claude are kept (CLAUDE_CONVERSATION): see LaneOptions.conversation in agent-core. */
  conversation: 'fresh-daily' | 'resume'
  /** Read from ANTHROPIC_API_KEY only here. Non-enumerable so JSON.stringify and console.log never show it. */
  apiKey?: string
  claudeExecutable?: string
  /** DEMO=1 keeps the fixture sessions, tasks, events and approvals (in a separate, disposable demo.db). */
  demo: boolean
  /** apps/web/dist when it exists. */
  webDist?: string
  /** Origins of the Vite dev server (it proxies to the daemon). The daemon's own origins are added at runtime. */
  allowedDevOrigins: string[]
  budgets: BudgetConfig
  /** Running sessions with no hook event for this long become `stale`. */
  staleRunningMs: number
  /** Idle or waiting sessions with no event for this long become `stale` (SessionEnd is often never delivered). */
  staleIdleMs: number
  sweepIntervalMs: number
  /** Hook-derived rows older than this are deleted. */
  retentionDays: number
  exchangeCodeTtlMs: number
  sessionTtlMs: number
  wsMaxClients: number
  wsHeartbeatMs: number
  wsMaxBufferedBytes: number
  /** Ring buffer size for WebSocket replay. */
  busBufferSize: number
  logLevel: 'debug' | 'info' | 'warn' | 'error' | 'silent'
  version: string
  terminals: TerminalConfig
  stage: StageConfig
}

export interface ConfigContext {
  platform: NodeJS.Platform
  homedir: string
  exists: (path: string) => boolean
  /** Directory of this module (apps/daemon/src), used to find apps/web/dist. */
  moduleDir: string
}

const DEV_ORIGINS_DEFAULT = ['http://127.0.0.1:5173', 'http://localhost:5173']
/** Pinned Agent SDK version (see packages/agent-core/package.json). Shown in Settings. */
export const SDK_VERSION = '0.3.316'

export function readVersion(): string {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8')
    const v = (JSON.parse(raw) as { version?: unknown }).version
    return typeof v === 'string' ? v : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

function defaultContext(): ConfigContext {
  return {
    platform: process.platform,
    homedir: homedir(),
    exists: existsSync,
    moduleDir: nodePath.dirname(fileURLToPath(import.meta.url)),
  }
}

/** The data directory: DATA_DIR, else %APPDATA%\ai-assistant on Windows, else XDG_DATA_HOME or ~/.local/share. */
export function resolveDataDir(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string): string {
  const p = platform === 'win32' ? nodePath.win32 : nodePath.posix
  const override = env.DATA_DIR?.trim()
  if (override) return p.resolve(override)
  if (platform === 'win32') {
    const appData = env.APPDATA?.trim() || p.join(home, 'AppData', 'Roaming')
    return p.join(appData, 'ai-assistant')
  }
  const xdg = env.XDG_DATA_HOME?.trim() || p.join(home, '.local', 'share')
  return p.join(xdg, 'ai-assistant')
}

function parseBool(raw: string | undefined): boolean {
  if (!raw) return false
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase())
}

function parseNumber(name: string, raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n < min || n > max) throw new ConfigError(`${name} must be a number between ${min} and ${max}`)
  return n
}

function parseInteger(name: string, raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = parseNumber(name, raw, fallback, min, max)
  if (!Number.isInteger(n)) throw new ConfigError(`${name} must be an integer`)
  return n
}

function parseOrigins(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === '') return [...DEV_ORIGINS_DEFAULT]
  const out: string[] = []
  for (const piece of raw.split(',')) {
    const s = piece.trim()
    if (!s) continue
    let u: URL
    try {
      u = new URL(s)
    } catch {
      throw new ConfigError(`DEV_ORIGINS entry is not a valid origin: ${s}`)
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new ConfigError(`DEV_ORIGINS entry must be http or https: ${s}`)
    out.push(u.origin)
  }
  return out
}

/** Pure function of the environment (plus an injectable platform context). Throws ConfigError on invalid values. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, ctx: Partial<ConfigContext> = {}): DaemonConfig {
  const c = { ...defaultContext(), ...ctx }
  const p = c.platform === 'win32' ? nodePath.win32 : nodePath.posix

  const port = parseNumber('DAEMON_PORT', env.DAEMON_PORT, DEFAULT_DAEMON_PORT, 1, 65535)
  if (!Number.isInteger(port)) throw new ConfigError('DAEMON_PORT must be an integer')

  const backendRaw = (env.CLAUDE_BACKEND ?? 'fake').trim().toLowerCase()
  if (backendRaw !== 'fake' && backendRaw !== 'sdk') throw new ConfigError(`CLAUDE_BACKEND must be "fake" or "sdk" (got "${backendRaw.slice(0, 20)}")`)

  const authRaw = (env.CLAUDE_AUTH_MODE ?? 'api-key').trim().toLowerCase()
  if (authRaw !== 'api-key' && authRaw !== 'local-login') {
    throw new ConfigError(`CLAUDE_AUTH_MODE must be "api-key" or "local-login" (got "${authRaw.slice(0, 20)}")`)
  }
  const conversationRaw = (env.CLAUDE_CONVERSATION ?? 'fresh-daily').trim().toLowerCase()
  if (conversationRaw !== 'fresh-daily' && conversationRaw !== 'resume') {
    throw new ConfigError(`CLAUDE_CONVERSATION must be "fresh-daily" or "resume" (got "${conversationRaw.slice(0, 20)}")`)
  }

  const logRaw = (env.LOG_LEVEL ?? 'info').trim().toLowerCase()
  const logLevel = (['debug', 'info', 'warn', 'error', 'silent'] as const).find((l) => l === logRaw)
  if (!logLevel) throw new ConfigError('LOG_LEVEL must be one of debug, info, warn, error, silent')

  const dataDir = resolveDataDir(env, c.platform, c.homedir)
  const demo = parseBool(env.DEMO)
  // The ONLY way to listen on anything but loopback: a deliberate, named switch that the Docker image sets and nothing else does
  // (DAEMON_HOST, DAEMON_BIND and the like are not read at all).
  const containerMode = parseBool(env.MIRA_CONTAINER)

  const webCandidate = env.WEB_DIST?.trim() ? p.resolve(env.WEB_DIST.trim()) : nodePath.resolve(c.moduleDir, '..', '..', 'web', 'dist')
  const webDist = c.exists(nodePath.join(webCandidate, 'index.html')) ? webCandidate : undefined

  const apiKey = env.ANTHROPIC_API_KEY?.trim() || undefined
  const claudeExecutable = env.CLAUDE_EXECUTABLE?.trim() || undefined
  const claudeCommandOverride = env.TERMINAL_CLAUDE_COMMAND?.trim() || undefined

  const config: DaemonConfig = {
    host: containerMode ? '0.0.0.0' : '127.0.0.1',
    containerMode,
    port,
    dataDir,
    // The demo runs on its own disposable database so fixture rows never mix with real data.
    dbFile: p.join(dataDir, demo ? 'demo.db' : 'app.db'),
    backend: backendRaw,
    authMode: authRaw,
    conversation: conversationRaw,
    ...(claudeExecutable ? { claudeExecutable } : {}),
    demo,
    ...(webDist ? { webDist } : {}),
    allowedDevOrigins: parseOrigins(env.DEV_ORIGINS),
    budgets: {
      secretaryDailyUsd: parseNumber('BUDGET_SECRETARY_USD', env.BUDGET_SECRETARY_USD, 4, 0, 10_000),
      readerDailyUsd: parseNumber('BUDGET_READER_USD', env.BUDGET_READER_USD, 1, 0, 10_000),
      voiceDailyUsd: parseNumber('BUDGET_VOICE_USD', env.BUDGET_VOICE_USD, 1, 0, 10_000),
      globalDailyUsd: parseNumber('BUDGET_GLOBAL_USD', env.BUDGET_GLOBAL_USD, 10, 0, 100_000),
    },
    staleRunningMs: parseNumber('STALE_RUNNING_MINUTES', env.STALE_RUNNING_MINUTES, 10, 1, 24 * 60) * 60_000,
    staleIdleMs: parseNumber('STALE_IDLE_MINUTES', env.STALE_IDLE_MINUTES, 6 * 60, 1, 30 * 24 * 60) * 60_000,
    sweepIntervalMs: 30_000,
    retentionDays: parseNumber('RETENTION_DAYS', env.RETENTION_DAYS, 30, 1, 3650),
    exchangeCodeTtlMs: 15 * 60_000,
    sessionTtlMs: 30 * 24 * 3_600_000,
    wsMaxClients: 8,
    wsHeartbeatMs: 30_000,
    wsMaxBufferedBytes: 4 * 1024 * 1024,
    busBufferSize: 2000,
    logLevel,
    version: readVersion(),
    terminals: {
      maxTerminals: parseInteger('TERMINAL_MAX', env.TERMINAL_MAX, 4, 1, 16),
      idleTimeoutMs: parseNumber('TERMINAL_IDLE_MINUTES', env.TERMINAL_IDLE_MINUTES, 240, 1, 7 * 24 * 60) * 60_000,
      scrollbackBytes: parseInteger('TERMINAL_SCROLLBACK_KB', env.TERMINAL_SCROLLBACK_KB, 256, 16, 4096) * 1024,
      ...(claudeCommandOverride ? { claudeCommandOverride } : {}),
      allowDevOrigins: parseBool(env.TERMINAL_ALLOW_DEV_ORIGINS),
      maxInputFrameBytes: 64 * 1024,
      inputBurstBytes: 1024 * 1024,
      inputBytesPerSec: 512 * 1024,
      maxBufferedBytes: 1024 * 1024,
      textFrameBurst: 100,
      textFramesPerSec: 50,
      maxDroppedInputFrames: 20_000,
      ticketTtlMs: 30_000,
      authTimeoutMs: 5_000,
      maxExitedKept: 8,
      killGraceMs: 2_000,
    },
    stage: {
      defaultOn: true,
      tickMs: 1000,
      helloTimeoutMs: 5000,
      heartbeatMs: 30_000,
      maxBufferedBytes: 4 * 1024 * 1024,
      maxMessageBytes: 256 * 1024,
      seed: 20_261_031,
      constructsEveryMs: 4000,
      moodPersistEveryMs: 30_000,
    },
  }
  if (apiKey) Object.defineProperty(config, 'apiKey', { value: apiKey, enumerable: false, writable: true, configurable: true })
  return config
}

/** A summary that is safe to log or print: it says whether a key is present, never what it is. */
export function describeConfig(config: DaemonConfig): Record<string, string | number | boolean> {
  return {
    host: config.host,
    containerMode: config.containerMode,
    port: config.port,
    dataDir: config.dataDir,
    backend: config.backend,
    authMode: config.authMode,
    conversation: config.conversation,
    keySet: Boolean(config.apiKey),
    claudeExecutable: config.claudeExecutable ?? '(SDK bundled)',
    demo: config.demo,
    webDist: config.webDist ?? '(not built)',
  }
}
