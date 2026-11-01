import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import type { ServerEvent } from '@ai-assistant/shared'
import { createDaemon } from '../src/app'
import { runRevokeCli } from '../src/cli/revoke'
import { createLogger } from '../src/log'
import { hideTerminals } from '../src/routes'
import { createSecurity, ensurePrivateDir, ensurePrivateFile, hardenDbFiles, loadOrCreateSecrets, readSecretsFile, writeSecretsFile } from '../src/security'
import { openStore } from '../src/store'
import { FakeLane, createTestBudget, makeClock, makeTmp, testConfig } from './helpers'
import { makeTerminalHarness, rawHttp, type TerminalHarness } from './terminalHarness'

/**
 * The findings of the adversarial review that live in the daemon's security core rather than in the terminal files proper:
 * signing out and revoking sessions, the logger knowing every secret, a private data folder, and what a dev-origin page may
 * read from the live feed.
 */

const open: TerminalHarness[] = []
const sockets: WebSocket[] = []
const cleanups: Array<() => void> = []
afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate()
  for (const h of open.splice(0)) await h.cleanup()
  for (const c of cleanups.splice(0)) c()
})
async function live(opts: Parameters<typeof makeTerminalHarness>[0] = {}): Promise<TerminalHarness> {
  const h = await makeTerminalHarness({ listen: true, ...opts })
  open.push(h)
  return h
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Sign a second browser in (a fresh one-time code through the real exchange route). */
async function signInAgain(h: TerminalHarness): Promise<string> {
  const { code } = h.daemon.security.issueExchangeCode()
  const res = await rawHttp(h.port, 'POST', '/api/auth/exchange', { code }, { Origin: h.origin })
  expect(res.status).toBe(200)
  return String(res.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? ''
}

interface Sock {
  ws: WebSocket
  messages: Array<Record<string, unknown>>
  /** The text of every text frame exactly as it arrived (to prove a string appears NOWHERE, not only in the fields a test knows about). */
  raw: string[]
  closed: Promise<{ code: number; reason: string }>
  closeInfo: { code: number; reason: string } | undefined
}
function openSocket(h: TerminalHarness, path: string, cookie: string, origin = h.origin): Promise<Sock> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${h.port}${path}`, { headers: { Origin: origin, Cookie: cookie } })
    sockets.push(ws)
    const s: Sock = { ws, messages: [], raw: [], closeInfo: undefined, closed: undefined as never }
    s.closed = new Promise((res) =>
      ws.on('close', (code, reason) => {
        s.closeInfo = { code, reason: reason.toString() }
        res(s.closeInfo)
      }),
    )
    ws.on('message', (d, bin) => {
      if (!bin) {
        s.raw.push(d.toString())
        s.messages.push(JSON.parse(d.toString()) as Record<string, unknown>)
      }
    })
    ws.once('open', () => resolve(s))
    ws.once('error', reject)
  })
}
async function until(cond: () => unknown, label: string, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`)
    await wait(10)
  }
}

