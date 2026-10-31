import type { BudgetLine, Category } from '@ai-assistant/shared'
import { AlertTriangle, Check, PieChart } from 'lucide-react'
import { useMemo } from 'react'
import { Badge, Gauge, Panel } from '../../../components/ui'
import { cn } from '../../../lib/cn'
import { fmtWhole, monthLong, num } from '../lib'

interface Row {
  id: string
  name: string
  fixed: boolean
  planned: number
  actual: number
  remaining: number
  pct: number
}

type State = 'paid' | 'ok' | 'near' | 'over'

/** Fixed costs read "paid"; others shift from green to amber near the limit and red when over. */
function stateOf(r: Row): State {
  if (r.actual > r.planned) return 'over'
  if (r.fixed) return r.actual >= r.planned ? 'paid' : 'ok'
  return r.pct >= 90 ? 'near' : 'ok'
}

const BAR: Record<State, string> = {
  paid: 'var(--color-money)',
  ok: 'var(--color-ok)',
  near: 'var(--color-warn)',
  over: 'var(--color-bad)',
}

function BudgetRow({ r }: { r: Row }) {
  const st = stateOf(r)
  const left = r.remaining
  return (
    <li>
      <div className="flex items-center gap-2">
        <span className="min-w-0 truncate text-[13px] text-fg">{r.name}</span>
        {st === 'paid' && (
          <Badge tone="money">
            <Check className="size-3" aria-hidden /> Paid
          </Badge>
        )}
        {st === 'near' && (
          <Badge tone="warn">
            <AlertTriangle className="size-3" aria-hidden /> Near limit
          </Badge>
        )}
        {st === 'over' && (
          <Badge tone="bad">
            <AlertTriangle className="size-3" aria-hidden /> Over
          </Badge>
        )}
        <span className="ml-auto text-[12px] whitespace-nowrap text-muted tabular-nums" data-sensitive>
          <span className="text-fg">{fmtWhole(r.actual)}</span> of {fmtWhole(r.planned)}
          {!r.fixed || st === 'over' ? (
            <span className={cn('ml-2 font-medium', st === 'over' ? 'text-bad' : st === 'near' ? 'text-warn' : 'text-muted')}>
              {left < 0 ? `${fmtWhole(-left)} over` : `${fmtWhole(left)} left`}
            </span>
          ) : null}
        </span>
      </div>
      <Gauge
        pct={r.planned ? Math.min(100, (r.actual / r.planned) * 100) : 0}
        color={BAR[st]}
        height={6}
        className="mt-1.5"
        label={`${r.name}: ${fmtWhole(r.actual)} spent of ${fmtWhole(r.planned)} planned`}
      />
    </li>
  )
}

/** The current period as one bar per category: planned against actual, and what is left. */
export function BudgetCard({ budget, categories, className }: { budget: BudgetLine[]; categories: Category[]; className?: string }) {
  const rows = useMemo<Row[]>(
    () =>
      budget.map((b) => {
        const cat = categories.find((c) => c.id === b.categoryId)
        const planned = num(b.planned)
        const actual = num(b.actual)
        return {
          id: b.categoryId,
          name: cat?.name ?? b.categoryId,
          fixed: cat?.fixed ?? false,
          planned,
          actual,
          remaining: num(b.remaining),
          pct: planned ? (actual / planned) * 100 : 0,
        }
      }),
    [budget, categories],
  )
  const totals = useMemo(() => {
    const planned = rows.reduce((a, r) => a + r.planned, 0)
    const actual = rows.reduce((a, r) => a + r.actual, 0)
    return { planned, actual, left: planned - actual, pct: planned ? (actual / planned) * 100 : 0 }
  }, [rows])
  const period = budget[0]?.period
  const over = rows.filter((r) => r.actual > r.planned)
  const summary = `Budget for ${period ? monthLong(period) : 'this period'}: ${fmtWhole(totals.actual)} spent of ${fmtWhole(totals.planned)} planned, ${fmtWhole(Math.abs(totals.left))} ${totals.left >= 0 ? 'left' : 'over'}. ${over.length ? `Over plan: ${over.map((r) => r.name).join(', ')}.` : 'Nothing is over plan.'}`

  return (
    <Panel
      title="Budget"
      subtitle={period ? `${monthLong(period)}, planned against actual` : 'This period'}
      icon={PieChart}
      area="money"
      className={className}
      bodyClassName="flex flex-col"
    >
      <div className="@container flex flex-1 flex-col">
        <ul aria-label={summary} className="grid grid-cols-1 gap-x-8 gap-y-3.5 @2xl:grid-cols-2">
          {rows.map((r) => (
            <BudgetRow key={r.id} r={r} />
          ))}
        </ul>
        <div className="mt-auto pt-4">
          <div className="rounded-xl border border-line bg-white/[0.025] px-3 py-2.5">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1" data-sensitive>
              <span className="text-[12px] text-muted">
                <span className="text-[15px] font-semibold text-fg tabular-nums">{fmtWhole(totals.actual)}</span> of {fmtWhole(totals.planned)} planned
              </span>
              <span className={cn('text-[12px] font-medium tabular-nums', totals.left >= 0 ? 'text-ok' : 'text-bad')}>
                {fmtWhole(Math.abs(totals.left))} {totals.left >= 0 ? 'under plan' : 'over plan'} ({Math.round(Math.abs(totals.left / (totals.planned || 1)) * 100)}%)
              </span>
            </div>
            <Gauge pct={totals.pct} color="var(--color-money)" height={6} className="mt-2" label="Total budget used" />
          </div>
        </div>
      </div>
    </Panel>
  )
}
