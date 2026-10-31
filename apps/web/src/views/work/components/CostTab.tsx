import { useMemo, type ReactNode } from 'react'
import { Bar, BarChart, CartesianGrid, Cell, LabelList, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Badge, Gauge, Panel, Sparkline } from '../../../components/ui'
import { fmtTime, fmtUsd } from '../../../lib/format'
import { useSnap, useStore } from '../../../state/store'
import { dayName, dayTotal, fmtDuration, shortModel, shortProject, sumValues, useCostDays } from '../lib'

// Chart styling from the design tokens (hex, because SVG attributes cannot rely on Tailwind classes).
const AXIS = '#6c7499'
const GRID = 'rgba(255,255,255,0.06)'
const FG = '#e9ebf7'
const MODEL_COLOR: Record<string, string> = {
  'claude-opus-5-5': '#a78bfa',
  'claude-sonnet-5-5': '#2dd4bf',
  'claude-haiku-5-5': '#60a5fa',
}
const FALLBACK_COLOR = '#9ca4c9'

interface TipRow {
  name?: string | number
  value?: number | string
  color?: string
  payload?: Record<string, unknown>
}
interface TipProps {
  active?: boolean
  payload?: TipRow[]
  label?: string | number
}

function TipBox({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-line-strong px-3 py-2 text-[12px] shadow-2xl" style={{ background: '#161a33', color: FG }}>
      <div className="mb-1 font-semibold">{title}</div>
      {children}
    </div>
  )
}

function Swatch({ color }: { color: string | undefined }) {
  return <span className="inline-block size-2 rounded-sm" style={{ background: color ?? FALLBACK_COLOR }} aria-hidden />
}

function DayTip({ active, payload }: TipProps) {
  if (!active || !payload?.length) return null
  const row = payload[0]?.payload as { date?: string; total?: number } | undefined
  const rows = payload.filter((p) => Number(p.value) > 0).reverse()
  return (
    <TipBox title={row?.date ? dayName(row.date) : ''}>
      {rows.map((p) => (
        <div key={String(p.name)} className="flex items-center gap-2 tabular-nums">
          <Swatch color={p.color} />
          <span className="flex-1 text-muted">{p.name}</span>
          <span>{fmtUsd(Number(p.value))}</span>
        </div>
      ))}
      <div className="mt-1 flex justify-between border-t border-line pt-1 font-semibold tabular-nums">
        <span>Total (est.)</span>
        <span>{fmtUsd(row?.total ?? 0)}</span>
      </div>
    </TipBox>
  )
}

function SessionTip({ active, payload }: TipProps) {
  if (!active || !payload?.length) return null
  const row = payload[0]?.payload as { full?: string; cost?: number; project?: string; color?: string } | undefined
  if (!row) return null
  return (
    <TipBox title={row.full}>
      <div className="flex items-center gap-2 tabular-nums">
        <Swatch color={row.color} />
        <span className="flex-1 text-muted">{row.project}</span>
        <span>{fmtUsd(row.cost ?? 0)}</span>
      </div>
    </TipBox>
  )
}

function ModelTip({ active, payload }: TipProps) {
  if (!active || !payload?.length) return null
  const p = payload[0]
  return (
    <TipBox title={String(p?.name ?? '')}>
      <div className="tabular-nums">{fmtUsd(Number(p?.value ?? 0))} over 14 days</div>
    </TipBox>
  )
}

/** Single-line category label (the default tick wraps long titles into two lines). */
function SessionTick({ x, y, payload }: { x?: number; y?: number; payload?: { value?: string } }) {
  return (
    <text x={(x ?? 0) - 4} y={y} dy={4} textAnchor="end" fill="#9ca4c9" fontSize={11}>
      {payload?.value}
    </text>
  )
}

function Summary({ children }: { children: ReactNode }) {
  return <div className="space-y-2 text-[12.5px] leading-relaxed text-muted">{children}</div>
}

function Tile({ label, value, sub, spark }: { label: string; value: string; sub: string; spark?: number[] }) {
  return (
    <div className="flex min-w-0 items-center gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="text-[11px] tracking-wide text-faint uppercase">{label}</div>
        <div className="truncate text-xl leading-tight font-semibold text-fg tabular-nums">{value}</div>
        <div className="truncate text-[11px] text-muted">{sub}</div>
      </div>
      {spark && (
        <span className="hidden shrink-0 @2xl:block">
          <Sparkline values={spark} color="var(--color-money)" width={72} height={26} />
        </span>
      )}
    </div>
  )
}

