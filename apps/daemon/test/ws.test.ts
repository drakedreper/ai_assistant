import { request as httpRequest } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { WsHello, type ServerEvent } from '@ai-assistant/shared'
import { ClientPump, type DaemonHello, type SocketLike } from '../src/ws'
import { makeDaemon, type TestDaemon } from './helpers'

const open: TestDaemon[] = []
const sockets: WebSocket[] = []
afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate()
  for (const d of open.splice(0)) await d.cleanup()
})

/** A daemon that is really listening on an ephemeral loopback port. */
async function live(opts: Parameters<typeof makeDaemon>[0] = {}): Promise<TestDaemon & { origin: string; wsUrl: string; cookie: string }> {
  const d = await makeDaemon({ ...opts, signIn: false, config: { port: 0, ...opts?.config } })
  open.push(d)
  const info = await d.daemon.start()
  const origin = `http://127.0.0.1:${info.port}`
  // Sign in over real HTTP, as a browser would.
  const code = info.code
  const res = await fetchJson(info.port, 'POST', '/api/auth/exchange', { code }, { Origin: origin })
  expect(res.status).toBe(200)
  const cookie = String(res.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? ''
  d.cookie = cookie
  return Object.assign(d, { origin, wsUrl: `ws://127.0.0.1:${info.port}/ws`, cookie })
}

function fetchJson(port: number, method: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; headers: Record<string, string[] | string | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers: { ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}), ...headers } }, (res) => {
      let data = ''
      res.on('data', (c) => (data += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers as Record<string, string[] | string | undefined>, body: data }))
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

interface Conn {
  ws: WebSocket
  messages: Array<Record<string, unknown>>
  next(n?: number): Promise<Array<Record<string, unknown>>>
  closed: Promise<{ code: number }>
}

function connect(url: string, headers: Record<string, string>, opts: { autoPong?: boolean } = {}): Promise<Conn> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers, ...opts })
    sockets.push(ws)
    const messages: Array<Record<string, unknown>> = []
    let cursor = 0
    const waiters: Array<() => void> = []
    ws.on('message', (data) => {
      messages.push(JSON.parse(data.toString()) as Record<string, unknown>)
      for (const w of waiters.splice(0)) w()
    })
    const closed = new Promise<{ code: number }>((res) => ws.on('close', (code) => res({ code })))
    const conn: Conn = {
      ws,
      messages,
      closed,
      async next(n = 1) {
        const start = cursor
        const deadline = Date.now() + 4000
        while (messages.length - start < n) {
          if (Date.now() > deadline) throw new Error(`timed out waiting for ${n} message(s); got ${messages.length - start}`)
          await new Promise<void>((r) => {
            waiters.push(r)
            setTimeout(r, 50)
          })
        }
        cursor = start + n
        return messages.slice(start, start + n)
      },
    }
    ws.once('open', () => resolve(conn))
    ws.once('error', reject)
    ws.once('unexpected-response', (_req, res) => reject(Object.assign(new Error(`status ${res.statusCode}`), { status: res.statusCode })))
  })
}

async function rejectedStatus(url: string, headers: Record<string, string>): Promise<number> {
  try {
    await connect(url, headers)
  } catch (e) {
    return (e as { status?: number }).status ?? -1
  }
  return 101
}

