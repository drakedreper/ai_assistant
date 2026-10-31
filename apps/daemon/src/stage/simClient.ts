import { WebSocket } from 'ws'
import {
  createSimulatorStage,
  systemClock,
  systemTimers,
  type Clock,
  type SimulatorOptions,
  type SimulatorStage,
  type Timers,
} from '@ai-assistant/stage-core'
import { wsTransport } from './transport'

/**
 * The headless SimulatorStage (packages/stage-core) as a WebSocket CLIENT of the daemon's stage socket: what an Unreal
 * or Unity stage does, minus the rendering. It authenticates the way an engine must (`Authorization: Bearer <stage
 * token>`, no cookie, no query string), sends `hello`, answers every command, and reconnects when the daemon goes away
 * (a restart) with a FRESH simulator, like an engine that was relaunched: so a test can check that the daemon rebuilds
 * the whole look for it.
 *
 * Used by the daemon's tests and by apps/web/scripts/e2e-stage.mjs. The token is passed in by the caller and never
 * logged. Loopback only.
 */

export interface SimClientOptions {
  /** ws://127.0.0.1:PORT/ws/stage */
  url: string
  token: string
  /** Sent as the Origin header when given (an engine sends none). */
  origin?: string
  /** Extra headers (tests that check the cookie is ignored). */
  headers?: Record<string, string>
  clock?: Clock
  timers?: Timers
  simulator?: Partial<Omit<SimulatorOptions, 'transport' | 'clock' | 'timers'>>
  /** Reconnect after a close or a refusal. Default true. */
  reconnect?: boolean
  /** Delay before reconnect attempt n (1-based). Default 150 ms doubling to 2 s. */
  backoffMs?: (attempt: number) => number
}

export interface SimClient {
  /** The simulator of the CURRENT connection (undefined while disconnected). */
  readonly sim: SimulatorStage | undefined
  /** Every simulator this client has run, oldest first (a reconnect starts a new one). */
  readonly history: SimulatorStage[]
  connected(): boolean
  /** HTTP status of the last refused attempt (401, 409...), if any. */
  lastRefusal(): number | undefined
  attempts(): number
  waitConnected(timeoutMs?: number): Promise<SimulatorStage>
  /** Close and stop reconnecting. */
  stop(): Promise<void>
}

export function connectSimulator(opts: SimClientOptions): SimClient {
  const clock = opts.clock ?? systemClock
  const timers = opts.timers ?? systemTimers
  const backoff = opts.backoffMs ?? ((n: number) => Math.min(2000, 150 * 2 ** (n - 1)))
  let stopped = false
  let current: SimulatorStage | undefined
  let ws: WebSocket | undefined
  let attempts = 0
  let refusal: number | undefined
  let retry: ReturnType<typeof setTimeout> | undefined
  const history: SimulatorStage[] = []
  const waiters: Array<(s: SimulatorStage) => void> = []

  const schedule = (): void => {
    if (stopped || opts.reconnect === false) return
    retry = setTimeout(connect, backoff(Math.max(1, attempts)))
    retry.unref?.()
  }

  function connect(): void {
    if (stopped) return
    attempts++
    const headers: Record<string, string> = { Authorization: `Bearer ${opts.token}`, ...(opts.headers ?? {}) }
    const socket = new WebSocket(opts.url, { headers, ...(opts.origin ? { origin: opts.origin } : {}), perMessageDeflate: false })
    ws = socket
    socket.once('unexpected-response', (_req, res) => {
      refusal = res.statusCode
      res.resume()
      socket.terminate()
    })
    socket.once('open', () => {
      refusal = undefined
      attempts = 0
      const sim = createSimulatorStage({ transport: wsTransport(socket), clock, timers, ...(opts.simulator ?? {}) })
      current = sim
      history.push(sim)
      sim.start()
      for (const w of waiters.splice(0)) w(sim)
    })
    socket.once('close', () => {
      if (current) {
        current.stop()
        current = undefined
      }
      if (ws === socket) ws = undefined
      schedule()
    })
    socket.on('error', () => undefined)
  }

  connect()

  return {
    get sim() {
      return current
    },
    history,
    connected: () => current !== undefined && ws?.readyState === WebSocket.OPEN,
    lastRefusal: () => refusal,
    attempts: () => attempts,
    waitConnected(timeoutMs = 10_000) {
      if (current) return Promise.resolve(current)
      return new Promise<SimulatorStage>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`the simulator did not connect within ${timeoutMs} ms${refusal ? ` (last refusal: HTTP ${refusal})` : ''}`)), timeoutMs)
        waiters.push((s) => {
          clearTimeout(t)
          resolve(s)
        })
      })
    },
    async stop() {
      stopped = true
      if (retry) clearTimeout(retry)
      const socket = ws
      if (current) current.stop()
      if (socket && socket.readyState !== WebSocket.CLOSED) {
        await new Promise<void>((resolve) => {
          socket.once('close', () => resolve())
          try {
            socket.close(1000, 'client stopping')
          } catch {
            resolve()
          }
          setTimeout(() => {
            socket.terminate()
            resolve()
          }, 500).unref?.()
        })
      }
    },
  }
}
