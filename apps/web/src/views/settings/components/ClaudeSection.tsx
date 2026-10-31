import { TOOL_SURFACE, type ToolSpec } from '@ai-assistant/shared'
import {
  BookOpen,
  Brain,
  CalendarDays,
  Check,
  Cpu,
  KeyRound,
  Lock,
  LogIn,
  Mail,
  Newspaper,
  Server,
  ShieldAlert,
  TriangleAlert,
  Users,
  Wallet,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import { useMemo } from 'react'
import { api } from '../../../api'
import { Badge, Gauge, Panel, StatusDot } from '../../../components/ui'
import { cn } from '../../../lib/cn'
import { fmtUsd } from '../../../lib/format'
import { useSnap } from '../../../state/store'
import { useSettingsUi } from '../ui'
import { Callout, SectionHeader, TierChip } from './Atoms'
import { Switch } from './Switch'

type Mode = 'api-key' | 'local-login'

const MODES: Array<{ id: Mode; title: string; icon: LucideIcon; badge: { tone: 'ok' | 'warn'; text: string }; body: string; bullets: string[] }> = [
  {
    id: 'api-key',
    title: 'API key',
    icon: KeyRound,
    badge: { tone: 'ok', text: 'Terms-safe default' },
    body: 'Mira calls Claude with an API key from your own Anthropic account.',
    bullets: ['The option Anthropic allows for third-party apps', 'Billed per token to your API account', 'She uses her own tools; no claude.ai connectors'],
  },
  {
    id: 'local-login',
    title: 'Local login',
    icon: LogIn,
    badge: { tone: 'warn', text: 'Grey area, personal use' },
    body: 'Mira drives the Claude binary you are already logged into on this PC.',
    bullets: ['Uses your subscription limits, not per-token billing', 'claude.ai connectors load only in this mode', 'Not confirmed with Anthropic; do not share this setup'],
  },
]

function ModeCard({ m, selected, onSelect }: { m: (typeof MODES)[number]; selected: boolean; onSelect: () => void }) {
  const Icon = m.icon
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        'flex cursor-pointer flex-col gap-2 rounded-xl border p-3.5 text-left transition',
        selected ? 'border-mira/50 bg-mira/8 ring-1 ring-mira/30' : 'border-line bg-white/[0.02] hover:border-line-strong hover:bg-white/[0.04]',
      )}
    >
      <span className="flex items-center gap-2">
        <span className={cn('grid size-7 place-items-center rounded-lg', selected ? 'bg-mira/20 text-mira' : 'bg-white/6 text-muted')}>
          <Icon className="size-4" aria-hidden />
        </span>
        <span className="text-[14px] font-semibold text-fg">{m.title}</span>
        <Badge tone={m.badge.tone} className="ml-auto">
          {m.badge.text}
        </Badge>
      </span>
      <span className="text-[12.5px] leading-snug text-muted">{m.body}</span>
      <ul className="flex flex-col gap-1 text-[12px] text-muted">
        {m.bullets.map((b) => (
          <li key={b} className="flex items-start gap-1.5">
            <Check className={cn('mt-0.5 size-3 shrink-0', selected ? 'text-mira' : 'text-faint')} aria-hidden />
            {b}
          </li>
        ))}
      </ul>
      <span className={cn('mt-0.5 text-[11px] font-medium', selected ? 'text-mira' : 'text-faint')}>{selected ? 'In use' : 'Click to switch'}</span>
    </button>
  )
}

