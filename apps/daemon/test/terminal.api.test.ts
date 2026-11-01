import { afterEach, describe, expect, it } from 'vitest'
import { Snapshot, TerminalInfo, TerminalTicketResponse, type ServerEvent } from '@ai-assistant/shared'
import { request as httpRequest } from 'node:http'
import { makeTmp } from './helpers'
import { makeTerminalHarness, rawHttp, type TerminalHarness } from './terminalHarness'

const open: TerminalHarness[] = []
afterEach(async () => {
  for (const h of open.splice(0)) await h.cleanup()
})
async function harness(opts: Parameters<typeof makeTerminalHarness>[0] = {}): Promise<TerminalHarness> {
  const h = await makeTerminalHarness(opts)
  open.push(h)
  return h
}
const body = async (r: Response) => (await r.json()) as Record<string, unknown>

/** One request per terminal route, as a browser would send it. */
function routes(id: string) {
  return [
    { name: 'list', method: 'GET', path: '/api/terminals', mutating: false },
    { name: 'create', method: 'POST', path: '/api/terminals', mutating: true, json: { kind: 'shell' } },
    { name: 'get', method: 'GET', path: `/api/terminals/${id}`, mutating: false },
    { name: 'close', method: 'DELETE', path: `/api/terminals/${id}`, mutating: true },
    { name: 'ticket', method: 'POST', path: `/api/terminals/${id}/ticket`, mutating: true },
    { name: 'ws path over http', method: 'GET', path: `/ws/terminal/${id}`, mutating: false },
  ] as const
}

describe('the disabled gate', () => {
  it('is off on a fresh install: every terminal route answers 403 terminals_disabled', async () => {
    const h = await harness({ enable: false })
    for (const r of routes('term-x')) {
      const res = await h.call(r.path, { method: r.method, ...('json' in r ? { json: r.json } : {}) })
      expect(res.status, r.name).toBe(403)
      expect(await body(res), r.name).toMatchObject({ error: 'terminals_disabled' })
    }
    expect(h.fake.specs).toHaveLength(0)
  })

  it('does not reveal the gate to an unauthenticated caller (auth first)', async () => {
    const h = await harness({ enable: false })
    for (const r of routes('term-x')) {
      const res = await h.call(r.path, { method: r.method, cookie: false, ...('json' in r ? { json: r.json } : {}) })
      expect(res.status, r.name).toBe(401)
    }
  })

  it('shows enabled:false in the snapshot, with an empty terminal list', async () => {
    const h = await harness({ enable: false })
    const snap = Snapshot.parse(await body(await h.call('/api/snapshot')))
    expect(snap.settings.terminals).toEqual({ enabled: false })
    expect(snap.terminals).toEqual([])
  })

  it('the switch persists in kv, is audited, publishes settings and shows in the snapshot', async () => {
    const h = await harness({ enable: false })
    const res = await h.setEnabled(true)
    expect(res.status).toBe(200)
    expect(await body(res)).toEqual({ ok: true, enabled: true })
    expect(h.daemon.store.kvGet('settings.terminals')).toBe(true)
    const snap = Snapshot.parse(await body(await h.call('/api/snapshot')))
    expect(snap.settings.terminals).toEqual({ enabled: true })
    expect(h.events.some((e) => e.type === 'settings.update' && e.settings.terminals?.enabled === true)).toBe(true)
    expect(h.daemon.store.listAudit(20).some((a) => a.action === 'Turned embedded terminals on' && a.target === 'Settings')).toBe(true)
    // POST is accepted as an alias, like the other settings routes; an unchanged switch is not audited twice
    const before = h.daemon.store.countAudit()
    expect((await h.call('/api/settings/terminals', { method: 'POST', json: { on: true } })).status).toBe(200)
    expect(h.daemon.store.countAudit()).toBe(before)
  })

  it('validates the switch body', async () => {
    const h = await harness({ enable: false })
    expect((await h.call('/api/settings/terminals', { method: 'PUT', json: { on: 'yes' } })).status).toBe(400)
    expect((await h.call('/api/settings/terminals', { method: 'PUT', json: {} })).status).toBe(400)
    expect((await h.call('/api/settings/terminals', { method: 'PUT', body: '{nope', contentType: 'application/json' })).status).toBe(400)
    expect(h.daemon.store.kvGet('settings.terminals')).toBeUndefined()
  })

  it('survives a daemon restart on the same database', async () => {
    const tmp = makeTmp('term-restart-')
    const dbFile = `${tmp.dir}/app.db`
    const a = await makeTerminalHarness({ dataDir: tmp.dir, dbFile, enable: true })
    await a.daemon.stop()
    const b = await makeTerminalHarness({ dataDir: tmp.dir, dbFile, enable: false })
    open.push(b)
    expect(b.daemon.terminals.enabled()).toBe(true)
    tmp.cleanup()
  })
})

