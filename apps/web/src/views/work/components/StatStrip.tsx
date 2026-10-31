import { Activity, BellRing, CheckCheck, CircleDollarSign, Gauge as GaugeIcon, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { Badge, Gauge } from '../../../components/ui'
import { cn } from '../../../lib/cn'
import { fmtTime, fmtUsd } from '../../../lib/format'
import { SESSION_STATUS } from '../../../lib/status'
import { useSnap, useStore } from '../../../state/store'
import { activeSubagents, dayTotal, fmtDuration, useCostDays } from '../lib'
import { useWork, type StatusFilter } from '../ui'

function Cell({
  icon: Icon,
  tone,
  label,
  value,
  sub,
  onClick,
  ariaLabel,
  className,
  emphasize,
}: {
  icon: LucideIcon
  tone: string
  label: string
  value: ReactNode
  sub?: ReactNode
  onClick?: () => void
  ariaLabel?: string
  className?: string
  emphasize?: boolean
}) {
  const body = (
    <>
      <span className={cn('grid size-8 shrink-0 place-items-center rounded-lg', tone)}>
        <Icon className="size-4" aria-hidden />
      </span>
      <span className="min-w-0 flex-1 text-left">
        <span className="block text-[11px] tracking-wide text-faint uppercase">{label}</span>
        <span className={cn('block truncate text-xl leading-tight font-semibold tabular-nums', emphasize ? 'text-warn' : 'text-fg')}>{value}</span>
        {sub && <span className="block truncate text-[11px] text-muted">{sub}</span>}
      </span>
    </>
  )
  const cls = cn('flex min-w-0 items-center gap-3 px-3.5 py-3', className)
  if (!onClick) return <div className={cls}>{body}</div>
  return (
    <button type="button" onClick={onClick} aria-label={ariaLabel} className={cn(cls, 'cursor-pointer transition hover:bg-white/[0.04]')}>
      {body}
    </button>
  )
}

/** Always-visible header strip: how many agents run, what needs you, what it costs, how full the 5-hour block is. */
export function StatStrip() {
  const sessions = useSnap((d) => d.sessions)
  const block = useSnap((d) => d.usageBlock)
  const now = useStore((s) => s.now)
  const costDays = useCostDays()
  const setTab = useWork((s) => s.setTab)
  const setStatusFilter = useWork((s) => s.setStatusFilter)

  const running = sessions.filter((s) => s.status === 'running')
  const needs = sessions.filter((s) => SESSION_STATUS[s.status].needsYou)
  const asking = needs.filter((s) => s.status === 'blocked_permission').length
  const replying = needs.length - asking
  const startOfDay = new Date(now)
  startOfDay.setHours(0, 0, 0, 0)
  const doneToday = sessions.filter((s) => s.status === 'done' && new Date(s.updatedAt) >= startOfDay).length
  const today = costDays[costDays.length - 1]
  const todayCost = today ? dayTotal(today) : 0
  const weekCost = costDays.slice(-7).reduce((a, d) => a + dayTotal(d), 0)
  const subagents = running.reduce((a, s) => a + activeSubagents(s), 0)

  const filterTo = (f: StatusFilter) => () => {
    setStatusFilter(f)
    setTab('overview')
  }

  const endsAt = new Date(block.endsAt).getTime()
  const startsAt = new Date(block.startedAt).getTime()
  const remaining = endsAt - now.getTime()
  const expired = remaining <= 0
  const elapsedPct = Math.max(0, Math.min(100, ((now.getTime() - startsAt) / (endsAt - startsAt)) * 100))

  return (
    <section aria-label="Work summary" className="glass grid grid-cols-2 overflow-hidden @2xl:grid-cols-4 @5xl:grid-cols-[repeat(4,minmax(0,1fr))_minmax(0,1.8fr)]">
      <Cell
        icon={Activity}
        tone="bg-ok/12 text-ok"
        label="Running"
        value={running.length}
        sub={subagents > 0 ? `${subagents} subagent${subagents === 1 ? '' : 's'} active` : 'no subagents active'}
        onClick={filterTo('running')}
        ariaLabel="Show running sessions"
      />
      <Cell
        icon={BellRing}
        tone={needs.length ? 'bg-warn/14 text-warn' : 'bg-white/6 text-muted'}
        label="Needs you"
        value={needs.length}
        emphasize={needs.length > 0}
        sub={needs.length ? `${asking} permission, ${replying} reply` : 'nothing waiting'}
        onClick={filterTo('needs')}
        ariaLabel="Show sessions that need you"
        className="border-l border-line"
      />
      <Cell
        icon={CheckCheck}
        tone="bg-work/12 text-work"
        label="Done today"
        value={doneToday}
        sub="sessions finished"
        onClick={filterTo('done')}
        ariaLabel="Show finished sessions"
        className="border-t border-line @2xl:border-t-0 @2xl:border-l"
      />
      <Cell
        icon={CircleDollarSign}
        tone="bg-money/12 text-money"
        label="Cost today (est.)"
        value={fmtUsd(todayCost)}
        sub={`7 days ${fmtUsd(weekCost, 0)} · estimate`}
        className="border-t border-l border-line @2xl:border-t-0"
      />
      <div className="col-span-2 flex min-w-0 items-center gap-3 border-t border-line px-3.5 py-3 @2xl:col-span-4 @5xl:col-span-1 @5xl:border-t-0 @5xl:border-l">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-brain/12 text-brain">
          <GaugeIcon className="size-4" aria-hidden />
        </span>
        <div className="flex min-w-0 flex-1 flex-col @2xl:flex-row @2xl:items-center @2xl:gap-6 @5xl:flex-col @5xl:items-stretch @5xl:gap-0">
          <div className="shrink-0">
            <div className="flex items-center gap-1.5 text-[11px] tracking-wide text-faint uppercase">
              5-hour block
              <Badge className="normal-case" title="Plan limits are not exposed by Claude Code; this is derived from local token counts at API list prices.">
                estimate
              </Badge>
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-xl leading-tight font-semibold text-fg tabular-nums">{Math.round(block.usedPct)}%</span>
              <span className="truncate text-[12px] text-muted">{expired ? 'window ended' : `resets in ${fmtDuration(remaining)}`}</span>
            </div>
          </div>
          <div className="min-w-0 flex-1">
            <Gauge pct={block.usedPct} height={6} className="mt-1 @2xl:mt-0 @5xl:mt-1" label="5-hour usage block used, estimate" />
            <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-faint tabular-nums">
              <span>{fmtTime(block.startedAt)}</span>
              <span className="truncate text-muted">{fmtUsd(block.costUsd)} so far · {Math.round(elapsedPct)}% of window elapsed</span>
              <span>{fmtTime(block.endsAt)}</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
