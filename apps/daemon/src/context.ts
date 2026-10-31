import type { BudgetGuard, SecretaryLane } from '@ai-assistant/shared'
import type { EventBus } from './bus'
import type { DaemonConfig } from './config'
import type { HookProjection } from './hooks/projection'
import type { HookService } from './hooks/service'
import type { IdGen } from './ids'
import type { Logger } from './log'
import type { Security } from './security'
import type { SnapshotBuilder } from './snapshot'
import type { Store } from './store'
import type { WsHub } from './ws'

/** Everything the route handlers and commands share. Built once by createDaemon. */
export interface DaemonContext {
  config: DaemonConfig
  store: Store
  bus: EventBus
  security: Security
  log: Logger
  now: () => Date
  clock: () => number
  newId: IdGen
  lane: SecretaryLane
  budget: BudgetGuard
  projection: HookProjection
  hooks: HookService
  snapshots: SnapshotBuilder
  /** Set once the HTTP server is listening. */
  ws: () => WsHub | undefined
  startedAt: number
  /** Push a snapshot.reset to every client (used when something happened that no incremental event can express). */
  announceReset: () => void
}

/** An error that maps to an HTTP status and a stable machine-readable code. */
export class HttpError extends Error {
  override name = 'HttpError'
  constructor(
    readonly status: 400 | 404 | 409 | 413 | 429 | 500 | 502 | 503,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
  }
}
