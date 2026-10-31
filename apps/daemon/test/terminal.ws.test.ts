import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { TerminalServerMessage } from '@ai-assistant/shared'
import { makeTerminalHarness, rawHttp, type TerminalHarness } from './terminalHarness'

const open: TerminalHarness[] = []
const sockets: WebSocket[] = []
afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate()
  for (const h of open.splice(0)) await h.cleanup()
})

async function live(opts: Parameters<typeof makeTerminalHarness>[0] = {}): Promise<TerminalHarness> {
  const h = await makeTerminalHarness({ listen: true, ...opts })
  open.push(h)
  return h
}

interface Conn {
  ws: WebSocket
  text: Array<Record<string, unknown>>
  bin: Buffer[]
  closed: Promise<{ code: number; reason: string }>
  binText(): string
  waitText(n: number): Promise<void>
  waitBinary(match: string, ms?: number): Promise<void>
}

function connect(h: TerminalHarness, id: string, headers: Record<string, string> | 'default' = 'default'): Promise<Conn> {
  const url = `ws://127.0.0.1:${h.port}/ws/terminal/${encodeURIComponent(id)}`
  const hdrs = headers === 'default' ? { Origin: h.origin, Cookie: h.cookie } : headers
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: hdrs })
    sockets.push(ws)
    const text: Array<Record<string, unknown>> = []
    const bin: Buffer[] = []
    const waiters: Array<() => void> = []
    const wake = () => waiters.splice(0).forEach((w) => w())
    ws.on('message', (data, isBinary) => {
      if (isBinary) bin.push(Buffer.from(data as Buffer))
      else text.push(JSON.parse(data.toString()) as Record<string, unknown>)
      wake()
    })
    const closed = new Promise<{ code: number; reason: string }>((res) => ws.on('close', (code, reason) => res({ code, reason: reason.toString() })))
    const until = async (cond: () => boolean, label: string, ms = 4000) => {
      const end = Date.now() + ms
      while (!cond()) {
        if (Date.now() > end) throw new Error(`timed out waiting for ${label}`)
        await new Promise<void>((r) => {
          waiters.push(r)
          setTimeout(r, 25)
        })
      }
    }
    const conn: Conn = {
      ws,
      text,
      bin,
      closed,
      binText: () => Buffer.concat(bin).toString('utf8'),
      waitText: (n) => until(() => text.length >= n, `${n} text frame(s), got ${text.length}`),
      waitBinary: (match, ms) => until(() => conn.binText().includes(match), `binary output containing ${match}`, ms),
    }
    ws.once('open', () => resolve(conn))
    ws.once('error', reject)
    ws.once('unexpected-response', (_req, res) => {
      let b = ''
      res.on('data', (c) => (b += c))
      res.on('end', () => reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode, body: b })))
    })
  })
}

const authFrame = (ticket: string) => JSON.stringify({ type: 'auth', ticket })

async function authed(h: TerminalHarness, id: string): Promise<Conn> {
  const c = await connect(h, id)
  c.ws.send(authFrame(await h.ticket(id)))
  await c.waitText(1)
  return c
}

