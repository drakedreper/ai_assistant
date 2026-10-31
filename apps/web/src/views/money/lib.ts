import type { Account, BalanceSnapshot, Money } from '@ai-assistant/shared'
import { fmtMoney, moneyToNumber } from '../../lib/format'

/** Chart styling from the design tokens (hex, because SVG attributes cannot use Tailwind classes). */
export const CHART = {
  axis: '#6c7499',
  grid: 'rgba(255,255,255,0.06)',
  fg: '#e9ebf7',
  muted: '#9ca4c9',
  money: '#fbbf24',
  income: '#4ade80',
  tipBg: '#161a33',
} as const

const CUR = 'USD'

export const toMoney = (n: number, currency: string = CUR): Money => ({ amountMinor: String(Math.round(n * 100)), currency })
/** Dollars (number) to "$1,234.56" / "-$12.00". */
export const fmt = (n: number, opts: { sign?: boolean; compact?: boolean } = {}) => fmtMoney(toMoney(n), opts)
/** "$1,234" with no cents, for tight places. */
export const fmtWhole = (n: number, opts: { sign?: boolean } = {}) => {
  const s = `$${Math.abs(Math.round(n)).toLocaleString()}`
  return n < 0 ? `-${s}` : opts.sign && n > 0 ? `+${s}` : s
}
/** "$44.8k" for axes. */
export const fmtK = (n: number) => `$${(n / 1000).toFixed(Math.abs(n) >= 10_000 ? 0 : 1)}k`
export const num = moneyToNumber

/** "May" from "2026-05" or "2026-05-14". */
export function monthShort(ym: string): string {
  const [y, m] = ym.split('-').map(Number)
  return new Date(y ?? 2000, (m ?? 1) - 1, 1).toLocaleDateString([], { month: 'short' })
}
export function monthLong(ym: string): string {
  const [y, m] = ym.split('-').map(Number)
  return new Date(y ?? 2000, (m ?? 1) - 1, 1).toLocaleDateString([], { month: 'long', year: 'numeric' })
}
/** "14 Jun 2027". */
export function fmtDate(isoDate: string, withYear = true): string {
  const [y, m, d] = isoDate.split('-').map(Number)
  return new Date(y ?? 2000, (m ?? 1) - 1, d ?? 1).toLocaleDateString([], { day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}) })
}
const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
/** Whole days from today (store "now") to a YYYY-MM-DD date; negative = overdue. */
export function daysUntil(isoDate: string, now: Date): number {
  const [y, m, d] = isoDate.split('-').map(Number)
  return Math.round((new Date(y ?? 2000, (m ?? 1) - 1, d ?? 1).getTime() - dayStart(now)) / 86_400_000)
}

export type AccountGroup = 'cash' | 'investments' | 'liabilities'
export const GROUP_LABEL: Record<AccountGroup, string> = { cash: 'Cash', investments: 'Investments', liabilities: 'Liabilities' }

export function groupOf(a: Account): AccountGroup {
  if (a.isLiability) return 'liabilities'
  return a.kind === 'investment' ? 'investments' : 'cash'
}

export interface AccountRow {
  account: Account
  balance: BalanceSnapshot | undefined
  current: number
  /** Signed change vs about 30 days ago; positive is always good (a liability moving toward zero is a gain). */
  change: number | null
}

export function accountRows(accounts: Account[], balances: BalanceSnapshot[]): AccountRow[] {
  return accounts
    .filter((a) => !a.archived)
    .map((account) => {
      const balance = balances.find((b) => b.accountId === account.id)
      const current = balance ? num(balance.current) : 0
      const change = balance?.previous ? current - num(balance.previous) : null
      return { account, balance, current, change }
    })
}
