import type { Server } from 'node:http'
import type { Hono } from 'hono'
import type { StageSnapshot, ToolBinding } from '@ai-assistant/shared'
import type { Security } from '../security'
import type { StageActions } from './actions'
import { StageHub, type StageHubDeps } from './hub'
import { registerStageRoutes } from './routes'
import { createStageUpgrade, type StageUpgrade } from './upgrade'

/**
 * Wires the stage backend into the daemon: the hub, its REST routes, its WebSocket upgrade and its shutdown. app.ts
 * only creates it, registers its routes, attaches its upgrade handler, starts its loop and shuts it down. (Same shape as
 * the terminal feature, src/terminal/mount.ts.)
 */

/** What a test (or a real engine integration later) may replace. Production uses the defaults: the fake TTS and face. */
export type StageOverrides = Pick<StageHubDeps, 'tts' | 'face' | 'timers' | 'rng' | 'notes'>

export interface StageFeatureDeps extends Omit<StageHubDeps, keyof StageOverrides> {
  security: Security
  overrides?: StageOverrides
}

export interface StageFeature {
  readonly hub: StageHub
  readonly upgrade: StageUpgrade
  actions(): StageActions | undefined
  registerRoutes(app: Hono): void
  attach(server: Server): void
  /** Start the behaviour loop (called by daemon.start()). */
  start(): void
  /** The stage tools for the Secretary lane (STAGE_TOOL_SURFACE). */
  toolBindings(): ToolBinding[]
  snapshot(): StageSnapshot
  shutdown(): Promise<void>
}

export function createStageFeature(d: StageFeatureDeps): StageFeature {
  const { security, overrides, ...hubDeps } = d
  const hub = new StageHub({ ...hubDeps, ...(overrides ?? {}) })
  const upgrade = createStageUpgrade({ security, hub, config: d.config.stage, log: d.log })
  let actions: StageActions | undefined
  return {
    hub,
    upgrade,
    actions: () => actions,
    registerRoutes(app) {
      actions = registerStageRoutes(app, { hub, security })
    },
    attach(server) {
      upgrade.attach(server)
    },
    start: () => hub.start(),
    toolBindings: () => hub.toolBindings(),
    snapshot: () => hub.snapshot(),
    async shutdown() {
      await hub.shutdown()
      await upgrade.close()
    },
  }
}
