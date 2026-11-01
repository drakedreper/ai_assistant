import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import { DaemonRoutes } from '@ai-assistant/shared'
import type { StageConfig } from '../config'
import type { Logger } from '../log'
import type { Security } from '../security'
import { peerAllowed } from '../net/peer'
import type { StageHub } from './hub'
import { wsTransport } from './transport'

/**
 * The stage WebSocket: GET /ws/stage with an Upgrade. This is the door of the engine process (Unreal, Unity, the
 * simulator), not of the browser, and it is guarded accordingly. Checks, in this order, all before the upgrade completes
 * (a plain HTTP answer, no socket is created):
 *
 *   1. the peer address is loopback (the daemon only listens on 127.0.0.1; this is the explicit second lock). In container
 *      mode (the Docker image) a PRIVATE peer address is accepted as well, because Docker hands published-port traffic to
 *      the container from its bridge gateway; a public address is refused in both modes (see net/peer.ts, ADR 0009);
 *   2. the path is exactly /ws/stage and the request target carries NO query string at all (a token in a URL would
 *      reach logs and history: it is refused outright, never read);
 *   2b. the request is HTTP/1.1 (RFC 6455 asks for at least that) and carries each of Host, Origin and Authorization at
 *      most ONCE: Node keeps the first of a duplicated header, a proxy or a library might keep the last, and a request
 *      the two disagree about is refused instead of judged by one of them;
 *   3. Host is 127.0.0.1:PORT or localhost:PORT (DNS rebinding);
 *   4. Origin is ABSENT (an engine is not a browser) or allowlisted (the daemon's own origins and the dev origins);
 *   5. `Authorization: Bearer <stage token>`, compared in constant time. The browser session cookie is NEVER read: a
 *      signed-in browser without the token gets 401, and the stage token opens no browser route;
 *   6. the stage switch is on (403 stage_disabled) and no other stage is connected (409 stage_busy).
 *
 * After the upgrade the stage must send `hello` within `helloTimeoutMs` (the StageSession enforces it and refuses a
 * protocol mismatch). Limits: messages from the stage above `maxMessageBytes` close the socket (1009), a client whose
 * unsent buffer passes `maxBufferedBytes` is dropped, a ping every `heartbeatMs` drops a dead peer.
 *
 * ONE STAGE AT A TIME. A second authenticated connection is refused with 409 until the first one closes (a stage that
 * crashed closes its socket at once on loopback, and a half-open one is dropped by the heartbeat within two intervals).
 * "Replace the old one" was rejected on purpose: it lets two stages fight each other forever. Settings, Stage has a
 * Disconnect button for a stuck one.
 */

export const STAGE_WS_PATH = DaemonRoutes.stageWs

export interface StageUpgrade {
  attach(server: Server): void
  close(): Promise<void>
  stats(): { accepted: number; rejected: number; droppedSlow: number; droppedStale: number }
}

export interface StageUpgradeDeps {
  security: Security
  hub: StageHub
  config: StageConfig
  log: Logger
  /** True in container mode (MIRA_CONTAINER=1): private peer addresses are accepted besides loopback. Default false. */
  containerMode?: boolean
}

function reject(socket: Duplex, status: number, code: string): void {
  const text: Record<number, string> = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 409: 'Conflict', 503: 'Service Unavailable' }
  const body = JSON.stringify({ error: code })
  socket.write(`HTTP/1.1 ${status} ${text[status] ?? 'Error'}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nCache-Control: no-store\r\n\r\n${body}`)
  socket.destroy()
}

/** Headers the upgrade decision reads; sent twice, the request is ambiguous and is refused. */
const SINGLE_HEADERS = new Set(['host', 'origin', 'authorization'])

/** The first header name that appears more than once among Host, Origin and Authorization (raw headers keep every copy). */
export function duplicatedDecisionHeader(rawHeaders: readonly string[]): string | undefined {
  const seen = new Set<string>()
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    const name = (rawHeaders[i] ?? '').toLowerCase()
    if (!SINGLE_HEADERS.has(name)) continue
    if (seen.has(name)) return name
    seen.add(name)
  }
  return undefined
}

export function createStageUpgrade(deps: StageUpgradeDeps): StageUpgrade {
  const { security, hub, config, log } = deps
  const containerMode = deps.containerMode === true
  const wss = new WebSocketServer({ noServer: true, maxPayload: config.maxMessageBytes, perMessageDeflate: false })
  const stats = { accepted: 0, rejected: 0, droppedSlow: 0, droppedStale: 0 }
  const alive = new WeakMap<object, boolean>()
  let server: Server | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    let url: URL
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1')
    } catch {
      return // malformed: the main handler answers
    }
    // The main /ws handler leaves every /ws/stage* path to this one, so anything under it is answered here.
    if (!url.pathname.startsWith(STAGE_WS_PATH)) return
    socket.on('error', () => {})
    const no = (status: number, code: string, why?: string): void => {
      stats.rejected++
      log.warn('rejected stage websocket upgrade', { code, ...(why ? { why } : {}) })
      reject(socket, status, code)
    }
    if (url.pathname !== STAGE_WS_PATH) return no(404, 'not_found')
    if (!peerAllowed(req.socket.remoteAddress, containerMode)) return no(403, containerMode ? 'peer_not_allowed' : 'not_loopback')
    // Not even an empty one: `?` anywhere in the request target is refused, so nothing can ever be read from it.
    if ((req.url ?? '').includes('?')) return no(400, 'no_query', 'a query string was sent')
    if (req.httpVersion !== '1.1') return no(400, 'http_version', 'the upgrade was not HTTP/1.1')
    const dup = duplicatedDecisionHeader(req.rawHeaders ?? [])
    if (dup) return no(400, 'duplicate_header', `${dup} was sent more than once`)

    const verdict = security.checkStageUpgrade({
      ...(req.headers.host !== undefined ? { host: req.headers.host } : {}),
      ...(req.headers.origin !== undefined ? { origin: req.headers.origin } : {}),
      ...(req.headers.authorization !== undefined ? { authorization: req.headers.authorization } : {}),
    })
    if (!verdict.ok) return no(verdict.status, verdict.code)

    const may = hub.canAccept()
    if (!may.ok) return no(may.status, may.code)

    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      stats.accepted++
      alive.set(ws, true)
      ws.on('pong', () => alive.set(ws, true))
      const transport = wsTransport(ws)
      // A re-check inside the callback: handleUpgrade is asynchronous and two sockets could have raced.
      const again = hub.canAccept()
      if (!again.ok) {
        ws.close(1013, again.code)
        return
      }
      hub.accept(transport)
    })
  }

  return {
    attach(s) {
      server = s
      s.on('upgrade', onUpgrade)
      heartbeat = setInterval(() => {
        for (const ws of wss.clients) {
          if (alive.get(ws) === false) {
            stats.droppedStale++
            ws.terminate()
            continue
          }
          if (ws.bufferedAmount > config.maxBufferedBytes) {
            stats.droppedSlow++
            log.warn('dropped the stage: slow consumer')
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
      }, config.heartbeatMs)
      heartbeat.unref?.()
    },
    async close() {
      if (heartbeat) clearInterval(heartbeat)
      heartbeat = undefined
      server?.off('upgrade', onUpgrade)
      for (const ws of wss.clients) ws.close(1001, 'daemon shutting down')
      const deadline = Date.now() + 500
      while (wss.clients.size > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
      for (const ws of wss.clients) ws.terminate()
      await new Promise<void>((resolve) => wss.close(() => resolve()))
    },
    stats: () => ({ ...stats }),
  }
}
