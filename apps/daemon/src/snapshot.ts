import type {
  BudgetGuard,
  ClaudeConnection,
  CostDay,
  IntegrationStatus,
  LaneId,
  LaneStatus,
  Persona,
  Project,
  Proposal,
  SecretaryLane,
  SettingsSnapshot,
  Snapshot,
  TrustRule,
  UsageBlock,
} from '@ai-assistant/shared'
import { buildSnapshot, dateOnly } from '@ai-assistant/shared/fixtures'
import { SDK_VERSION, type DaemonConfig } from './config'
import type { EventBus } from './bus'
import type { Store } from './store'

/** Lane model defaults (the mockup's numbers). Only the Secretary lane exists in Phase 1. */
export const LANE_DEFAULTS: Record<LaneId, { model: string; effort: 'low' | 'medium' | 'high'; enabled: boolean }> = {
  secretary: { model: 'claude-sonnet-5-5', effort: 'medium', enabled: true },
  reader: { model: 'claude-haiku-5-5', effort: 'low', enabled: false },
  voice: { model: 'claude-haiku-5-5', effort: 'low', enabled: false },
}

const EPOCH_DAY = '0000-01-01'

/** Pseudo project that carries the Secretary lane's own spend in the cost charts. */
export const LANE_PROJECT_ID = 'secretary'

/** kv keys for state that survives restarts. */
export const KV = {
  persona: 'settings.persona',
  trustModes: 'settings.trustModes',
  trustCounts: 'settings.trustCounts',
  claudeMode: 'settings.claudeMode',
  guest: 'settings.guestMode',
  webcam: 'settings.webcam',
  proposals: 'brain.proposalDecisions',
  forgotten: 'brain.forgottenFacts',
  demoSeeded: 'demo.seeded',
} as const

export type TrustCounts = Record<string, { approvals: number; rejections: number }>
export type ProposalDecisions = Record<string, { status: 'approved' | 'rejected'; decidedAt: string }>

/** Approvals without a single rejection promote to "suggest auto" at this many (ADR 0005 proposes roughly 10 to 15). */
export const PROMOTION_THRESHOLD = 10

export interface SnapshotDeps {
  config: DaemonConfig
  store: Store
  bus: EventBus
  budget: BudgetGuard
  /** The lane is built after the snapshot builder (the lane factory may ask for the Claude connection), so it can be undefined early on. */
  lane: () => SecretaryLane | undefined
  now: () => Date
}

function addInto(into: Record<string, number>, from: Record<string, number>): void {
  for (const [k, v] of Object.entries(from)) into[k] = Math.round(((into[k] ?? 0) + v) * 1e6) / 1e6
}

/**
 * Assembles the Snapshot the UI renders. Real: sessions, agents, events, tasks, approvals, chat, cost days,
 * the Claude connection and budgets, persona, trust modes, guest and webcam switches, the audit log.
 * Mock (fixtures from @ai-assistant/shared): briefing, learned facts, notes, proposals, memory, calendar, mail,
 * contacts, finance, world, integrations other than Claude, privacy map.
 */
export class SnapshotBuilder {
  constructor(private readonly deps: SnapshotDeps) {}

  private fixtures(): Snapshot {
    return buildSnapshot(this.deps.now())
  }

  persona(fx?: Persona): Persona {
    return this.deps.store.kvGet<Persona>(KV.persona) ?? (fx ?? this.fixtures().settings.persona)
  }

  claudeMode(): 'api-key' | 'local-login' {
    const stored = this.deps.store.kvGet<string>(KV.claudeMode)
    return stored === 'api-key' || stored === 'local-login' ? stored : this.deps.config.authMode
  }

  laneStatus(): LaneStatus {
    return this.deps.lane()?.status() ?? { state: 'starting', backend: this.deps.config.backend }
  }

