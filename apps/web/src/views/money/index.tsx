import { useMemo } from 'react'
import { useSnap, useStore } from '../../state/store'
import { timeAgo } from '../../lib/format'
import { AccountsCard } from './components/AccountsCard'
import { BillsCard } from './components/BillsCard'
import { BudgetCard } from './components/BudgetCard'
import { CashFlowCard } from './components/CashFlowCard'
import { IndependenceCard } from './components/IndependenceCard'
import { MiraTake } from './components/MiraTake'
import { MockBanner } from './components/MockBanner'
import { NetWorthCard } from './components/NetWorthCard'
import { TransactionsCard } from './components/TransactionsCard'
import { num } from './lib'

/**
 * MONEY (Atlas): aggregates by default, read-only contract v0.1. The grid reflows from one column to two
 * (stage at about 1000px) to three (about 1400px); cards are re-ordered with container queries.
 */
export function MoneyView() {
  const f = useSnap((d) => d.finance)
  const now = useStore((s) => s.now)
  const asOf = f.balances[0]?.asOf
  const monthlySaved = useMemo(() => {
    const cf = f.cashFlow ?? []
    return cf.length ? cf.reduce((a, p) => a + num(p.income) + num(p.expenses), 0) / cf.length : undefined
  }, [f.cashFlow])

  return (
    <div className="@container flex flex-col gap-3 pb-4">
      <header className="flex flex-wrap items-end gap-x-3 gap-y-1">
        <div className="mr-auto min-w-0">
          <h1 className="text-[17px] leading-tight font-semibold text-fg">Money (Atlas)</h1>
          <p className="text-[12px] text-faint">Net worth, budget and bills. Read-only, aggregates first.</p>
        </div>
        {asOf && <p className="text-[12px] text-faint">Balances as of {timeAgo(asOf, now)}</p>}
      </header>

      <MockBanner connected={f.connected} contractVersion={f.contractVersion} />

      <div className="grid grid-cols-1 items-stretch gap-3 @4xl:grid-cols-2 @6xl:grid-cols-3">
        <div className="flex min-w-0 @4xl:col-span-2 @6xl:order-1">
          <NetWorthCard series={f.netWorth} accountCount={f.accounts.length} className="w-full" />
        </div>
        {f.insight && (
          <div className="flex min-w-0 @6xl:order-2">
            <MiraTake insight={f.insight} className="w-full" />
          </div>
        )}
        {f.independence && (
          <div className="flex min-w-0 @6xl:order-7">
            <IndependenceCard plan={f.independence} monthlySaved={monthlySaved} className="w-full" />
          </div>
        )}
        <div className="flex min-w-0 @6xl:order-3">
          <AccountsCard accounts={f.accounts} balances={f.balances} className="w-full" />
        </div>
        {f.cashFlow && (
          <div className="flex min-w-0 @6xl:order-4 @6xl:col-span-2">
            <CashFlowCard points={f.cashFlow} className="w-full" />
          </div>
        )}
        <div className="flex min-w-0 @6xl:order-5">
          <BudgetCard budget={f.budget} categories={f.categories} className="w-full" />
        </div>
        <div className="flex min-w-0 @6xl:order-6">
          <BillsCard bills={f.upcomingBills} className="w-full" />
        </div>
        <div className="flex min-w-0 @4xl:col-span-2 @6xl:order-8 @6xl:col-span-3">
          <TransactionsCard txns={f.recentTransactions} accounts={f.accounts} categories={f.categories} className="w-full" />
        </div>
      </div>
    </div>
  )
}
