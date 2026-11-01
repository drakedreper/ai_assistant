import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

/**
 * Per-install secrets and the request-level checks that every route and the WebSocket upgrade share.
 *
 *  - hook token: random 256-bit bearer token for Claude Code http hooks. Separate from browser auth.
 *  - stage token: random 256-bit bearer token for the stage socket (Unreal, Unity, the simulator). Separate from
 *    browser auth AND from the hook token: the browser cookie does nothing on the stage socket and the stage token
 *    does nothing on any browser route. It is never printed (the banner only says where to find it).
 *  - exchange code: single use, short lived, printed once at startup; swapped at POST /api/auth/exchange for
 *    an opaque session cookie (HttpOnly, SameSite=Strict). Only a SHA-256 of each session token is stored.
 *  - terminal proof: a second secret, per run and never persisted, that the terminal routes require besides the cookie
 *    (header X-Terminal-Proof). A cookie is scoped to the HOST, not the port, so another local server the user browses to
 *    (127.0.0.1:3000) receives it; the proof is never in a cookie: it travels in the FRAGMENT of the printed sign-in link,
 *    which no server ever sees, and the page keeps it in its own origin's storage (which no other port can read).
 *
 * Secrets live in dataDir/secrets.json (mode 0600 where the OS honours it). On Windows that file is protected
 * only by the user profile ACLs; Windows Credential Manager (@napi-rs/keyring) is the planned upgrade.
 *
 * The data directory itself is private on POSIX: created 0700 (and tightened to 0700 when it is demonstrably ours), the
 * database files 0600 (see ensurePrivateDir and hardenDbFiles below).
 */

/** Constant-time string comparison: both sides are hashed to equal-length digests first. */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest()
  const hb = createHash('sha256').update(b, 'utf8').digest()
  return timingSafeEqual(ha, hb)
}

const sha256hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')
/** How many plaintext session tokens of this run are kept in memory for log masking. */
const MAX_ISSUED_LITERALS = 40
export const newToken = (bytes = 32) => randomBytes(bytes).toString('base64url')

// ---------------------------------------------------------------- private data directory (POSIX)

const chmodQuiet = (path: string, mode: number): void => {
  try {
    chmodSync(path, mode)
  } catch {
    /* best effort: a file system that has no modes (FAT, some network shares) */
  }
}

/**
 * Create `dir` (and missing parents) so that only the owner can enter it, where the OS honours modes (not Windows, whose
 * profile ACLs apply instead). A directory that already exists is tightened to 0700 only when it is demonstrably this
 * product's own data folder (it holds secrets.json or the database) or was just created here: pointing DATA_DIR at some other,
 * shared folder never changes ITS permissions (the files in it are 0600 either way).
 */
export function ensurePrivateDir(dir: string, platform: NodeJS.Platform = process.platform): void {
  const existed = existsSync(dir)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (platform === 'win32') return
  const ours = !existed || existsSync(join(dir, 'secrets.json')) || existsSync(join(dir, 'app.db')) || existsSync(join(dir, 'demo.db'))
  if (ours) chmodQuiet(dir, 0o700)
}

/** Create an empty file with mode 0600 if there is none (SQLite then gives its -wal and -shm files the same mode). */
export function ensurePrivateFile(file: string, platform: NodeJS.Platform = process.platform): void {
  if (file === ':memory:' || existsSync(file)) return
  try {
    closeSync(openSync(file, 'a', 0o600))
  } catch {
    /* the store creates it with default modes then, and hardenDbFiles tightens it */
  }
  if (platform !== 'win32') chmodQuiet(file, 0o600)
}

/** The database and its SQLite side files: owner read and write only (POSIX). */
export function hardenDbFiles(dbFile: string, platform: NodeJS.Platform = process.platform): void {
  if (dbFile === ':memory:' || platform === 'win32') return
  for (const suffix of ['', '-wal', '-shm', '-journal']) if (existsSync(`${dbFile}${suffix}`)) chmodQuiet(`${dbFile}${suffix}`, 0o600)
}

// ---------------------------------------------------------------- secrets file

