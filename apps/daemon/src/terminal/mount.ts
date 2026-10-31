import { homedir } from 'node:os'
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
import { createNodePtyFactory, type PtyFactory } from './pty'
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

export function createTerminalFeature(d: TerminalFeatureDeps): TerminalFeature {
  const o = d.overrides ?? {}
  const platform = o.platform ?? process.platform
  const limits = d.config.terminals
  const enabled = (): boolean => d.store.kvGet<boolean>(KV.terminals) === true

  // Several events in one tick (a kill-all) become one snapshot.reset.
  let resetQueued = false
  const scheduleReset = (): void => {
    if (resetQueued) return
    resetQueued = true
    queueMicrotask(() => {
      resetQueued = false
      try {
        d.announceReset()
      } catch {
        /* the daemon is stopping */
      }
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
        audit({ actor: e.reason === 'idle' || e.reason === 'shutdown' ? 'job' : 'you', action: text, target: label(e.info), outcome: 'auto' })
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

  const service = new TerminalService({
    limits,
    platform,
    env: o.env ?? (() => process.env),
    home: o.home ?? homedir(),
    cwdFs: o.cwdFs ?? nodeCwdFs,
    launchFs: o.launchFs ?? nodeLaunchFs,
    ptyFactory: o.ptyFactory ?? createNodePtyFactory(platform),
    killer: o.killer ?? createTreeKiller({ platform, systemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT }),
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
  const upgrade = createTerminalUpgrade({ security: d.security, service, tickets, limits, log: d.log, originAllowed: (o) => originAllowed(o), ...(o.heartbeatMs ? { heartbeatMs: o.heartbeatMs } : {}) })

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
      process.off('exit', exitKill)
      await service.shutdown()
      tickets.clear()
      await upgrade.close()
    },
  }
}
