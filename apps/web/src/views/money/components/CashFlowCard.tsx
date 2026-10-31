import type { CashFlowPoint } from '@ai-assistant/shared'
import { ArrowLeftRight } from 'lucide-react'
import { useMemo } from 'react'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Panel, Stat } from '../../../components/ui'
import { cn } from '../../../lib/cn'
import { CHART, fmt, fmtK, fmtWhole, monthLong, monthShort, num } from '../lib'

interface Row {
  month: string
  income: number
  spend: number
  saved: number
}

function FlowTip({ active, payload }: { active?: boolean; payload?: Array<{ payload?: Row }> }) {
  const row = active ? payload?.[0]?.payload : undefined
  if (!row) return null
  return (
    <div className="rounded-lg border border-line-strong px-3 py-2 text-[12px] shadow-2xl" style={{ background: CHART.tipBg, color: CHART.fg }}>
      <div className="mb-1 font-semibold">{monthLong(row.month)}</div>
      <div className="flex items-center gap-2 tabular-nums">
        <span className="inline-block size-2 rounded-sm" style={{ background: CHART.income }} aria-hidden />
        <span className="flex-1 text-muted">Income</span>
        <span>{fmt(row.income)}</span>
      </div>
      <div className="flex items-center gap-2 tabular-nums">
        <span className="inline-block size-2 rounded-sm" style={{ background: CHART.money }} aria-hidden />
        <span className="flex-1 text-muted">Spending</span>
        <span>{fmt(row.spend)}</span>
      </div>
      <div className="mt-1 flex justify-between gap-4 border-t border-line pt-1 font-semibold tabular-nums">
        <span>Saved</span>
        <span>{fmt(row.saved, { sign: true })}</span>
      </div>
    </div>
  )
}

/** Income against spending for the last six months. */
export function CashFlowCard({ points, className }: { points: CashFlowPoint[]; className?: string }) {
  const rows = useMemo<Row[]>(
    () =>
      points.map((p) => {
        const income = num(p.income)
        const spend = Math.abs(num(p.expenses))
        return { month: p.month, income, spend, saved: income - spend }
      }),
    [points],
  )
  const stats = useMemo(() => {
    const n = rows.length || 1
    const income = rows.reduce((a, r) => a + r.income, 0) / n
    const spend = rows.reduce((a, r) => a + r.spend, 0) / n
    const best = rows.reduce((a, r) => (r.saved > a.saved ? r : a), rows[0] as Row)
    return { income, spend, rate: income ? ((income - spend) / income) * 100 : 0, best }
  }, [rows])
  if (rows.length === 0) return null

  const summary = `Cash flow for the last ${rows.length} months. Income averaged ${fmtWhole(stats.income)} a month and spending ${fmtWhole(stats.spend)}, so you saved about ${Math.round(stats.rate)} percent. Best month: ${monthLong(stats.best.month)}, saving ${fmtWhole(stats.best.saved)}.`

  return (
    <Panel
      title="Cash flow"
      subtitle={`Income vs spending, last ${rows.length} months`}
      icon={ArrowLeftRight}
      area="money"
      className={className}
      actions={
        <div className="flex items-center gap-3 text-[11px] text-muted" aria-hidden>
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2 rounded-sm" style={{ background: CHART.income }} /> Income
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2 rounded-sm" style={{ background: CHART.money }} /> Spending
          </span>
        </div>
      }
      bodyClassName="flex flex-col"
    >
      <div className="@container flex flex-1 flex-col">
        <div className="flex flex-1 flex-col gap-3 @2xl:flex-row">
          <div className="flex min-w-0 flex-1 flex-col">
            <div role="img" aria-label={summary} data-sensitive className="h-[160px] w-full min-w-0 flex-1 select-none">
              <ResponsiveContainer width="100%" height="100%" minHeight={140}>
                <BarChart data={rows} margin={{ top: 8, right: 4, left: 0, bottom: 0 }} barGap={3} barCategoryGap="22%" accessibilityLayer={false}>
                  <CartesianGrid stroke={CHART.grid} vertical={false} />
                  <XAxis dataKey="month" tickFormatter={monthShort} tick={{ fill: CHART.axis, fontSize: 11 }} axisLine={false} tickLine={false} />
                  <YAxis width={38} tickFormatter={fmtK} tick={{ fill: CHART.axis, fontSize: 11 }} axisLine={false} tickLine={false} tickCount={4} />
                  <Tooltip content={<FlowTip />} cursor={{ fill: 'rgba(255,255,255,0.05)' }} />
                  <Bar dataKey="income" fill={CHART.income} fillOpacity={0.85} radius={[4, 4, 0, 0]} maxBarSize={22} isAnimationActive={false} />
                  <Bar dataKey="spend" fill={CHART.money} fillOpacity={0.85} radius={[4, 4, 0, 0]} maxBarSize={22} isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <ul
              aria-label="Saved each month"
              className="mt-2 grid gap-1 pl-[38px]"
              style={{ gridTemplateColumns: `repeat(${rows.length}, minmax(0, 1fr))` }}
              data-sensitive
            >
              {rows.map((r) => (
                <li key={r.month} className={cn('text-center text-[11px] leading-tight font-medium tabular-nums', r.saved >= 0 ? 'text-ok' : 'text-bad')}>
                  {fmtWhole(r.saved, { sign: true })}
                </li>
              ))}
            </ul>
            <p className="mt-0.5 pl-[38px] text-center text-[11px] text-faint">saved each month</p>
          </div>
          <div
            className="grid grid-cols-3 gap-3 border-t border-line pt-3 @2xl:w-[170px] @2xl:shrink-0 @2xl:grid-cols-1 @2xl:content-center @2xl:gap-4 @2xl:border-t-0 @2xl:border-l @2xl:pt-0 @2xl:pl-5"
            data-sensitive
          >
            <Stat label="Avg income" value={fmtWhole(stats.income)} />
            <Stat label="Avg spending" value={fmtWhole(stats.spend)} />
            <Stat label="Saved" value={`${Math.round(stats.rate)}%`} sub="of income" />
          </div>
        </div>
      </div>
    </Panel>
  )
}
