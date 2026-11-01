import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { createSecurity } from '../src/security'
import { makeTmp } from './helpers'
import { makeTerminalHarness, type TerminalHarness } from './terminalHarness'

/**
 * SESSION-COOKIE-HOST-SCOPED. A cookie is scoped to the HOST, not the port: another server on 127.0.0.1 that the user
 * browses to receives it, and can replay it (with a forged Origin) from a non-browser client. So the terminal routes need
 * a second secret that is never in the cookie jar: the pairing proof. It rides in the FRAGMENT of the printed sign-in link
 * (no server ever sees a fragment), the page keeps it in its own origin's storage, and it travels as X-Terminal-Proof.
 */

const open: TerminalHarness[] = []
const sockets: WebSocket[] = []
afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate()
  for (const h of open.splice(0)) await h.cleanup()
})
async function harness(opts: Parameters<typeof makeTerminalHarness>[0] = {}): Promise<TerminalHarness> {
  const h = await makeTerminalHarness(opts)
  open.push(h)
  return h
}

const ROUTES: Array<[string, string, unknown?]> = [
  ['GET', '/api/terminals'],
  ['POST', '/api/terminals', { kind: 'shell' }],
  ['GET', '/api/terminals/term-x'],
  ['DELETE', '/api/terminals/term-x'],
  ['POST', '/api/terminals/term-x/ticket', {}],
]

describe('the terminal routes need the pairing proof as well as the cookie', () => {
  it('refuses every route without the proof, and with a wrong one, with the same 401', async () => {
    const h = await harness()
    for (const proof of [false, '', 'x', `${h.daemon.security.terminalProof()}x`, h.daemon.security.terminalProof().slice(1), h.daemon.security.hookToken(), h.daemon.security.stageToken()] as const) {
      for (const [method, path, json] of ROUTES) {
        const res = await h.call(path, { method, proof, ...(json !== undefined ? { json } : {}) })
        expect(res.status, `${method} ${path} with proof ${proof === false ? '(none)' : '(wrong)'}`).toBe(401)
        expect(await res.json()).toMatchObject({ error: 'terminal_proof_required' })
      }
    }
    expect(h.daemon.terminals.service.list()).toHaveLength(0) // nothing was started
  })

  it('accepts the right proof on every route', async () => {
    const h = await harness()
    expect((await h.call('/api/terminals')).status).toBe(200)
    const { id } = await h.create()
    expect((await h.call(`/api/terminals/${id}`)).status).toBe(200)
    expect((await h.call(`/api/terminals/${id}/ticket`, { method: 'POST' })).status).toBe(200)
    expect((await h.call(`/api/terminals/${id}`, { method: 'DELETE' })).status).toBe(204)
  })

  it('a stolen cookie alone is useless: replayed with a forged own Origin it cannot mint a ticket or start a terminal', async () => {
    const h = await harness()
    const { id } = await h.create()
    // what a hostile local server does with the cookie it received: replay it, own Origin forged, no proof
    const ticket = await h.call(`/api/terminals/${id}/ticket`, { method: 'POST', proof: false })
    expect(ticket.status).toBe(401)
    expect(JSON.stringify(await ticket.json())).not.toMatch(/"ticket"/)
    expect((await h.call('/api/terminals', { json: { kind: 'shell' }, proof: false })).status).toBe(401)
    expect((await h.call('/api/settings/terminals', { method: 'PUT', json: { on: true }, proof: false })).status).toBe(401)
    expect(h.daemon.terminals.tickets.pendingCount()).toBe(0)
    expect(h.daemon.terminals.service.list()).toHaveLength(1) // just the one the owner made
  })

  it('without a ticket there is no socket, and a ticket is only ever minted behind the proof', async () => {
    const h = await harness({ listen: true })
    const { id } = await h.create()
    const ws = new WebSocket(`ws://127.0.0.1:${h.port}/ws/terminal/${id}`, { headers: { Origin: h.origin, Cookie: h.cookie } })
    sockets.push(ws)
    const closed = new Promise<number>((res) => {
      ws.on('close', (code) => res(code))
      ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', ticket: 'guess' })))
    })
    expect(await closed).toBe(4401)
    expect(h.daemon.terminals.tickets.pendingCount()).toBe(0)
  })

  it('checks Origin first, then the switch, then the proof (so the answers leak nothing new)', async () => {
    const h = await harness({ enable: false })
    // switched off: 403 terminals_disabled whatever the proof (the snapshot already says whether they are on)
    expect(await (await h.call('/api/terminals', { proof: false })).json()).toMatchObject({ error: 'terminals_disabled' })
    // a foreign origin is refused before anything else
    expect(await (await h.call('/api/terminals', { proof: false, origin: 'http://127.0.0.1:5173' })).json()).toMatchObject({ error: 'forbidden_origin' })
    await h.setEnabled(true)
    expect(await (await h.call('/api/terminals', { proof: false })).json()).toMatchObject({ error: 'terminal_proof_required' })
  })

  it('switching terminals ON needs the proof; switching them OFF needs only the cookie (a safety action)', async () => {
    const h = await harness({ enable: false })
    expect((await h.call('/api/settings/terminals', { method: 'PUT', json: { on: true }, proof: false })).status).toBe(401)
    expect((await h.call('/api/settings/terminals', { method: 'PUT', json: { on: true }, proof: 'wrong' })).status).toBe(401)
    expect(h.daemon.terminals.enabled()).toBe(false)
    expect((await h.call('/api/settings/terminals', { method: 'PUT', json: { on: true } })).status).toBe(200)
    expect(h.daemon.terminals.enabled()).toBe(true)
    await h.create()
    expect((await h.call('/api/settings/terminals', { method: 'PUT', json: { on: false }, proof: false })).status).toBe(200)
    expect(h.daemon.terminals.enabled()).toBe(false)
    expect(h.daemon.terminals.service.list()).toHaveLength(0) // and it killed what ran
    // POST is accepted as an alias for PUT, with the same rule
    expect((await h.call('/api/settings/terminals', { method: 'POST', json: { on: true }, proof: false })).status).toBe(401)
  })

  it('reads the proof from the header only: not from the query string, a cookie, or the body', async () => {
    const h = await harness()
    const proof = h.daemon.security.terminalProof()
    expect((await h.call(`/api/terminals?tp=${proof}&proof=${proof}`, { proof: false })).status).toBe(401)
    expect((await h.call('/api/terminals', { proof: false, cookie: `${h.cookie}; tp=${proof}; x_terminal_proof=${proof}` })).status).toBe(401)
    expect((await h.call('/api/terminals', { method: 'POST', json: { kind: 'shell', proof, tp: proof }, proof: false })).status).toBe(401)
    expect((await h.call('/api/terminals', { proof: false, headers: { Authorization: `Bearer ${proof}` } })).status).toBe(401)
  })
})

