import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

/**
 * Per-install secrets and the request-level checks that every route and the WebSocket upgrade share.
 *
 *  - hook token: random 256-bit bearer token for Claude Code http hooks. Separate from browser auth.
 *  - exchange code: single use, short lived, printed once at startup; swapped at POST /api/auth/exchange for
 *    an opaque session cookie (HttpOnly, SameSite=Strict). Only a SHA-256 of each session token is stored.
 *
 * Secrets live in dataDir/secrets.json (mode 0600 where the OS honours it). On Windows that file is protected
 * only by the user profile ACLs; Windows Credential Manager (@napi-rs/keyring) is the planned upgrade.
 */

/** Constant-time string comparison: both sides are hashed to equal-length digests first. */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest()
  const hb = createHash('sha256').update(b, 'utf8').digest()
  return timingSafeEqual(ha, hb)
}

const sha256hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')
export const newToken = (bytes = 32) => randomBytes(bytes).toString('base64url')

// ---------------------------------------------------------------- secrets file

const StoredSession = z.object({ hash: z.string().length(64), createdAt: z.number(), expiresAt: z.number() })
const SecretsFile = z.object({
  version: z.literal(1),
  hookToken: z.string().min(32),
  sessions: z.array(StoredSession).default([]),
})
export type SecretsFile = z.infer<typeof SecretsFile>

export const secretsPath = (dataDir: string) => join(dataDir, 'secrets.json')

/** Read the secrets file, or null when it is missing or unusable. Never creates or modifies anything. */
export function readSecretsFile(dataDir: string): SecretsFile | null {
  try {
    const parsed = SecretsFile.safeParse(JSON.parse(readFileSync(secretsPath(dataDir), 'utf8')))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export function writeSecretsFile(dataDir: string, secrets: SecretsFile): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const file = secretsPath(dataDir)
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 })
  try {
    chmodSync(tmp, 0o600) // a no-op for permission bits on Windows; ACLs of the profile apply there
  } catch {
    /* best effort */
  }
  renameSync(tmp, file)
}

/** Replace only the hook token in an existing secrets file (CLI `token --rotate`). Returns the new token, or null if there is no file. */
export function rotateSecretsHookToken(dataDir: string): string | null {
  const existing = readSecretsFile(dataDir)
  if (!existing) return null
  const hookToken = newToken(32)
  writeSecretsFile(dataDir, { ...existing, hookToken })
  return hookToken
}

/** Load the secrets, creating the file (and a fresh hook token) on first run. A corrupt file is set aside, not trusted. */
export function loadOrCreateSecrets(dataDir: string): SecretsFile {
  const existing = readSecretsFile(dataDir)
  if (existing) return existing
  try {
    // Unusable existing content (corrupt JSON, wrong shape): keep it for inspection and start fresh.
    statSync(secretsPath(dataDir))
    renameSync(secretsPath(dataDir), `${secretsPath(dataDir)}.corrupt-${Date.now()}`)
  } catch {
    /* no file: first run */
  }
  const fresh: SecretsFile = { version: 1, hookToken: newToken(32), sessions: [] }
  writeSecretsFile(dataDir, fresh)
  return fresh
}

// ---------------------------------------------------------------- security core

export interface SecurityOptions {
  dataDir: string
  port: number
  devOrigins: string[]
  exchangeCodeTtlMs: number
  sessionTtlMs: number
  now?: () => number
  /** Persist hashed browser sessions in secrets.json so a daemon restart keeps the browser signed in. Default true. */
  persist?: boolean
  maxFailedExchanges?: number
  exchangeWindowMs?: number
}

export type ExchangeResult =
  | { ok: true; token: string; maxAgeSec: number }
  | { ok: false; reason: 'invalid' | 'rate_limited'; retryAfterSec?: number }

export type Verdict = { ok: true } | { ok: false; status: 401 | 403 | 415 | 429; code: string; message: string }

export interface Security {
  getPort(): number
  setPort(port: number): void
  allowedHosts(): string[]
  /** The daemon's own origins plus the configured dev origins. */
  allowedOrigins(): string[]
  cookieName(): string
  hookToken(): string
  /** Rewrite the hook token (the installed hooks must be updated afterwards). */
  rotateHookToken(): string
  issueExchangeCode(): { code: string; expiresAt: number }
  exchange(code: string): ExchangeResult
  setCookieHeader(token: string, maxAgeSec: number): string
  clearCookieHeader(): string
  parseSessionCookie(cookieHeader: string | undefined): string | undefined
  validateSession(token: string | undefined): boolean
  revokeAllSessions(): void
  verifyHookToken(authorization: string | undefined): boolean
  checkHost(host: string | undefined): Verdict
  /** `required` is true for non-GET requests on browser routes and for WebSocket upgrades. */
  checkOrigin(origin: string | undefined, required: boolean): Verdict
  checkSessionCookie(cookieHeader: string | undefined): Verdict
  /** Host, Origin and cookie checks for a WebSocket upgrade, in that order. */
  checkUpgrade(h: { host?: string; origin?: string; cookie?: string }): Verdict
  csp(): string
}

const ok: Verdict = { ok: true }
const deny = (status: 401 | 403 | 415 | 429, code: string, message: string): Verdict => ({ ok: false, status, code, message })