describe('the upgrade handshake', () => {
  it('refuses a wrong Host, a missing or foreign Origin, and a missing or bad cookie before any socket exists', async () => {
    const h = await live()
    const { id } = await h.create()
    const cases: Array<[string, Record<string, string>, number]> = [
      ['no origin', { Cookie: h.cookie }, 403],
      ['foreign origin', { Origin: 'https://evil.example', Cookie: h.cookie }, 403],
      ['null origin', { Origin: 'null', Cookie: h.cookie }, 403],
      ['no cookie', { Origin: h.origin }, 401],
      ['bad cookie', { Origin: h.origin, Cookie: 'aia_sid_1=nope' }, 401],
      ['wrong host', { Origin: h.origin, Cookie: h.cookie, Host: 'evil.example:80' }, 403],
    ]
    for (const [name, headers, status] of cases) {
      await expect(connect(h, id, headers), name).rejects.toMatchObject({ status })
    }
    expect(h.daemon.terminals.upgrade.socketCount()).toBe(0)
    expect(h.daemon.terminals.service.isAttached(id)).toBe(false)
  })

  it('refuses a dev origin (another app on port 5173 shares the cookie) unless TERMINAL_ALLOW_DEV_ORIGINS is set', async () => {
    const h = await live()
    const { id } = await h.create()
    await expect(connect(h, id, { Origin: 'http://127.0.0.1:5173', Cookie: h.cookie })).rejects.toMatchObject({ status: 403, body: expect.stringContaining('forbidden_origin') })
    await expect(connect(h, id, { Origin: 'http://localhost:5173', Cookie: h.cookie })).rejects.toMatchObject({ status: 403 })
    expect(h.daemon.terminals.upgrade.socketCount()).toBe(0)
    const allowed = await live({ limits: { allowDevOrigins: true } })
    const t = await allowed.create()
    const c = await connect(allowed, t.id, { Origin: 'http://127.0.0.1:5173', Cookie: allowed.cookie })
    c.ws.send(authFrame(await allowed.ticket(t.id)))
    await c.waitText(1)
    expect(c.text[0]).toMatchObject({ type: 'ready' })
  })

  it('answers 403 terminals_disabled and 404 for an unknown terminal', async () => {
    const h = await live()
    await expect(connect(h, 'term-nope')).rejects.toMatchObject({ status: 404 })
    const { id } = await h.create()
    await h.setEnabled(false)
    await expect(connect(h, id)).rejects.toMatchObject({ status: 403, body: expect.stringContaining('terminals_disabled') })
  })

  it('only leaves /ws/terminal/ alone: other unknown ws paths are still refused by the main handler', async () => {
    const h = await live()
    await expect(connect(h, 'x').catch((e: unknown) => Promise.reject(e))).rejects.toMatchObject({ status: 404 })
    const res = await rawHttp(h.port, 'GET', '/ws/other', undefined, { Origin: h.origin, Cookie: h.cookie })
    expect([404, 401]).toContain(res.status)
  })

  it('a plain HTTP GET to a terminal socket path needs the cookie and says to upgrade', async () => {
    const h = await live()
    const { id } = await h.create()
    expect((await rawHttp(h.port, 'GET', `/ws/terminal/${id}`, undefined, {})).status).toBe(401)
    expect((await rawHttp(h.port, 'GET', `/ws/terminal/${id}`, undefined, { Cookie: h.cookie })).status).toBe(426)
  })

  it('does not read anything from the query string', async () => {
    const h = await live()
    const { id } = await h.create()
    const ticket = await h.ticket(id)
    const ws = new WebSocket(`ws://127.0.0.1:${h.port}/ws/terminal/${id}?ticket=${ticket}&token=${ticket}`, { headers: { Origin: h.origin, Cookie: h.cookie } })
    sockets.push(ws)
    const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)))
    await new Promise((r) => ws.once('open', r))
    expect(await closed).toBe(4408) // never authenticated: closed by the auth timeout
    expect(h.daemon.terminals.tickets.pendingCount()).toBe(1) // the ticket in the URL was not consumed
  })
})