describe('signing out (NO-SESSION-REVOCATION)', () => {
  it('POST /api/auth/signout ends this browser\'s session, clears the cookie, audits it, and leaves other browsers alone', async () => {
    const h = await live()
    const other = await signInAgain(h)
    expect((await h.call('/api/health')).status).toBe(200)
    const res = await h.call('/api/auth/signout', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, signedOut: 1 })
    expect(res.headers.get('set-cookie')).toMatch(/^aia_sid_\d+=;.*Max-Age=0/)
    expect((await h.call('/api/health')).status).toBe(401) // the old cookie is dead
    expect((await h.call('/api/health', { cookie: other })).status).toBe(200) // the other browser is not
    const audit = h.daemon.store.listAudit(10).find((a) => a.action === 'Signed out of this browser')
    expect(audit).toMatchObject({ actor: 'you', target: 'Local daemon', outcome: 'auto', detail: '1 session(s)' })
    expect(JSON.stringify(h.daemon.store.listAudit(10))).not.toContain(h.cookie.split('=')[1] as string)
  })

  it('{everywhere:true} signs every browser out, this one included', async () => {
    const h = await live()
    const other = await signInAgain(h)
    const res = await h.call('/api/auth/signout', { json: { everywhere: true } })
    expect(await res.json()).toEqual({ ok: true, signedOut: 2 })
    expect((await h.call('/api/health')).status).toBe(401)
    expect((await h.call('/api/health', { cookie: other })).status).toBe(401)
    expect(h.daemon.store.listAudit(10).some((a) => a.action === 'Signed out of every browser')).toBe(true)
    expect(readSecretsFile(h.dataDir)?.sessions).toEqual([])
  })

  it('is an ordinary browser route: it needs the cookie, an allowed Origin, a JSON body, and a body of the right shape', async () => {
    const h = await live()
    expect((await h.call('/api/auth/signout', { method: 'POST', cookie: false })).status).toBe(401)
    expect((await h.call('/api/auth/signout', { method: 'POST', origin: false })).status).toBe(403)
    expect((await h.call('/api/auth/signout', { method: 'POST', origin: 'http://evil.example' })).status).toBe(403)
    expect((await h.call('/api/auth/signout', { method: 'POST', host: 'evil.example' })).status).toBe(403)
    expect((await h.call('/api/auth/signout', { method: 'POST', body: 'x', contentType: 'text/plain' })).status).toBe(415)
    expect((await h.call('/api/auth/signout', { method: 'POST', body: '{nope', contentType: 'application/json' })).status).toBe(400)
    expect((await h.call('/api/auth/signout', { json: { everywhere: 'yes' } })).status).toBe(400)
    expect((await h.call('/api/auth/signout', { json: { everywhere: true, extra: 1 } })).status).toBe(400)
    expect((await h.call('/api/health')).status).toBe(200) // none of those signed anyone out
    expect((await h.call('/api/auth/signout', { method: 'GET' })).status).not.toBe(200)
  })

  it('closes the live feed and the terminal viewers of the signed-out session only, and the terminal keeps running', async () => {
    const h = await live()
    const other = await signInAgain(h)
    const t = await h.create({ kind: 'shell' })
    const feedMine = await openSocket(h, '/ws', h.cookie)
    const feedOther = await openSocket(h, '/ws', other)
    await until(() => feedMine.messages.length > 0 && feedOther.messages.length > 0, 'both hellos')
    const term = await openSocket(h, `/ws/terminal/${t.id}`, h.cookie)
    term.ws.send(JSON.stringify({ type: 'auth', ticket: await h.ticket(t.id) }))
    await until(() => term.messages.some((m) => m.type === 'ready'), 'the terminal to be ready')

    await h.call('/api/auth/signout', { method: 'POST' })
    expect((await feedMine.closed).code).toBe(4401)
    expect((await term.closed).code).toBe(4401)
    await wait(80)
    expect(feedOther.closeInfo).toBeUndefined() // another browser's feed is untouched
    expect(h.daemon.terminals.service.get(t.id)?.state).toBe('running') // the process is not the browser's to take with it
    // a new socket with the dead cookie is refused at the door
    await expect(openSocket(h, '/ws', h.cookie)).rejects.toBeTruthy()
  })

  it('a revocation made from the command line (the file changes on disk) is noticed: requests, feed and viewers', async () => {
    const h = await live({ heartbeatMs: 40 })
    const t = await h.create({ kind: 'shell' })
    const term = await openSocket(h, `/ws/terminal/${t.id}`, h.cookie)
    term.ws.send(JSON.stringify({ type: 'auth', ticket: await h.ticket(t.id) }))
    await until(() => term.messages.some((m) => m.type === 'ready'), 'ready')
    const feed = await openSocket(h, '/ws', h.cookie)
    await until(() => feed.messages.length > 0, 'the hello')

    await wait(25) // a visibly newer mtime
    const secrets = readSecretsFile(h.dataDir)!
    writeSecretsFile(h.dataDir, { ...secrets, sessions: [] }) // what `revoke` does
    expect((await h.call('/api/health')).status).toBe(401) // the very next request sees it
    // the viewers are closed by the heartbeat sweep (or at once by the revocation listener)
    expect((await term.closed).code).toBe(4401)
    h.daemon.ctx.ws()?.dropRevoked()
    expect((await feed.closed).code).toBe(4401)
    expect(h.daemon.terminals.service.get(t.id)?.state).toBe('running')
  })

  it('the daemon never overwrites a revocation with its own, older, list of sessions', () => {
    const t = makeTmp()
    cleanups.push(t.cleanup)
    const opts = { dataDir: t.dir, port: 7421, devOrigins: [], exchangeCodeTtlMs: 60_000, sessionTtlMs: 3_600_000 }
    const sec = createSecurity(opts)
    const a = sec.exchange(sec.issueExchangeCode().code)
    if (!a.ok) throw new Error('exchange failed')
    // the command line revokes everything (the daemon still has the session in memory)
    const file = readSecretsFile(t.dir)!
    writeSecretsFile(t.dir, { ...file, sessions: [] })
    // the daemon's next write (a new sign-in) must keep the revocation: it re-reads the file first
    const b = sec.exchange(sec.issueExchangeCode().code)
    if (!b.ok) throw new Error('exchange failed')
    expect(sec.validateSession(a.token)).toBe(false)
    expect(sec.validateSession(b.token)).toBe(true)
    expect(readSecretsFile(t.dir)?.sessions).toHaveLength(1)
  })
})

