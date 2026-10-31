import type { Account, Category, Txn } from '@ai-assistant/shared'
import { Eye, EyeOff, Lock, Receipt, ScrollText } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Badge, Button, Panel } from '../../../components/ui'
import { cn } from '../../../lib/cn'
import { fmtDay, fmtMoney } from '../../../lib/format'
import { useStore } from '../../../state/store'

/**
 * Raw transactions stay hidden until you reveal them; the reveal is local UI state, so leaving the screen
 * hides them again. The audit line is honest: the real daemon would write that entry.
 */
export function TransactionsCard({
  txns,
  accounts,
  categories,
  className,
}: {
  txns: Txn[]
  accounts: Account[]
  categories: Category[]
  className?: string
}) {
  const [revealed, setRevealed] = useState(false)
  const navigate = useStore((s) => s.navigate)
  const rows = useMemo(() => txns.slice().sort((a, b) => (a.postedAt < b.postedAt ? 1 : -1)), [txns])

  return (
    <Panel
      title="Recent transactions"
      subtitle={revealed ? `${rows.length} rows, shown on screen only` : 'Hidden by default'}
      icon={Receipt}
      area="money"
      className={className}
      actions={
        revealed ? (
          <Button size="xs" variant="ghost" onClick={() => setRevealed(false)}>
            <EyeOff className="size-3" aria-hidden /> Hide
          </Button>
        ) : undefined
      }
      flush={revealed}
    >
      {!revealed ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-line-strong px-4 py-7 text-center">
          <span className="grid size-10 place-items-center rounded-full bg-white/6 text-muted">
            <Lock className="size-[18px]" aria-hidden />
          </span>
          <div className="max-w-[46ch]">
            <p className="text-[13px] font-medium text-fg">Raw transactions are hidden</p>
            <p className="mt-1 text-[12px] leading-snug text-muted">
              This screen and Mira work from aggregates. Reveal the list when you need to check a charge; it hides again when you leave the screen.
            </p>
          </div>
          <Button variant="outline" size="md" onClick={() => setRevealed(true)}>
            <Eye className="size-4" aria-hidden /> Reveal raw transactions
          </Button>
        </div>
      ) : (
        <div className="@container">
          <div className="max-h-[360px] overflow-y-auto" data-sensitive>
            <table className="w-full text-left text-[12px]">
              <caption className="sr-only">Recent transactions, newest first</caption>
              <thead className="sticky top-0 bg-raised/95 text-[11px] tracking-wide text-faint uppercase backdrop-blur">
                <tr>
                  <th scope="col" className="px-4 py-1.5 font-medium">When</th>
                  <th scope="col" className="px-2 py-1.5 font-medium">Merchant</th>
                  <th scope="col" className="hidden px-2 py-1.5 font-medium @2xl:table-cell">Account</th>
                  <th scope="col" className="hidden px-2 py-1.5 font-medium @xl:table-cell">Category</th>
                  <th scope="col" className="px-4 py-1.5 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((t) => {
                  const v = Number(t.amount.amountMinor)
                  const cat = categories.find((c) => c.id === t.categoryId)
                  const acc = accounts.find((a) => a.id === t.accountId)
                  const transfer = cat?.kind === 'transfer'
                  return (
                    <tr key={t.id} className="hover:bg-white/[0.03]">
                      <td className="px-4 py-2 whitespace-nowrap text-muted tabular-nums">{fmtDay(t.postedAt)}</td>
                      <td className="px-2 py-2">
                        <div className="flex items-center gap-1.5 text-[13px] text-fg">
                          {t.merchant ?? t.description}
                          {t.status === 'pending' && <Badge tone="warn">Pending</Badge>}
                        </div>
                        <div className="text-[11px] text-faint">{t.description}</div>
                      </td>
                      <td className="hidden px-2 py-2 text-muted @2xl:table-cell">{acc?.name ?? t.accountId}</td>
                      <td className="hidden px-2 py-2 @xl:table-cell">{cat && <Badge>{cat.name}</Badge>}</td>
                      <td
                        className={cn(
                          'px-4 py-2 text-right text-[13px] font-medium whitespace-nowrap tabular-nums',
                          transfer ? 'text-muted' : v > 0 ? 'text-ok' : 'text-fg',
                        )}
                      >
                        {fmtMoney(t.amount, { sign: true })}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line px-4 py-2.5 text-[11px] text-faint">
            <span className="inline-flex items-center gap-1.5">
              <ScrollText className="size-3.5" aria-hidden />
              Access logged to the audit trail
            </span>
            <span aria-hidden>·</span>
            <span>shown until you leave this screen</span>
            <button
              type="button"
              onClick={() => navigate('settings', { tab: 'audit' })}
              className="ml-auto cursor-pointer text-money hover:underline"
            >
              View audit log
            </button>
          </div>
        </div>
      )}
    </Panel>
  )
}
