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

export interface DaemonConfig {
  /** Always loopback. There is deliberately no way to configure this. */
  readonly host: '127.0.0.1'
  /** 0 is accepted by createDaemon for tests (ephemeral port); the environment can only set 1..65535. */
  port: number
  dataDir: string
  /** SQLite file. ':memory:' is allowed for tests. */
  dbFile: string
  backend: 'fake' | 'sdk'
  authMode: 'api-key' | 'local-login'
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

  const logRaw = (env.LOG_LEVEL ?? 'info').trim().toLowerCase()
  const logLevel = (['debug', 'info', 'warn', 'error', 'silent'] as const).find((l) => l === logRaw)
  if (!logLevel) throw new ConfigError('LOG_LEVEL must be one of debug, info, warn, error, silent')

  const dataDir = resolveDataDir(env, c.platform, c.homedir)
  const demo = parseBool(env.DEMO)

  const webCandidate = env.WEB_DIST?.trim() ? p.resolve(env.WEB_DIST.trim()) : nodePath.resolve(c.moduleDir, '..', '..', 'web', 'dist')
  const webDist = c.exists(nodePath.join(webCandidate, 'index.html')) ? webCandidate : undefined

  const apiKey = env.ANTHROPIC_API_KEY?.trim() || undefined
  const claudeExecutable = env.CLAUDE_EXECUTABLE?.trim() || undefined

  const config: DaemonConfig = {
    host: '127.0.0.1',
    port,
    dataDir,
    // The demo runs on its own disposable database so fixture rows never mix with real data.
    dbFile: p.join(dataDir, demo ? 'demo.db' : 'app.db'),
    backend: backendRaw,
    authMode: authRaw,
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
  }
  if (apiKey) Object.defineProperty(config, 'apiKey', { value: apiKey, enumerable: false, writable: true, configurable: true })
  return config
}

/** A summary that is safe to log or print: it says whether a key is present, never what it is. */
export function describeConfig(config: DaemonConfig): Record<string, string | number | boolean> {
  return {
    host: config.host,
    port: config.port,
    dataDir: config.dataDir,
    backend: config.backend,
    authMode: config.authMode,
    keySet: Boolean(config.apiKey),
    claudeExecutable: config.claudeExecutable ?? '(SDK bundled)',
    demo: config.demo,
    webDist: config.webDist ?? '(not built)',
  }
}