describe('the revoke command (NO-SESSION-REVOCATION)', () => {
  function rig(sessions = 2) {
    const t = makeTmp()
    cleanups.push(t.cleanup)
    const sec = createSecurity({ dataDir: t.dir, port: 7421, devOrigins: [], exchangeCodeTtlMs: 60_000, sessionTtlMs: 3_600_000 })
    const tokens: string[] = []
    for (let i = 0; i < sessions; i++) {
      const ex = sec.exchange(sec.issueExchangeCode().code)
      if (!ex.ok) throw new Error('exchange failed')
      tokens.push(ex.token)
    }
    const out: string[] = []
    const err: string[] = []
    const io = { out: (s: string) => void out.push(s), err: (s: string) => void err.push(s), now: () => new Date('2026-11-02T10:00:00Z'), platform: process.platform, homedir: '/home/test' }
    const env = { DATA_DIR: t.dir }
    return { t, sec, tokens, out, err, io, env }
  }

  it('revokes every browser session, keeps the hook and stage tokens, never prints a token or hash, and keeps the file private', () => {
    const r = rig(3)
    const before = readSecretsFile(r.t.dir)!
    const code = runRevokeCli([], r.env, r.io)
    expect(code).toBe(0)
    const after = readSecretsFile(r.t.dir)!
    expect(after.sessions).toEqual([])
    expect(after.hookToken).toBe(before.hookToken)
    expect(after.stageToken).toBe(before.stageToken)
    for (const tok of r.tokens) expect(r.sec.validateSession(tok)).toBe(false)
    const printed = [...r.out, ...r.err].join('\n')
    expect(printed).toMatch(/Revoked 3 browser session\(s\)/)
    for (const secret of [...r.tokens, before.hookToken, before.stageToken ?? '', ...before.sessions.map((s) => s.hash)]) expect(printed).not.toContain(secret)
    if (process.platform !== 'win32') expect(statSync(join(r.t.dir, 'secrets.json')).mode & 0o777).toBe(0o600)
  })

  it('--dry-run changes nothing, and the arguments are checked', () => {
    const r = rig(2)
    expect(runRevokeCli(['--dry-run'], r.env, r.io)).toBe(0)
    expect(readSecretsFile(r.t.dir)?.sessions).toHaveLength(2)
    expect(r.out.join('')).toMatch(/2 browser session\(s\) would be revoked/)
    expect(runRevokeCli(['--bogus'], r.env, r.io)).toBe(2)
    expect(runRevokeCli(['everything'], r.env, r.io)).toBe(2)
    expect(runRevokeCli(['--help'], r.env, r.io)).toBe(0)
    expect(readSecretsFile(r.t.dir)?.sessions).toHaveLength(2)
  })

  it('says so when there is nothing to revoke from (a wrong DATA_DIR) instead of pretending', () => {
    const t = makeTmp()
    cleanups.push(t.cleanup)
    const err: string[] = []
    const code = runRevokeCli([], { DATA_DIR: t.dir }, { out: () => undefined, err: (s) => void err.push(s), now: () => new Date(), platform: process.platform, homedir: '/h' })
    expect(code).toBe(1)
    expect(err.join('')).toMatch(/no secrets\.json/)
    expect(readdirSync(t.dir)).toEqual([]) // and it created nothing
    expect(runRevokeCli([], { DATA_DIR: t.dir, DAEMON_PORT: 'nope' }, { out: () => undefined, err: () => undefined, now: () => new Date(), platform: process.platform, homedir: '/h' })).toBe(2)
  })

  it('writes an audit entry into the daemon\'s own database when there is one, and survives a database it cannot open', () => {
    const r = rig(1)
    const dbFile = join(r.t.dir, 'app.db')
    const store = openStore({ file: dbFile })
    store.close()
    expect(runRevokeCli([], r.env, r.io)).toBe(0)
    const check = openStore({ file: dbFile })
    const row = check.listAudit(5).find((a) => a.action === 'Revoked every browser session (command line)')
    check.close()
    expect(row).toMatchObject({ actor: 'you', target: 'Local daemon', outcome: 'auto', detail: '1 session(s)' })

    const r2 = rig(1)
    writeFileSync(join(r2.t.dir, 'app.db'), 'this is not a database')
    expect(runRevokeCli([], r2.env, r2.io)).toBe(0)
    expect(readSecretsFile(r2.t.dir)?.sessions).toEqual([]) // revoked all the same
    expect(r2.err.join('')).toMatch(/No audit entry could be written/)
  })
})

