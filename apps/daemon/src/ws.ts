import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer } from 'ws'
import type { ServerEvent, WsHello } from '@ai-assistant/shared'
import { DaemonRoutes } from '@ai-assistant/shared'
import type { EventBus } from './bus'
import type { Logger } from './log'
import type { Security } from './security'

/** The hello the daemon sends: the shared WsHello plus a local `resync` flag (see README, "WebSocket"). */
export type DaemonHello = WsHello & { resync: boolean; reason?: string }

/** The slice of a ws WebSocket the pump needs; a plain object implements it in tests. */
export interface SocketLike {
  readyState: number
  bufferedAmount: number
  send(data: string): void
  close(code?: number, reason?: string): void
  terminate(): void
  ping(): void
}

const OPEN = 1

/**
 * Paths served by other upgrade listeners: this handler must not answer (or destroy) those sockets. `/ws/stage` is the
 * engine's own door (bearer token, no cookie): src/stage/upgrade.ts answers everything under it, including a wrong path.
 */
const OTHER_WS_PREFIXES = ['/ws/terminal/', '/ws/stage']

export interface WsOptions {
  maxClients: number
  heartbeatMs: number
  /** A client whose unsent buffer exceeds this is dropped (slow consumer). */
  maxBufferedBytes: number
}

/** Bounded fan-out to one socket: drop it rather than let memory grow behind a slow reader. */
export class ClientPump {
  dropped = false
  constructor(
    private readonly socket: SocketLike,
    private readonly maxBufferedBytes: number,
    private readonly onDrop: (reason: string) => void,
  ) {}

  send(message: unknown): boolean {
    if (this.dropped || this.socket.readyState !== OPEN) return false
    if (this.socket.bufferedAmount > this.maxBufferedBytes) return this.drop('slow_consumer')
    try {
      this.socket.send(typeof message === 'string' ? message : JSON.stringify(message))
    } catch {
      return this.drop('send_failed')
    }
    if (this.socket.bufferedAmount > this.maxBufferedBytes) return this.drop('slow_consumer')
    return true
  }

  private drop(reason: string): false {
    this.dropped = true
    this.onDrop(reason)
    try {
      this.socket.terminate()
    } catch {
      /* already gone */
    }
    return false
  }
}

export interface WsHub {
  clientCount(): number
  stats(): { accepted: number; rejected: number; droppedSlow: number }
  /** Close (4401) every client whose session is no longer valid (signed out, revoked from the command line). */
  dropRevoked(): number
  close(): Promise<void>
}

function rejectUpgrade(socket: Duplex, status: number, code: string): void {
  const text: Record<number, string> = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 503: 'Service Unavailable' }
  const body = JSON.stringify({ error: code })
  socket.write(
    `HTTP/1.1 ${status} ${text[status] ?? 'Error'}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nCache-Control: no-store\r\n\r\n${body}`,
  )
  socket.destroy()
}