export function CostTab() {
  const projects = useSnap((d) => d.projects)
  const sessions = useSnap((d) => d.sessions)
  const block = useSnap((d) => d.usageBlock)
  const now = useStore((s) => s.now)
  const days = useCostDays()

  const stats = useMemo(() => {
    const totals = days.map(dayTotal)
    const today = totals[totals.length - 1] ?? 0
    const week = totals.slice(-7).reduce((a, b) => a + b, 0)
    const all = totals.reduce((a, b) => a + b, 0)
    let peakIdx = 0
    totals.forEach((t, i) => {
      if (t > (totals[peakIdx] ?? 0)) peakIdx = i
    })
    const byProject: Record<string, number> = {}
    const byModel: Record<string, number> = {}
    for (const d of days) {
      for (const [k, v] of Object.entries(d.byProject)) byProject[k] = (byProject[k] ?? 0) + v
      for (const [k, v] of Object.entries(d.byModel)) byModel[k] = (byModel[k] ?? 0) + v
    }
    return { totals, today, week, all, peakIdx, byProject, byModel }
  }, [days])

  const chartData = useMemo(
    () => days.map((d) => ({ date: d.date, day: dayName(d.date, false), total: dayTotal(d), ...d.byProject })),
    [days],
  )
  const peak = days[stats.peakIdx]
  const topProject = Object.entries(stats.byProject).sort((a, b) => b[1] - a[1])[0]
  const topProjectName = projects.find((p) => p.id === topProject?.[0])?.name ?? topProject?.[0] ?? ''

  const modelData = Object.entries(stats.byModel)
    .map(([id, value]) => ({ id, name: shortModel(id), value: +value.toFixed(2), color: MODEL_COLOR[id] ?? FALLBACK_COLOR }))
    .sort((a, b) => b.value - a.value)
  const modelTotal = modelData.reduce((a, b) => a + b.value, 0)

  const topSessions = useMemo(
    () =>
      sessions
        .slice()
        .sort((a, b) => b.costUsd - a.costUsd)
        .slice(0, 6)
        .map((s) => {
          const p = projects.find((x) => x.id === s.projectId)
          return {
            name: s.title.length > 27 ? `${s.title.slice(0, 26)}…` : s.title,
            full: s.title,
            cost: s.costUsd,
            color: p?.color ?? FALLBACK_COLOR,
            project: p ? shortProject(p.name) : s.projectId,
          }
        }),
    [sessions, projects],
  )
  const sessionTotal = sumValues(Object.fromEntries(sessions.map((s) => [s.id, s.costUsd])))
  const top3 = topSessions.slice(0, 3).reduce((a, b) => a + b.cost, 0)

  const endsAt = new Date(block.endsAt).getTime()
  const startsAt = new Date(block.startedAt).getTime()
  const remaining = endsAt - now.getTime()
  const elapsedPct = Math.max(0, Math.min(100, ((now.getTime() - startsAt) / (endsAt - startsAt)) * 100))

  const chart1Label = `Stacked bar chart of estimated cost per day by project for the last ${days.length} days. Total ${fmtUsd(stats.all)}. Peak day ${peak ? dayName(peak.date) : ''} at ${fmtUsd(stats.totals[stats.peakIdx] ?? 0)}.`
  const chart2Label = `Donut chart of estimated cost by model over 14 days: ${modelData.map((m) => `${m.name} ${fmtUsd(m.value)}`).join(', ')}.`
  const chart3Label = `Bar chart of the most expensive sessions: ${topSessions.map((s) => `${s.full} ${fmtUsd(s.cost)}`).join('; ')}.`

  return (
    <div className="flex flex-col gap-3">
      <section aria-label="Cost totals" className="glass grid grid-cols-2 divide-line @3xl:grid-cols-4 @3xl:divide-x">
        <Tile label="Today (est.)" value={fmtUsd(stats.today)} sub="estimate, not a bill" spark={stats.totals} />
        <Tile label="Last 7 days" value={fmtUsd(stats.week)} sub={`${fmtUsd(stats.week / 7)} per day`} />
        <Tile label="Last 14 days" value={fmtUsd(stats.all)} sub={`${fmtUsd(stats.all / days.length)} per day`} />
        <Tile label="Top project" value={topProject ? shortProject(topProjectName) : 'n/a'} sub={topProject ? `${fmtUsd(topProject[1])} · ${Math.round((topProject[1] / (stats.all || 1)) * 100)}% of spend` : ''} />
      </section>

      <Panel title="Cost per day by project" subtitle="Estimate: tokens at API list prices" bodyClassName="@3xl:flex @3xl:gap-5">
        <div className="min-w-0 flex-1">
          <div role="img" aria-label={chart1Label} className="h-[260px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 8, right: 8, left: -12, bottom: 0 }} accessibilityLayer={false}>
                <CartesianGrid stroke={GRID} vertical={false} />
                <XAxis dataKey="day" tick={{ fill: AXIS, fontSize: 11 }} tickLine={false} axisLine={{ stroke: GRID }} interval="preserveStartEnd" minTickGap={14} />
                <YAxis tick={{ fill: AXIS, fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={(v: number) => `$${v}`} width={44} />
                <Tooltip content={<DayTip />} cursor={{ fill: 'rgba(255,255,255,0.05)' }} />
                {projects.map((p) => (
                  <Bar key={p.id} dataKey={p.id} name={shortProject(p.name)} stackId="cost" fill={p.color} isAnimationActive={false} maxBarSize={28} />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
          <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 pl-9 text-[11px] text-muted" aria-label="Legend">
            {projects.map((p) => (
              <li key={p.id} className="flex items-center gap-1.5">
                <Swatch color={p.color} /> {shortProject(p.name)}
                <span className="text-faint tabular-nums">{fmtUsd(stats.byProject[p.id] ?? 0, 0)}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="mt-4 shrink-0 @3xl:mt-0 @3xl:w-[230px]">
          <h3 className="mb-1.5 text-[11px] font-semibold tracking-wide text-faint uppercase">In words</h3>
          <Summary>
            <p>
              The last {days.length} days came to <b className="text-fg tabular-nums">{fmtUsd(stats.all)}</b>, {fmtUsd(stats.all / days.length)} a day.
            </p>
            {peak && (
              <p>
                Busiest day: <b className="text-fg">{dayName(peak.date)}</b> at <span className="tabular-nums">{fmtUsd(stats.totals[stats.peakIdx] ?? 0)}</span>.
              </p>
            )}
            {topProject && (
              <p>
                {shortProject(topProjectName)} is {Math.round((topProject[1] / (stats.all || 1)) * 100)}% of it{topProject[0] === 'atlas' ? ', in line with the Atlas beta push' : ''}.
              </p>
            )}
          </Summary>
        </div>
      </Panel>

      <div className="grid items-stretch gap-3 @4xl:grid-cols-2">
        <Panel title="By model" subtitle="14 days, estimate" bodyClassName="@xl:flex @xl:items-center @xl:gap-4">
          <div role="img" aria-label={chart2Label} className="relative mx-auto h-[190px] w-[190px] shrink-0">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart accessibilityLayer={false}>
                <Pie data={modelData} dataKey="value" nameKey="name" innerRadius={58} outerRadius={86} paddingAngle={2} stroke="none" isAnimationActive={false}>
                  {modelData.map((m) => (
                    <Cell key={m.id} fill={m.color} />
                  ))}
                </Pie>
                <Tooltip content={<ModelTip />} />
              </PieChart>
            </ResponsiveContainer>
            <div className="pointer-events-none absolute inset-0 grid place-items-center text-center">
              <div>
                <div className="text-lg font-semibold text-fg tabular-nums">{fmtUsd(modelTotal, 0)}</div>
                <div className="text-[11px] text-faint">14 days</div>
              </div>
            </div>
          </div>
          <div className="mt-3 min-w-0 flex-1 @xl:mt-0">
            <ul className="space-y-2">
              {modelData.map((m) => (
                <li key={m.id} className="text-[12.5px]">
                  <div className="flex items-center gap-2">
                    <Swatch color={m.color} />
                    <span className="flex-1 font-medium text-fg">{m.name}</span>
                    <span className="text-muted tabular-nums">{fmtUsd(m.value)}</span>
                    <span className="w-9 text-right text-faint tabular-nums">{Math.round((m.value / (modelTotal || 1)) * 100)}%</span>
                  </div>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-[12px] leading-relaxed text-muted">
              {modelData[0] ? `${modelData[0].name} carries ${Math.round((modelData[0].value / (modelTotal || 1)) * 100)}% of the estimate. ` : ''}
              Routing small jobs, like certs and a11y passes, to Haiku is the cheapest lever.
            </p>
          </div>
        </Panel>

        <Panel title="Top sessions by cost" subtitle="lifetime of the session, estimate">
          <div role="img" aria-label={chart3Label} className="h-[210px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={topSessions} layout="vertical" margin={{ top: 0, right: 44, left: 0, bottom: 0 }} accessibilityLayer={false}>
                <CartesianGrid stroke={GRID} horizontal={false} />
                <XAxis type="number" hide />
                <YAxis type="category" dataKey="name" width={176} tick={<SessionTick />} tickLine={false} axisLine={false} />
                <Tooltip content={<SessionTip />} cursor={{ fill: 'rgba(255,255,255,0.05)' }} />
                <Bar dataKey="cost" radius={[0, 4, 4, 0]} isAnimationActive={false} barSize={14}>
                  {topSessions.map((s, i) => (
                    <Cell key={i} fill={s.color} />
                  ))}
                  <LabelList dataKey="cost" position="right" formatter={(v: unknown) => fmtUsd(Number(v))} fill={FG} fontSize={11} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <p className="mt-2 text-[12px] leading-relaxed text-muted">
            {topSessions[0] ? (
              <>
                <b className="text-fg">{topSessions[0].full}</b> is the priciest at <span className="tabular-nums">{fmtUsd(topSessions[0].cost)}</span>. The top three make up{' '}
                {Math.round((top3 / (sessionTotal || 1)) * 100)}% of tracked session cost.
              </>
            ) : (
              'No sessions yet.'
            )}
          </p>
        </Panel>
      </div>

      <Panel
        title="5-hour usage block"
        subtitle="the rolling window your plan limits are counted in"
        actions={<Badge title="Derived locally; plan limits are not exposed by Claude Code.">estimate</Badge>}
        bodyClassName="@3xl:grid @3xl:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] @3xl:gap-6"
      >
        <div>
          <div className="flex items-baseline gap-3">
            <span className="text-3xl font-semibold text-fg tabular-nums">{Math.round(block.usedPct)}%</span>
            <span className="text-[13px] text-muted">{remaining > 0 ? `resets in ${fmtDuration(remaining)}` : 'window ended'}</span>
          </div>
          <Gauge pct={block.usedPct} height={8} className="mt-2" label="5-hour usage block used, estimate" />
          <div className="relative mt-4">
            <div className="h-1.5 rounded-full bg-white/8" role="img" aria-label={`${Math.round(elapsedPct)} percent of the 5-hour window has elapsed`}>
              <div className="h-full rounded-full bg-world/70" style={{ width: `${elapsedPct}%` }} />
            </div>
            <div className="mt-1.5 flex justify-between text-[11px] text-faint tabular-nums">
              <span>starts {fmtTime(block.startedAt)}</span>
              <span className="text-muted">{Math.round(elapsedPct)}% of time elapsed</span>
              <span>resets {fmtTime(block.endsAt)}</span>
            </div>
          </div>
          <p className="mt-3 text-[12.5px] text-muted">
            <b className="text-fg tabular-nums">{fmtUsd(block.costUsd)}</b> API-equivalent so far in this window.
          </p>
        </div>
        <div className="mt-4 space-y-2 rounded-xl border border-line bg-white/[0.025] p-3 text-[12.5px] leading-relaxed text-muted @3xl:mt-0">
          <h3 className="text-[12px] font-semibold text-fg">Why every number here is an estimate</h3>
          <p>
            On a subscription Claude Code never reports dollars, and the plan&apos;s limits are not exposed anywhere. Mira multiplies the tokens she sees in hook
            payloads and session logs by public API list prices. That gives you the <i>API-equivalent</i> cost: what the same work would cost on pay-as-you-go.
          </p>
          <p>
            Cache reads, discounts and the plan&apos;s own rules move the real figure, so read {Math.round(block.usedPct)}% as &ldquo;about this full&rdquo;, never as a bill or a hard limit.
            With an API key (Settings, Claude connection) the dollars get much closer to real spend.
          </p>
        </div>
      </Panel>
    </div>
  )
}