function Connection() {
  const claude = useSnap((d) => d.settings.claude)
  const statusColor = claude.status === 'connected' ? 'var(--color-ok)' : claude.status === 'degraded' ? 'var(--color-warn)' : 'var(--color-bad)'
  return (
    <Panel title="Connection" subtitle="How Mira reaches Claude" icon={Cpu}>
      <div className="grid grid-cols-2 gap-x-4 gap-y-3 @2xl:grid-cols-4">
        <div>
          <div className="text-[11px] tracking-wide text-faint uppercase">Status</div>
          <div className="mt-0.5 flex items-center gap-2 text-[14px] font-semibold text-fg capitalize">
            <StatusDot color={statusColor} pulse={claude.status === 'connected'} />
            {claude.status}
          </div>
        </div>
        <div>
          <div className="text-[11px] tracking-wide text-faint uppercase">Daemon</div>
          <div className="mt-0.5 flex items-center gap-2 text-[14px] font-semibold text-fg capitalize">
            <Server className="size-3.5 text-muted" aria-hidden />
            {claude.daemon}
          </div>
        </div>
        <div>
          <div className="text-[11px] tracking-wide text-faint uppercase">Agent SDK</div>
          <div className="mt-0.5 font-mono text-[14px] font-semibold text-fg">{claude.sdkVersion}</div>
        </div>
        <div>
          <div className="text-[11px] tracking-wide text-faint uppercase">Costs shown as</div>
          <div className="mt-0.5 text-[14px] font-semibold text-fg">API-equivalent estimate</div>
        </div>
      </div>

      <div role="radiogroup" aria-label="Authentication mode" className="mt-4 grid gap-3 @2xl:grid-cols-2">
        {MODES.map((m) => (
          <ModeCard key={m.id} m={m} selected={claude.mode === m.id} onSelect={() => void api.setClaudeMode(m.id)} />
        ))}
      </div>

      <Callout tone="warn" icon={TriangleAlert} title="An honest note on logging in" className="mt-4">
        <p>
          Anthropic&apos;s terms do not allow third-party apps to offer claude.ai login. That is why the API key is the default. Local login only drives your own
          logged-in binary for your own personal use; it is a grey area that has to be confirmed with Anthropic before anyone relies on it.
        </p>
        <p className="mt-1.5">
          Costs everywhere in this app are API-equivalent estimates, not a bill. claude.ai connectors (Gmail, Calendar and so on) only load under subscription
          login.
        </p>
      </Callout>
    </Panel>
  )
}

const LANE_INFO: Record<string, { name: string; role: string; tools: string }> = {
  secretary: {
    name: 'Secretary',
    role: 'A long-lived streaming session. The only lane that can propose actions, and every outward one still waits for you.',
    tools: 'brain, calendar, mail (read), finance (read), worklog',
  },
  reader: {
    name: 'Reader',
    role: 'Tool-less and schema-constrained. It turns news and mail into fixed summary fields and can never send or write anything.',
    tools: 'none',
  },
  voice: {
    name: 'Voice',
    role: 'A direct, low-latency lane. Enabled only if the time-to-first-token spike fails the 1.2 s gate.',
    tools: 'none, direct to the speaker',
  },
}

const shortModel = (m: string) => m.replace(/^claude-/, '')

