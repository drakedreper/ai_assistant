import { homedir } from 'node:os'
import * as nodePath from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Server } from 'node:http'
import type { Hono } from 'hono'
import type { AuditEntry, SettingsSnapshot, TerminalInfo } from '@ai-assistant/shared'
import type { EventBus } from '../bus'
import type { DaemonConfig } from '../config'
import type { Scheduler } from '../hooks/service'
import type { IdGen } from '../ids'
import type { Logger } from '../log'
import type { Security } from '../security'
import { KV } from '../snapshot'
import type { Store } from '../store'
import { redactText } from '../store/redact'
import { nodeCwdFs, type CwdFs } from './cwd'
import { createTreeKiller, type TreeKiller } from './kill'
import { nodeLaunchFs, type LaunchFs } from './launch'
import { createRealHostPtyFactory, type HostPtyFactory } from './hostClient'
import type { PtyFactory } from './pty'
import { registerTerminalRoutes } from './routes'
import { TerminalService, type TerminalEvent } from './service'
import { TicketStore } from './tickets'
import { createTerminalUpgrade, type TerminalUpgrade } from './ws'

/**
 * Wires the terminal feature into the daemon: the service with its real collaborators, the ticket store, the REST
 * routes, the WebSocket upgrade, the on/off switch (persisted in kv, audited, published) and the audit trail.
 * app.ts only creates it, registers its routes, attaches its upgrade handler and shuts it down.
 *
 * Audit entries carry the terminal's kind and id and the outcome, NEVER keystrokes, output or the folder.
 */

/** Everything a test may replace. Production uses the defaults. */
export interface TerminalOverrides {
  ptyFactory?: PtyFactory
  killer?: TreeKiller
  platform?: NodeJS.Platform
  env?: () => Readonly<Record<string, string | undefined>>
  home?: string
  cwdFs?: CwdFs
  launchFs?: LaunchFs
  heartbeatMs?: number
  /** Timers for the idle sweep. The hook staleness scheduler is NOT shared on purpose. */
  scheduler?: Scheduler
}

export interface TerminalFeatureDeps {
  config: DaemonConfig
  store: Store
  security: Security
  bus: EventBus
  log: Logger
  now: () => Date
  clock: () => number
  newId: IdGen
  /** The Settings snapshot, for the `settings.update` event after the switch changes. */
  settings: () => SettingsSnapshot
  /** A snapshot.reset to every client (the terminal list changed). */
  announceReset: () => void
  overrides?: TerminalOverrides
}

export interface TerminalFeature {
  readonly service: TerminalService
  readonly tickets: TicketStore
  readonly upgrade: TerminalUpgrade
  enabled(): boolean
  /** The terminals to show: none while the switch is off. */
  list(): TerminalInfo[]
  setEnabled(on: boolean): Promise<void>
  registerRoutes(app: Hono): void
  attach(server: Server): void
  shutdown(): Promise<void>
}

/** The daemon's own install folders (the workspace root and the daemon package): kept out of a terminal's NODE_PATH. */
function daemonRoots(): string[] {
  const here = nodePath.dirname(fileURLToPath(import.meta.url))
  return [nodePath.resolve(here, '..', '..'), nodePath.resolve(here, '..', '..', '..', '..')]
}

