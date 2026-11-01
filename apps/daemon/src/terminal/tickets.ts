import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * WebSocket tickets for terminals.
 *
 * A browser cannot set headers on a WebSocket, and a secret in the URL would end up in history, logs and proxies.
 * So the page first asks (POST /api/terminals/:id/ticket, which needs the cookie, Origin and a JSON body like every
 * mutation) for a ticket, then opens the socket and sends it as the FIRST TEXT FRAME. A ticket is:
 *   - random (256 bits); only its SHA-256 is kept, never the ticket itself;
 *   - single use: presenting it consumes it, whatever the outcome (a wrong-terminal presentation burns it too);
 *   - short lived (about 30 s);
 *   - bound to ONE terminal and to the browser session (the SHA-256 of the session cookie) that asked for it.
 * Comparison walks every pending ticket with timingSafeEqual and never exits early.
 * Failed presentations are rate limited PER BROWSER SESSION (the presenter's, which is known: the cookie was checked
 * before the upgrade), so one session that misbehaves, or a buggy client loop, locks out only itself and never another
 * session. A ticket that merely expired is not a failure: a slow client is not an attacker.
 */

export interface TicketBinding {
  terminalId: string
  /** SHA-256 hex of the session cookie value (the cookie itself is never stored). */
  sessionKey: string
}

export type RedeemResult =
  | { ok: true }
  | { ok: false; reason: 'invalid' | 'expired' | 'wrong_terminal' | 'wrong_session' | 'rate_limited' }

interface Pending extends TicketBinding {
  hash: Buffer
  expiresAt: number
}

export interface TicketStoreOptions {
  ttlMs: number
  now: () => number
  /** Pending tickets kept at once (the oldest is dropped beyond this). */
  maxPending?: number
  maxFailures?: number
  failureWindowMs?: number
}

const MAX_TRACKED_SESSIONS = 256

const sha256 = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest()

/** The binding key for a session cookie value. */
export const sessionKeyOf = (cookieValue: string): string => createHash('sha256').update(cookieValue, 'utf8').digest('hex')

export class TicketStore {
  private pending: Pending[] = []
  /** Failed presentations per presenting session (a hash): the timestamps inside the window. */
  private failures = new Map<string, number[]>()
  private readonly maxPending: number
  private readonly maxFailures: number
  private readonly failureWindowMs: number

  constructor(private readonly opts: TicketStoreOptions) {
    this.maxPending = opts.maxPending ?? 64
    this.maxFailures = opts.maxFailures ?? 20
    this.failureWindowMs = opts.failureWindowMs ?? 60_000
  }

  mint(binding: TicketBinding): { ticket: string; expiresInSec: number } {
    const t = this.opts.now()
    this.pending = this.pending.filter((p) => p.expiresAt > t)
    while (this.pending.length >= this.maxPending) this.pending.shift()
    const ticket = randomBytes(32).toString('base64url')
    this.pending.push({ ...binding, hash: sha256(ticket), expiresAt: t + this.opts.ttlMs })
    return { ticket, expiresInSec: Math.round(this.opts.ttlMs / 1000) }
  }

  redeem(ticket: string, binding: TicketBinding): RedeemResult {
    const t = this.opts.now()
    const key = binding.sessionKey
    const recent = (this.failures.get(key) ?? []).filter((f) => t - f < this.failureWindowMs)
    if (recent.length > 0) this.failures.set(key, recent)
    else this.failures.delete(key)
    if (recent.length >= this.maxFailures) return { ok: false, reason: 'rate_limited' }
    const fail = (reason: 'invalid' | 'wrong_terminal' | 'wrong_session'): RedeemResult => {
      const list = this.failures.get(key) ?? []
      list.push(t)
      this.failures.set(key, list)
      // Sessions are few (the daemon keeps at most 20), but never let a pathological caller grow this without bound.
      while (this.failures.size > MAX_TRACKED_SESSIONS) this.failures.delete(this.failures.keys().next().value as string)
      return { ok: false, reason }
    }

    const presented = sha256(typeof ticket === 'string' ? ticket : '')
    let hit = -1
    for (let i = 0; i < this.pending.length; i++) {
      const p = this.pending[i] as Pending
      if (timingSafeEqual(presented, p.hash) && hit === -1) hit = i
    }
    if (hit === -1) return fail('invalid')
    const [entry] = this.pending.splice(hit, 1) as [Pending] // consumed, whatever happens next
    if (entry.expiresAt <= t) return { ok: false, reason: 'expired' } // not counted: a slow client is not an attacker
    if (entry.terminalId !== binding.terminalId) return fail('wrong_terminal')
    // Both are hex digests of equal length, compared in constant time.
    const a = Buffer.from(entry.sessionKey, 'utf8')
    const b = Buffer.from(binding.sessionKey, 'utf8')
    if (a.length !== b.length || !timingSafeEqual(a, b)) return fail('wrong_session')
    return { ok: true }
  }

  /** Forget the tickets of a terminal that no longer exists. */
  revokeTerminal(terminalId: string): void {
    this.pending = this.pending.filter((p) => p.terminalId !== terminalId)
  }

  clear(): void {
    this.pending = []
  }

  pendingCount(): number {
    return this.pending.length
  }
}