export function createSecurity(opts: SecurityOptions): Security {
  const now = opts.now ?? Date.now
  const persist = opts.persist !== false
  const maxFailed = opts.maxFailedExchanges ?? 10
  const windowMs = opts.exchangeWindowMs ?? 60_000
  let port = opts.port

  let secrets: SecretsFile = persist ? loadOrCreateSecrets(opts.dataDir) : { version: 1, hookToken: newToken(32), sessions: [] }
  let secretsMtime = persist ? mtimeOf(opts.dataDir) : 0
  let active: { code: string; expiresAt: number } | null = null
  let failures: number[] = []

  function mtimeOf(dir: string): number {
    try {
      return statSync(secretsPath(dir)).mtimeMs
    } catch {
      return 0
    }
  }

  function save(): void {
    if (!persist) return
    writeSecretsFile(opts.dataDir, secrets)
    secretsMtime = mtimeOf(opts.dataDir)
  }

  /** Pick up a hook token rotated by the CLI while the daemon is running (one stat per hook request). */
  function refreshHookToken(): void {
    if (!persist) return
    const m = mtimeOf(opts.dataDir)
    if (m === secretsMtime) return
    secretsMtime = m
    const fresh = readSecretsFile(opts.dataDir)
    if (fresh) secrets = { ...secrets, hookToken: fresh.hookToken }
  }

  function pruneSessions(): void {
    const t = now()
    const kept = secrets.sessions.filter((s) => s.expiresAt > t)
    if (kept.length !== secrets.sessions.length) {
      secrets = { ...secrets, sessions: kept }
      save()
    }
  }

  const cookieName = () => `aia_sid_${port}`
  const ownOrigins = () => [`http://127.0.0.1:${port}`, `http://localhost:${port}`]
  const hosts = () => [`127.0.0.1:${port}`, `localhost:${port}`]

  const security: Security = {
    getPort: () => port,
    setPort(p) {
      port = p
    },
    allowedHosts: hosts,
    allowedOrigins: () => [...ownOrigins(), ...opts.devOrigins],
    cookieName,
    hookToken() {
      refreshHookToken()
      return secrets.hookToken
    },
    rotateHookToken() {
      secrets = { ...secrets, hookToken: newToken(32) }
      save()
      return secrets.hookToken
    },

    issueExchangeCode() {
      active = { code: newToken(32), expiresAt: now() + opts.exchangeCodeTtlMs }
      return { ...active }
    },

    exchange(code) {
      const t = now()
      failures = failures.filter((f) => t - f < windowMs)
      if (failures.length >= maxFailed) {
        const oldest = failures[0] ?? t
        return { ok: false, reason: 'rate_limited', retryAfterSec: Math.max(1, Math.ceil((windowMs - (t - oldest)) / 1000)) }
      }
      // Compare even when there is no active code so timing does not reveal whether one exists.
      const candidate = active && active.expiresAt > t ? active.code : newToken(32)
      const match = safeEqual(code, candidate) && active !== null && active.expiresAt > t
      if (!match) {
        failures.push(t)
        return { ok: false, reason: 'invalid' }
      }
      active = null // single use
      const token = newToken(32)
      pruneSessions()
      const sessions = [...secrets.sessions, { hash: sha256hex(token), createdAt: t, expiresAt: t + opts.sessionTtlMs }]
      secrets = { ...secrets, sessions: sessions.slice(-20) }
      save()
      return { ok: true, token, maxAgeSec: Math.floor(opts.sessionTtlMs / 1000) }
    },

    setCookieHeader(token, maxAgeSec) {
      // No `Secure`: the daemon is plain http on loopback, where browsers treat the origin as secure anyway.
      return `${cookieName()}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}`
    },
    clearCookieHeader() {
      return `${cookieName()}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`
    },
    parseSessionCookie(header) {
      if (!header) return undefined
      const name = cookieName()
      for (const part of header.split(';')) {
        const eq = part.indexOf('=')
        if (eq < 0) continue
        if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim() || undefined
      }
      return undefined
    },
    validateSession(token) {
      if (!token) return false
      const h = sha256hex(token)
      const t = now()
      let valid = false
      // Walk every stored session with a constant-time compare; no early exit.
      for (const s of secrets.sessions) {
        const same = safeEqual(h, s.hash)
        if (same && s.expiresAt > t) valid = true
      }
      return valid
    },
    revokeAllSessions() {
      secrets = { ...secrets, sessions: [] }
      save()
    },

    verifyHookToken(authorization) {
      refreshHookToken()
      const m = /^Bearer\s+(\S+)$/i.exec(authorization ?? '')
      const presented = m?.[1] ?? ''
      const same = safeEqual(presented, secrets.hookToken)
      return same && presented.length > 0
    },

    checkHost(host) {
      const h = (host ?? '').trim().toLowerCase()
      return hosts().includes(h) ? ok : deny(403, 'forbidden_host', 'Host header is not allowed')
    },
    checkOrigin(origin, required) {
      if (origin === undefined || origin === '') {
        return required ? deny(403, 'forbidden_origin', 'Origin header is required') : ok
      }
      const o = origin.trim().toLowerCase()
      return security.allowedOrigins().some((a) => a.toLowerCase() === o) ? ok : deny(403, 'forbidden_origin', 'Origin is not allowed')
    },
    checkSessionCookie(cookieHeader) {
      return security.validateSession(security.parseSessionCookie(cookieHeader)) ? ok : deny(401, 'unauthorized', 'Sign in required')
    },
    checkUpgrade(h) {
      const host = security.checkHost(h.host)
      if (!host.ok) return host
      const origin = security.checkOrigin(h.origin, true)
      if (!origin.ok) return origin
      return security.checkSessionCookie(h.cookie)
    },

    csp() {
      const p = port
      return [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        `connect-src 'self' ws://127.0.0.1:${p} ws://localhost:${p}`,
        "img-src 'self' data: blob:",
        "worker-src 'self' blob:",
        "media-src 'self' blob:",
        "font-src 'self' data:",
        "object-src 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'",
        "base-uri 'none'",
      ].join('; ')
    },
  }

  pruneSessions()
  return security
}
