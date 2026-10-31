import type { Account, BalanceSnapshot } from '@ai-assistant/shared'
import { Banknote, CreditCard, HandCoins, Landmark, PiggyBank, TrendingUp, type LucideIcon } from 'lucide-react'
import { useMemo } from 'react'
import { Panel } from '../../../components/ui'
import { cn } from '../../../lib/cn'
import { timeAgo } from '../../../lib/format'
import { useStore } from '../../../state/store'
import { GROUP_LABEL, accountRows, fmt, groupOf, type AccountGroup, type AccountRow } from '../lib'
import { Tip } from './Tip'

const KIND_ICON: Record<Account['kind'], LucideIcon> = {
  checking: Landmark,
  savings: PiggyBank,
  investment: TrendingUp,
  credit: CreditCard,
  loan: HandCoins,
  cash: Banknote,
  other: Landmark,
}

const ORDER: AccountGroup[] = ['cash', 'investments', 'liabilities']

function Row({ row }: { row: AccountRow }) {
  const Icon = KIND_ICON[row.account.kind]
  const { change } = row
  return (
    <li className="flex items-center gap-3 rounded-lg px-1.5 py-1">
      <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-white/5 text-muted">
        <Icon className="size-3.5" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] text-fg">{row.account.name}</div>
        <div className="truncate text-[11px] text-faint">{row.account.institution ?? row.account.kind}</div>
      </div>
      <div className="text-right" data-sensitive>
        <div className="text-[13px] font-semibold text-fg tabular-nums">{fmt(row.current)}</div>
        {change !== null && (
          <Tip text="Change since about 30 days ago" side="top" align="end">
            <span
              className={cn('cursor-help text-[11px] tabular-nums', change >= 0 ? 'text-ok' : 'text-bad')}
              aria-label={`${change >= 0 ? 'Up' : 'Down'} ${fmt(Math.abs(change))} in 30 days`}
            >
              {fmt(change, { sign: true })}
            </span>
          </Tip>
        )}
      </div>
    </li>
  )
}

/** Accounts grouped as Cash, Investments and Liabilities, each with a subtotal. */
export function AccountsCard({ accounts, balances, className }: { accounts: Account[]; balances: BalanceSnapshot[]; className?: string }) {
  const now = useStore((s) => s.now)
  const groups = useMemo(() => {
    const rows = accountRows(accounts, balances)
    return ORDER.map((g) => {
      const items = rows.filter((r) => groupOf(r.account) === g)
      return { id: g, items, total: items.reduce((a, r) => a + r.current, 0) }
    }).filter((g) => g.items.length > 0)
  }, [accounts, balances])
  const asOf = balances[0]?.asOf

  return (
    <Panel
      title="Accounts"
      subtitle={`${accounts.length} accounts${asOf ? `, as of ${timeAgo(asOf, now)}` : ''}`}
      icon={Landmark}
      area="money"
      className={className}
    >
      <div className="flex flex-col gap-3">
        {groups.map((g) => (
          <section key={g.id} aria-label={GROUP_LABEL[g.id]}>
            <div className="flex items-baseline justify-between border-b border-line px-1.5 pb-1">
              <h3 className="text-[11px] font-semibold tracking-wide text-faint uppercase">{GROUP_LABEL[g.id]}</h3>
              <span className="text-[12px] font-medium text-muted tabular-nums" data-sensitive>
                {fmt(g.total)}
              </span>
            </div>
            <ul className="mt-1">
              {g.items.map((r) => (
                <Row key={r.account.id} row={r} />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Panel>
  )
}
