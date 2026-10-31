import type { StageTransport, Unsubscribe } from '@ai-assistant/stage-core'
import type { WebSocket } from 'ws'

/**
 * Adapts a `ws` WebSocket to stage-core's abstract StageTransport (text frames carry JSON, binary frames carry audio and
 * face weights). The same adapter serves the daemon side (an accepted socket) and the client side (the simulator
 * connecting out, see simClient.ts), because both are plain `ws` sockets.
 *
 * Nothing here logs or inspects payloads: a message may carry terminal bytes or speech text.
 */

const OPEN = 1

export interface WsTransport extends StageTransport {
  /** Hard-close (no closing handshake). */
  terminate(): void
  readonly socket: WebSocket
}

export function wsTransport(ws: WebSocket): WsTransport {
  const text = new Set<(d: string) => void>()
  const binary = new Set<(d: Uint8Array) => void>()
  const close = new Set<(r?: string) => void>()
  let closed = false

  ws.on('message', (data, isBinary) => {
    try {
      if (isBinary) {
        const buf = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer)
        const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
        for (const h of [...binary]) h(bytes)
      } else {
        const s = Buffer.isBuffer(data) ? data.toString('utf8') : Array.isArray(data) ? Buffer.concat(data).toString('utf8') : Buffer.from(data as ArrayBuffer).toString('utf8')
        for (const h of [...text]) h(s)
      }
    } catch {
      // a handler that throws must not take the socket's event loop down
    }
  })
  const onGone = (code?: number, reason?: Buffer): void => {
    if (closed) return
    closed = true
    const why = reason && reason.length > 0 ? reason.toString('utf8').slice(0, 120) : `closed (${code ?? 'no code'})`
    for (const h of [...close]) h(why)
  }
  ws.on('close', (code, reason) => onGone(code, reason))
  ws.on('error', () => onGone(1006))

  const t: WsTransport = {
    socket: ws,
    sendText(data) {
      if (ws.readyState !== OPEN) return
      try {
        ws.send(data)
      } catch {
        /* closing */
      }
    },
    sendBinary(data) {
      if (ws.readyState !== OPEN) return
      try {
        ws.send(data, { binary: true })
      } catch {
        /* closing */
      }
    },
    onText(h): Unsubscribe {
      text.add(h)
      return () => text.delete(h)
    },
    onBinary(h): Unsubscribe {
      binary.add(h)
      return () => binary.delete(h)
    },
    onClose(h): Unsubscribe {
      close.add(h)
      return () => close.delete(h)
    },
    close(code, reason) {
      try {
        if (ws.readyState === OPEN || ws.readyState === 0) ws.close(code, reason?.slice(0, 120))
      } catch {
        /* already closed */
      }
    },
    terminate() {
      try {
        ws.terminate()
      } catch {
        /* already gone */
      }
    },
    bufferedAmount: () => ws.bufferedAmount,
  }
  return t
}