describe('Origin, Host, content type and cookie on every route', () => {
  it('requires the session cookie (401) on every route', async () => {
    const h = await harness()
    const { id } = await h.create()
    for (const r of routes(id)) {
      const res = await h.call(r.path, { method: r.method, cookie: false, ...('json' in r ? { json: r.json } : {}) })
      expect(res.status, r.name).toBe(401)
    }
    const bad = await h.call(`/api/terminals/${id}`, { cookie: 'aia_sid_7421=not-a-real-session' })
    expect(bad.status).toBe(401)
    expect((await h.call('/api/settings/terminals', { method: 'PUT', json: { on: false }, cookie: false })).status).toBe(401)
    expect(h.daemon.terminals.enabled()).toBe(true)
    expect(h.daemon.terminals.service.runningCount()).toBe(1)
  })

  it('refuses a wrong or missing Host on every route', async () => {
    const h = await harness()
    const { id } = await h.create()
    for (const host of ['evil.example:80', `127.0.0.1:${h.daemon.security.getPort() + 1}`, '[::1]:7421', false] as const) {
      for (const r of routes(id)) {
        const res = await h.call(r.path, { method: r.method, host, ...('json' in r ? { json: r.json } : {}) })
        expect(res.status, `${r.name} ${String(host)}`).toBe(403)
        expect(await body(res)).toMatchObject({ error: 'forbidden_host' })
      }
    }
  })

  it('requires an allowlisted Origin on every mutation, and refuses a foreign one even on reads', async () => {
    const h = await harness()
    const { id } = await h.create()
    for (const r of routes(id).filter((x) => x.mutating)) {
      const missing = await h.call(r.path, { method: r.method, origin: false, ...('json' in r ? { json: r.json } : {}) })
      expect(missing.status, `${r.name} missing`).toBe(403)
      expect(await body(missing)).toMatchObject({ error: 'forbidden_origin' })
      for (const origin of ['https://evil.example', 'http://127.0.0.1:1', 'null', 'http://localhost.evil.example:7421']) {
        const res = await h.call(r.path, { method: r.method, origin, ...('json' in r ? { json: r.json } : {}) })
        expect(res.status, `${r.name} ${origin}`).toBe(403)
      }
    }
    for (const r of routes(id).filter((x) => !x.mutating)) {
      const res = await h.call(r.path, { method: r.method, origin: 'https://evil.example' })
      expect(res.status, r.name).toBe(403)
    }
    const switchRes = await h.call('/api/settings/terminals', { method: 'PUT', json: { on: false }, origin: 'https://evil.example' })
    expect(switchRes.status).toBe(403)
    expect(h.daemon.terminals.enabled()).toBe(true)
    expect(h.daemon.terminals.service.runningCount()).toBe(1)
  })

  it('requires a JSON content type on mutations that carry a body', async () => {
    const h = await harness()
    const { id } = await h.create()
    for (const contentType of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
      const res = await h.call('/api/terminals', { method: 'POST', body: JSON.stringify({ kind: 'shell' }), contentType })
      expect(res.status, contentType).toBe(415)
    }
    const res = await h.call(`/api/terminals/${id}/ticket`, { method: 'POST', body: '{}', contentType: 'text/plain' })
    expect(res.status).toBe(415)
    expect(h.fake.specs).toHaveLength(1)
  })

  it('a malicious cross-site form post cannot open a terminal', async () => {
    const h = await harness()
    const res = await h.call('/api/terminals', { method: 'POST', body: '{"kind":"shell"}', contentType: 'text/plain', origin: 'https://evil.example' })
    expect([403, 415]).toContain(res.status)
    expect(h.fake.specs).toHaveLength(0)
  })

  it('never sends CORS headers', async () => {
    const h = await harness()
    const { id } = await h.create()
    for (const r of routes(id).slice(0, 3)) {
      const res = await h.call(r.path, { method: r.method, origin: 'https://evil.example', ...('json' in r ? { json: r.json } : {}) })
      expect(res.headers.get('access-control-allow-origin')).toBeNull()
    }
  })
})