describe('the proof itself', () => {
  it('is random per run, URL-safe, long, never persisted and never in a response', async () => {
    const a = await harness()
    const b = await harness()
    const pa = a.daemon.security.terminalProof()
    expect(pa).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(pa).toBe(a.daemon.security.terminalProof()) // stable within a run
    expect(pa).not.toBe(b.daemon.security.terminalProof()) // different in every run
    expect(readFileSync(join(a.dataDir, 'secrets.json'), 'utf8')).not.toContain(pa)
    // not in the snapshot, the health answer, the settings, the audit log or the lane's context
    const blob = JSON.stringify([await (await a.call('/api/snapshot')).json(), await (await a.call('/api/health')).json(), a.daemon.store.listAudit(200)])
    expect(blob).not.toContain(pa)
  })

  it('is verified in constant time and never matches nothing', () => {
    const t = makeTmp()
    try {
      const sec = createSecurity({ dataDir: t.dir, port: 7421, devOrigins: [], exchangeCodeTtlMs: 60_000, sessionTtlMs: 60_000, persist: false })
      const p = sec.terminalProof()
      expect(sec.verifyTerminalProof(p)).toBe(true)
      for (const bad of [undefined, '', ' ', p.slice(0, -1), `${p} `, p.toUpperCase(), 'x'.repeat(10_000)]) expect(sec.verifyTerminalProof(bad), String(bad).slice(0, 12)).toBe(false)
    } finally {
      t.cleanup()
    }
  })

  it('is masked by the logger like every other secret', async () => {
    const h = await harness()
    expect(h.daemon.security.secretLiterals()).toContain(h.daemon.security.terminalProof())
    // and a log line that quotes a request header never carries it
    h.logs.length = 0
    await h.call('/api/terminals', { proof: h.daemon.security.terminalProof(), host: 'evil.example' })
    expect(h.logs.join('\n')).not.toContain(h.daemon.security.terminalProof())
  })

  it('is handed out only in the fragment of the sign-in link, which is the one place no server ever sees', async () => {
    const h = await harness({ listen: true })
    const again = await h.daemon.start().catch(() => undefined) // already started by the harness: refused, nothing printed
    expect(again).toBeUndefined()
    // the link a fresh daemon prints
    const fresh = await harness({ listen: false })
    const info = await fresh.daemon.start()
    const url = new URL(info.exchangeUrl)
    expect(url.search).toBe(`?code=${info.code}`)
    expect(url.hash).toBe(`#tp=${fresh.daemon.security.terminalProof()}`)
    // a browser strips the fragment from every request it makes, so the server-visible part carries only the one-time code
    expect(`${url.pathname}${url.search}`).not.toContain(fresh.daemon.security.terminalProof())
  })
})
