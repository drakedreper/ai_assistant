import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type RawData, type WebSocket } from 'ws'
import { TerminalClientMessage, TerminalServerMessage } from '@ai-assistant/shared'
import type { TerminalConfig } from '../config'
import type { Logger } from '../log'
import type { Security } from '../security'
import { sessionKeyOf, type TicketStore } from './tickets'
import { TerminalError, type TerminalAttachment, type TerminalService, type TerminalSink } from './service'

/**
 * The terminal WebSocket: GET /ws/terminal/:id with an Upgrade.
 *
 * Handshake checks, in order, all before the upgrade completes (a plain HTTP error answer, no socket is created):
 *   1. Host is 127.0.0.1:PORT or localhost:PORT, 2. Origin is REQUIRED and allowlisted (cross-site WebSocket
 *   hijacking) and is the daemon's OWN origin (dev origins only with TERMINAL_ALLOW_DEV_ORIGINS), 3. the session cookie is valid (same checks as every browser route; nothing is read from the URL),
 *   4. terminals are switched on (403 terminals_disabled), 5. the terminal exists (404), 6. a bounded number of
 *   not-yet-authenticated sockets (503).
 * After the upgrade the FIRST frame must be a TEXT frame {type:'auth', ticket} within `authTimeoutMs`; the ticket is
 * single use, short lived, bound to this terminal and to this browser session (see tickets.ts). Any other first
 * frame, a bad ticket or a timeout closes the socket with a generic reason (no oracle for which part failed).
 *
 * After auth: the server sends {type:'ready', replayBytes}, then the scrollback as BINARY frames. Terminal output and
 * keystrokes are binary frames. Text frames are only TerminalClientMessage (resize) from the client and
 * TerminalServerMessage (ready, exit, error) from the server, validated with the shared zod schemas.
 *
 * Limits: one client per terminal; frames above maxInputFrameBytes close the socket (1009, enforced by `ws`);
 * a token bucket on keystrokes (excess frames are dropped with an error message, never silently); a slow consumer
 * (unsent bytes above maxBufferedBytes) is dropped and can reattach; a ping every 30 s drops dead peers.
 * The PTY keeps running when the browser goes away.
 */

export const TERMINAL_WS_PREFIX = '/ws/terminal/'

/** Close codes (4000 to 4999 are application codes). The reason text is deliberately generic. */
export const CLOSE = {
  unauthorized: 4401,
  authTimeout: 4408,
  alreadyAttached: 4409,
  badFrame: 4400,
  tooMany: 4503,
} as const

const MAX_AUTH_FRAME_BYTES = 2048
const MAX_UNAUTHENTICATED = 8

export interface TerminalUpgrade {
  /** Is this upgrade request for a terminal socket (so the main /ws handler must leave it alone)? */
  matches(pathname: string): boolean
  attach(server: Server): void
  close(): Promise<void>
  stats(): { accepted: number; rejected: number; authFailed: number; droppedSlow: number }
  socketCount(): number
}

export interface TerminalUpgradeDeps {
  security: Security
  service: TerminalService
  tickets: TicketStore
  limits: TerminalConfig
  log: Logger
  heartbeatMs?: number
  /** The daemon's own origin only (and the dev origins when explicitly allowed): see TERMINAL_ALLOW_DEV_ORIGINS. */
  originAllowed?: (origin: string | undefined) => boolean
}

function reject(socket: Duplex, status: number, code: string): void {
  const text: Record<number, string> = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 503: 'Service Unavailable' }
  const body = JSON.stringify({ error: code })
  socket.write(`HTTP/1.1 ${status} ${text[status] ?? 'Error'}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nCache-Control: no-store\r\n\r\n${body}`)
  socket.destroy()
}

export function terminalIdFromPath(pathname: string): string | undefined {
  if (!pathname.startsWith(TERMINAL_WS_PREFIX)) return undefined
  const raw = pathname.slice(TERMINAL_WS_PREFIX.length)
  if (raw.length === 0 || raw.includes('/')) return undefined
  try {
    const id = decodeURIComponent(raw)
    return id.length > 0 && id.length <= 128 && !id.includes('\0') ? id : undefined
  } catch {
    return undefined
  }
}

function dataToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data
  if (Array.isArray(data)) return Buffer.concat(data)
  return Buffer.from(data)
}

export function createTerminalUpgrade(deps: TerminalUpgradeDeps): TerminalUpgrade {
  const { security, service, tickets, limits, log } = deps
  const wss = new WebSocketServer({ noServer: true, maxPayload: limits.maxInputFrameBytes, perMessageDeflate: false })
  const stats = { accepted: 0, rejected: 0, authFailed: 0, droppedSlow: 0 }
  const alive = new WeakMap<object, boolean>()
  let unauthenticated = 0
  let server: Server | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    let url: URL
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1')
    } catch {
      return // not ours to judge: the main handler answers malformed URLs
    }
    if (!url.pathname.startsWith(TERMINAL_WS_PREFIX)) return
    const id = terminalIdFromPath(url.pathname)
    socket.on('error', () => {})
    const verdict = security.checkUpgrade({
      ...(req.headers.host !== undefined ? { host: req.headers.host } : {}),
      ...(req.headers.origin !== undefined ? { origin: req.headers.origin } : {}),
      ...(req.headers.cookie !== undefined ? { cookie: req.headers.cookie } : {}),
    })
    if (!verdict.ok) {
      stats.rejected++
      log.warn('rejected terminal websocket upgrade', { code: verdict.code })
      return reject(socket, verdict.status, verdict.code)
    }
    if (deps.originAllowed && !deps.originAllowed(req.headers.origin)) {
      stats.rejected++
      log.warn('rejected terminal websocket upgrade', { code: 'foreign_origin' })
      return reject(socket, 403, 'forbidden_origin')
    }
    if (!service.enabled()) {
      stats.rejected++
      return reject(socket, 403, 'terminals_disabled')
    }
    if (id === undefined || !service.get(id)) {
      stats.rejected++
      return reject(socket, 404, 'not_found')
    }
    if (unauthenticated >= MAX_UNAUTHENTICATED) {
      stats.rejected++
      return reject(socket, 503, 'too_many_clients')
    }
    const cookieValue = security.parseSessionCookie(req.headers.cookie)
    if (!cookieValue) {
      stats.rejected++
      return reject(socket, 401, 'unauthorized')
    }
    const sessionKey = sessionKeyOf(cookieValue)
    wss.handleUpgrade(req, socket, head, (ws) => {
      stats.accepted++
      onSocket(ws, id, sessionKey)
    })
  }

  const sendControl = (ws: WebSocket, msg: TerminalServerMessage): void => {
    if (ws.readyState !== ws.OPEN) return
    try {
      ws.send(JSON.stringify(TerminalServerMessage.parse(msg)))
    } catch {
      ws.terminate()
    }
  }

  const closeSocket = (ws: WebSocket, code: number, reason: string): void => {
    try {
      ws.close(code, reason)
    } catch {
      ws.terminate()
    }
    // A peer that never answers the closing handshake must not keep the socket (and the terminal's slot) alive.
    const t = setTimeout(() => ws.terminate(), 2000)
    t.unref()
    ws.once('close', () => clearTimeout(t))
  }

  function onSocket(ws: WebSocket, terminalId: string, sessionKey: string): void {
    alive.set(ws, true)
    ws.on('pong', () => alive.set(ws, true))
    ws.on('error', () => ws.terminate())

    let authed = false
    let attachment: TerminalAttachment | undefined
    unauthenticated++
    let counted = true
    const uncount = (): void => {
      if (counted) {
        counted = false
        unauthenticated--
      }
    }
    const authTimer = setTimeout(() => {
      stats.authFailed++
      closeSocket(ws, CLOSE.authTimeout, 'auth timeout')
    }, limits.authTimeoutMs)
    authTimer.unref()

    const dropSlow = (): false => {
      stats.droppedSlow++
      log.warn('dropped a slow terminal client', { terminal: terminalId })
      ws.terminate()
      return false
    }
    const sink: TerminalSink = {
      output(chunk) {
        if (ws.readyState !== ws.OPEN) return false
        if (ws.bufferedAmount > limits.maxBufferedBytes) return dropSlow()
        ws.send(chunk, { binary: true }, (err) => {
          if (err) ws.terminate()
        })
        return ws.bufferedAmount > limits.maxBufferedBytes ? dropSlow() : true
      },
      control: (msg) => sendControl(ws, msg),
      end: (reason) => closeSocket(ws, 1000, reason),
    }

    ws.on('close', () => {
      clearTimeout(authTimer)
      uncount()
      attachment?.detach()
      attachment = undefined
    })

    ws.on('message', (data, isBinary) => {
      if (!authed) {
        clearTimeout(authTimer)
        const fail = (): void => {
          stats.authFailed++
          closeSocket(ws, CLOSE.unauthorized, 'unauthorized')
        }
        if (isBinary) return fail()
        const buf = dataToBuffer(data)
        if (buf.length > MAX_AUTH_FRAME_BYTES) return fail()
        let msg: TerminalClientMessage
        try {
          const parsed = TerminalClientMessage.safeParse(JSON.parse(buf.toString('utf8')))
          if (!parsed.success || parsed.data.type !== 'auth') return fail()
          msg = parsed.data
        } catch {
          return fail()
        }
        // `msg.type === 'auth'` is guaranteed above.
        const redeemed = tickets.redeem((msg as { ticket: string }).ticket, { terminalId, sessionKey })
        if (!redeemed.ok) {
          log.warn('terminal websocket auth refused', { reason: redeemed.reason })
          return fail()
        }
        try {
          authed = true
          uncount()
          attachment = service.attach(terminalId, sink)
        } catch (err) {
          authed = false
          if (err instanceof TerminalError) {
            sendControl(ws, { type: 'error', message: err.code })
            closeSocket(ws, err.code === 'already_attached' ? CLOSE.alreadyAttached : CLOSE.unauthorized, err.code)
          } else {
            closeSocket(ws, 1011, 'internal error')
          }
        }
        return
      }
      if (!attachment) return
      if (isBinary) {
        const result = attachment.write(dataToBuffer(data))
        if (result === 'rate_limited') sendControl(ws, { type: 'error', message: 'input_rate_limited' })
        else if (result === 'too_large') closeSocket(ws, 1009, 'frame too large')
        return
      }
      const buf = dataToBuffer(data)
      let msg: TerminalClientMessage
      try {
        const parsed = TerminalClientMessage.safeParse(JSON.parse(buf.toString('utf8')))
        if (!parsed.success) return closeSocket(ws, CLOSE.badFrame, 'bad frame')
        msg = parsed.data
      } catch {
        return closeSocket(ws, CLOSE.badFrame, 'bad frame')
      }
      if (msg.type === 'resize') attachment.resize(msg.cols, msg.rows)
      else sendControl(ws, { type: 'error', message: 'already_authenticated' })
    })
  }

  return {
    matches: (pathname) => pathname.startsWith(TERMINAL_WS_PREFIX),
    attach(s) {
      server = s
      s.on('upgrade', onUpgrade)
      heartbeat = setInterval(() => {
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
      }, deps.heartbeatMs ?? 30_000)
      heartbeat.unref()
    },
    async close() {
      if (heartbeat) clearInterval(heartbeat)
      heartbeat = undefined
      server?.off('upgrade', onUpgrade)
      for (const ws of wss.clients) closeSocket(ws, 1001, 'daemon shutting down')
      const deadline = Date.now() + 500
      while (wss.clients.size > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
      for (const ws of wss.clients) ws.terminate()
      await new Promise<void>((resolve) => wss.close(() => resolve()))
    },
    stats: () => ({ ...stats }),
    socketCount: () => wss.clients.size,
  }
}