export function createTerminalFeature(d: TerminalFeatureDeps): TerminalFeature {
  const o = d.overrides ?? {}
  const platform = o.platform ?? process.platform
  const limits = d.config.terminals
  const enabled = (): boolean => d.store.kvGet<boolean>(KV.terminals) === true

  // Every change of the terminal list is a full `snapshot.reset` (about 170 KiB) that is kept in the event bus's 2000-event
  // replay ring and sent to every /ws client, so a loop of create and close would fill the ring with snapshots. Two limits:
  //   1. several events in one tick (a kill-all) become one reset;
  //   2. a token bucket on the resets themselves: a burst of RESET_BURST goes out at once (ordinary use never notices), after
  //      that one reset per RESET_EVERY_MS, and everything that happens meanwhile is coalesced into ONE trailing reset (so the
  //      last state is always published). The bucket runs on the real clock, not the injected one.
  // What this does not do: the ring still holds up to 2000 snapshots in the worst case. Removing that needs a small
  // `terminals.update` event (packages/shared) or a ring-exempt marker in the bus: see the README, "Known limits".
  const RESET_BURST = 20
  const RESET_EVERY_MS = 1000
  let resetQueued = false
  let resetTokens = RESET_BURST
  let resetRefilledAt = Date.now()
  let trailing: ReturnType<typeof setTimeout> | undefined
  const publishReset = (): void => {
    try {
      d.announceReset()
    } catch {
      /* the daemon is stopping */
    }
  }
  const refillResets = (): void => {
    const t = Date.now()
    resetTokens = Math.min(RESET_BURST, resetTokens + (t - resetRefilledAt) / RESET_EVERY_MS)
    resetRefilledAt = t
  }
  const scheduleReset = (): void => {
    if (resetQueued) return
    resetQueued = true
    queueMicrotask(() => {
      resetQueued = false
      if (trailing !== undefined) return // one is already on its way: it will carry the latest state
      refillResets()
      if (resetTokens >= 1) {
        resetTokens -= 1
        publishReset()
        return
      }
      const wait = Math.max(50, Math.ceil((1 - resetTokens) * RESET_EVERY_MS))
      trailing = setTimeout(() => {
        trailing = undefined
        refillResets()
        resetTokens = Math.max(0, resetTokens - 1)
        publishReset()
      }, wait)
      trailing.unref()
    })
  }

  const audit = (e: { actor?: AuditEntry['actor']; action: string; target: string; outcome: AuditEntry['outcome']; detail?: string }): void => {
    try {
      d.store.insertAudit({
        id: d.newId('au'),
        at: d.now().toISOString(),
        actor: e.actor ?? 'you',
        action: e.action,
        target: redactText(e.target, 160),
        outcome: e.outcome,
        ...(e.detail ? { detail: redactText(e.detail, 120) } : {}),
      })
    } catch (err) {
      d.log.warn('could not write a terminal audit entry', { error: err instanceof Error ? err.message : 'unknown' })
    }
  }

  const label = (info: Pick<TerminalInfo, 'kind' | 'id'>): string => `${info.kind} terminal ${info.id}`

  const onEvent = (e: TerminalEvent): void => {
    switch (e.type) {
      case 'opened':
        audit({ action: 'Opened a terminal', target: label(e.info), outcome: 'auto' })
        break
      case 'exited':
        audit({ action: 'A terminal exited', target: label(e.info), outcome: 'auto', detail: `exit code ${e.info.exitCode ?? 'unknown'}` })
        break
      case 'closed': {
        const text = { user: 'Closed a terminal', idle: 'Closed an idle terminal', disabled: 'Closed a terminal (terminals switched off)', shutdown: 'Closed a terminal (daemon stopping)' }[e.reason]
        // Processes of the terminal that could not be ended are said so (a count, never a name or a command line).
        audit({ actor: e.reason === 'idle' || e.reason === 'shutdown' ? 'job' : 'you', action: text, target: label(e.info), outcome: 'auto', ...(e.survivors ? { detail: `${e.survivors} process(es) could not be ended` } : {}) })
        break
      }
      case 'refused':
        audit({ action: 'Refused to open a terminal', target: `${e.kind} terminal`, outcome: 'blocked', detail: e.code })
        return // nothing changed in the list
      case 'removed':
        break
    }
    scheduleReset()
  }

  const killer = o.killer ?? createTreeKiller({ platform, systemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT })
  // Every terminal runs in its OWN PTY host process (src/terminal/ptyHost.ts): node-pty is never loaded in the daemon, so one
  // terminal's master descriptor can never be inherited by another's programs, and the host ends its tree if the daemon dies.
  // If a host vanishes with its program still running, the daemon ends that program's orphaned family itself.
  const hosts: HostPtyFactory | undefined = o.ptyFactory ? undefined : createRealHostPtyFactory({ onLost: (pid) => void killer.forceKill(pid).catch(() => undefined), log: d.log, graceMs: limits.killGraceMs })

  const service = new TerminalService({
    limits,
    platform,
    env: o.env ?? (() => process.env),
    home: o.home ?? homedir(),
    cwdFs: o.cwdFs ?? nodeCwdFs,
    launchFs: o.launchFs ?? nodeLaunchFs,
    ptyFactory: o.ptyFactory ?? (hosts as HostPtyFactory).create,
    killer,
    daemonRoots: daemonRoots(),
    clock: d.clock,
    newId: d.newId,
    ...(o.scheduler ? { scheduler: o.scheduler } : {}),
    enabled,
    projects: () => d.store.listProjects().map((p) => ({ id: p.id, name: p.name, rootPath: p.rootPath })),
    claudeExecutable: d.config.claudeExecutable,
    log: d.log,
    onEvent,
  })
  service.start()

  const tickets = new TicketStore({ ttlMs: limits.ticketTtlMs, now: d.clock })
  const upgrade = createTerminalUpgrade({ security: d.security, service, tickets, limits, log: d.log, now: d.clock, originAllowed: (o) => originAllowed(o), ...(o.heartbeatMs ? { heartbeatMs: o.heartbeatMs } : {}) })

  if (limits.claudeCommandOverride) d.log.warn('TERMINAL_CLAUDE_COMMAND is set: "Claude" terminals run that command instead of your claude (test setting)')

  const setEnabled = async (on: boolean): Promise<void> => {
    const was = enabled()
    d.store.kvSet(KV.terminals, on, d.now().toISOString())
    if (was !== on) audit({ action: on ? 'Turned embedded terminals on' : 'Turned embedded terminals off', target: 'Settings', outcome: 'auto' })
    // Off: every running terminal and its process tree is killed and the list is emptied before this returns.
    if (!on) {
      await service.closeAll('disabled')
      tickets.clear()
    }
    d.bus.publish({ type: 'settings.update', settings: d.settings() })
    scheduleReset()
  }

  const exitKill = (): void => service.killAllNow()

  /** The daemon's own origins, plus the Vite dev origins only when TERMINAL_ALLOW_DEV_ORIGINS is set. */
  const originAllowed = (origin: string | undefined): boolean => {
    if (origin === undefined || origin === '') return true // the guards already require an Origin where it matters
    const o = origin.trim().toLowerCase()
    const port = d.security.getPort()
    if (o === `http://127.0.0.1:${port}` || o === `http://localhost:${port}`) return true
    return limits.allowDevOrigins && d.security.allowedOrigins().some((a) => a.toLowerCase() === o)
  }

  return {
    service,
    tickets,
    upgrade,
    enabled,
    list: () => (enabled() ? service.list() : []),
    setEnabled,
    registerRoutes: (app) => registerTerminalRoutes(app, { service, tickets, security: d.security, enabled, setEnabled, originAllowed }),
    attach(server) {
      upgrade.attach(server)
      // Last resort: if the process ends without a graceful stop (a crash, the shutdown watchdog), kill the trees.
      process.on('exit', exitKill)
    },
    async shutdown() {
      if (trailing !== undefined) clearTimeout(trailing)
      trailing = undefined
      process.off('exit', exitKill)
      await service.shutdown()
      // Every terminal is ended; wait for its host process to leave too, so none is left behind when the daemon returns.
      await hosts?.shutdown()
      tickets.clear()
      await upgrade.close()
    },
  }
}