export function attachWebSocket(opts: {
  server: Server
  bus: EventBus
  security: Security
  hello: () => { backend: 'fake' | 'sdk'; version: string }
  options: WsOptions
  log: Logger
  /**
   * Shape an event for ONE client before it is sent. `ownOrigin` is false for a page served from a dev origin (the Vite dev
   * server): it is allowed to read the feed, but not the details of the embedded terminals (src/app.ts hides them).
   */
  transform?: (event: ServerEvent, ownOrigin: boolean) => ServerEvent
}): WsHub {
  const { server, bus, security, log } = opts
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false })
  const stats = { accepted: 0, rejected: 0, droppedSlow: 0 }
  const alive = new WeakMap<object, boolean>()
  /** Who each socket is: the session it signed in with (a hash, never the cookie). */
  const owners = new WeakMap<object, { sessionKey: string | undefined }>()

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    socket.on('error', () => {})
    let url: URL
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1')
    } catch {
      stats.rejected++
      return rejectUpgrade(socket, 400, 'bad_request')
    }
    if (url.pathname !== DaemonRoutes.ws) {
      // Other WebSocket endpoints (embedded terminals) attach their own 'upgrade' listener and answer for their paths.
      if (OTHER_WS_PREFIXES.some((p) => url.pathname.startsWith(p))) return
      stats.rejected++
      return rejectUpgrade(socket, 404, 'not_found')
    }
    // Host, then Origin (required on upgrades: every browser sends it), then the session cookie.
    // Tokens in the query string are never read.
    const verdict = security.checkUpgrade({
      ...(req.headers.host !== undefined ? { host: req.headers.host } : {}),
      ...(req.headers.origin !== undefined ? { origin: req.headers.origin } : {}),
      ...(req.headers.cookie !== undefined ? { cookie: req.headers.cookie } : {}),
    })
    if (!verdict.ok) {
      stats.rejected++
      log.warn('rejected websocket upgrade', { code: verdict.code })
      return rejectUpgrade(socket, verdict.status, verdict.code)
    }
    const sinceRaw = url.searchParams.get('since')
    if (sinceRaw !== null && !/^\d{1,15}$/.test(sinceRaw)) {
      stats.rejected++
      return rejectUpgrade(socket, 400, 'bad_since')
    }
    if (wss.clients.size >= opts.options.maxClients) {
      stats.rejected++
      return rejectUpgrade(socket, 503, 'too_many_clients')
    }
    const since = sinceRaw === null ? undefined : Number(sinceRaw)
    const epoch = url.searchParams.get('epoch') ?? undefined
    const cookieValue = security.parseSessionCookie(req.headers.cookie)
    const sessionKey = cookieValue ? security.sessionKey(cookieValue) : undefined
    const ownOrigin = security.isOwnOrigin(req.headers.origin)

    wss.handleUpgrade(req, socket, head, (ws) => {
      stats.accepted++
      alive.set(ws, true)
      owners.set(ws, { sessionKey })
      const pump = new ClientPump(ws, opts.options.maxBufferedBytes, (reason) => {
        if (reason === 'slow_consumer') stats.droppedSlow++
        log.warn('dropped websocket client', { reason })
      })

      // Everything below is synchronous, so no event can be published between planning the replay and subscribing.
      const plan = bus.planReplay(since, epoch)
      const shape = (event: ServerEvent): ServerEvent => (opts.transform ? opts.transform(event, ownOrigin) : event)
      const unsubscribe = bus.subscribe((event) => {
        pump.send(shape(event))
      })
      const hello: DaemonHello = {
        type: 'hello',
        seq: bus.latestSeq,
        epoch: bus.epoch,
        backend: opts.hello().backend,
        version: opts.hello().version,
        resync: plan.kind === 'resync',
        ...(plan.kind === 'resync' ? { reason: plan.reason } : {}),
      }
      pump.send(hello)
      if (plan.kind === 'replay') for (const e of plan.events) pump.send(shape(e))

      ws.on('pong', () => alive.set(ws, true))
      ws.on('message', (data, isBinary) => {
        if (isBinary) return
        try {
          const msg = JSON.parse(data.toString()) as { type?: unknown }
          if (msg.type === 'ping') pump.send({ type: 'pong' })
        } catch {
          /* clients are read-only consumers; ignore anything else */
        }
      })
      ws.on('close', unsubscribe)
      ws.on('error', () => {
        unsubscribe()
        ws.terminate()
      })
    })
  }

  server.on('upgrade', onUpgrade)

  /** Close the sockets of sessions that are no longer valid (4401: the client must sign in again). */
  const dropRevoked = (): number => {
    let n = 0
    for (const ws of wss.clients) {
      const key = owners.get(ws)?.sessionKey
      if (key !== undefined && security.validateSessionKey(key)) continue
      n++
      try {
        ws.close(4401, 'signed out')
      } catch {
        ws.terminate()
      }
      const t = setTimeout(() => ws.terminate(), 1000)
      t.unref()
    }
    return n
  }

  const heartbeat = setInterval(() => {
    // A session revoked from the command line is noticed here at the latest (the file is re-read on the next check).
    dropRevoked()
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
        ws.terminate()
        continue
      }
      alive.set(ws, false)
      try {
        ws.ping()
      } catch {
        ws.terminate()
      }
    }
  }, opts.options.heartbeatMs)
  heartbeat.unref()

  return {
    clientCount: () => wss.clients.size,
    stats: () => ({ ...stats }),
    dropRevoked,
    async close() {
      clearInterval(heartbeat)
      server.off('upgrade', onUpgrade)
      for (const ws of wss.clients) ws.close(1001, 'daemon shutting down')
      // Give clients a moment to finish the closing handshake, then cut whoever is left.
      const deadline = Date.now() + 500
      while (wss.clients.size > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
      for (const ws of wss.clients) ws.terminate()
      await new Promise<void>((resolve) => wss.close(() => resolve()))
    },
  }
}