describe('WebSocket upgrade security', () => {
  it('rejects a missing cookie, a forged cookie and the hook token with 401', async () => {
    const d = await live()
    const name = d.daemon.security.cookieName()
    expect(await rejectedStatus(d.wsUrl, { Origin: d.origin })).toBe(401)
    expect(await rejectedStatus(d.wsUrl, { Origin: d.origin, Cookie: `${name}=forged` })).toBe(401)
    expect(await rejectedStatus(d.wsUrl, { Origin: d.origin, Authorization: `Bearer ${d.daemon.security.hookToken()}` })).toBe(401)
  })

  it('never accepts a token in the query string', async () => {
    const d = await live()
    expect(await rejectedStatus(`${d.wsUrl}?token=${d.daemon.security.hookToken()}`, { Origin: d.origin })).toBe(401)
    expect(await rejectedStatus(`${d.wsUrl}?cookie=${d.cookie}&access_token=${d.cookie}`, { Origin: d.origin })).toBe(401)
  })

  it('rejects a foreign or missing Origin even with a valid cookie (cross-site WebSocket hijacking)', async () => {
    const d = await live()
    expect(await rejectedStatus(d.wsUrl, { Origin: 'http://evil.example.com', Cookie: d.cookie })).toBe(403)
    expect(await rejectedStatus(d.wsUrl, { Cookie: d.cookie })).toBe(403)
    expect(await rejectedStatus(d.wsUrl, { Origin: 'null', Cookie: d.cookie })).toBe(403)
  })

  it('rejects a bad Host (DNS rebinding) even with a valid cookie and Origin', async () => {
    const d = await live()
    expect(await rejectedStatus(d.wsUrl, { Origin: d.origin, Cookie: d.cookie, Host: 'evil.example.com' })).toBe(403)
    expect(await rejectedStatus(d.wsUrl, { Origin: d.origin, Cookie: d.cookie, Host: '127.0.0.1:1' })).toBe(403)
  })

  it('rejects other paths and a malformed since', async () => {
    const d = await live()
    const h = { Origin: d.origin, Cookie: d.cookie }
    expect(await rejectedStatus(d.wsUrl.replace('/ws', '/socket'), h)).toBe(404)
    expect(await rejectedStatus(`${d.wsUrl}?since=abc`, h)).toBe(400)
    expect(await rejectedStatus(`${d.wsUrl}?since=-1`, h)).toBe(400)
  })

  it('accepts the dev server origin through the proxy path', async () => {
    const d = await live()
    const c = await connect(d.wsUrl, { Origin: 'http://localhost:5173', Cookie: d.cookie })
    expect((await c.next())[0]).toMatchObject({ type: 'hello' })
  })

  it('has no Access-Control headers on the real HTTP server either', async () => {
    const d = await live()
    const res = await fetchJson(d.daemon.address()!.port, 'GET', '/api/health', undefined, { Cookie: d.cookie, Origin: 'http://localhost:5173' })
    expect(res.status).toBe(200)
    expect(Object.keys(res.headers).some((k) => k.startsWith('access-control-'))).toBe(false)
  })
})