const StoredSession = z.object({ hash: z.string().length(64), createdAt: z.number(), expiresAt: z.number() })
const SecretsFile = z.object({
  version: z.literal(1),
  hookToken: z.string().min(32),
  /** Optional in the schema so a Phase 1 file still loads; createSecurity adds one on the first start that needs it. */
  stageToken: z.string().min(32).optional(),
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

/** Replace only the stage token in an existing secrets file (`stage token --rotate`). Returns the new token, or null if there is no file. */
export function rotateSecretsStageToken(dataDir: string): string | null {
  const existing = readSecretsFile(dataDir)
  if (!existing) return null
  const stageToken = newToken(32)
  writeSecretsFile(dataDir, { ...existing, stageToken })
  return stageToken
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
  const fresh: SecretsFile = { version: 1, hookToken: newToken(32), stageToken: newToken(32), sessions: [] }
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
  /** The bearer token of the stage socket. Never log it, never put it in a URL. */
  stageToken(): string
  /** Rewrite the stage token; a connected stage keeps its socket, a reconnect needs the new one. */
  rotateStageToken(): string
  verifyStageToken(authorization: string | undefined): boolean
  issueExchangeCode(): { code: string; expiresAt: number }
  exchange(code: string): ExchangeResult
  setCookieHeader(token: string, maxAgeSec: number): string
  clearCookieHeader(): string
  parseSessionCookie(cookieHeader: string | undefined): string | undefined
  validateSession(token: string | undefined): boolean
  /** The key a session is known by (tickets and sockets are bound to it): the SHA-256 hex of the session token. */
  sessionKey(token: string): string
  /** Is the session with this key still valid (neither revoked nor expired)? */
  validateSessionKey(key: string): boolean
  /** Sign this one session out (POST /api/auth/signout). False when it was not a valid session. */
  revokeSession(token: string | undefined): boolean
  /** Sign every browser out (signout everywhere, the revoke command). Returns how many sessions there were. */
  revokeAllSessions(): number
  /** Called after sessions were revoked here or by the command line: close what they opened. Returns an unsubscribe. */
  onSessionsRevoked(listener: () => void): () => void
  /**
   * Every secret value the daemon holds right now, for the logger to mask by exact match: the hook and stage tokens, the
   * pending exchange code and the session tokens this process issued (kept in memory only, never written anywhere).
   */
  secretLiterals(): string[]
  /** Is this the daemon's own origin (an absent Origin counts: browsers omit it on same-origin GETs)? Dev origins are not. */
  isOwnOrigin(origin: string | undefined): boolean
  verifyHookToken(authorization: string | undefined): boolean
  /** The terminal proof of this run (see above). Printed only inside the sign-in link's fragment; never logged, never in a response. */
  terminalProof(): string
  /** Constant-time check of a presented X-Terminal-Proof header. */
  verifyTerminalProof(presented: string | undefined): boolean
  checkHost(host: string | undefined): Verdict
  /** `required` is true for non-GET requests on browser routes and for WebSocket upgrades. */
  checkOrigin(origin: string | undefined, required: boolean): Verdict
  checkSessionCookie(cookieHeader: string | undefined): Verdict
  /** Host, Origin and cookie checks for a WebSocket upgrade, in that order. */
  checkUpgrade(h: { host?: string; origin?: string; cookie?: string }): Verdict
  /**
   * The stage socket upgrade: Host, then Origin (ABSENT is fine, a stage is not a browser; if present it must be
   * allowlisted), then the bearer stage token. The cookie header is never read.
   */
  checkStageUpgrade(h: { host?: string; origin?: string; authorization?: string }): Verdict
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
  let secretsMtime = persist ? mtimeOf(opts.dataDir) : ''
  let active: { code: string; expiresAt: number } | null = null
  let failures: number[] = []
  /** The terminal proof: random per run, held in memory only. */
  const proof = newToken(32)
  /** Plaintext session tokens this process issued (memory only): so the logger can mask them. Bounded. */
  const issued: string[] = []
  const revokedListeners = new Set<() => void>()

  /** A stamp of the secrets file that changes with every rewrite: every write is a rename, so the inode changes even where mtime is coarse. */
  function mtimeOf(dir: string): string {
    try {
      const st = statSync(secretsPath(dir))
      return `${st.mtimeMs}:${st.ino}:${st.size}`
    } catch {
      return ''
    }
  }

  function save(): void {
    if (!persist) return
    writeSecretsFile(opts.dataDir, secrets)
    secretsMtime = mtimeOf(opts.dataDir)
  }

  /**
   * Pick up what a CLI changed in secrets.json while the daemon runs (one stat per request that needs a secret): a rotated
   * hook or stage token, and sessions revoked by `revoke`. Sessions that disappeared are announced, so their sockets close.
   * Every method that rewrites the file calls this first, so a revocation made from the command line is never written over.
   */
  function refreshFromDisk(): void {
    if (!persist) return
    const m = mtimeOf(opts.dataDir)
    if (m === secretsMtime) return
    secretsMtime = m
    const fresh = readSecretsFile(opts.dataDir)
    if (!fresh) return
    const had = secrets.sessions.map((x) => x.hash)
    secrets = { ...secrets, hookToken: fresh.hookToken, ...(fresh.stageToken ? { stageToken: fresh.stageToken } : {}), sessions: fresh.sessions }
    if (had.some((h) => !fresh.sessions.some((x) => x.hash === h))) notifyRevoked()
  }

  function notifyRevoked(): void {
    for (const l of [...revokedListeners]) {
      try {
        l()
      } catch {
        /* a listener must not stop the others */
      }
    }
  }

  /** The stage token always exists once the security core is built (see below). */
  const currentStageToken = (): string => secrets.stageToken ?? ''

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
      refreshFromDisk()
      return secrets.hookToken
    },
    rotateHookToken() {
      refreshFromDisk()
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
      refreshFromDisk()
      failures = failures.filter((f) => t - f < windowMs)
      // The code is compared FIRST, always, in constant time (a dummy when none is pending, so timing says nothing about
      // whether one exists). The limiter only ever judges WRONG codes: a correct one succeeds even while it is tripped,
      // so someone who merely hammers the endpoint cannot keep the owner from signing in. (Guessing a 256-bit code is not
      // what the limiter is for; it keeps a flood of wrong guesses cheap and quiet.)
      const candidate = active && active.expiresAt > t ? active.code : newToken(32)
      const match = safeEqual(code, candidate) && active !== null && active.expiresAt > t
      if (!match) {
        if (failures.length >= maxFailed) {
          const oldest = failures[0] ?? t
          return { ok: false, reason: 'rate_limited', retryAfterSec: Math.max(1, Math.ceil((windowMs - (t - oldest)) / 1000)) }
        }
        failures.push(t)
        return { ok: false, reason: 'invalid' }
      }
      active = null // single use
      failures = []
      const token = newToken(32)
      issued.push(token)
      if (issued.length > MAX_ISSUED_LITERALS) issued.shift()
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
      return security.validateSessionKey(sha256hex(token))
    },
    sessionKey: sha256hex,
    validateSessionKey(key) {
      refreshFromDisk()
      const t = now()
      let valid = false
      // Walk every stored session with a constant-time compare; no early exit.
      for (const s of secrets.sessions) {
        const same = safeEqual(key, s.hash)
        if (same && s.expiresAt > t) valid = true
      }
      return valid
    },
    revokeSession(token) {
      refreshFromDisk()
      if (!token) return false
      const h = sha256hex(token)
      const before = secrets.sessions.length
      secrets = { ...secrets, sessions: secrets.sessions.filter((s) => !safeEqual(h, s.hash)) }
      const removed = before - secrets.sessions.length
      if (removed > 0) {
        save()
        notifyRevoked()
      }
      return removed > 0
    },
    revokeAllSessions() {
      refreshFromDisk()
      const n = secrets.sessions.length
      secrets = { ...secrets, sessions: [] }
      save()
      issued.length = 0
      notifyRevoked()
      return n
    },
    onSessionsRevoked(listener) {
      revokedListeners.add(listener)
      return () => void revokedListeners.delete(listener)
    },
    secretLiterals() {
      refreshFromDisk()
      return [secrets.hookToken, currentStageToken(), proof, ...(active ? [active.code] : []), ...issued].filter((v) => v.length > 0)
    },
    isOwnOrigin(origin) {
      if (origin === undefined || origin === '') return true
      const o = origin.trim().toLowerCase()
      return ownOrigins().some((a) => a.toLowerCase() === o)
    },

    stageToken() {
      refreshFromDisk()
      return currentStageToken()
    },
    rotateStageToken() {
      refreshFromDisk()
      secrets = { ...secrets, stageToken: newToken(32) }
      save()
      return currentStageToken()
    },
    verifyStageToken(authorization) {
      refreshFromDisk()
      const m = /^Bearer\s+(\S+)$/i.exec(authorization ?? '')
      const presented = m?.[1] ?? ''
      const expected = currentStageToken()
      // Compare even when nothing was presented, so timing says nothing; an empty expectation never matches.
      const same = safeEqual(presented, expected)
      return same && presented.length > 0 && expected.length > 0
    },

    terminalProof: () => proof,
    verifyTerminalProof(presented) {
      // Compare even when nothing was presented, so timing says nothing; an empty header never matches.
      const same = safeEqual(presented ?? '', proof)
      return same && typeof presented === 'string' && presented.length > 0
    },

    verifyHookToken(authorization) {
      refreshFromDisk()
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

    checkStageUpgrade(h) {
      const host = security.checkHost(h.host)
      if (!host.ok) return host
      const origin = security.checkOrigin(h.origin, false)
      if (!origin.ok) return origin
      return security.verifyStageToken(h.authorization) ? ok : deny(401, 'unauthorized', 'A valid stage token is required (Authorization: Bearer <stage token>)')
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
  // A secrets file written before the stage existed has no stage token: add one (the first start after the upgrade).
  if (!secrets.stageToken) {
    secrets = { ...secrets, stageToken: newToken(32) }
    save()
  }
  return security
}
