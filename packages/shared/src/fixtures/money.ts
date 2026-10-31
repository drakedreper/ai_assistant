import type { FinanceSnapshot } from '../index'
import { ago, dateOnly, usd } from './time'

/** SEED. The Money owner enriches. Atlas is NOT connected: the screen shows a mock banner. */
export function buildFinance(now: Date): FinanceSnapshot {
  const period = dateOnly(now).slice(0, 7)
  return {
    connected: false,
    contractVersion: '0.1',
    accounts: [
      { id: 'acc-check', name: 'Everyday checking', kind: 'checking', currency: 'USD', institution: 'Northwind Bank', isLiability: false, archived: false },
      { id: 'acc-save', name: 'Runway savings', kind: 'savings', currency: 'USD', institution: 'Northwind Bank', isLiability: false, archived: false },
      { id: 'acc-invest', name: 'Index fund', kind: 'investment', currency: 'USD', institution: 'Brokerage', isLiability: false, archived: false },
      { id: 'acc-card', name: 'Credit card', kind: 'credit', currency: 'USD', institution: 'Northwind Bank', isLiability: true, archived: false },
    ],
    balances: [
      { accountId: 'acc-check', asOf: ago(now, 30), current: usd(4280.55), available: usd(4280.55) },
      { accountId: 'acc-save', asOf: ago(now, 30), current: usd(18200) },
      { accountId: 'acc-invest', asOf: ago(now, 30), current: usd(41250.1) },
      { accountId: 'acc-card', asOf: ago(now, 30), current: usd(-612.4) },
    ],
    categories: [
      { id: 'cat-income', name: 'Income', kind: 'income' },
      { id: 'cat-rent', name: 'Rent', kind: 'expense' },
      { id: 'cat-food', name: 'Food', kind: 'expense' },
      { id: 'cat-tools', name: 'Tools and cloud', kind: 'expense' },
      { id: 'cat-fun', name: 'Fun', kind: 'expense' },
    ],
    recentTransactions: [
      { id: 'tx-1', accountId: 'acc-check', postedAt: ago(now, 60 * 20), amount: usd(-12), status: 'posted', merchant: 'Cloud Host', description: 'Monthly hosting', categoryId: 'cat-tools', tags: [] },
      { id: 'tx-2', accountId: 'acc-card', postedAt: ago(now, 60 * 30), amount: usd(-46.2), status: 'posted', merchant: 'Corner Cafe', description: 'Lunch', categoryId: 'cat-food', tags: [] },
      { id: 'tx-3', accountId: 'acc-check', postedAt: ago(now, 60 * 72), amount: usd(3200), status: 'posted', merchant: 'Client payment', description: 'Invoice 0042', categoryId: 'cat-income', tags: ['invoice'] },
    ],
    budget: [
      { categoryId: 'cat-rent', period, planned: usd(1400), actual: usd(1400), remaining: usd(0) },
      { categoryId: 'cat-food', period, planned: usd(500), actual: usd(412), remaining: usd(88) },
      { categoryId: 'cat-tools', period, planned: usd(200), actual: usd(118), remaining: usd(82) },
      { categoryId: 'cat-fun', period, planned: usd(250), actual: usd(190), remaining: usd(60) },
    ],
    netWorth: Array.from({ length: 12 }, (_, i) => {
      const net = 52000 + i * 1450 + (i % 3) * 180
      return { date: dateOnly(now, (i - 11) * 30), assets: usd(net + 700), liabilities: usd(-700), net: usd(net) }
    }),
    upcomingBills: [
      { id: 'bill-rent', payee: 'Landlord', dueDate: dateOnly(now, 4), expected: usd(1400), isPaid: false, origin: 'declared', autopay: true },
      { id: 'bill-tax', payee: 'Tax authority (Q3 estimate)', dueDate: dateOnly(now, 9), expected: usd(1850), isPaid: false, origin: 'manual', autopay: false },
      { id: 'bill-host', payee: 'Cloud Host', dueDate: dateOnly(now, 20), expected: usd(12), isPaid: false, origin: 'detected', autopay: true },
    ],
  }
}