describe('WebSocket hello, live events and resume', () => {
  it('sends a valid hello first, with the current seq and epoch', async () => {
    const d = await live()
    d.daemon.bus.publish({ type: 'chat.done', messageId: 'x' })
    const c = await connect(d.wsUrl, { Origin: d.origin, Cookie: d.cookie })
    const [hello] = await c.next()
    expect(WsHello.safeParse(hello).success).toBe(true)
    const h = hello as unknown as DaemonHello
    expect(h).toMatchObject({ type: 'hello', seq: d.daemon.bus.latestSeq, epoch: d.daemon.bus.epoch, backend: 'fake', resync: false })
    expect(h.seq).toBeGreaterThan(0)
  })

  it('delivers live events in order after the hello', async () => {
    const d = await live()
    const c = await connect(d.wsUrl, { Origin: d.origin, Cookie: d.cookie })
    await c.next() // hello
    for (let i = 0; i < 5; i++) d.daemon.bus.publish({ type: 'chat.done', messageId: `m${i}` })
    const got = (await c.next(5)) as unknown as ServerEvent[]
    expect(got.map((e) => (e.type === 'chat.done' ? e.messageId : ''))).toEqual(['m0', 'm1', 'm2', 'm3', 'm4'])
    const seqs = got.map((e) => e.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
  })

  it('resumes: replays exactly the events missed since `since`, then continues live', async () => {
    const d = await live()
    const bus = d.daemon.bus
    for (let i = 0; i < 3; i++) bus.publish({ type: 'chat.done', messageId: `old${i}` })
    const since = bus.latestSeq
    for (let i = 0; i < 4; i++) bus.publish({ type: 'chat.done', messageId: `missed${i}` })
    const c = await connect(`${d.wsUrl}?since=${since}&epoch=${bus.epoch}`, { Origin: d.origin, Cookie: d.cookie })
    const msgs = (await c.next(5)) as Array<Record<string, unknown>>
    expect(msgs[0]).toMatchObject({ type: 'hello', resync: false, seq: bus.latestSeq })
    expect(msgs.slice(1).map((m) => m.messageId)).toEqual(['missed0', 'missed1', 'missed2', 'missed3'])
    bus.publish({ type: 'chat.done', messageId: 'live' })
    expect((await c.next())[0]).toMatchObject({ messageId: 'live' })
  })

  it('an unchanged position replays nothing', async () => {
    const d = await live()
    d.daemon.bus.publish({ type: 'chat.done', messageId: 'a' })
    const c = await connect(`${d.wsUrl}?since=${d.daemon.bus.latestSeq}&epoch=${d.daemon.bus.epoch}`, { Origin: d.origin, Cookie: d.cookie })
    expect((await c.next())[0]).toMatchObject({ type: 'hello', resync: false })
    d.daemon.bus.publish({ type: 'chat.done', messageId: 'b' })
    expect((await c.next())[0]).toMatchObject({ messageId: 'b' })
  })

  it('a different epoch (daemon restart) tells the client to refetch the snapshot and replays nothing', async () => {
    const d = await live()
    d.daemon.bus.publish({ type: 'chat.done', messageId: 'a' })
    const c = await connect(`${d.wsUrl}?since=1&epoch=not-this-run`, { Origin: d.origin, Cookie: d.cookie })
    const [hello] = (await c.next()) as unknown as DaemonHello[]
    expect(hello).toMatchObject({ resync: true, reason: 'epoch' })
    await new Promise((r) => setTimeout(r, 100))
    expect(c.messages).toHaveLength(1) // nothing replayed behind the hello
  })

  it('a gap (since older than the buffer) tells the client to resync', async () => {
    const d = await live({ config: { busBufferSize: 5 } })
    for (let i = 0; i < 20; i++) d.daemon.bus.publish({ type: 'chat.done', messageId: `m${i}` })
    const c = await connect(`${d.wsUrl}?since=3&epoch=${d.daemon.bus.epoch}`, { Origin: d.origin, Cookie: d.cookie })
    expect((await c.next())[0]).toMatchObject({ resync: true, reason: 'gap' })
  })

  it('since without an epoch, or from the future, also resyncs', async () => {
    const d = await live()
    d.daemon.bus.publish({ type: 'chat.done', messageId: 'a' })
    const noEpoch = await connect(`${d.wsUrl}?since=1`, { Origin: d.origin, Cookie: d.cookie })
    expect((await noEpoch.next())[0]).toMatchObject({ resync: true, reason: 'unknown_epoch' })
    const future = await connect(`${d.wsUrl}?since=500&epoch=${d.daemon.bus.epoch}`, { Origin: d.origin, Cookie: d.cookie })
    expect((await future.next())[0]).toMatchObject({ resync: true, reason: 'future' })
  })

  it('the snapshot seq lines up with the stream (nothing between snapshot and resume is lost)', async () => {
    const d = await live()
    const snapRes = await fetchJson(d.daemon.address()!.port, 'GET', '/api/snapshot', undefined, { Cookie: d.cookie })
    const epoch = String(snapRes.headers['x-daemon-epoch'])
    const seq = (JSON.parse(snapRes.body) as { seq: number }).seq
    expect(epoch).toBe(d.daemon.bus.epoch)
    d.daemon.bus.publish({ type: 'chat.done', messageId: 'between' })
    const c = await connect(`${d.wsUrl}?since=${seq}&epoch=${epoch}`, { Origin: d.origin, Cookie: d.cookie })
    const msgs = await c.next(2)
    expect(msgs[0]).toMatchObject({ type: 'hello', resync: false })
    expect(msgs[1]).toMatchObject({ messageId: 'between' })
  })

  it('answers an application-level ping and ignores junk from clients', async () => {
    const d = await live()
    const c = await connect(d.wsUrl, { Origin: d.origin, Cookie: d.cookie })
    await c.next()
    c.ws.send('not json')
    c.ws.send(JSON.stringify({ type: 'subscribe', topic: 'everything' }))
    c.ws.send(JSON.stringify({ type: 'ping' }))
    expect((await c.next())[0]).toEqual({ type: 'pong' })
  })

  it('carries real daemon traffic: a hook event shows up as session.update over the socket', async () => {
    const d = await live()
    const c = await connect(d.wsUrl, { Origin: d.origin, Cookie: d.cookie })
    await c.next()
    const hookRes = await fetchJson(d.daemon.address()!.port, 'POST', '/hooks/SessionStart', { session_id: 'ws-sess', hook_event_name: 'SessionStart', cwd: 'C:\\dev\\atlas' }, { Authorization: `Bearer ${d.daemon.security.hookToken()}` })
    expect(hookRes.status).toBe(200)
    await d.daemon.ctx.hooks.drain()
    // A brand-new project has no event of its own, so the first session arrives inside a snapshot.reset.
    const first = ((await c.next(2)) as Array<Record<string, unknown>>).map((m) => m.type)
    expect(first).toEqual(['agent.event', 'snapshot.reset'])
    await fetchJson(d.daemon.address()!.port, 'POST', '/hooks/UserPromptSubmit', { session_id: 'ws-sess', hook_event_name: 'UserPromptSubmit', cwd: 'C:\\dev\\atlas', prompt: 'hi' }, { Authorization: `Bearer ${d.daemon.security.hookToken()}` })
    await d.daemon.ctx.hooks.drain()
    const second = ((await c.next(2)) as Array<Record<string, unknown>>).map((m) => m.type)
    expect(second).toEqual(['agent.event', 'session.update'])
  })
})

describe('WebSocket limits and shutdown', () => {
  it('refuses clients beyond the maximum with 503', async () => {
    const d = await live({ config: { wsMaxClients: 2 } })
    const h = { Origin: d.origin, Cookie: d.cookie }
    await connect(d.wsUrl, h)
    await connect(d.wsUrl, h)
    expect(await rejectedStatus(d.wsUrl, h)).toBe(503)
    expect(d.daemon.ctx.ws()?.clientCount()).toBe(2)
  })

  it('drops a client that stops answering heartbeats', async () => {
    const d = await live({ config: { wsHeartbeatMs: 60 } })
    const c = await connect(d.wsUrl, { Origin: d.origin, Cookie: d.cookie }, { autoPong: false })
    await c.next()
    const closed = await Promise.race([c.closed, new Promise<{ code: number }>((r) => setTimeout(() => r({ code: -1 }), 3000))])
    expect(closed.code).not.toBe(-1)
    for (let i = 0; i < 40 && d.daemon.ctx.ws()?.clientCount() !== 0; i++) await new Promise((r) => setTimeout(r, 25))
    expect(d.daemon.ctx.ws()?.clientCount()).toBe(0)
  })

  it('keeps a healthy client that answers pings', async () => {
    const d = await live({ config: { wsHeartbeatMs: 60 } })
    const c = await connect(d.wsUrl, { Origin: d.origin, Cookie: d.cookie })
    await c.next()
    await new Promise((r) => setTimeout(r, 400))
    expect(c.ws.readyState).toBe(WebSocket.OPEN)
  })

  it('drops a slow consumer instead of buffering without bound', async () => {
    const d = await live({ config: { wsMaxBufferedBytes: 256 * 1024 } })
    const c = await connect(d.wsUrl, { Origin: d.origin, Cookie: d.cookie })
    await c.next()
    // Stop reading from the socket so the kernel and ws buffers fill up.
    ;(c.ws as unknown as { _socket: { pause(): void } })._socket.pause()
    const big = 'x'.repeat(200_000)
    for (let i = 0; i < 400 && d.daemon.ctx.ws()?.clientCount() === 1; i++) {
      d.daemon.bus.publish({ type: 'chat.delta', messageId: 'slow', text: big })
      if (i % 20 === 0) await new Promise((r) => setTimeout(r, 5))
    }
    expect(d.daemon.ctx.ws()?.clientCount()).toBe(0)
    expect(d.daemon.ctx.ws()?.stats().droppedSlow).toBeGreaterThanOrEqual(1)
    // the daemon keeps working for everyone else
    const other = await connect(d.wsUrl, { Origin: d.origin, Cookie: d.cookie })
    expect((await other.next())[0]).toMatchObject({ type: 'hello' })
  })

  it('closes clients cleanly on shutdown and stop() is idempotent', async () => {
    const d = await live()
    const c = await connect(d.wsUrl, { Origin: d.origin, Cookie: d.cookie })
    await c.next()
    await d.daemon.stop()
    const closed = await c.closed
    expect(closed.code).toBe(1001)
    await expect(d.daemon.stop()).resolves.toBeUndefined()
    expect(d.lane.stopped).toBe(true)
    expect(d.lane.interrupted).toBeGreaterThanOrEqual(1)
  })

  it('refuses to start twice and reports a busy port clearly', async () => {
    const d = await live()
    await expect(d.daemon.start()).rejects.toThrow(/already started/)
    const port = d.daemon.address()!.port
    const second = await makeDaemon({ signIn: false, config: { port } })
    open.push(second)
    await expect(second.daemon.start()).rejects.toThrow(/already in use/)
  })

  it('binds to the loopback interface only', async () => {
    const d = await live()
    expect(d.daemon.address()?.address).toBe('127.0.0.1')
  })

  it('starts the lane and returns a one-time sign-in link', async () => {
    const d = await makeDaemon({ signIn: false, config: { port: 0 } })
    open.push(d)
    const info = await d.daemon.start()
    expect(d.lane.state).toBe('ready')
    expect(info.exchangeUrl).toBe(`http://127.0.0.1:${info.port}/?code=${info.code}`)
    expect(info.code.length).toBeGreaterThanOrEqual(32)
    // The port in the allowlist follows the real port.
    expect(d.daemon.security.allowedHosts()).toContain(`127.0.0.1:${info.port}`)
  })
})

describe('ClientPump', () => {
  function fake(over: Partial<SocketLike> = {}): SocketLike & { sent: string[]; terminated: boolean } {
    const s = {
      readyState: 1,
      bufferedAmount: 0,
      sent: [] as string[],
      terminated: false,
      send(data: string) {
        s.sent.push(data)
      },
      close() {},
      terminate() {
        s.terminated = true
      },
      ping() {},
      ...over,
    }
    return s
  }

  it('sends objects as JSON and strings as they are', () => {
    const sock = fake()
    const pump = new ClientPump(sock, 1000, () => {})
    expect(pump.send({ a: 1 })).toBe(true)
    expect(pump.send('raw')).toBe(true)
    expect(sock.sent).toEqual(['{"a":1}', 'raw'])
  })

  it('drops the socket when its buffer is over the limit, before and after a send', () => {
    const reasons: string[] = []
    const before = fake({ bufferedAmount: 5000 })
    expect(new ClientPump(before, 1000, (r) => reasons.push(r)).send({ a: 1 })).toBe(false)
    expect(before.terminated).toBe(true)
    expect(before.sent).toHaveLength(0)

    const after = fake()
    after.send = (d: string) => {
      after.sent.push(d)
      after.bufferedAmount = 5000
    }
    const pump = new ClientPump(after, 1000, (r) => reasons.push(r))
    expect(pump.send({ a: 1 })).toBe(false)
    expect(after.terminated).toBe(true)
    expect(reasons).toEqual(['slow_consumer', 'slow_consumer'])
    expect(pump.send({ a: 2 })).toBe(false) // stays dropped
  })

  it('does not send to a socket that is not open and drops one whose send throws', () => {
    const closed = fake({ readyState: 3 })
    expect(new ClientPump(closed, 1000, () => {}).send('x')).toBe(false)
    expect(closed.terminated).toBe(false)
    const throwing = fake({
      send() {
        throw new Error('EPIPE')
      },
    })
    const reasons: string[] = []
    expect(new ClientPump(throwing, 1000, (r) => reasons.push(r)).send('x')).toBe(false)
    expect(reasons).toEqual(['send_failed'])
    expect(throwing.terminated).toBe(true)
  })
})