describe('the auth frame and tickets', () => {
  it('ready, then the scrollback as binary frames, then live output', async () => {
    const h = await live()
    const { id } = await h.create()
    h.fake.last().emit('hello from before the attach\r\n')
    const c = await connect(h, id)
    c.ws.send(authFrame(await h.ticket(id)))
    await c.waitText(1)
    expect(TerminalServerMessage.parse(c.text[0])).toEqual({ type: 'ready', replayBytes: 30 })
    await c.waitBinary('before the attach')
    expect(c.binText()).toBe('hello from before the attach\r\n')
    h.fake.last().emit('live line\r\n')
    await c.waitBinary('live line')
  })

  it('a socket that sends nothing is closed after the auth timeout', async () => {
    const h = await live()
    const { id } = await h.create()
    const c = await connect(h, id)
    expect(await c.closed).toMatchObject({ code: 4408 })
    expect(h.daemon.terminals.service.isAttached(id)).toBe(false)
  })

  it('rejects a first frame that is not a valid auth frame (binary, junk, wrong type, oversize)', async () => {
    const h = await live()
    const { id } = await h.create()
    const frames: Array<[string, string | Buffer]> = [
      ['binary', Buffer.from('keystrokes')],
      ['junk', 'not json'],
      ['resize first', JSON.stringify({ type: 'resize', cols: 80, rows: 24 })],
      ['no ticket', JSON.stringify({ type: 'auth' })],
      ['numeric ticket', JSON.stringify({ type: 'auth', ticket: 12 })],
      ['oversize', JSON.stringify({ type: 'auth', ticket: 'x'.repeat(4000) })],
    ]
    for (const [name, frame] of frames) {
      const c = await connect(h, id)
      c.ws.send(frame)
      expect(await c.closed, name).toMatchObject({ code: 4401, reason: 'unauthorized' })
    }
    expect(h.fake.last().text).toBe('') // nothing reached the pty
    expect(h.daemon.terminals.service.isAttached(id)).toBe(false)
  })

  it('a ticket works once: reuse is refused', async () => {
    const h = await live()
    const { id } = await h.create()
    const ticket = await h.ticket(id)
    const first = await connect(h, id)
    first.ws.send(authFrame(ticket))
    await first.waitText(1)
    first.ws.close()
    await first.closed
    await new Promise((r) => setTimeout(r, 30))
    const second = await connect(h, id)
    second.ws.send(authFrame(ticket))
    expect(await second.closed).toMatchObject({ code: 4401, reason: 'unauthorized' })
  })

  it('a ticket cannot be used for another terminal, and the attempt burns it', async () => {
    const h = await live({ limits: { maxTerminals: 4 } })
    const a = await h.create()
    const b = await h.create()
    const ticketA = await h.ticket(a.id)
    const wrong = await connect(h, b.id)
    wrong.ws.send(authFrame(ticketA))
    expect(await wrong.closed).toMatchObject({ code: 4401 })
    expect(h.daemon.terminals.service.isAttached(b.id)).toBe(false)
    const right = await connect(h, a.id)
    right.ws.send(authFrame(ticketA))
    expect(await right.closed).toMatchObject({ code: 4401 }) // burned
  })

  it('an expired ticket is refused', async () => {
    const h = await live()
    const { id } = await h.create()
    const ticket = await h.ticket(id)
    h.clock.advance(31_000)
    const c = await connect(h, id)
    c.ws.send(authFrame(ticket))
    expect(await c.closed).toMatchObject({ code: 4401 })
  })

  it('a ticket is bound to the browser session that asked for it', async () => {
    const h = await live()
    const { id } = await h.create()
    const ticket = await h.ticket(id)
    // a second, equally valid browser session
    const { code } = h.daemon.security.issueExchangeCode()
    const ex = await rawHttp(h.port, 'POST', '/api/auth/exchange', { code }, { Origin: h.origin })
    const otherCookie = String(ex.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? ''
    expect(otherCookie).not.toBe(h.cookie)
    const c = await connect(h, id, { Origin: h.origin, Cookie: otherCookie })
    c.ws.send(authFrame(ticket))
    expect(await c.closed).toMatchObject({ code: 4401 })
    expect(h.daemon.terminals.service.isAttached(id)).toBe(false)
  })

  it('rate limits repeated failed auth attempts', async () => {
    const h = await live()
    const { id } = await h.create()
    for (let i = 0; i < 20; i++) {
      const c = await connect(h, id)
      c.ws.send(authFrame(`wrong-${i}`))
      await c.closed
    }
    const good = await h.ticket(id)
    const c = await connect(h, id)
    c.ws.send(authFrame(good))
    expect(await c.closed).toMatchObject({ code: 4401 })
    expect(h.daemon.terminals.upgrade.stats().authFailed).toBeGreaterThanOrEqual(21)
  })

  it('the ticket is never in a URL or a log line', async () => {
    const h = await live()
    const { id } = await h.create()
    const ticket = await h.ticket(id)
    const c = await connect(h, id)
    c.ws.send(authFrame(ticket))
    await c.waitText(1)
    expect(c.ws.url).not.toContain(ticket)
    expect(h.logs.join('\n')).not.toContain(ticket)
  })
})

describe('one client, input, resize, exit', () => {
  it('a second client is refused with already_attached, and may connect once the first leaves', async () => {
    const h = await live()
    const { id } = await h.create()
    const first = await authed(h, id)
    const second = await connect(h, id)
    second.ws.send(authFrame(await h.ticket(id)))
    await second.waitText(1)
    expect(second.text[0]).toEqual({ type: 'error', message: 'already_attached' })
    expect(await second.closed).toMatchObject({ code: 4409 })
    // the first client is untouched
    h.fake.last().emit('still here')
    await first.waitBinary('still here')
    first.ws.close()
    await first.closed
    await new Promise((r) => setTimeout(r, 30))
    const third = await authed(h, id)
    expect(third.text[0]).toMatchObject({ type: 'ready' })
  })

  it('binary frames are keystrokes, text frames are resize; the pty keeps running when the browser disconnects', async () => {
    const h = await live()
    const { id } = await h.create()
    const c = await authed(h, id)
    c.ws.send(Buffer.from('echo hi\r'))
    c.ws.send(JSON.stringify({ type: 'resize', cols: 132, rows: 43 }))
    const deadline = Date.now() + 2000
    while ((h.fake.last().text !== 'echo hi\r' || h.fake.last().resizes.length === 0) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
    expect(h.fake.last().text).toBe('echo hi\r')
    expect(h.fake.last().resizes).toEqual([[132, 43]])
    c.ws.close()
    await c.closed
    await new Promise((r) => setTimeout(r, 30))
    expect(h.daemon.terminals.service.get(id)).toMatchObject({ state: 'running', cols: 132, rows: 43 })
    expect(h.killer.terminated).toHaveLength(0)
  })

  it('reattach with a fresh ticket replays what happened while the browser was away', async () => {
    const h = await live()
    const { id } = await h.create()
    const a = await authed(h, id)
    h.fake.last().emit('first part|')
    await a.waitBinary('first part')
    a.ws.close()
    await a.closed
    h.fake.last().emit('while away|')
    await new Promise((r) => setTimeout(r, 30))
    const b = await authed(h, id)
    await b.waitBinary('while away|')
    expect(b.binText()).toBe('first part|while away|')
    expect(b.text[0]).toEqual({ type: 'ready', replayBytes: 22 })
  })

  it('invalid text frames after auth close the socket; a second auth is answered with an error', async () => {
    const h = await live()
    const { id } = await h.create()
    const c = await authed(h, id)
    c.ws.send(authFrame('again'))
    await c.waitText(2)
    expect(c.text[1]).toEqual({ type: 'error', message: 'already_authenticated' })
    c.ws.send(JSON.stringify({ type: 'resize', cols: 3, rows: 3 }))
    expect(await c.closed).toMatchObject({ code: 4400 })
    const d = await authed(h, id).catch(() => undefined)
    if (d) {
      d.ws.send('{nope')
      expect(await d.closed).toMatchObject({ code: 4400 })
    }
  })

  it('a frame above the cap closes the socket with 1009 and writes nothing', async () => {
    const h = await live({ limits: { maxInputFrameBytes: 2048 } })
    const { id } = await h.create()
    const c = await authed(h, id)
    c.ws.send(Buffer.alloc(4096, 0x61))
    expect(await c.closed).toMatchObject({ code: 1009 })
    expect(h.fake.last().text).toBe('')
  })

  it('drops input above the rate limit with an error message, and never silently', async () => {
    const h = await live({ limits: { inputBurstBytes: 2000, inputBytesPerSec: 100 } })
    const { id } = await h.create()
    const c = await authed(h, id)
    for (let i = 0; i < 20; i++) c.ws.send(Buffer.alloc(500, 0x61))
    await c.waitText(2)
    expect(c.text.filter((m) => m.type === 'error' && m.message === 'input_rate_limited').length).toBeGreaterThan(0)
    await new Promise((r) => setTimeout(r, 50))
    expect(h.fake.last().text.length).toBeLessThanOrEqual(2000)
    expect(h.fake.last().text.length).toBeGreaterThan(0)
  })

  it('tells the client about the exit and closes the socket; the terminal stays listed as exited', async () => {
    const h = await live()
    const { id } = await h.create()
    const c = await authed(h, id)
    h.fake.last().emit('bye\r\n')
    await c.waitBinary('bye')
    h.fake.last().exit(4)
    await c.waitText(2)
    expect(TerminalServerMessage.parse(c.text[1])).toEqual({ type: 'exit', exitCode: 4 })
    expect(await c.closed).toMatchObject({ code: 1000 })
    const info = h.daemon.terminals.service.get(id)
    expect(info).toMatchObject({ state: 'exited', exitCode: 4 })
    // a later attach still shows the final output and the exit
    const late = await authed(h, id)
    expect(late.text[0]).toMatchObject({ type: 'ready' })
    await late.waitText(2)
    expect(late.text[1]).toEqual({ type: 'exit', exitCode: 4 })
    expect(late.binText()).toBe('bye\r\n')
  })

  it('closing the terminal over HTTP tells the attached client and closes its socket', async () => {
    const h = await live()
    const { id } = await h.create()
    const c = await authed(h, id)
    const res = await h.call(`/api/terminals/${id}`, { method: 'DELETE' })
    expect(res.status).toBe(204)
    await c.waitText(2)
    expect(c.text[1]).toMatchObject({ type: 'exit' })
    expect(await c.closed).toMatchObject({ code: 1000 })
  })

  it('switching terminals off closes every attached socket', async () => {
    const h = await live({ limits: { maxTerminals: 4 } })
    const a = await h.create()
    const b = await h.create()
    const ca = await authed(h, a.id)
    const cb = await authed(h, b.id)
    await h.setEnabled(false)
    await Promise.all([ca.closed, cb.closed])
    const deadline = Date.now() + 2000
    while (h.daemon.terminals.upgrade.socketCount() > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
    expect(h.daemon.terminals.upgrade.socketCount()).toBe(0)
  })
})

describe('slow consumers and shutdown', () => {
  it('drops a client whose buffer grows past the bound, while the terminal keeps running and can be reattached', async () => {
    const h = await live({ limits: { maxBufferedBytes: 64 * 1024, scrollbackBytes: 4096 } })
    const { id } = await h.create()
    const c = await authed(h, id)
    // a client that stops reading: pause the underlying socket
    ;(c.ws as unknown as { _socket: { pause(): void } })._socket.pause()
    const chunk = 'y'.repeat(32 * 1024)
    for (let i = 0; i < 4000 && h.daemon.terminals.service.isAttached(id); i++) {
      h.fake.last().emit(chunk)
      if (i % 50 === 0) await new Promise((r) => setTimeout(r, 1))
    }
    expect(h.daemon.terminals.service.isAttached(id)).toBe(false)
    expect(h.daemon.terminals.upgrade.stats().droppedSlow).toBeGreaterThan(0)
    expect(h.daemon.terminals.service.get(id)).toMatchObject({ state: 'running' })
    const again = await authed(h, id)
    expect(again.text[0]).toMatchObject({ type: 'ready' })
  })

  it('limits the number of sockets that have not authenticated yet', async () => {
    const h = await live({ limits: { authTimeoutMs: 3000 } })
    const { id } = await h.create()
    const idle: Conn[] = []
    for (let i = 0; i < 8; i++) idle.push(await connect(h, id))
    await expect(connect(h, id)).rejects.toMatchObject({ status: 503 })
    idle.forEach((c) => c.ws.terminate())
  })

  it('daemon shutdown kills the ptys and closes the sockets', async () => {
    const h = await live()
    const { id } = await h.create()
    const c = await authed(h, id)
    const pid = h.fake.last().pid
    await h.daemon.stop()
    expect(h.killer.terminated).toContain(pid)
    const closed = await c.closed
    expect([1000, 1001]).toContain(closed.code)
  })
})
