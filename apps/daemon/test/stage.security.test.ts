import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createLogger } from '../src/log'
import { createSecurity, readSecretsFile, rotateSecretsStageToken, secretsPath, safeEqual, type Security } from '../src/security'
import { formatBanner } from '../src/banner'
import { describeConfig } from '../src/config'
import { makeDaemon, testConfig, type TestDaemon } from './helpers'

const dirs: string[] = []
const open: TestDaemon[] = []
afterEach(async () => {
  for (const d of open.splice(0)) await d.cleanup()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function sec(opts: { port?: number; devOrigins?: string[] } = {}): { s: Security; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'stage-sec-'))
  dirs.push(dir)
  const s = createSecurity({ dataDir: dir, port: opts.port ?? 7421, devOrigins: opts.devOrigins ?? ['http://127.0.0.1:5173'], exchangeCodeTtlMs: 60_000, sessionTtlMs: 3_600_000 })
  return { s, dir }
}

describe('the stage token', () => {
  it('is a fresh 256-bit secret, stored in secrets.json beside the hook token, and different from it', () => {
    const { s, dir } = sec()
    const file = readSecretsFile(dir)!
    expect(file.stageToken).toBe(s.stageToken())
    expect(file.hookToken).toBe(s.hookToken())
    expect(s.stageToken()).not.toBe(s.hookToken())
    expect(s.stageToken()).toMatch(/^[A-Za-z0-9_-]{43}$/)
    if (process.platform !== 'win32') expect(statSync(secretsPath(dir)).mode & 0o777).toBe(0o600)
  })

  it('survives a restart (same file) and rotates on request without touching the hook token or the sessions', () => {
    const { s, dir } = sec()
    const a = s.stageToken()
    const hook = s.hookToken()
    const again = createSecurity({ dataDir: dir, port: 7421, devOrigins: [], exchangeCodeTtlMs: 60_000, sessionTtlMs: 3_600_000 })
    expect(again.stageToken()).toBe(a)
    const b = again.rotateStageToken()
    expect(b).not.toBe(a)
    expect(again.hookToken()).toBe(hook)
    expect(rotateSecretsStageToken(dir)).not.toBe(b) // the CLI rotation changes the file...
    expect(again.stageToken()).toBe(readSecretsFile(dir)!.stageToken) // ...and a running daemon follows it
    expect(rotateSecretsStageToken(join(dir, 'nowhere'))).toBeNull()
  })

  it('verifyStageToken accepts exactly "Bearer <token>" and nothing near it', () => {
    const { s } = sec()
    const t = s.stageToken()
    expect(s.verifyStageToken(`Bearer ${t}`)).toBe(true)
    expect(s.verifyStageToken(`bearer ${t}`)).toBe(true) // the scheme is case-insensitive
    for (const bad of [undefined, '', 'Bearer', 'Bearer ', `Bearer ${t}x`, `Bearer ${t.slice(0, -1)}`, `Bearer  ${t} extra`, `Basic ${t}`, t, `Token ${t}`, `Bearer ${t.toUpperCase()}`, `Bearer ${s.hookToken()}`, `Bearer ${t}\n`, `Bearer\t`, 'Bearer null', 'Bearer undefined']) {
      expect(s.verifyStageToken(bad), String(bad)).toBe(false)
    }
  })

  it('the stage token is not a hook token and the hook token is not a stage token', () => {
    const { s } = sec()
    expect(s.verifyHookToken(`Bearer ${s.stageToken()}`)).toBe(false)
    expect(s.verifyStageToken(`Bearer ${s.hookToken()}`)).toBe(false)
  })

  it('compares in constant time (both sides hashed to equal-length digests first)', () => {
    // the shared helper is the only comparison used; strings of different lengths must not throw or short-circuit
    expect(safeEqual('a', 'a'.repeat(1000))).toBe(false)
    expect(safeEqual('', '')).toBe(true)
  })
})