describe('terminals answer to the daemon\'s own origin only', () => {
  // Another app on an allowlisted dev port (5173 is everyone's Vite default) shares the 127.0.0.1 session cookie.
  const dev = 'http://127.0.0.1:5173'

  it('refuses the dev origin on every terminal route and on the switch, and nothing changes', async () => {
    const h = await harness()
    const { id } = await h.create()
    for (const r of routes(id)) {
      const res = await h.call(r.path, { method: r.method, origin: dev, ...('json' in r ? { json: r.json } : {}) })
      expect(res.status, r.name).toBe(403)
      expect(await body(res), r.name).toMatchObject({ error: 'forbidden_origin' })
    }
    const off = await h.call('/api/settings/terminals', { method: 'PUT', json: { on: false }, origin: dev })
    expect(off.status).toBe(403)
    expect(h.daemon.terminals.enabled()).toBe(true)
    expect(h.daemon.terminals.service.runningCount()).toBe(1)
    // ... while an ordinary dev-origin route is still allowed by the daemon's general rules
    expect((await h.call('/api/health', { origin: dev })).status).toBe(200)
  })

  it('cannot be used to switch terminals ON from a dev origin either', async () => {
    const h = await harness({ enable: false })
    expect((await h.call('/api/settings/terminals', { method: 'PUT', json: { on: true }, origin: dev })).status).toBe(403)
    expect(h.daemon.terminals.enabled()).toBe(false)
  })

  it('accepts both spellings of its own origin', async () => {
    const h = await harness()
    const p = h.daemon.security.getPort()
    for (const origin of [`http://127.0.0.1:${p}`, `http://localhost:${p}`, `HTTP://LOCALHOST:${p}`]) {
      expect((await h.call('/api/terminals', { origin })).status, origin).toBe(200)
    }
  })

  it('TERMINAL_ALLOW_DEV_ORIGINS lets the Vite dev server use them', async () => {
    const h = await harness({ limits: { allowDevOrigins: true } })
    expect((await h.call('/api/terminals', { origin: dev })).status).toBe(200)
    expect((await h.call('/api/terminals', { json: { kind: 'shell' }, origin: dev })).status).toBe(201)
    // an origin that is not in the dev allowlist stays refused
    expect((await h.call('/api/terminals', { origin: 'http://127.0.0.1:3000' })).status).toBe(403)
  })
})