  /** The real Claude connection: mode, lane health and budgets. */
  claude(): ClaudeConnection {
    const { config } = this.deps
    const st = this.laneStatus()
    const budget = this.deps.budget.status()
    const status: ClaudeConnection['status'] =
      st.state === 'error' || st.state === 'stopped' ? 'disconnected' : st.state === 'starting' || config.backend === 'fake' ? 'degraded' : 'connected'
    const lanes = (Object.keys(LANE_DEFAULTS) as LaneId[]).map((id) => {
      const b = budget.lanes.find((l) => l.lane === id)
      const d = LANE_DEFAULTS[id]
      return {
        id,
        model: d.model,
        effort: d.effort,
        enabled: d.enabled,
        dailyBudgetUsd: b?.dailyBudgetUsd ?? 0,
        spentTodayUsd: Math.round((b?.spentTodayUsd ?? 0) * 1e6) / 1e6,
      }
    })
    return {
      mode: this.claudeMode(),
      status,
      daemon: 'online',
      sdkVersion: config.backend === 'sdk' ? SDK_VERSION : 'fake (no SDK)',
      lanes,
      globalDailyCapUsd: budget.globalDailyCapUsd,
    }
  }

  private claudeIntegration(): IntegrationStatus {
    const { config } = this.deps
    const st = this.laneStatus()
    if (config.backend === 'fake') {
      return {
        id: 'int-claude',
        name: 'Claude (fake backend)',
        kind: 'claude',
        state: 'mock',
        detail: 'Scripted zero-token replies. Set CLAUDE_BACKEND=sdk for real Claude.',
        dataLeaves: 'Nothing: the fake backend never leaves this PC',
      }
    }
    const needsKey = this.claudeMode() === 'api-key' && !config.apiKey
    return {
      id: 'int-claude',
      name: 'Claude (Agent SDK)',
      kind: 'claude',
      state: needsKey ? 'needs_auth' : st.state === 'error' || st.state === 'stopped' ? 'off' : 'connected',
      detail: needsKey ? 'ANTHROPIC_API_KEY is not set' : st.error ? `Lane error: ${st.error.slice(0, 120)}` : `Secretary lane ${st.state}`,
      dataLeaves: 'Chat text, retrieved note snippets and tool results go to Anthropic',
    }
  }

  private trustRules(fx: SettingsSnapshot['trustRules']): TrustRule[] {
    const { store, config } = this.deps
    const modes = store.kvGet<Record<string, 'ask' | 'auto'>>(KV.trustModes) ?? {}
    const counts = store.kvGet<TrustCounts>(KV.trustCounts) ?? {}
    return fx.map((r) => {
      const c = counts[r.id] ?? { approvals: 0, rejections: 0 }
      // A fresh install starts honest: fixture approval counts only show in demo mode.
      const approvals = (config.demo ? r.approvals : 0) + c.approvals
      const rejections = (config.demo ? r.rejections : 0) + c.rejections
      const mode = r.locked ? r.mode : (modes[r.id] ?? r.mode)
      const suggested = !r.locked && mode === 'ask' && rejections === 0 && approvals >= PROMOTION_THRESHOLD
      return { ...r, mode, approvals, rejections, promotionSuggested: suggested }
    })
  }