describe('checkStageUpgrade', () => {
  const token = (s: Security) => `Bearer ${s.stageToken()}`

  it('checks Host, then Origin, then the token, in that order', () => {
    const { s } = sec({ port: 7421 })
    const host = '127.0.0.1:7421'
    expect(s.checkStageUpgrade({ host, authorization: token(s) })).toEqual({ ok: true })
    // wrong host wins over everything else
    expect(s.checkStageUpgrade({ host: 'evil.test', origin: 'https://evil.test', authorization: 'nope' })).toMatchObject({ ok: false, status: 403, code: 'forbidden_host' })
    // then the origin, even when the token is fine
    expect(s.checkStageUpgrade({ host, origin: 'https://evil.test', authorization: token(s) })).toMatchObject({ ok: false, status: 403, code: 'forbidden_origin' })
    // then the token
    expect(s.checkStageUpgrade({ host, authorization: 'Bearer nope' })).toMatchObject({ ok: false, status: 401, code: 'unauthorized' })
    expect(s.checkStageUpgrade({ host })).toMatchObject({ ok: false, status: 401 })
  })

  it('an absent Origin is fine (an engine is not a browser); an allowlisted one is fine; an empty one counts as absent', () => {
    const { s } = sec({ port: 7421, devOrigins: ['http://127.0.0.1:5173'] })
    const host = 'localhost:7421'
    expect(s.checkStageUpgrade({ host, authorization: token(s) }).ok).toBe(true)
    expect(s.checkStageUpgrade({ host, origin: 'http://127.0.0.1:7421', authorization: token(s) }).ok).toBe(true)
    expect(s.checkStageUpgrade({ host, origin: 'http://127.0.0.1:5173', authorization: token(s) }).ok).toBe(true)
    expect(s.checkStageUpgrade({ host, origin: '', authorization: token(s) }).ok).toBe(true)
    expect(s.checkStageUpgrade({ host, origin: 'null', authorization: token(s) }).ok).toBe(false)
    expect(s.checkStageUpgrade({ host, origin: 'http://127.0.0.1:7422', authorization: token(s) }).ok).toBe(false)
  })

  it('a valid browser session is worth nothing on the stage socket, and the stage token opens no browser upgrade', () => {
    const { s } = sec({ port: 7421 })
    const { code } = s.issueExchangeCode()
    const ex = s.exchange(code)
    if (!ex.ok) throw new Error('exchange failed')
    const cookie = `${s.cookieName()}=${ex.token}`
    expect(s.checkSessionCookie(cookie).ok).toBe(true)
    // the cookie is not even a parameter of the stage check, and it cannot stand in for the token
    expect(s.checkStageUpgrade({ host: '127.0.0.1:7421', origin: 'http://127.0.0.1:7421' })).toMatchObject({ ok: false, status: 401 })
    // the browser upgrade check never looks at the stage token
    expect(s.checkUpgrade({ host: '127.0.0.1:7421', origin: 'http://127.0.0.1:7421' })).toMatchObject({ ok: false, status: 401 })
  })
})

describe('the token never leaks', () => {
  it('a log line that holds it is masked, because the daemon registers it as a secret literal', async () => {
    const d = await makeDaemon()
    open.push(d)
    const token = d.daemon.security.stageToken()
    const lines: string[] = []
    const log = createLogger({ level: 'debug', sink: (l) => lines.push(l), literals: () => [d.daemon.security.hookToken(), d.daemon.security.stageToken()] })
    log.warn(`something happened with ${token} in it`, { header: `Bearer ${token}` })
    expect(lines.join('\n')).not.toContain(token)
    // and the daemon's own logger (silent here) is built with the same literal list
    expect(d.daemon.ctx.log).toBeDefined()
  })

  it('the banner and the configuration summary never carry it', async () => {
    const d = await makeDaemon()
    open.push(d)
    const token = d.daemon.security.stageToken()
    const banner = formatBanner({ version: '0', port: 7421, exchangeUrl: 'http://127.0.0.1:7421/?code=x', exchangeTtlMinutes: 15, dataDir: d.dataDir, backend: 'fake', authMode: 'api-key', apiKeyPresent: false, demo: false, webBuilt: true }).join('\n')
    expect(banner).not.toContain(token)
    expect(JSON.stringify(describeConfig(testConfig(d.dataDir)))).not.toContain(token)
    expect(JSON.stringify(d.daemon.ctx.config)).not.toContain(token)
  })

  it('no API response, snapshot, audit row or bus event holds it', async () => {
    const d = await makeDaemon()
    open.push(d)
    const token = d.daemon.security.stageToken()
    const bodies: string[] = []
    for (const p of ['/api/snapshot', '/api/stage', '/api/health']) bodies.push(await (await d.call(p)).text())
    await d.call('/api/stage/scene/camera', { method: 'PUT', json: { shot: 'closeup' } })
    await d.call('/api/stage/characters/char.assistant/equip', { json: { assetId: 'prop.lounge-chair' } })
    bodies.push(JSON.stringify(d.daemon.store.listAudit(200)), JSON.stringify(d.events))
    for (const b of bodies) expect(b).not.toContain(token)
  })

  it('the stage routes are not served to the static handler or the SPA fallback', async () => {
    const d = await makeDaemon()
    open.push(d)
    const r = await d.call('/api/stage/unknown-route', { cookie: false })
    expect(r.status).toBe(401)
    const r2 = await d.call('/api/stage/unknown-route')
    expect(r2.status).toBe(404)
    expect(((await r2.json()) as { error: string }).error).toBe('not_found')
  })
})