describe('the logger knows every secret (LOGGER-MISSES-HOOK-STAGE-TOKENS)', () => {
  it('secretLiterals holds the hook and stage tokens, the pending sign-in code and this run\'s session tokens, and drops a used code', () => {
    const t = makeTmp()
    cleanups.push(t.cleanup)
    const sec = createSecurity({ dataDir: t.dir, port: 7421, devOrigins: [], exchangeCodeTtlMs: 60_000, sessionTtlMs: 60_000 })
    const { code } = sec.issueExchangeCode()
    expect(sec.secretLiterals()).toEqual(expect.arrayContaining([sec.hookToken(), sec.stageToken(), code]))
    const ex = sec.exchange(code)
    if (!ex.ok) throw new Error('exchange failed')
    const lits = sec.secretLiterals()
    expect(lits).toContain(ex.token)
    expect(lits).not.toContain(code) // single use: spent
    sec.revokeAllSessions()
    expect(sec.secretLiterals()).not.toContain(ex.token)
  })

  it('a logger fed those literals masks each of them, wherever it appears, and masks session cookies and ?code= by shape', () => {
    const t = makeTmp()
    cleanups.push(t.cleanup)
    const sec = createSecurity({ dataDir: t.dir, port: 7421, devOrigins: [], exchangeCodeTtlMs: 60_000, sessionTtlMs: 60_000 })
    const { code } = sec.issueExchangeCode()
    const lines: string[] = []
    const log = createLogger({ level: 'debug', sink: (l) => void lines.push(l), literals: () => [...sec.secretLiterals(), 'sk-ant-api03-KEYKEYKEYKEYKEYKEYKEY'] })
    const stranger = 'Zz'.repeat(21) + 'Q' // a 43-char token of an earlier run: unknown to this process
    log.warn(`hook ${sec.hookToken()} stage ${sec.stageToken()} code ${code} key sk-ant-api03-KEYKEYKEYKEYKEYKEYKEY`)
    log.info('cookie header', { header: `aia_sid_7421=${stranger}; other=1`, url: `http://127.0.0.1:7421/?code=${stranger}` })
    const all = lines.join('\n')
    for (const secret of [sec.hookToken(), sec.stageToken(), code, 'KEYKEYKEYKEYKEY', stranger]) expect(all, secret.slice(0, 6)).not.toContain(secret)
    expect(all).toContain('aia_sid_7421=***')
    expect(all).toContain('?code=***')
  })

  it('the daemon\'s own logger (the one main.ts now uses) masks a token that reaches a log line through a request path', async () => {
    const t = makeTmp()
    cleanups.push(t.cleanup)
    const written: string[] = []
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => (written.push(String(chunk)), true)) as never)
    try {
      const daemon = createDaemon({ config: testConfig(t.dir, { logLevel: 'warn' }), budget: createTestBudget(), clock: makeClock().fn, lane: (ctx) => new FakeLane(ctx) })
      const hook = daemon.security.hookToken()
      const stage = daemon.security.stageToken()
      // a wrong Host makes the guards log the path: a path that happens to hold the tokens must come out masked
      const res = await daemon.app.request(`/api/${hook}/${stage}`, { headers: { Host: 'evil.example' } })
      expect(res.status).toBe(403)
      const out = written.join('')
      expect(out).toContain('rejected request: bad host')
      expect(out).not.toContain(hook)
      expect(out).not.toContain(stage)
      await daemon.stop()
    } finally {
      spy.mockRestore()
    }
  })

  it('main.ts no longer hands the daemon a logger of its own (the API-key-only one)', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'main.ts'), 'utf8')
    const call = /createDaemon\(\{([\s\S]*?)\n  \}\)/.exec(src)?.[1] ?? ''
    expect(call).toContain('config')
    expect(call).not.toMatch(/\blog\b\s*[,:]/)
    expect(src).toMatch(/daemon\.ctx\.log/)
  })
})

