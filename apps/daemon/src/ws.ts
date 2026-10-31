import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer } from 'ws'
import type { WsHello } from '@ai-assistant/shared'
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
}): WsHub {
  const { server, bus, security, log } = opts
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false })
  const stats = { accepted: 0, rejected: 0, droppedSlow: 0 }
  const alive = new WeakMap<object, boolean>()

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

    wss.handleUpgrade(req, socket, head, (ws) => {
      stats.accepted++
      alive.set(ws, true)
      const pump = new ClientPump(ws, opts.options.maxBufferedBytes, (reason) => {
        if (reason === 'slow_consumer') stats.droppedSlow++
        log.warn('dropped websocket client', { reason })
      })

      // Everything below is synchronous, so no event can be published between planning the replay and subscribing.
      const plan = bus.planReplay(since, epoch)
      const unsubscribe = bus.subscribe((event) => {
        pump.send(event)
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
      if (plan.kind === 'replay') for (const e of plan.events) pump.send(e)

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

  const heartbeat = setInterval(() => {
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
