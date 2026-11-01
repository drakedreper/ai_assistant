import { describe, expect, it } from 'vitest'
import { TicketStore, sessionKeyOf } from '../src/terminal/tickets'
import { Scrollback } from '../src/terminal/scrollback'
import { TokenBucket } from '../src/terminal/limits'
import { makeClock } from './helpers'

const S1 = sessionKeyOf('cookie-of-session-one')
const S2 = sessionKeyOf('cookie-of-session-two')

function store(overrides: Partial<ConstructorParameters<typeof TicketStore>[0]> = {}) {
  const clock = makeClock()
  return { clock, tickets: new TicketStore({ ttlMs: 30_000, now: clock.fn, ...overrides }) }
}

describe('terminal tickets', () => {
  it('mints a random, url-safe ticket valid for about 30 seconds', () => {
    const { tickets } = store()
    const a = tickets.mint({ terminalId: 't1', sessionKey: S1 })
    const b = tickets.mint({ terminalId: 't1', sessionKey: S1 })
    expect(a.expiresInSec).toBe(30)
    expect(a.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(a.ticket).not.toBe(b.ticket)
  })

  it('redeems once, then refuses reuse', () => {
    const { tickets } = store()
    const { ticket } = tickets.mint({ terminalId: 't1', sessionKey: S1 })
    expect(tickets.redeem(ticket, { terminalId: 't1', sessionKey: S1 })).toEqual({ ok: true })
    expect(tickets.redeem(ticket, { terminalId: 't1', sessionKey: S1 })).toEqual({ ok: false, reason: 'invalid' })
  })

  it('expires', () => {
    const { tickets, clock } = store()
    const { ticket } = tickets.mint({ terminalId: 't1', sessionKey: S1 })
    clock.advance(30_000)
    expect(tickets.redeem(ticket, { terminalId: 't1', sessionKey: S1 })).toEqual({ ok: false, reason: 'expired' })
    // consumed even though it was expired
    expect(tickets.redeem(ticket, { terminalId: 't1', sessionKey: S1 })).toEqual({ ok: false, reason: 'invalid' })
  })

  it('is still valid just before the deadline', () => {
    const { tickets, clock } = store()
    const { ticket } = tickets.mint({ terminalId: 't1', sessionKey: S1 })
    clock.advance(29_999)
    expect(tickets.redeem(ticket, { terminalId: 't1', sessionKey: S1 })).toEqual({ ok: true })
  })

  it('is bound to one terminal, and a wrong-terminal presentation burns it', () => {
    const { tickets } = store()
    const { ticket } = tickets.mint({ terminalId: 't1', sessionKey: S1 })
    expect(tickets.redeem(ticket, { terminalId: 't2', sessionKey: S1 })).toEqual({ ok: false, reason: 'wrong_terminal' })
    expect(tickets.redeem(ticket, { terminalId: 't1', sessionKey: S1 })).toEqual({ ok: false, reason: 'invalid' })
  })

  it('is bound to the browser session that asked for it', () => {
    const { tickets } = store()
    const { ticket } = tickets.mint({ terminalId: 't1', sessionKey: S1 })
    expect(tickets.redeem(ticket, { terminalId: 't1', sessionKey: S2 })).toEqual({ ok: false, reason: 'wrong_session' })
    expect(tickets.redeem(ticket, { terminalId: 't1', sessionKey: S1 })).toEqual({ ok: false, reason: 'invalid' })
  })

  it('refuses garbage, empty and non-string input', () => {
    const { tickets } = store()
    tickets.mint({ terminalId: 't1', sessionKey: S1 })
    for (const bad of ['', 'x', 'a'.repeat(5000), undefined as unknown as string, 42 as unknown as string]) {
      expect(tickets.redeem(bad, { terminalId: 't1', sessionKey: S1 })).toMatchObject({ ok: false, reason: 'invalid' })
    }
  })

  it('keeps several tickets apart', () => {
    const { tickets } = store()
    const a = tickets.mint({ terminalId: 't1', sessionKey: S1 })
    const b = tickets.mint({ terminalId: 't2', sessionKey: S2 })
    expect(tickets.redeem(b.ticket, { terminalId: 't2', sessionKey: S2 }).ok).toBe(true)
    expect(tickets.redeem(a.ticket, { terminalId: 't1', sessionKey: S1 }).ok).toBe(true)
  })

  it('rate limits failed presentations, even for a valid ticket afterwards', () => {
    const { tickets, clock } = store({ maxFailures: 3, failureWindowMs: 10_000 })
    const { ticket } = tickets.mint({ terminalId: 't1', sessionKey: S1 })
    for (let i = 0; i < 3; i++) expect(tickets.redeem(`bad-${i}`, { terminalId: 't1', sessionKey: S1 })).toMatchObject({ reason: 'invalid' })
    expect(tickets.redeem(ticket, { terminalId: 't1', sessionKey: S1 })).toEqual({ ok: false, reason: 'rate_limited' })
    clock.advance(10_001)
    expect(tickets.redeem(ticket, { terminalId: 't1', sessionKey: S1 })).toEqual({ ok: true })
  })

  it('counts failures per session: one session\'s failures never limit another\'s', () => {
    const { tickets } = store({ maxFailures: 3, failureWindowMs: 10_000 })
    const mine = tickets.mint({ terminalId: 't1', sessionKey: S1 })
    const yours = tickets.mint({ terminalId: 't1', sessionKey: S2 })
    for (let i = 0; i < 3; i++) tickets.redeem(`bad-${i}`, { terminalId: 't1', sessionKey: S2 })
    expect(tickets.redeem(yours.ticket, { terminalId: 't1', sessionKey: S2 })).toEqual({ ok: false, reason: 'rate_limited' })
    expect(tickets.redeem(mine.ticket, { terminalId: 't1', sessionKey: S1 })).toEqual({ ok: true })
  })

  it('a wrong-terminal or wrong-session presentation counts against the PRESENTER, an expired ticket against nobody', () => {
    const { tickets, clock } = store({ maxFailures: 2, failureWindowMs: 10_000 })
    // S2 presents S1's ticket twice (wrong session), then is limited; S1 is not
    for (let i = 0; i < 2; i++) {
      const t = tickets.mint({ terminalId: 't1', sessionKey: S1 })
      expect(tickets.redeem(t.ticket, { terminalId: 't1', sessionKey: S2 })).toMatchObject({ reason: 'wrong_session' })
    }
    expect(tickets.redeem('anything', { terminalId: 't1', sessionKey: S2 })).toEqual({ ok: false, reason: 'rate_limited' })
    const own = tickets.mint({ terminalId: 't1', sessionKey: S1 })
    expect(tickets.redeem(own.ticket, { terminalId: 't1', sessionKey: S1 })).toEqual({ ok: true })
    // expired ones are free
    for (let i = 0; i < 5; i++) {
      const old = tickets.mint({ terminalId: 't1', sessionKey: S1 })
      clock.advance(31_000)
      expect(tickets.redeem(old.ticket, { terminalId: 't1', sessionKey: S1 })).toMatchObject({ reason: 'expired' })
    }
    const fine = tickets.mint({ terminalId: 't1', sessionKey: S1 })
    expect(tickets.redeem(fine.ticket, { terminalId: 't1', sessionKey: S1 })).toEqual({ ok: true })
  })

  it('never tracks an unbounded number of sessions', () => {
    const { tickets } = store({ maxFailures: 2 })
    for (let i = 0; i < 1000; i++) tickets.redeem('bad', { terminalId: 't1', sessionKey: `s-${i}`.padEnd(64, '0') })
    const internal = tickets as unknown as { failures: Map<string, number[]> }
    expect(internal.failures.size).toBeLessThanOrEqual(256)
  })

  it('bounds the number of pending tickets (the oldest is dropped) and prunes expired ones', () => {
    const { tickets, clock } = store({ maxPending: 3 })
    const first = tickets.mint({ terminalId: 't1', sessionKey: S1 })
    for (let i = 0; i < 3; i++) tickets.mint({ terminalId: 't1', sessionKey: S1 })
    expect(tickets.pendingCount()).toBe(3)
    expect(tickets.redeem(first.ticket, { terminalId: 't1', sessionKey: S1 })).toMatchObject({ ok: false })
    clock.advance(31_000)
    tickets.mint({ terminalId: 't1', sessionKey: S1 })
    expect(tickets.pendingCount()).toBe(1)
  })

  it('revokes the tickets of a closed terminal', () => {
    const { tickets } = store()
    const a = tickets.mint({ terminalId: 't1', sessionKey: S1 })
    const b = tickets.mint({ terminalId: 't2', sessionKey: S1 })
    tickets.revokeTerminal('t1')
    expect(tickets.redeem(a.ticket, { terminalId: 't1', sessionKey: S1 })).toMatchObject({ ok: false })
    expect(tickets.redeem(b.ticket, { terminalId: 't2', sessionKey: S1 }).ok).toBe(true)
  })

  it('keeps no plaintext ticket or cookie in its state', () => {
    const { tickets } = store()
    const { ticket } = tickets.mint({ terminalId: 't1', sessionKey: sessionKeyOf('raw-cookie-value') })
    const dump = JSON.stringify(tickets, (_k, v) => (v && typeof v === 'object' && v.type === 'Buffer' ? Buffer.from(v.data).toString('base64url') : v))
    expect(dump).not.toContain(ticket)
    expect(dump).not.toContain('raw-cookie-value')
  })
})

describe('sessionKeyOf', () => {
  it('is a stable SHA-256 hex digest that differs per cookie', () => {
    expect(sessionKeyOf('a')).toMatch(/^[0-9a-f]{64}$/)
    expect(sessionKeyOf('a')).toBe(sessionKeyOf('a'))
    expect(sessionKeyOf('a')).not.toBe(sessionKeyOf('b'))
  })
})

describe('Scrollback', () => {
  it('keeps everything while below the bound', () => {
    const s = new Scrollback(16)
    s.push(Buffer.from('hello '))
    s.push(Buffer.from('world'))
    expect(s.snapshot().toString()).toBe('hello world')
    expect(s.size).toBe(11)
    expect(s.truncated).toBe(false)
  })

  it('keeps only the last maxBytes, across wrap-around', () => {
    const s = new Scrollback(10)
    s.push(Buffer.from('0123456'))
    s.push(Buffer.from('789abcd'))
    expect(s.snapshot().toString()).toBe('456789abcd')
    expect(s.size).toBe(10)
    s.push(Buffer.from('XY'))
    expect(s.snapshot().toString()).toBe('6789abcdXY')
    expect(s.truncated).toBe(true)
  })

  it('handles a chunk larger than the buffer and an exact fit', () => {
    const s = new Scrollback(8)
    s.push(Buffer.from('abcdefghijkl'))
    expect(s.snapshot().toString()).toBe('efghijkl')
    const t = new Scrollback(4)
    t.push(Buffer.from('abcd'))
    expect(t.snapshot().toString()).toBe('abcd')
    expect(t.truncated).toBe(false)
  })

  it('never exceeds its bound under a long random stream and matches a naive tail', () => {
    const max = 257
    const s = new Scrollback(max)
    let all = Buffer.alloc(0)
    let seed = 12345
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff)
    for (let i = 0; i < 400; i++) {
      const chunk = Buffer.alloc(1 + (rnd() % 120), 0x41 + (i % 26))
      s.push(chunk)
      all = Buffer.concat([all, chunk])
      expect(s.size).toBeLessThanOrEqual(max)
      expect(s.snapshot().equals(all.subarray(Math.max(0, all.length - max)))).toBe(true)
    }
  })

  it('starts the replay on a UTF-8 boundary after a cut', () => {
    const s = new Scrollback(6)
    s.push(Buffer.from('é€x')) // c3 a9 e2 82 ac 78 = 6 bytes, exact fit
    expect(s.snapshot().toString()).toBe('é€x')
    s.push(Buffer.from('y')) // drops the first byte: a9 becomes an orphan continuation byte
    expect(s.snapshot().toString('utf8')).toBe('€xy')
  })

  it('ignores empty chunks, can be cleared, and rejects a bad size', () => {
    const s = new Scrollback(4)
    s.push(Buffer.alloc(0))
    expect(s.size).toBe(0)
    s.push(Buffer.from('ab'))
    s.clear()
    expect(s.snapshot().length).toBe(0)
    expect(() => new Scrollback(0)).toThrow()
    expect(() => new Scrollback(1.5)).toThrow()
  })
})

describe('TokenBucket', () => {
  it('allows a burst, then refills at the sustained rate', () => {
    const clock = makeClock()
    const b = new TokenBucket(1000, 500, clock.fn)
    expect(b.take(1000)).toBe(true)
    expect(b.take(1)).toBe(false)
    clock.advance(1000)
    expect(b.take(500)).toBe(true)
    expect(b.take(1)).toBe(false)
    clock.advance(60_000)
    expect(b.take(1001)).toBe(false) // never more than the capacity
    expect(b.take(1000)).toBe(true)
  })
  it('takes nothing when the request is refused', () => {
    const clock = makeClock()
    const b = new TokenBucket(10, 10, clock.fn)
    expect(b.take(11)).toBe(false)
    expect(b.take(10)).toBe(true)
  })
})
