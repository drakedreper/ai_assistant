import type { NetWorthPoint } from '@ai-assistant/shared'
import { TrendingDown, TrendingUp, Wallet } from 'lucide-react'
import { useMemo } from 'react'
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Panel } from '../../../components/ui'
import { cn } from '../../../lib/cn'
import { CHART, fmt, fmtDate, fmtK, monthShort, num } from '../lib'

interface Row {
  date: string
  net: number
  assets: number
  liabilities: number
}

function NwTip({ active, payload }: { active?: boolean; payload?: Array<{ payload?: Row }> }) {
  const row = active ? payload?.[0]?.payload : undefined
  if (!row) return null
  return (
    <div className="rounded-lg border border-line-strong px-3 py-2 text-[12px] shadow-2xl" style={{ background: CHART.tipBg, color: CHART.fg }}>
      <div className="mb-1 font-semibold">{fmtDate(row.date, false)}</div>
      <div className="flex items-center gap-4 tabular-nums">
        <span className="flex-1 text-muted">Net worth</span>
        <span className="font-semibold">{fmt(row.net)}</span>
      </div>
      <div className="flex items-center gap-4 text-muted tabular-nums">
        <span className="flex-1">Assets</span>
        <span>{fmt(row.assets)}</span>
      </div>
      <div className="flex items-center gap-4 text-muted tabular-nums">
        <span className="flex-1">Liabilities</span>
        <span>{fmt(row.liabilities)}</span>
      </div>
    </div>
  )
}

/** Net worth hero: the big number, the change vs 30 days ago, and twelve months of history. */
export function NetWorthCard({ series, accountCount, className }: { series: NetWorthPoint[]; accountCount: number; className?: string }) {
  const rows = useMemo<Row[]>(
    () => series.map((p) => ({ date: p.date, net: num(p.net), assets: num(p.assets), liabilities: num(p.liabilities) })),
    [series],
  )
  const stats = useMemo(() => {
    const last = rows[rows.length - 1]
    const prev = rows[rows.length - 2]
    const first = rows[0]
    const delta = last && prev ? last.net - prev.net : 0
    const pct = prev && prev.net ? (delta / Math.abs(prev.net)) * 100 : 0
    const low = rows.reduce((a, b) => (b.net < a.net ? b : a), rows[0] as Row)
    const high = rows.reduce((a, b) => (b.net > a.net ? b : a), rows[0] as Row)
    const yearChange = last && first ? last.net - first.net : 0
    return { last, delta, pct, low, high, yearChange }
  }, [rows])

  if (!stats.last) return null
  const up = stats.delta >= 0
  const summary = `Net worth over the last ${rows.length} months. Now ${fmt(stats.last.net)}, ${up ? 'up' : 'down'} ${fmt(Math.abs(stats.delta))} (${Math.abs(stats.pct).toFixed(1)} percent) from 30 days ago. Over the whole period it moved ${fmt(stats.yearChange, { sign: true })}, from a low of ${fmt(stats.low.net)} to a high of ${fmt(stats.high.net)}.`

  return (
    <Panel
      title="Net worth"
      subtitle={`${accountCount} accounts, last ${rows.length} months`}
      icon={Wallet}
      area="money"
      className={className}
      bodyClassName="flex flex-col"
    >
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2" data-sensitive>
        <div className="min-w-0">
          <div className="text-[32px] leading-none font-semibold tracking-tight text-fg tabular-nums">{fmt(stats.last.net)}</div>
          <div className={cn('mt-2 inline-flex items-center gap-1.5 text-[12px] font-medium tabular-nums', up ? 'text-ok' : 'text-bad')}>
            {up ? <TrendingUp className="size-3.5" aria-hidden /> : <TrendingDown className="size-3.5" aria-hidden />}
            {fmt(stats.delta, { sign: true })} ({up ? '+' : '-'}{Math.abs(stats.pct).toFixed(1)}%)
            <span className="font-normal text-muted">vs 30 days ago</span>
          </div>
        </div>
        <dl className="flex gap-6 text-[12px]">
          <div>
            <dt className="text-[11px] tracking-wide text-faint uppercase">Assets</dt>
            <dd className="font-semibold text-fg tabular-nums">{fmt(stats.last.assets)}</dd>
          </div>
          <div>
            <dt className="text-[11px] tracking-wide text-faint uppercase">Liabilities</dt>
            <dd className="font-semibold text-fg tabular-nums">{fmt(stats.last.liabilities)}</dd>
          </div>
          <div className="hidden sm:block">
            <dt className="text-[11px] tracking-wide text-faint uppercase">{rows.length} months</dt>
            <dd className={cn('font-semibold tabular-nums', stats.yearChange >= 0 ? 'text-ok' : 'text-bad')}>{fmt(stats.yearChange, { sign: true })}</dd>
          </div>
        </dl>
      </div>

      <div role="img" aria-label={summary} data-sensitive className="mt-3 h-[190px] w-full min-w-0 flex-1 select-none">
        <ResponsiveContainer width="100%" height="100%" minHeight={160}>
          <AreaChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} accessibilityLayer={false}>
            <defs>
              <linearGradient id="nw-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={CHART.money} stopOpacity={0.32} />
                <stop offset="100%" stopColor={CHART.money} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke={CHART.grid} vertical={false} />
            <XAxis
              dataKey="date"
              tickFormatter={(v: string, i: number) => (i === rows.length - 1 ? 'Now' : monthShort(v))}
              tick={{ fill: CHART.axis, fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              minTickGap={14}
              padding={{ left: 6, right: 6 }}
            />
            <YAxis
              width={42}
              tickFormatter={fmtK}
              tick={{ fill: CHART.axis, fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              tickCount={4}
              domain={[(min: number) => Math.floor(min / 5000) * 5000, (max: number) => Math.ceil(max / 5000) * 5000]}
            />
            <Tooltip content={<NwTip />} cursor={{ stroke: 'rgba(255,255,255,0.22)', strokeDasharray: '3 3' }} />
            <Area
              type="monotone"
              dataKey="net"
              stroke={CHART.money}
              strokeWidth={2}
              fill="url(#nw-fill)"
              dot={false}
              activeDot={{ r: 4, stroke: CHART.money, fill: '#0a0c16', strokeWidth: 2 }}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </Panel>
  )
}
