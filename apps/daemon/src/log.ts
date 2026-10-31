import { redactText } from './store/redact'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent'
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 }

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void
  info(msg: string, meta?: Record<string, unknown>): void
  warn(msg: string, meta?: Record<string, unknown>): void
  error(msg: string, meta?: Record<string, unknown>): void
}

export interface LoggerOptions {
  level?: LogLevel
  sink?: (line: string) => void
  /** Extra exact-match secrets to mask (the hook token, the API key). */
  literals?: () => string[]
}

function metaToString(meta: Record<string, unknown> | undefined): string {
  if (!meta) return ''
  const parts: string[] = []
  for (const [k, v] of Object.entries(meta)) {
    // Only primitives are logged, and strings are cut short: logs are not a place for payloads.
    if (v === undefined || v === null) continue
    if (typeof v === 'string') parts.push(`${k}=${JSON.stringify(v.length > 120 ? `${v.slice(0, 120)}...` : v)}`)
    else if (typeof v === 'number' || typeof v === 'boolean') parts.push(`${k}=${v}`)
  }
  return parts.length ? ` ${parts.join(' ')}` : ''
}

/** A tiny structured logger. Every line goes through the redactor first. */
export function createLogger(opts: LoggerOptions = {}): Logger {
  const threshold = ORDER[opts.level ?? 'info']
  const sink = opts.sink ?? ((line: string) => process.stderr.write(`${line}\n`))
  const emit = (level: Exclude<LogLevel, 'silent'>, msg: string, meta?: Record<string, unknown>) => {
    if (ORDER[level] < threshold) return
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}${metaToString(meta)}`
    sink(redactText(line, 600, opts.literals?.() ?? []))
  }
  return {
    debug: (m, x) => emit('debug', m, x),
    info: (m, x) => emit('info', m, x),
    warn: (m, x) => emit('warn', m, x),
    error: (m, x) => emit('error', m, x),
  }
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} }
