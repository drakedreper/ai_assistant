import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createSecurity, loadOrCreateSecrets, readSecretsFile, safeEqual, secretsPath, writeSecretsFile } from '../src/security'
import { json, makeClock, makeDaemon, makeTmp, type TestDaemon } from './helpers'

const open: TestDaemon[] = []
const tmps: Array<() => void> = []
afterEach(async () => {
  for (const d of open.splice(0)) await d.cleanup()
  for (const c of tmps.splice(0)) c()
})
async function daemon(opts: Parameters<typeof makeDaemon>[0] = {}): Promise<TestDaemon> {
  const d = await makeDaemon(opts)
  open.push(d)
  return d
}

describe('Host header (DNS rebinding)', () => {
  it.each([
    ['evil.example.com', 'a foreign host'],
    ['127.0.0.1:9999', 'the right host on the wrong port'],
    ['127.0.0.1', 'no port'],
    ['localhost', 'localhost without a port'],
    ['127.0.0.1:7421.evil.com', 'a suffix attack'],
    ['[::1]:7421', 'IPv6 loopback (the daemon binds IPv4 only)'],
    ['0.0.0.0:7421', 'the wildcard address'],
  ])('rejects %s (%s) with 403 on every route class', async (host) => {
    const d = await daemon()
    for (const path of ['/api/health', '/', '/hooks/Stop']) {
      const res = path.startsWith('/hooks')
        ? await d.hook('Stop', { session_id: 's' }, { headers: { Host: host } })
        : await d.call(path, { host })
      expect(res.status, `${path} with Host ${host}`).toBe(403)
      expect((await json(res)).error).toBe('forbidden_host')
    }
  })

  it('rejects a missing Host header', async () => {
    const d = await daemon()
    const res = await d.call('/api/health', { host: false })
    expect(res.status).toBe(403)
  })

  it('accepts 127.0.0.1:PORT and localhost:PORT, case-insensitively', async () => {
    const d = await daemon()
    expect((await d.call('/api/health', { host: '127.0.0.1:7421' })).status).toBe(200)
    expect((await d.call('/api/health', { host: 'localhost:7421' })).status).toBe(200)
    expect((await d.call('/api/health', { host: 'LOCALHOST:7421' })).status).toBe(200)
  })

  it('is checked before authentication, so a rebinding page learns nothing about login state', async () => {
    const d = await daemon({ signIn: false })
    const res = await d.call('/api/snapshot', { host: 'evil.com' })
    expect(res.status).toBe(403)
  })
})