describe.skipIf(process.platform === 'win32')('a private data folder (DATA-DIR-WORLD-READABLE-POSIX)', () => {
  const mode = (p: string) => statSync(p).mode & 0o777

  it('ensurePrivateDir creates 0700 even under umask 022, and tightens only a folder that is demonstrably ours', () => {
    const old = process.umask(0o022)
    try {
      const t = makeTmp()
      cleanups.push(t.cleanup)
      const fresh = join(t.dir, 'a', 'b', 'data')
      ensurePrivateDir(fresh)
      expect(mode(fresh)).toBe(0o700)
      // somebody else's existing folder keeps its permissions (its files are 0600 anyway)
      const shared = join(t.dir, 'shared')
      mkdirSync(shared, { mode: 0o755 })
      ensurePrivateDir(shared)
      expect(mode(shared)).toBe(0o755)
      // ours (it holds secrets.json) is tightened
      const ours = join(t.dir, 'ours')
      mkdirSync(ours, { mode: 0o755 })
      writeFileSync(join(ours, 'secrets.json'), '{}')
      ensurePrivateDir(ours)
      expect(mode(ours)).toBe(0o700)
    } finally {
      process.umask(old)
    }
  })

  it('ensurePrivateFile and hardenDbFiles give the database and its side files 0600', () => {
    const old = process.umask(0o022)
    try {
      const t = makeTmp()
      cleanups.push(t.cleanup)
      const db = join(t.dir, 'app.db')
      ensurePrivateFile(db)
      expect(mode(db)).toBe(0o600)
      for (const s of ['-wal', '-shm']) writeFileSync(`${db}${s}`, 'x', { mode: 0o644 })
      writeFileSync(`${db}-journal`, 'x', { mode: 0o644 })
      hardenDbFiles(db)
      for (const s of ['', '-wal', '-shm', '-journal']) expect(mode(`${db}${s}`), s).toBe(0o600)
      expect(() => hardenDbFiles(':memory:')).not.toThrow()
    } finally {
      process.umask(old)
    }
  })

  it('a real daemon on a file database: the folder 0700, app.db, -wal and -shm 0600, secrets.json 0600, agent/ 0700', async () => {
    const old = process.umask(0o022)
    const t = makeTmp()
    cleanups.push(t.cleanup)
    const dataDir = join(t.dir, 'data')
    try {
      const h = await makeTerminalHarness({ dataDir, dbFile: join(dataDir, 'app.db'), listen: true })
      open.push(h)
      expect(mode(dataDir)).toBe(0o700)
      for (const f of readdirSync(dataDir).filter((n) => /^app\.db/.test(n) || n === 'secrets.json')) expect(mode(join(dataDir, f)), f).toBe(0o600)
      expect(readdirSync(dataDir)).toEqual(expect.arrayContaining(['app.db', 'app.db-wal', 'app.db-shm', 'secrets.json']))
      expect(mode(join(dataDir, 'agent'))).toBe(0o700)
    } finally {
      process.umask(old)
    }
  })

  it('an existing 0644 database from an older run is tightened at the next start', async () => {
    const old = process.umask(0o022)
    const t = makeTmp()
    cleanups.push(t.cleanup)
    const dataDir = join(t.dir, 'data')
    try {
      mkdirSync(dataDir, { mode: 0o755 })
      const db = join(dataDir, 'app.db')
      openStore({ file: db }).close()
      writeFileSync(join(dataDir, 'secrets.json'), JSON.stringify({ ...loadOrCreateSecrets(join(t.dir, 'x')) }), { mode: 0o644 })
      expect(mode(db)).toBe(0o644)
      const h = await makeTerminalHarness({ dataDir, dbFile: db })
      open.push(h)
      expect(mode(db)).toBe(0o600)
      expect(mode(dataDir)).toBe(0o700)
    } finally {
      process.umask(old)
    }
  })
})

