import type { Bill } from '@ai-assistant/shared'
import { CalendarClock, Check, Hand, RefreshCw } from 'lucide-react'
import { useMemo } from 'react'
import { Badge, Panel } from '../../../components/ui'
import { cn } from '../../../lib/cn'
import { useStore } from '../../../state/store'
import { daysUntil, fmt, fmtWhole, num } from '../lib'
import { Tip } from './Tip'

const ORIGIN: Record<Bill['origin'], string> = {
  declared: 'You declared this bill',
  detected: 'Atlas detected this from repeating payments',
  manual: 'You added this one by hand',
}

function leftText(days: number): string {
  if (days < 0) return `${-days} d overdue`
  if (days === 0) return 'today'
  if (days === 1) return 'tomorrow'
  return `in ${days} days`
}

function BillRow({ bill, days }: { bill: Bill; days: number }) {
  const due = new Date(`${bill.dueDate}T00:00:00`)
  const soon = days <= 3 && !bill.isPaid
  return (
    <li className={cn('flex items-center gap-3 rounded-lg px-1.5 py-2', bill.isPaid && 'opacity-60')}>
      <div className="grid w-10 shrink-0 place-items-center rounded-lg border border-line bg-white/[0.04] py-1 text-center leading-none">
        <span className="text-[10px] tracking-wide text-faint uppercase">{due.toLocaleDateString([], { month: 'short' })}</span>
        <span className="mt-0.5 text-[15px] font-semibold text-fg tabular-nums">{due.getDate()}</span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <Tip text={ORIGIN[bill.origin]} side="top" align="start" className="min-w-0">
            <span className="cursor-help truncate text-[13px] text-fg">{bill.payee}</span>
          </Tip>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
          {bill.isPaid ? (
            <Badge tone="ok">
              <Check className="size-3" aria-hidden /> Paid
            </Badge>
          ) : bill.autopay ? (
            <Badge tone="ok">
              <RefreshCw className="size-3" aria-hidden /> Autopay
            </Badge>
          ) : (
            <Badge tone="warn">
              <Hand className="size-3" aria-hidden /> You pay this
            </Badge>
          )}
          <span className={cn('text-[11px] tabular-nums', soon ? 'font-medium text-warn' : 'text-faint')}>{leftText(days)}</span>
        </div>
      </div>
      <div className="text-right text-[13px] font-semibold text-fg tabular-nums" data-sensitive>
        {fmt(num(bill.expected))}
      </div>
    </li>
  )
}

/** Bills due soon, soonest first, with who pays them: autopay or you. */
export function BillsCard({ bills, className }: { bills: Bill[]; className?: string }) {
  const now = useStore((s) => s.now)
  const rows = useMemo(
    () => bills.map((b) => ({ bill: b, days: daysUntil(b.dueDate, now) })).sort((a, b) => a.days - b.days),
    [bills, now],
  )
  const open = rows.filter((r) => !r.bill.isPaid)
  const total = open.reduce((a, r) => a + num(r.bill.expected), 0)
  const manual = open.filter((r) => !r.bill.autopay)
  const manualTotal = manual.reduce((a, r) => a + num(r.bill.expected), 0)
  const horizon = open.length ? Math.max(...open.map((r) => r.days)) : 0

  return (
    <Panel
      title="Upcoming bills"
      subtitle={open.length ? `${open.length} due in the next ${horizon} days` : 'Nothing due'}
      icon={CalendarClock}
      area="money"
      className={className}
      bodyClassName="flex flex-col"
    >
      <ul className="-mx-1.5 divide-y divide-line">
        {rows.map((r) => (
          <BillRow key={r.bill.id} bill={r.bill} days={r.days} />
        ))}
      </ul>
      <div className="mt-auto pt-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 rounded-xl border border-line bg-white/[0.025] px-3 py-2.5 text-[12px]" data-sensitive>
          <span className="text-muted">
            Total <span className="text-[15px] font-semibold text-fg tabular-nums">{fmtWhole(total)}</span>
          </span>
          {manual.length > 0 && (
            <span className="text-warn tabular-nums">
              {fmtWhole(manualTotal)} not on autopay
            </span>
          )}
        </div>
      </div>
    </Panel>
  )
}