describe('create, list, get, ticket, close', () => {
  it('creates a terminal and returns a valid TerminalInfo', async () => {
    const h = await harness()
    const res = await h.call('/api/terminals', { json: { kind: 'shell', cols: 110, rows: 32 } })
    expect(res.status).toBe(201)
    const info = TerminalInfo.parse(await body(res))
    expect(info).toMatchObject({ kind: 'shell', cwd: '/home/ana', cols: 110, rows: 32, state: 'running', exitCode: null })
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('opens Claude in a project, refuses an unknown project', async () => {
    const h = await harness()
    const ok = await h.call('/api/terminals', { json: { kind: 'claude', projectId: 'p-atlas' } })
    expect(ok.status).toBe(201)
    expect(await body(ok)).toMatchObject({ kind: 'claude', cwd: '/home/ana/proj', projectId: 'p-atlas' })
    const bad = await h.call('/api/terminals', { json: { kind: 'claude', projectId: 'nope' } })
    expect(bad.status).toBe(400)
    expect(await body(bad)).toMatchObject({ error: 'unknown_project' })
  })

  it('answers claude_not_found with help text when claude is missing', async () => {
    // the in-memory file system has /usr/bin/claude, but PATH points somewhere else
    const h = await harness({ env: { PATH: '/nowhere' } })
    const res = await h.call('/api/terminals', { json: { kind: 'claude' } })
    expect(res.status).toBe(422)
    const b = await body(res)
    expect(b.error).toBe('claude_not_found')
    expect(String(b.message)).toMatch(/CLAUDE_EXECUTABLE/)
  })

  it('refuses folders outside the roots with a stable code, and audits the refusal without the path', async () => {
    const h = await harness()
    const res = await h.call('/api/terminals', { json: { kind: 'shell', cwd: '/etc' } })
    expect(res.status).toBe(400)
    expect(await body(res)).toMatchObject({ error: 'cwd_outside' })
    const audit = h.daemon.store.listAudit(20).find((a) => a.action === 'Refused to open a terminal')
    expect(audit).toMatchObject({ outcome: 'blocked', detail: 'cwd_outside', target: 'shell terminal' })
    expect(JSON.stringify(audit)).not.toContain('/etc')
  })

  it('validates the body', async () => {
    const h = await harness()
    for (const bad of [{}, { kind: 'bash' }, { kind: 'shell', cols: 5 }, { kind: 'shell', rows: 999 }, { kind: 'shell', cols: 'wide' }, { kind: 'shell', cwd: 5 }]) {
      const res = await h.call('/api/terminals', { json: bad })
      expect(res.status, JSON.stringify(bad)).toBe(400)
      expect(await body(res)).toMatchObject({ error: 'invalid_request' })
    }
    expect((await h.call('/api/terminals', { body: '{oops', contentType: 'application/json' })).status).toBe(400)
    expect((await h.call('/api/terminals', { body: JSON.stringify({ kind: 'shell', pad: 'x'.repeat(600_000) }), contentType: 'application/json' })).status).toBe(413)
    expect(h.fake.specs).toHaveLength(0)
  })

  it('answers 429 at the cap', async () => {
    const h = await harness({ limits: { maxTerminals: 2 } })
    await h.create()
    await h.create()
    const res = await h.call('/api/terminals', { json: { kind: 'shell' } })
    expect(res.status).toBe(429)
    expect(await body(res)).toMatchObject({ error: 'terminal_limit' })
  })

  it('lists and gets terminals; unknown ids are 404', async () => {
    const h = await harness()
    const a = await h.create()
    const b = await h.create({ kind: 'claude' })
    const list = (await (await h.call('/api/terminals')).json()) as unknown[]
    expect(list.map((x) => TerminalInfo.parse(x).id)).toEqual([a.id, b.id])
    expect((await h.call(`/api/terminals/${b.id}`)).status).toBe(200)
    for (const path of ['/api/terminals/nope', '/api/terminals/nope/ticket']) {
      const res = await h.call(path, { method: path.endsWith('ticket') ? 'POST' : 'GET' })
      expect(res.status, path).toBe(404)
    }
    expect((await h.call('/api/terminals/nope', { method: 'DELETE' })).status).toBe(404)
  })

  it('mints a ticket (valid shape, 30 s) bound to the terminal', async () => {
    const h = await harness()
    const { id } = await h.create()
    const res = await h.call(`/api/terminals/${id}/ticket`, { method: 'POST', json: {} })
    expect(res.status).toBe(200)
    const t = TerminalTicketResponse.parse(await body(res))
    expect(t.expiresInSec).toBe(30)
    expect(t.ticket.length).toBeGreaterThanOrEqual(32)
    expect(h.daemon.terminals.tickets.pendingCount()).toBe(1)
  })

  it('closes a running terminal: 204, process tree killed, gone from the list', async () => {
    const h = await harness()
    const { id } = await h.create()
    const pid = h.fake.last().pid
    const res = await h.call(`/api/terminals/${id}`, { method: 'DELETE' })
    expect(res.status).toBe(204)
    expect(h.killer.terminated).toEqual([pid])
    expect((await h.call(`/api/terminals/${id}`)).status).toBe(404)
    expect(((await (await h.call('/api/terminals')).json()) as unknown[]).length).toBe(0)
  })

  it('keeps an exited terminal listed with its exit code until it is deleted', async () => {
    const h = await harness()
    const { id } = await h.create()
    h.fake.last().exit(7)
    const info = TerminalInfo.parse(await body(await h.call(`/api/terminals/${id}`)))
    expect(info).toMatchObject({ state: 'exited', exitCode: 7 })
    expect((await h.call(`/api/terminals/${id}`, { method: 'DELETE' })).status).toBe(204)
    expect((await h.call(`/api/terminals/${id}`)).status).toBe(404)
  })
})

describe('snapshot and events', () => {
  it('lists terminals in the snapshot (valid against the shared schema) and publishes a reset when the list changes', async () => {
    const h = await harness()
    const before = h.events.length
    const { id } = await h.create()
    await new Promise((r) => setTimeout(r, 5))
    const resets = () => h.events.slice(before).filter((e): e is Extract<ServerEvent, { type: 'snapshot.reset' }> => e.type === 'snapshot.reset')
    expect(resets().length).toBeGreaterThanOrEqual(1)
    expect(resets().at(-1)!.snapshot.terminals?.map((t) => t.id)).toEqual([id])
    const snap = Snapshot.parse(await body(await h.call('/api/snapshot')))
    expect(snap.terminals).toHaveLength(1)
    expect(snap.terminals?.[0]).toMatchObject({ id, kind: 'shell', state: 'running' })
    await h.call(`/api/terminals/${id}`, { method: 'DELETE' })
    await new Promise((r) => setTimeout(r, 5))
    expect(resets().at(-1)!.snapshot.terminals).toEqual([])
  })

  it('several changes in one tick become one reset', async () => {
    const h = await harness({ limits: { maxTerminals: 8 } })
    for (let i = 0; i < 3; i++) await h.create()
    await new Promise((r) => setTimeout(r, 5))
    const n = h.events.filter((e) => e.type === 'snapshot.reset').length
    h.fake.ptys.forEach((p) => p.exit(0))
    await new Promise((r) => setTimeout(r, 5))
    expect(h.events.filter((e) => e.type === 'snapshot.reset').length - n).toBe(1)
  })
})

describe('churn does not flood the event bus with snapshots (SNAPSHOT-RESET-AMPLIFICATION)', () => {
  it('a burst of create and close publishes a bounded number of resets, then ONE coalesced trailing reset with the final state', async () => {
    const h = await harness({ limits: { maxTerminals: 8 } })
    const before = h.events.filter((e) => e.type === 'snapshot.reset').length
    const CYCLES = 60
    for (let i = 0; i < CYCLES; i++) {
      const { id } = await h.create()
      await h.call(`/api/terminals/${id}`, { method: 'DELETE' })
    }
    await new Promise((r) => setTimeout(r, 20))
    const sent = h.events.filter((e) => e.type === 'snapshot.reset').length - before
    // 120 list changes (open, close, removal each) used to mean up to 120+ full snapshots; now at most the burst allowance
    expect(sent).toBeLessThanOrEqual(21)
    expect(sent).toBeGreaterThanOrEqual(10)
    // the trailing reset arrives within about a second and carries the LAST state (no terminals left)
    const deadline = Date.now() + 3000
    const last = () => h.events.filter((e): e is Extract<ServerEvent, { type: 'snapshot.reset' }> => e.type === 'snapshot.reset').at(-1)
    let initial = sent
    while (Date.now() < deadline && h.events.filter((e) => e.type === 'snapshot.reset').length - before === initial) await new Promise((r) => setTimeout(r, 25))
    initial = h.events.filter((e) => e.type === 'snapshot.reset').length - before
    expect(initial).toBeGreaterThan(sent) // the coalesced one came
    expect(last()?.snapshot.terminals ?? []).toEqual([])
    // and it is only one: nothing more follows
    await new Promise((r) => setTimeout(r, 1200))
    expect(h.events.filter((e) => e.type === 'snapshot.reset').length - before).toBe(initial)
  })

  it('ordinary use is not delayed at all: a single change is published at once', async () => {
    const h = await harness()
    const before = h.events.filter((e) => e.type === 'snapshot.reset').length
    await h.create()
    await new Promise((r) => setTimeout(r, 5))
    expect(h.events.filter((e) => e.type === 'snapshot.reset').length - before).toBe(1)
  })
})

describe('switching off', () => {
  it('kills every running terminal and its tree, empties the list and refuses the old tickets', async () => {
    const h = await harness({ limits: { maxTerminals: 8 } })
    const a = await h.create()
    await h.create({ kind: 'claude' })
    const ticket = await h.ticket(a.id)
    const pids = h.fake.ptys.map((p) => p.pid)
    const res = await h.setEnabled(false)
    expect(res.status).toBe(200)
    expect(h.killer.terminated.sort()).toEqual(pids.sort())
    expect(h.daemon.terminals.service.runningCount()).toBe(0)
    expect(h.daemon.terminals.service.list()).toHaveLength(0)
    expect(h.daemon.terminals.tickets.pendingCount()).toBe(0)
    expect(h.daemon.terminals.tickets.redeem(ticket, { terminalId: a.id, sessionKey: 'x' })).toMatchObject({ ok: false })
    expect((await h.call('/api/terminals')).status).toBe(403)
    const snap = Snapshot.parse(await body(await h.call('/api/snapshot')))
    expect(snap.terminals).toEqual([])
    expect(snap.settings.terminals).toEqual({ enabled: false })
    expect(h.daemon.store.kvGet('settings.terminals')).toBe(false)
  })

  it('writes the audit trail: enable, open, close, disable', async () => {
    const h = await harness()
    const a = await h.create()
    await h.call(`/api/terminals/${a.id}`, { method: 'DELETE' })
    await h.create()
    await h.setEnabled(false)
    const actions = h.daemon.store.listAudit(50).map((x) => x.action).reverse()
    expect(actions.filter((x) => /terminal/i.test(x))).toEqual([
      'Turned embedded terminals on',
      'Opened a terminal',
      'Closed a terminal',
      'Opened a terminal',
      'Turned embedded terminals off',
      'Closed a terminal (terminals switched off)',
    ])
  })
})

describe('audit and logs never contain keystrokes or output', () => {
  it('records kind and id only', async () => {
    const h = await harness({ listen: false })
    const { id } = await h.create({ kind: 'claude', projectId: 'p-atlas' })
    const pty = h.fake.last()
    // simulate a session: someone typed a secret and the program printed another
    const sink = { out: [] as Buffer[] }
    const attachment = h.daemon.terminals.service.attach(id, { output: (c) => (sink.out.push(c), true), control: () => undefined, end: () => undefined })
    attachment.write(Buffer.from('export TOKEN=KEYSTROKE-CANARY-12345\r'))
    pty.emit('printing OUTPUT-CANARY-67890\r\n')
    pty.exit(2)
    await h.setEnabled(false)
    const dump = JSON.stringify(h.daemon.store.listAudit(500)) + h.logs.join('\n')
    expect(dump).not.toContain('KEYSTROKE-CANARY')
    expect(dump).not.toContain('OUTPUT-CANARY')
    expect(dump).not.toContain('/home/ana/proj') // not even the folder
    const exitEntry = h.daemon.store.listAudit(500).find((a) => a.action === 'A terminal exited')
    expect(exitEntry).toMatchObject({ target: `claude terminal ${id}`, detail: 'exit code 2', outcome: 'auto' })
    const open = h.daemon.store.listAudit(500).find((a) => a.action === 'Opened a terminal')
    expect(open).toMatchObject({ target: `claude terminal ${id}`, actor: 'you' })
    expect(Object.keys(open!).sort()).toEqual(['action', 'actor', 'at', 'id', 'outcome', 'target'])
  })
})

describe('shutdown', () => {
  it('a graceful daemon stop kills every pty and its tree before closing', async () => {
    const h = await harness({ limits: { maxTerminals: 8 } })
    await h.create()
    await h.create()
    const pids = h.fake.ptys.map((p) => p.pid)
    await h.daemon.stop()
    expect(h.killer.terminated.sort()).toEqual(pids.sort())
    expect(h.daemon.terminals.service.runningCount()).toBe(0)
  })
})

describe('real HTTP framing (the node adapter, not the in-memory app)', () => {
  it('a bare DELETE with no body and no Content-Length closes the terminal (a browser sends exactly this)', async () => {
    const h = await harness({ listen: true })
    const { id } = await h.create()
    const paired = { Origin: h.origin, Cookie: h.cookie, 'X-Terminal-Proof': h.daemon.security.terminalProof() }
    const res = await rawHttp(h.port, 'DELETE', `/api/terminals/${id}`, undefined, paired)
    expect(res.status).toBe(204)
    expect(h.daemon.terminals.service.list()).toHaveLength(0)
    const missing = await rawHttp(h.port, 'DELETE', '/api/terminals/nope', undefined, paired)
    expect(missing.status).toBe(404)
  })

  it('a chunked POST without Content-Length is read under the cap: accepted when small, 413 when large', async () => {
    const h = await harness({ listen: true })
    const chunked = (payload: string): Promise<{ status: number; body: string }> =>
      new Promise((resolve, reject) => {
        const req = httpRequest(
          { host: '127.0.0.1', port: h.port, method: 'POST', path: '/api/terminals', headers: { 'Content-Type': 'application/json', Origin: h.origin, Cookie: h.cookie, 'X-Terminal-Proof': h.daemon.security.terminalProof(), 'Transfer-Encoding': 'chunked' } },
          (res) => {
            let data = ''
            res.on('data', (c) => (data += c))
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }))
          },
        )
        req.on('error', reject)
        req.write(payload.slice(0, 10))
        req.write(payload.slice(10))
        req.end()
      })
    const ok = await chunked(JSON.stringify({ kind: 'shell' }))
    expect(ok.status).toBe(201)
    const big = await chunked(JSON.stringify({ kind: 'shell', pad: 'x'.repeat(600_000) }))
    expect(big.status).toBe(413)
    expect(h.daemon.terminals.service.list()).toHaveLength(1)
  })

  it('the existing task delete route works over a real socket too', async () => {
    const h = await harness({ listen: true })
    const created = await rawHttp(h.port, 'POST', '/api/tasks', { title: 'x' }, { Origin: h.origin, Cookie: h.cookie })
    const task = JSON.parse(created.body) as { id: string }
    const del = await rawHttp(h.port, 'DELETE', `/api/tasks/${task.id}`, undefined, { Origin: h.origin, Cookie: h.cookie })
    expect(del.status).toBe(204)
  })
})