function Lanes() {
  const lanes = useSnap((d) => d.settings.claude.lanes)
  const cap = useSnap((d) => d.settings.claude.globalDailyCapUsd)
  const overrides = useSettingsUi((s) => s.laneEnabled)
  const setLane = useSettingsUi((s) => s.setLane)
  const on = (id: string, base: boolean) => overrides[id] ?? base
  const spent = lanes.reduce((a, l) => a + (on(l.id, l.enabled) ? l.spentTodayUsd : 0), 0)
  const budgets = lanes.reduce((a, l) => a + (on(l.id, l.enabled) ? l.dailyBudgetUsd : 0), 0)

  return (
    <Panel title="Lanes" subtitle="Separate Claude sessions with their own model, effort and budget" icon={Cpu} flush>
      <div className="@container">
        <div className="hidden grid-cols-[minmax(0,1.7fr)_minmax(0,0.9fr)_minmax(0,1.2fr)_auto] gap-4 border-b border-line px-4 py-1.5 text-[11px] tracking-wide text-faint uppercase @2xl:grid">
          <span>Lane</span>
          <span>Model and effort</span>
          <span>Spent today</span>
          <span className="w-10 text-right">On</span>
        </div>
        <ul className="divide-y divide-line">
          {lanes.map((l) => {
            const info = LANE_INFO[l.id]
            const enabled = on(l.id, l.enabled)
            const pct = l.dailyBudgetUsd ? (l.spentTodayUsd / l.dailyBudgetUsd) * 100 : 0
            return (
              <li key={l.id} className={cn('grid gap-x-4 gap-y-3 px-4 py-3.5 @2xl:grid-cols-[minmax(0,1.7fr)_minmax(0,0.9fr)_minmax(0,1.2fr)_auto] @2xl:items-center', !enabled && 'opacity-75')}>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="text-[14px] font-semibold text-fg">{info?.name ?? l.id}</h3>
                    {l.id === 'voice' && !enabled && <Badge title="Held back until the latency spike fails the gate">Gated</Badge>}
                    {l.id === 'reader' && <Badge tone="ok"><ShieldAlert className="size-3" aria-hidden /> No write tools</Badge>}
                  </div>
                  <p className="mt-0.5 text-[12px] leading-snug text-muted">{info?.role}</p>
                  <p className="mt-1 text-[11px] text-faint">
                    Tools: <span className="text-muted">{info?.tools}</span>
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge className="font-mono">{shortModel(l.model)}</Badge>
                  <Badge>{l.effort} effort</Badge>
                </div>
                <div>
                  <div className="flex items-baseline justify-between text-[12px] tabular-nums">
                    <span className="font-medium text-fg">{fmtUsd(l.spentTodayUsd)}</span>
                    <span className="text-faint">of {fmtUsd(l.dailyBudgetUsd)}</span>
                  </div>
                  <Gauge pct={pct} height={6} className="mt-1" label={`${info?.name ?? l.id} lane: ${fmtUsd(l.spentTodayUsd)} of ${fmtUsd(l.dailyBudgetUsd)} budget used today`} />
                </div>
                <div className="flex @2xl:w-10 @2xl:justify-end">
                  <Switch checked={enabled} onChange={(v) => setLane(l.id, v)} label={`${enabled ? 'Disable' : 'Enable'} the ${info?.name ?? l.id} lane`} />
                </div>
              </li>
            )
          })}
        </ul>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-line bg-white/[0.02] px-4 py-3">
          <div className="min-w-[180px]">
            <div className="text-[11px] tracking-wide text-faint uppercase">Global daily cap</div>
            <div className="text-[15px] font-semibold text-fg tabular-nums">{fmtUsd(cap)}</div>
          </div>
          <div className="min-w-[200px] flex-1">
            <div className="flex justify-between text-[12px] tabular-nums">
              <span className="text-muted">
                <span className="font-medium text-fg">{fmtUsd(spent)}</span> spent by her lanes today (est.)
              </span>
              <span className="text-faint">{Math.round((spent / cap) * 100)}% of cap</span>
            </div>
            <Gauge pct={(spent / cap) * 100} height={6} className="mt-1" label="Share of the global daily cap used" />
          </div>
          <p className="basis-full text-[11px] leading-snug text-faint">
            Lane budgets add up to {fmtUsd(budgets)}, under the {fmtUsd(cap)} cap. At the cap her Claude calls pause until midnight and she tells you. Claude Code
            session cost is on the Work screen.
          </p>
        </div>
      </div>
    </Panel>
  )
}

const SERVER_META: Record<ToolSpec['server'], { label: string; icon: LucideIcon; hint: string }> = {
  brain: { label: 'brain', icon: Brain, hint: 'Your second brain' },
  calendar: { label: 'calendar', icon: CalendarDays, hint: 'Events' },
  mail: { label: 'mail', icon: Mail, hint: 'Drafts and search' },
  contacts: { label: 'contacts', icon: Users, hint: 'People' },
  finance: { label: 'finance', icon: Wallet, hint: 'Atlas, read-only' },
  worklog: { label: 'worklog', icon: Wrench, hint: 'Agent dashboard' },
  news: { label: 'news', icon: Newspaper, hint: 'Briefing items' },
}