  settings(fx: Snapshot = this.fixtures()): SettingsSnapshot {
    const { store, config } = this.deps
    const stored = store.listAudit(100)
    const audit = config.demo ? [...stored, ...fx.settings.audit].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)) : stored
    return {
      persona: this.persona(fx.settings.persona),
      claude: this.claude(),
      integrations: fx.settings.integrations.map((i) => (i.id === 'int-claude' ? this.claudeIntegration() : i)),
      trustRules: this.trustRules(fx.settings.trustRules),
      audit,
      privacy: fx.settings.privacy,
      guestMode: store.kvGet<boolean>(KV.guest) ?? false,
      webcam: { enabled: store.kvGet<boolean>(KV.webcam) ?? false, retention: 'none' },
      ...(config.demo && fx.settings.vault ? { vault: fx.settings.vault } : {}),
    }
  }

  /** Fixture proposals with the user's decisions applied. */
  proposals(fx: Snapshot = this.fixtures()): Proposal[] {
    const decisions = this.deps.store.kvGet<ProposalDecisions>(KV.proposals) ?? {}
    return fx.proposals.map((p) => {
      const d = decisions[p.id]
      return d ? { ...p, status: d.status, decidedAt: d.decidedAt } : p
    })
  }

  learned(fx: Snapshot = this.fixtures()): Snapshot['learned'] {
    const forgotten = new Set(this.deps.store.kvGet<string[]>(KV.forgotten) ?? [])
    return fx.learned.filter((f) => !forgotten.has(f.id))
  }

  /** 14 days, oldest first, from persisted lane spend. Every day is present so charts always have a baseline. */
  costDays(fx?: Snapshot): CostDay[] {
    const now = this.deps.now()
    const usage = this.deps.store.listUsage(dateOnly(now, -13))
    const days: CostDay[] = []
    for (let off = -13; off <= 0; off++) {
      const date = dateOnly(now, off)
      const byProject: Record<string, number> = {}
      const byModel: Record<string, number> = {}
      for (const u of usage) {
        if (u.day !== date) continue
        addInto(byProject, { [LANE_PROJECT_ID]: u.costUsd })
        addInto(byModel, { [u.model]: u.costUsd })
      }
      days.push({ date, byProject, byModel })
    }
    if (this.deps.config.demo && fx) {
      for (const f of fx.costDays) {
        const mine = days.find((d) => d.date === f.date)
        if (!mine) continue
        addInto(mine.byProject, f.byProject)
        addInto(mine.byModel, f.byModel)
      }
    }
    return days
  }

  spentToday(): number {
    return this.deps.store.listUsage(dateOnly(this.deps.now())).reduce((a, u) => (u.day === dateOnly(this.deps.now()) ? a + u.costUsd : a), 0)
  }

  /**
   * The 5-hour rate-limit window. The daemon cannot see the real plan window, so this is a placeholder window
   * starting at the top of the current hour with usedPct 0 and costUsd equal to today's lane spend.
   */
  usageBlock(fx?: Snapshot): UsageBlock {
    if (this.deps.config.demo && fx) return fx.usageBlock
    const now = this.deps.now()
    const start = new Date(now)
    start.setMinutes(0, 0, 0)
    return { startedAt: start.toISOString(), endsAt: new Date(start.getTime() + 5 * 3_600_000).toISOString(), usedPct: 0, costUsd: Math.round(this.spentToday() * 1e6) / 1e6 }
  }

  projects(): Project[] {
    const list = this.deps.store.listProjects()
    if (this.deps.store.listUsage(EPOCH_DAY).length > 0) {
      if (!list.some((p) => p.id === LANE_PROJECT_ID)) {
        list.push({ id: LANE_PROJECT_ID, name: 'Mira chat (Secretary lane)', rootPath: this.deps.config.dataDir, status: 'active', tags: ['lane'], color: '#f472b6' })
      }
    }
    return list
  }

  build(): Snapshot {
    const { store, bus, now, config } = this.deps
    const fx = this.fixtures()
    return {
      now: now().toISOString(),
      seq: bus.latestSeq,
      // Chat, Work and approvals are real. Everything below still comes from mock providers until Phase 2.
      mockSections: ['briefing', 'brain', 'life', 'money', 'world'],
      briefing: fx.briefing,
      learned: this.learned(fx),
      chat: store.recentChat(200),
      projects: this.projects(),
      sessions: store.listSessions(),
      events: store.listAgentEvents(config.demo ? 400 : 300),
      tasks: store.listTasks(),
      approvals: store.listApprovals(200),
      costDays: this.costDays(fx),
      usageBlock: this.usageBlock(fx),
      notes: fx.notes,
      proposals: this.proposals(fx),
      memory: fx.memory,
      calendar: fx.calendar,
      mail: fx.mail,
      contacts: fx.contacts,
      finance: fx.finance,
      world: fx.world,
      settings: this.settings(fx),
    }
  }
}