describe('what a dev-origin page may read from the live feed (DEV-ORIGIN-WS-METADATA-LEAK)', () => {
  const reset = (terminals: Array<{ id: string }>, audit: Array<{ action: string; target: string }> = []): ServerEvent =>
    ({ type: 'snapshot.reset', seq: 1, ts: 't', snapshot: { terminals, settings: { audit } } } as unknown as ServerEvent)
  const update = (audit: Array<{ action: string; target: string }>): ServerEvent => ({ type: 'settings.update', seq: 2, ts: 't', settings: { audit, persona: 'x' } } as unknown as ServerEvent)
  const opened = { action: 'Opened a terminal', target: 'shell terminal term-abc123' }
  const closed = { action: 'Closed a terminal', target: 'claude terminal term-def456' }
  const refused = { action: 'Refused to open a terminal', target: 'shell terminal' }
  const unrelated = { action: 'Approved a command', target: 'git status' }
  const terminalsOf = (e: ServerEvent) => (e as unknown as { snapshot: { terminals: unknown[] } }).snapshot.terminals
  const auditOf = (e: ServerEvent) => ((e as unknown as { snapshot?: { settings: { audit: unknown[] } }; settings?: { audit: unknown[] } }).snapshot?.settings ?? (e as unknown as { settings: { audit: unknown[] } }).settings).audit

  it('hideTerminals empties the terminal list for a foreign origin only, and leaves other events alone', () => {
    const ev = reset([{ id: 'term-1' }])
    expect(terminalsOf(hideTerminals(ev, true, false))).toHaveLength(1)
    expect(terminalsOf(hideTerminals(ev, false, true))).toHaveLength(1) // TERMINAL_ALLOW_DEV_ORIGINS
    expect(terminalsOf(hideTerminals(ev, false, false))).toEqual([])
    expect(terminalsOf(ev)).toHaveLength(1) // the original is not mutated
    const other = { type: 'chat.done', seq: 2, ts: 't', messageId: 'm' } as unknown as ServerEvent
    expect(hideTerminals(other, false, false)).toBe(other)
  })

  it('it also drops the audit entries ABOUT terminals (they carry the terminal id) from a snapshot.reset and a settings.update', () => {
    const ev = reset([{ id: 'term-abc123' }], [unrelated, opened, closed, refused])
    const seen = hideTerminals(ev, false, false)
    expect(auditOf(seen)).toEqual([unrelated])
    expect(JSON.stringify(seen)).not.toMatch(/term-|Opened a terminal|Closed a terminal|Refused to open|shell terminal|claude terminal/)
    const upd = hideTerminals(update([opened, unrelated, closed]), false, false)
    expect(auditOf(upd)).toEqual([unrelated])
    expect((upd as unknown as { settings: { persona: string } }).settings.persona).toBe('x') // the rest of the settings is untouched
    // the daemon's own origin, and a deliberately allowed dev origin, see the whole log
    expect(auditOf(hideTerminals(ev, true, false))).toHaveLength(4)
    expect(auditOf(hideTerminals(update([opened]), false, true))).toHaveLength(1)
    // nothing was mutated: the same event object is still handed, unchanged, to the other sockets
    expect(auditOf(ev)).toHaveLength(4)
  })

  it('an event with nothing to hide is passed through as the same object (no copy per socket per event)', () => {
    const plain = reset([], [unrelated])
    expect(hideTerminals(plain, false, false)).toBe(plain)
    const noList = { type: 'snapshot.reset', seq: 1, ts: 't', snapshot: { settings: { audit: [unrelated] } } } as unknown as ServerEvent // an older snapshot without a terminal list
    expect(hideTerminals(noList, false, false)).toBe(noList)
    const plainUpdate = update([unrelated])
    expect(hideTerminals(plainUpdate, false, false)).toBe(plainUpdate)
  })

  it('over a real socket: the dev origin never sees a terminal id, in the list or in the audit log; the daemon\'s own origin does', async () => {
    const h = await live()
    const dev = await openSocket(h, '/ws', h.cookie, 'http://127.0.0.1:5173')
    const own = await openSocket(h, '/ws', h.cookie)
    const { id } = await h.create({ kind: 'shell' })
    await until(() => own.raw.some((r) => r.includes(id)) && dev.messages.some((m) => m.type === 'snapshot.reset'), 'both feeds to see the reset')
    // one more change of the list and of the audit log (closing is audited too, with the same id)
    expect((await h.call(`/api/terminals/${id}`, { method: 'DELETE' })).status).toBe(204)
    await until(() => own.raw.filter((r) => r.includes('Closed a terminal')).length > 0, 'the close to reach the own feed')
    await wait(150) // give a wrongly forwarded event time to arrive
    expect(own.raw.join('\n')).toContain(id) // the test is not vacuous: the owner's feed carries the id (list and audit)
    expect(dev.raw.join('\n')).not.toContain(id)
    expect(dev.raw.join('\n')).not.toMatch(/Opened a terminal|Closed a terminal|shell terminal/)
    const lastReset = dev.messages.filter((m) => m.type === 'snapshot.reset').at(-1) as { snapshot: { terminals?: unknown[] } }
    expect(lastReset.snapshot.terminals ?? []).toEqual([])
    // the replay a late dev client asks for is filtered the same way
    const late = await openSocket(h, `/ws?since=0&epoch=${h.daemon.bus.epoch}`, h.cookie, 'http://localhost:5173')
    await until(() => late.messages.some((m) => m.type === 'snapshot.reset'), 'the replay')
    await wait(100)
    expect(late.raw.join('\n')).not.toContain(id)
  })

  it('with TERMINAL_ALLOW_DEV_ORIGINS the dev origin sees them (it may then use terminals anyway)', async () => {
    const h = await live({ limits: { allowDevOrigins: true } })
    const dev = await openSocket(h, '/ws', h.cookie, 'http://127.0.0.1:5173')
    const { id } = await h.create({ kind: 'shell' })
    await until(() => dev.raw.some((r) => r.includes(id)), 'the id to reach the dev feed')
    expect(((dev.messages.filter((m) => m.type === 'snapshot.reset').at(-1) as { snapshot: { terminals?: unknown[] } }).snapshot.terminals ?? []).length).toBe(1)
  })
})
