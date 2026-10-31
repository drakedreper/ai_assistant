/**
 * The abstract transport under a stage connection. The daemon adapts a WebSocket to it; tests use the in-memory pair.
 * Text frames carry JSON (StageCommand down, StageEvent up); binary frames carry audio and face weights.
 */
import type { Timers } from '../util/clock'

export type Unsubscribe = () => void

export interface StageTransport {
  sendText(data: string): void
  sendBinary(data: Uint8Array): void
  onText(handler: (data: string) => void): Unsubscribe
  onBinary(handler: (data: Uint8Array) => void): Unsubscribe
  /** Optional: without it the owner must call `session.notifyClosed()`. */
  onClose?(handler: (reason?: string) => void): Unsubscribe
  close(code?: number, reason?: string): void
  /** Optional: bytes queued but not yet sent (WebSocket.bufferedAmount). Drives back-pressure. */
  bufferedAmount?(): number
}

export interface MemoryEndpoint extends StageTransport {
  /** Simulate a congested socket: what bufferedAmount() reports. */
  buffered: number
  readonly closed: boolean
  /** Everything this endpoint sent (for assertions). */
  readonly sentText: string[]
  readonly sentBinary: Uint8Array[]
  /** Sends after the pair was closed (dropped silently, like a closed socket). */
  droppedAfterClose: number
}

export interface MemoryPair {
  /** The backend's end (give it to createStageSession). */
  backend: MemoryEndpoint
  /** The stage's end (give it to a SimulatorStage or a test double). */
  stage: MemoryEndpoint
  /** Deliver everything that is due, in order. Normally automatic when there is no latency. */
  flush(): void
  /** Number of messages still in flight. */
  inFlight(): number
}

export interface MemoryPairOptions {
  /** With latency > 0 a Timers (e.g. a VirtualTime's) is required. */
  timers?: Timers
  /** One-way latency in ms. Default 0 (delivered at once, still in order, never re-entrantly). */
  latencyMs?: number
}

type Msg = { to: 'backend' | 'stage'; kind: 'text'; data: string } | { to: 'backend' | 'stage'; kind: 'binary'; data: Uint8Array }

export function createMemoryTransportPair(opts: MemoryPairOptions = {}): MemoryPair {
  const latency = Math.max(0, opts.latencyMs ?? 0)
  if (latency > 0 && !opts.timers) throw new Error('createMemoryTransportPair: latencyMs > 0 needs timers')
  const queue: Msg[] = []
  let draining = false
  let closed = false
  let pendingTimers = 0

  const handlers = {
    backend: { text: new Set<(d: string) => void>(), binary: new Set<(d: Uint8Array) => void>(), close: new Set<(r?: string) => void>() },
    stage: { text: new Set<(d: string) => void>(), binary: new Set<(d: Uint8Array) => void>(), close: new Set<(r?: string) => void>() },
  }

  const deliver = (m: Msg): void => {
    const h = handlers[m.to]
    if (m.kind === 'text') for (const fn of [...h.text]) fn(m.data)
    else for (const fn of [...h.binary]) fn(m.data)
  }
  const drain = (): void => {
    if (draining) return // re-entrant send from inside a handler: the outer loop delivers it, in order
    draining = true
    try {
      while (queue.length > 0) deliver(queue.shift()!)
    } finally {
      draining = false
    }
  }
  const enqueue = (m: Msg): void => {
    if (latency > 0) {
      pendingTimers++
      opts.timers!.setTimeout(() => {
        pendingTimers--
        if (closed) return
        queue.push(m)
        drain()
      }, latency)
    } else {
      queue.push(m)
      drain()
    }
  }

  const makeEndpoint = (self: 'backend' | 'stage'): MemoryEndpoint => {
    const other = self === 'backend' ? 'stage' : 'backend'
    const ep: MemoryEndpoint = {
      buffered: 0,
      sentText: [],
      sentBinary: [],
      droppedAfterClose: 0,
      get closed() {
        return closed
      },
      sendText(data) {
        if (closed) {
          ep.droppedAfterClose++
          return
        }
        ep.sentText.push(data)
        enqueue({ to: other, kind: 'text', data })
      },
      sendBinary(data) {
        if (closed) {
          ep.droppedAfterClose++
          return
        }
        const copy = data.slice()
        ep.sentBinary.push(copy)
        enqueue({ to: other, kind: 'binary', data: copy })
      },
      onText(h) {
        handlers[self].text.add(h)
        return () => handlers[self].text.delete(h)
      },
      onBinary(h) {
        handlers[self].binary.add(h)
        return () => handlers[self].binary.delete(h)
      },
      onClose(h) {
        handlers[self].close.add(h)
        return () => handlers[self].close.delete(h)
      },
      close(_code, reason) {
        if (closed) return
        closed = true
        queue.length = 0
        for (const side of ['backend', 'stage'] as const) for (const fn of [...handlers[side].close]) fn(reason)
      },
      bufferedAmount: () => ep.buffered,
    }
    return ep
  }

  return {
    backend: makeEndpoint('backend'),
    stage: makeEndpoint('stage'),
    flush: drain,
    inFlight: () => queue.length + pendingTimers,
  }
}