const LANE_LETTER: Record<string, { letter: string; tone: 'mira' | 'neutral' }> = {
  secretary: { letter: 'S', tone: 'mira' },
  reader: { letter: 'R', tone: 'neutral' },
}

function ToolRow({ t }: { t: ToolSpec }) {
  return (
    <li className={cn('rounded-lg border px-2.5 py-2', t.locked ? 'border-bad/30 bg-bad/[0.06]' : 'border-line bg-white/[0.02]')}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {t.locked && <Lock className="size-3.5 shrink-0 text-bad" aria-label="Permanently locked" />}
        <code className={cn('font-mono text-[12px]', t.locked ? 'text-bad' : 'text-fg')}>{t.name}</code>
        <span className="ml-auto flex items-center gap-1">
          <TierChip tier={t.tier} short />
          {t.locked ? <Badge tone="bad">locked</Badge> : <Badge tone={t.readOnly ? 'neutral' : 'warn'}>{t.readOnly ? 'read-only' : 'writes'}</Badge>}
          {t.lanes.length === 0 ? (
            <Badge tone="bad" title="No lane can call this tool">no lane</Badge>
          ) : (
            t.lanes.map((ln) => (
              <Badge key={ln} tone={LANE_LETTER[ln]?.tone ?? 'neutral'} title={`${ln} lane may call this`} className="w-5 justify-center px-0">
                <span aria-label={`${ln} lane`}>{LANE_LETTER[ln]?.letter ?? ln}</span>
              </Badge>
            ))
          )}
        </span>
      </div>
      <p className="mt-1 text-[11.5px] leading-snug text-muted">{t.description}</p>
    </li>
  )
}

function ToolSurface() {
  const groups = useMemo(() => {
    const order: ToolSpec['server'][] = ['brain', 'calendar', 'mail', 'contacts', 'finance', 'worklog', 'news']
    return order.map((s) => ({ server: s, tools: TOOL_SURFACE.filter((t) => t.server === s) })).filter((g) => g.tools.length)
  }, [])
  return (
    <Panel
      title="Tool surface"
      subtitle={`${TOOL_SURFACE.length} tools across ${groups.length} in-process servers. Nothing else is reachable`}
      icon={BookOpen}
      actions={
        <span className="hidden items-center gap-2 text-[11px] text-faint sm:flex" aria-hidden>
          <Badge tone="mira" className="w-5 justify-center px-0">S</Badge> secretary
          <Badge className="w-5 justify-center px-0">R</Badge> reader
        </span>
      }
    >
      <div className="gap-x-3 @2xl:columns-2">
        {groups.map((g) => {
          const meta = SERVER_META[g.server]
          const Icon = meta.icon
          return (
            <section key={g.server} aria-label={`${meta.label} tools`} className="mb-3 min-w-0 break-inside-avoid">
              <h3 className="mb-1.5 flex items-center gap-2 text-[12px] font-semibold text-fg">
                <Icon className="size-3.5 text-muted" aria-hidden />
                <span className="font-mono">{meta.label}</span>
                <span className="font-normal text-faint">{meta.hint}</span>
              </h3>
              <ul className="flex flex-col gap-1.5">
                {g.tools.map((t) => (
                  <ToolRow key={t.name} t={t} />
                ))}
              </ul>
            </section>
          )
        })}
      </div>
      <p className="text-[11px] leading-snug text-faint">
        The reader lane only ever gets read-only tools. <code className="font-mono text-muted">finance_move_money</code> exists only as a locked placeholder: there is no
        implementation behind it in v0.x.
      </p>
    </Panel>
  )
}

/** CLAUDE CONNECTION: auth mode with an honest callout, lanes and budgets, and the tool surface she can reach. */
export function ClaudeSection() {
  return (
    <div className="@container flex flex-col gap-3">
      <SectionHeader icon={Cpu} title="Claude connection">
        How Mira talks to Claude, which lanes she runs, and the full list of tools she is allowed to touch.
      </SectionHeader>
      <Connection />
      <Lanes />
      <ToolSurface />
    </div>
  )
}