describe('Origin', () => {
  it('rejects a foreign Origin on non-GET requests', async () => {
    const d = await daemon()
    for (const origin of ['http://evil.example.com', 'https://127.0.0.1:7421', 'http://127.0.0.1:7422', 'null', 'http://localhost:5174']) {
      const res = await d.call('/api/chat', { json: { text: 'hi' }, origin })
      expect(res.status, origin).toBe(403)
      expect((await json(res)).error).toBe('forbidden_origin')
    }
    expect(d.lane.sent).toHaveLength(0)
  })

  it('requires an Origin on non-GET browser requests, even with a valid cookie', async () => {
    const d = await daemon()
    const res = await d.call('/api/chat', { json: { text: 'hi' }, origin: false })
    expect(res.status).toBe(403)
  })

  it('rejects a foreign Origin on GET too, but lets a GET without Origin through', async () => {
    const d = await daemon()
    expect((await d.call('/api/health', { origin: 'http://evil.example.com' })).status).toBe(403)
    expect((await d.call('/api/health')).status).toBe(200)
  })

  it('accepts the daemon origins and the dev server origins', async () => {
    const d = await daemon()
    for (const origin of ['http://127.0.0.1:7421', 'http://localhost:7421', 'http://127.0.0.1:5173', 'http://localhost:5173']) {
      const res = await d.call('/api/chat', { json: { text: 'hi' }, origin })
      expect(res.status, origin).toBe(202)
    }
  })

  it('preflight requests from other origins are refused and no CORS headers ever appear', async () => {
    const d = await daemon()
    const res = await d.call('/api/chat', {
      method: 'OPTIONS',
      origin: 'http://evil.example.com',
      headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
    })
    expect(res.status).toBe(403)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('never sends Access-Control-* headers on any kind of response', async () => {
    const d = await daemon()
    const responses = [
      await d.call('/api/health'),
      await d.call('/api/health', { origin: 'http://localhost:5173' }),
      await d.call('/api/nope'),
      await d.call('/api/snapshot', { cookie: false }),
      await d.call('/api/chat', { json: { text: 'x' }, origin: 'http://evil.example.com' }),
      await d.call('/api/chat', { method: 'OPTIONS', origin: 'http://localhost:5173' }),
      await d.call('/', { host: 'evil.com' }),
      await d.hook('Stop', { session_id: 's' }),
    ]
    for (const res of responses) {
      for (const [k] of res.headers.entries()) expect(k.toLowerCase().startsWith('access-control-'), k).toBe(false)
    }
  })
})

describe('Content-Type on mutating routes', () => {
  it.each(['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/xml'])('rejects %s with 415', async (contentType) => {
    const d = await daemon()
    const res = await d.call('/api/chat', { body: '{"text":"hi"}', contentType })
    expect(res.status).toBe(415)
    expect((await json(res)).error).toBe('unsupported_media_type')
    expect(d.lane.sent).toHaveLength(0)
  })

  it('also applies to PUT, PATCH and the exchange route', async () => {
    const d = await daemon()
    expect((await d.call('/api/settings/guest', { method: 'PUT', body: '{"on":true}', contentType: 'text/plain' })).status).toBe(415)
    expect((await d.call('/api/tasks/x', { method: 'PATCH', body: '{"column":"done"}', contentType: 'text/plain' })).status).toBe(415)
    expect((await d.call('/api/auth/exchange', { body: '{"code":"x"}', contentType: 'text/plain', cookie: false })).status).toBe(415)
  })

  it('accepts application/json with a charset', async () => {
    const d = await daemon()
    const res = await d.call('/api/chat', { json: { text: 'hi' }, contentType: 'application/json; charset=utf-8' })
    expect(res.status).toBe(202)
  })

  it('lets a body-less POST without a Content-Type through (interrupt has no body)', async () => {
    const d = await daemon()
    const res = await d.call('/api/chat/interrupt', { method: 'POST' })
    expect(res.status).toBe(202)
  })

  it('is checked after Origin and before the cookie', async () => {
    const d = await daemon({ signIn: false })
    const res = await d.call('/api/chat', { body: 'x', contentType: 'text/plain', cookie: false })
    expect(res.status).toBe(415)
  })
})

describe('browser session cookie', () => {
  it('rejects a missing, empty, forged or truncated cookie with 401', async () => {
    const d = await daemon()
    const name = d.daemon.security.cookieName()
    for (const cookie of [false as const, '', `${name}=`, `${name}=forged-value-0123456789`, `other=1`, (d.cookie ?? '').slice(0, -4)]) {
      const res = await d.call('/api/snapshot', { cookie })
      expect(res.status, String(cookie)).toBe(401)
      expect((await json(res)).error).toBe('unauthorized')
    }
  })

  it('protects every browser route, not just the snapshot', async () => {
    const d = await daemon()
    const routes: Array<[string, string]> = [
      ['GET', '/api/health'], ['GET', '/api/snapshot'], ['GET', '/api/tasks'], ['POST', '/api/chat'], ['POST', '/api/chat/interrupt'],
      ['POST', '/api/approvals/x/decision'], ['POST', '/api/proposals/x/decision'], ['POST', '/api/tasks'], ['PATCH', '/api/tasks/x'],
      ['DELETE', '/api/tasks/x'], ['PUT', '/api/settings/guest'], ['PUT', '/api/settings/webcam'], ['PUT', '/api/settings/persona'],
      ['PUT', '/api/settings/claude-mode'], ['PUT', '/api/settings/trust/tr-read'], ['DELETE', '/api/learned/x'], ['GET', '/ws'], ['GET', '/api/unknown'],
    ]
    for (const [method, path] of routes) {
      const res = await d.call(path, { method, cookie: false, json: method === 'GET' || method === 'DELETE' ? undefined : {} })
      expect(res.status, `${method} ${path}`).toBe(401)
    }
  })

  it('expires sessions after the configured lifetime', async () => {
    const d = await daemon()
    expect((await d.call('/api/health')).status).toBe(200)
    d.clock.advance(31 * 24 * 3_600_000)
    expect((await d.call('/api/health')).status).toBe(401)
  })

  it('does not accept the hook token (or anything else) in the Authorization header or query string', async () => {
    const d = await daemon({ signIn: false })
    const hookToken = d.daemon.security.hookToken()
    expect((await d.call('/api/snapshot', { cookie: false, headers: { Authorization: `Bearer ${hookToken}` } })).status).toBe(401)
    expect((await d.call(`/api/snapshot?token=${hookToken}`, { cookie: false })).status).toBe(401)
    expect((await d.call(`/api/snapshot?code=${d.daemon.security.issueExchangeCode().code}`, { cookie: false })).status).toBe(401)
    expect((await d.call('/api/snapshot', { cookie: false, headers: { Authorization: `Bearer ${hookToken}` }, origin: 'http://localhost:5173' })).status).toBe(401)
  })

  it('sets security headers on every response, including rejections', async () => {
    const d = await daemon()
    for (const res of [await d.call('/api/health'), await d.call('/api/snapshot', { cookie: false }), await d.call('/api/x'), await d.call('/', { host: 'evil.com' })]) {
      expect(res.headers.get('x-content-type-options')).toBe('nosniff')
      expect(res.headers.get('x-frame-options')).toBe('DENY')
      expect(res.headers.get('referrer-policy')).toBe('no-referrer')
      expect(res.headers.get('cross-origin-opener-policy')).toBe('same-origin')
      expect(res.headers.get('cross-origin-resource-policy')).toBe('same-origin')
      expect(res.headers.get('permissions-policy')).toContain('geolocation=()')
    }
    const api = await d.call('/api/health')
    expect(api.headers.get('cache-control')).toBe('no-store')
    expect(api.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
  })
})

describe('hook route authentication', () => {
  const event = { session_id: 'sess-x', hook_event_name: 'Stop' }

  it('accepts only the bearer hook token', async () => {
    const d = await daemon()
    const ok = await d.hook('Stop', event)
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({})
  })

  it('rejects a browser session cookie on the hook route', async () => {
    const d = await daemon()
    const res = await d.hook('Stop', event, { token: false, headers: { Cookie: d.cookie ?? '' } })
    expect(res.status).toBe(401)
    await d.daemon.ctx.hooks.drain()
    expect(d.daemon.store.countEvents()).toBe(0)
  })

  it('rejects the exchange code, a wrong token, a prefix, a longer token, and a missing or malformed header', async () => {
    const d = await daemon()
    const real = d.daemon.security.hookToken()
    const code = d.daemon.security.issueExchangeCode().code
    const bad: Array<string | false> = [code, 'wrong', real.slice(0, -1), `${real}x`, `${real} extra`, 'Bearer', real, false]
    for (const token of bad) {
      const headers: Record<string, string> = {}
      if (token === real) headers.Authorization = real // no "Bearer " scheme
      const res = await d.hook('Stop', event, token === real ? { token: false, headers } : { token })
      expect(res.status, String(token)).toBe(401)
    }
    await d.daemon.ctx.hooks.drain()
    expect(d.daemon.store.countEvents()).toBe(0)
  })

  it('checks Host, and Origin when one is present, but does not require an Origin', async () => {
    const d = await daemon()
    expect((await d.hook('Stop', event, { headers: { Origin: 'http://evil.example.com' } })).status).toBe(403)
    expect((await d.hook('Stop', event, { headers: { Origin: 'http://127.0.0.1:7421' } })).status).toBe(200)
    expect((await d.hook('Stop', event)).status).toBe(200)
  })

  it('does not enforce Content-Type (the exact client headers were not verified) and still fails open', async () => {
    const d = await daemon()
    const res = await d.hook('Stop', event, { headers: { 'Content-Type': 'text/plain' } })
    expect(res.status).toBe(200)
  })

  it('rejects other methods with 404 or 405 rather than processing them', async () => {
    const d = await daemon()
    const res = await d.daemon.app.request('/hooks/Stop', { method: 'GET', headers: { Host: '127.0.0.1:7421', Authorization: `Bearer ${d.daemon.security.hookToken()}` } })
    expect([404, 405]).toContain(res.status)
  })
})

describe('exchange code', () => {
  it('swaps a valid code for an HttpOnly, SameSite=Strict, Path=/ cookie without Secure', async () => {
    const d = await daemon({ signIn: false })
    const { code } = d.daemon.security.issueExchangeCode()
    const res = await d.call('/api/auth/exchange', { json: { code }, cookie: false })
    expect(res.status).toBe(200)
    const cookie = res.headers.get('set-cookie') ?? ''
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Strict')
    expect(cookie).toContain('Path=/')
    expect(cookie).not.toMatch(/;\s*Secure/i)
    expect(cookie).toMatch(/Max-Age=\d+/)
    expect(cookie).not.toContain(code)
    const value = cookie.split(';')[0]!
    expect((await d.call('/api/health', { cookie: value })).status).toBe(200)
  })

  it('is single use', async () => {
    const d = await daemon({ signIn: false })
    const { code } = d.daemon.security.issueExchangeCode()
    expect((await d.call('/api/auth/exchange', { json: { code }, cookie: false })).status).toBe(200)
    const again = await d.call('/api/auth/exchange', { json: { code }, cookie: false })
    expect(again.status).toBe(401)
    expect((await json(again)).error).toBe('invalid_code')
  })

  it('expires', async () => {
    const d = await daemon({ signIn: false })
    const { code } = d.daemon.security.issueExchangeCode()
    d.clock.advance(16 * 60_000)
    expect((await d.call('/api/auth/exchange', { json: { code }, cookie: false })).status).toBe(401)
  })

  it('issuing a new code invalidates the previous one', async () => {
    const d = await daemon({ signIn: false })
    const first = d.daemon.security.issueExchangeCode().code
    const second = d.daemon.security.issueExchangeCode().code
    expect((await d.call('/api/auth/exchange', { json: { code: first }, cookie: false })).status).toBe(401)
    expect((await d.call('/api/auth/exchange', { json: { code: second }, cookie: false })).status).toBe(200)
  })

  it('rejects wrong codes, a missing code and a short code, and needs Origin and JSON like any POST', async () => {
    const d = await daemon({ signIn: false })
    d.daemon.security.issueExchangeCode()
    expect((await d.call('/api/auth/exchange', { json: { code: 'x'.repeat(43) }, cookie: false })).status).toBe(401)
    expect((await d.call('/api/auth/exchange', { json: {}, cookie: false })).status).toBe(400)
    expect((await d.call('/api/auth/exchange', { json: { code: 'short' }, cookie: false })).status).toBe(400)
    expect((await d.call('/api/auth/exchange', { json: { code: 'x'.repeat(43) }, cookie: false, origin: 'http://evil.com' })).status).toBe(403)
    expect((await d.call('/api/auth/exchange', { json: { code: 'x'.repeat(43) }, cookie: false, origin: false })).status).toBe(403)
  })

  it('is rate limited for WRONG codes, but a correct code is never refused (nobody can lock the owner out by guessing)', async () => {
    const d = await daemon({ signIn: false })
    const { code } = d.daemon.security.issueExchangeCode()
    for (let i = 0; i < 10; i++) {
      expect((await d.call('/api/auth/exchange', { json: { code: `${'y'.repeat(42)}${i}` }, cookie: false })).status).toBe(401)
    }
    // tripped: further wrong codes are refused outright, with a Retry-After
    const limited = await d.call('/api/auth/exchange', { json: { code: 'z'.repeat(43) }, cookie: false })
    expect(limited.status).toBe(429)
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)
    // ... but the owner's code still works at once (it used to be refused until the window passed: a local denial of service)
    expect((await d.call('/api/auth/exchange', { json: { code }, cookie: false })).status).toBe(200)
  })

  it('the limiter forgets after its window, and a good sign-in clears it', async () => {
    const d = await daemon({ signIn: false })
    const first = d.daemon.security.issueExchangeCode().code
    for (let i = 0; i < 10; i++) await d.call('/api/auth/exchange', { json: { code: `${'y'.repeat(42)}${i}` }, cookie: false })
    expect((await d.call('/api/auth/exchange', { json: { code: 'z'.repeat(43) }, cookie: false })).status).toBe(429)
    d.clock.advance(61_000)
    expect((await d.call('/api/auth/exchange', { json: { code: 'z'.repeat(43) }, cookie: false })).status).toBe(401) // wrong again, but no longer limited
    expect((await d.call('/api/auth/exchange', { json: { code: first }, cookie: false })).status).toBe(200)
    expect((await d.call('/api/auth/exchange', { json: { code: first }, cookie: false })).status).toBe(401) // single use
  })

  it('the exchange route is the only open API route', async () => {
    const d = await daemon({ signIn: false })
    const { code } = d.daemon.security.issueExchangeCode()
    expect((await d.call('/api/auth/exchange', { json: { code }, cookie: false })).status).toBe(200)
    expect((await d.call('/api/health', { cookie: false })).status).toBe(401)
  })

  it('records a successful sign-in in the audit log without storing the code or cookie', async () => {
    const d = await daemon({ signIn: false })
    await d.signIn()
    const rows = d.daemon.store.listAudit(10)
    expect(rows[0]?.action).toBe('Signed in from a browser')
    expect(JSON.stringify(rows)).not.toContain(d.cookie?.split('=')[1] ?? 'impossible')
  })
})

describe('safeEqual', () => {
  it('compares equal-length digests and never throws on different lengths', () => {
    expect(safeEqual('abc', 'abc')).toBe(true)
    expect(safeEqual('abc', 'abd')).toBe(false)
    expect(safeEqual('abc', 'abcd')).toBe(false)
    expect(safeEqual('', '')).toBe(true)
    expect(safeEqual('', 'a')).toBe(false)
    expect(safeEqual('é', 'é')).toBe(true)
  })
})

describe('secrets file', () => {
  it('creates 256-bit tokens, per install, in a 0600 file, and reuses them', () => {
    const a = makeTmp()
    const b = makeTmp()
    tmps.push(a.cleanup, b.cleanup)
    const s1 = loadOrCreateSecrets(a.dir)
    const s2 = loadOrCreateSecrets(a.dir)
    const other = loadOrCreateSecrets(b.dir)
    expect(Buffer.from(s1.hookToken, 'base64url')).toHaveLength(32)
    expect(s2.hookToken).toBe(s1.hookToken)
    expect(other.hookToken).not.toBe(s1.hookToken)
    if (process.platform !== 'win32') expect(statSync(secretsPath(a.dir)).mode & 0o777).toBe(0o600)
  })

  it('sets a corrupt file aside and starts fresh instead of trusting it', () => {
    const t = makeTmp()
    tmps.push(t.cleanup)
    writeFileSync(secretsPath(t.dir), '{ not json')
    const s = loadOrCreateSecrets(t.dir)
    expect(s.hookToken.length).toBeGreaterThanOrEqual(32)
    expect(readdirSync(t.dir).some((f) => f.startsWith('secrets.json.corrupt-'))).toBe(true)
    expect(readSecretsFile(t.dir)?.hookToken).toBe(s.hookToken)
  })

  it('readSecretsFile never creates anything', () => {
    const t = makeTmp()
    tmps.push(t.cleanup)
    expect(readSecretsFile(t.dir)).toBeNull()
    expect(existsSync(secretsPath(t.dir))).toBe(false)
  })

  it('keeps browser sessions across a restart but stores only their hash', async () => {
    const t = makeTmp()
    tmps.push(t.cleanup)
    const clock = makeClock()
    const opts = { dataDir: t.dir, port: 7421, devOrigins: [], exchangeCodeTtlMs: 60_000, sessionTtlMs: 3_600_000, now: clock.fn }
    const first = createSecurity(opts)
    const { code } = first.issueExchangeCode()
    const ex = first.exchange(code)
    if (!ex.ok) throw new Error('exchange failed')
    expect(first.validateSession(ex.token)).toBe(true)
    const raw = readFileSync(secretsPath(t.dir), 'utf8')
    expect(raw).not.toContain(ex.token)

    const second = createSecurity(opts)
    expect(second.validateSession(ex.token)).toBe(true)
    expect(second.validateSession('nope')).toBe(false)
    clock.advance(2 * 3_600_000)
    expect(second.validateSession(ex.token)).toBe(false)
  })

  it('revokeAllSessions logs everyone out', () => {
    const t = makeTmp()
    tmps.push(t.cleanup)
    const sec = createSecurity({ dataDir: t.dir, port: 7421, devOrigins: [], exchangeCodeTtlMs: 60_000, sessionTtlMs: 60_000 })
    const ex = sec.exchange(sec.issueExchangeCode().code)
    if (!ex.ok) throw new Error('exchange failed')
    sec.revokeAllSessions()
    expect(sec.validateSession(ex.token)).toBe(false)
  })

  it('a running daemon picks up a hook token rotated on disk, and the old one stops working', async () => {
    const d = await daemon()
    const old = d.daemon.security.hookToken()
    expect((await d.hook('Stop', { session_id: 's' })).status).toBe(200)
    const secrets = readSecretsFile(d.dataDir)!
    const fresh = 'N'.repeat(43)
    // mtime granularity: make sure the rewrite is visibly newer
    await new Promise((r) => setTimeout(r, 20))
    writeSecretsFile(d.dataDir, { ...secrets, hookToken: fresh })
    expect((await d.hook('Stop', { session_id: 's' }, { token: old })).status).toBe(401)
    expect((await d.hook('Stop', { session_id: 's' }, { token: fresh })).status).toBe(200)
    expect(join(d.dataDir, 'secrets.json')).toBe(secretsPath(d.dataDir))
  })
})

describe('Content-Security-Policy value', () => {
  it('has the strict directives from the security model, with the real port', async () => {
    const d = await daemon()
    const csp = d.daemon.security.csp()
    for (const part of [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      'connect-src \'self\' ws://127.0.0.1:7421 ws://localhost:7421',
      "img-src 'self' data: blob:",
      "worker-src 'self' blob:",
      "frame-ancestors 'none'",
      "base-uri 'none'",
    ]) {
      expect(csp).toContain(part)
    }
    expect(csp).not.toContain('unsafe-eval')
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/)
    expect(csp).not.toContain('*')
  })
})
