import type { FinanceSnapshot } from '../index'
import { ago, dateOnly, usd } from './time'

/** "YYYY-MM" of the month `offset` months from `now` (negative = past). */
function monthKey(now: Date, offset: number): string {
  const d = new Date(now.getFullYear(), now.getMonth() + offset, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)

/**
 * Finance mock behind the read-only FinanceProvider v0.1 contract. Atlas is NOT connected, so the screen
 * shows a mock banner. Everything is derived from a few hand-set numbers so that balances, the net-worth
 * tail, runway and the budget totals always agree with each other.
 */
export function buildFinance(now: Date): FinanceSnapshot {
  const period = dateOnly(now).slice(0, 7)

  // ---- accounts: current and ~30 days earlier (dollars) ----
  const acc = {
    check: { cur: 3846.2, prev: 4102.4 },
    save: { cur: 16400, prev: 15900 },
    tax: { cur: 3200, prev: 2950 },
    invest: { cur: 18014.35, prev: 17420.1 },
    retire: { cur: 22640, prev: 21880 },
    card: { cur: -1284.3, prev: -1102.15 },
    loan: { cur: -2400, prev: -2595 },
  }
  const assetsNow = sum([acc.check.cur, acc.save.cur, acc.tax.cur, acc.invest.cur, acc.retire.cur])
  const assetsPrev = sum([acc.check.prev, acc.save.prev, acc.tax.prev, acc.invest.prev, acc.retire.prev])
  const liabNow = Math.abs(acc.card.cur + acc.loan.cur)
  const liabPrev = Math.abs(acc.card.prev + acc.loan.prev)

  // ---- 12 monthly net-worth points, 30 days apart; the last two come from the balances above ----
  const earlierAssets = [50660, 51840, 52600, 53070, 55010, 56060, 57000, 56300, 58140, 60020]
  const earlierLiab = [5829, 5634, 5439, 5244, 5049, 4854, 4659, 4464, 4269, 4074]
  const assets = [...earlierAssets, assetsPrev, assetsNow]
  const liab = [...earlierLiab, liabPrev, liabNow]

  // ---- cash flow, oldest first (dollars) ----
  const income = [3600, 4150, 3200, 4800, 3900, 4250]
  const spend = [2580, 2710, 2490, 3040, 2560, 2640]
  const burn = sum(spend) / spend.length
  const avgIncome = sum(income) / income.length
  const liquid = acc.check.cur + acc.save.cur + acc.invest.cur
  const runway = Math.round((liquid / burn) * 10) / 10

  // "Next June 30" is the plan's target; the projection is two weeks ahead of it.
  const targetYear = now.getMonth() >= 5 ? now.getFullYear() + 1 : now.getFullYear()
  const targetDate = `${targetYear}-06-30`
  const projectedDate = `${targetYear}-06-16`

  return {
    connected: false,
    contractVersion: '0.1',
    accounts: [
      { id: 'acc-check', name: 'Everyday checking', kind: 'checking', currency: 'USD', institution: 'Northwind Bank', isLiability: false, archived: false },
      { id: 'acc-save', name: 'Runway savings', kind: 'savings', currency: 'USD', institution: 'Northwind Bank', isLiability: false, archived: false },
      { id: 'acc-tax', name: 'Tax set-aside', kind: 'savings', currency: 'USD', institution: 'Northwind Bank', isLiability: false, archived: false },
      { id: 'acc-invest', name: 'Index fund', kind: 'investment', currency: 'USD', institution: 'Harbor Brokerage', isLiability: false, archived: false },
      { id: 'acc-retire', name: 'Retirement account', kind: 'investment', currency: 'USD', institution: 'Harbor Brokerage', isLiability: false, archived: false },
      { id: 'acc-card', name: 'Credit card', kind: 'credit', currency: 'USD', institution: 'Northwind Bank', isLiability: true, archived: false },
      { id: 'acc-loan', name: 'Equipment loan', kind: 'loan', currency: 'USD', institution: 'Northwind Bank', isLiability: true, archived: false },
    ],
    balances: [
      { accountId: 'acc-check', asOf: ago(now, 30), current: usd(acc.check.cur), available: usd(acc.check.cur), previous: usd(acc.check.prev) },
      { accountId: 'acc-save', asOf: ago(now, 30), current: usd(acc.save.cur), previous: usd(acc.save.prev) },
      { accountId: 'acc-tax', asOf: ago(now, 30), current: usd(acc.tax.cur), previous: usd(acc.tax.prev) },
      { accountId: 'acc-invest', asOf: ago(now, 30), current: usd(acc.invest.cur), previous: usd(acc.invest.prev) },
      { accountId: 'acc-retire', asOf: ago(now, 30), current: usd(acc.retire.cur), previous: usd(acc.retire.prev) },
      { accountId: 'acc-card', asOf: ago(now, 30), current: usd(acc.card.cur), previous: usd(acc.card.prev) },
      { accountId: 'acc-loan', asOf: ago(now, 30), current: usd(acc.loan.cur), previous: usd(acc.loan.prev) },
    ],
    categories: [
      { id: 'cat-income', name: 'Income', kind: 'income' },
      { id: 'cat-rent', name: 'Rent', kind: 'expense', fixed: true },
      { id: 'cat-food', name: 'Food', kind: 'expense' },
      { id: 'cat-tools', name: 'Tools and cloud', kind: 'expense' },
      { id: 'cat-fun', name: 'Fun', kind: 'expense' },
      { id: 'cat-transport', name: 'Transport', kind: 'expense' },
      { id: 'cat-health', name: 'Health', kind: 'expense' },
      { id: 'cat-transfer', name: 'Transfers', kind: 'transfer' },
    ],
    recentTransactions: [
      { id: 'tx-1', accountId: 'acc-check', postedAt: ago(now, 60 * 20), amount: usd(-12), status: 'posted', merchant: 'Cloud Host', description: 'Monthly hosting', categoryId: 'cat-tools', tags: [] },
      { id: 'tx-12', accountId: 'acc-card', postedAt: ago(now, 60 * 26), amount: usd(-23.5), status: 'pending', merchant: 'Corner Cafe', description: 'Coffee and a sandwich', categoryId: 'cat-food', tags: [] },
      { id: 'tx-2', accountId: 'acc-card', postedAt: ago(now, 60 * 30), amount: usd(-46.2), status: 'posted', merchant: 'Corner Cafe', description: 'Lunch', categoryId: 'cat-food', tags: [] },
      { id: 'tx-3', accountId: 'acc-check', postedAt: ago(now, 60 * 72), amount: usd(3200), status: 'posted', merchant: 'Client payment', description: 'Invoice 0042', categoryId: 'cat-income', tags: ['invoice'] },
      { id: 'tx-4', accountId: 'acc-card', postedAt: ago(now, 60 * 78), amount: usd(-64.85), status: 'posted', merchant: 'Greenleaf Market', description: 'Groceries', categoryId: 'cat-food', tags: [] },
      { id: 'tx-10', accountId: 'acc-check', postedAt: ago(now, 60 * 96), amount: usd(-250), status: 'posted', merchant: 'Harbor Brokerage', description: 'Monthly index fund buy', categoryId: 'cat-transfer', tags: ['auto'] },
      { id: 'tx-11', accountId: 'acc-invest', postedAt: ago(now, 60 * 96), amount: usd(250), status: 'posted', merchant: 'Harbor Brokerage', description: 'Monthly index fund buy', categoryId: 'cat-transfer', tags: ['auto'] },
      { id: 'tx-6', accountId: 'acc-card', postedAt: ago(now, 60 * 110), amount: usd(-18.4), status: 'posted', merchant: 'Northwind Transit', description: 'Transit top-up', categoryId: 'cat-transport', tags: [] },
      { id: 'tx-9', accountId: 'acc-card', postedAt: ago(now, 60 * 128), amount: usd(-84), status: 'posted', merchant: 'Sushi Counter', description: 'Dinner with Leo', categoryId: 'cat-fun', tags: ['friends'] },
      { id: 'tx-8', accountId: 'acc-check', postedAt: ago(now, 60 * 150), amount: usd(-52.6), status: 'posted', merchant: 'Harbour Pharmacy', description: 'Prescription and supplies', categoryId: 'cat-health', tags: [] },
      { id: 'tx-5', accountId: 'acc-check', postedAt: ago(now, 60 * 168), amount: usd(-29), status: 'posted', merchant: 'Fibre Mobile', description: 'Phone plan', categoryId: 'cat-tools', tags: ['recurring'] },
      { id: 'tx-7', accountId: 'acc-card', postedAt: ago(now, 60 * 190), amount: usd(-38), status: 'posted', merchant: 'Book Barn', description: 'Two paperbacks', categoryId: 'cat-fun', tags: [] },
      { id: 'tx-13', accountId: 'acc-check', postedAt: ago(now, 60 * 214), amount: usd(-36.8), status: 'posted', merchant: 'Nordic Cycle Repairs', description: 'Brake pads', categoryId: 'cat-transport', tags: [] },
      { id: 'tx-14', accountId: 'acc-check', postedAt: ago(now, 60 * 260), amount: usd(450), status: 'posted', merchant: 'Client payment', description: 'Invoice 0041, second part', categoryId: 'cat-income', tags: ['invoice'] },
    ],
    // planned 2,650 / actual 2,424: about 8% under, which is what the independence note says
    budget: [
      { categoryId: 'cat-rent', period, planned: usd(1400), actual: usd(1400), remaining: usd(0) },
      { categoryId: 'cat-food', period, planned: usd(520), actual: usd(438), remaining: usd(82) },
      { categoryId: 'cat-tools', period, planned: usd(220), actual: usd(203), remaining: usd(17) },
      { categoryId: 'cat-fun', period, planned: usd(250), actual: usd(188), remaining: usd(62) },
      { categoryId: 'cat-transport', period, planned: usd(140), actual: usd(61), remaining: usd(79) },
      { categoryId: 'cat-health', period, planned: usd(120), actual: usd(134), remaining: usd(-14) },
    ],
    netWorth: assets.map((a, i) => ({
      date: dateOnly(now, (i - 11) * 30),
      assets: usd(a),
      liabilities: usd(-(liab[i] ?? 0)),
      net: usd(a - (liab[i] ?? 0)),
    })),
    upcomingBills: [
      { id: 'bill-rent', payee: 'Landlord', dueDate: dateOnly(now, 4), expected: usd(1400), isPaid: false, origin: 'declared', autopay: true },
      { id: 'bill-net', payee: 'Fibre internet', dueDate: dateOnly(now, 6), expected: usd(49.9), isPaid: false, origin: 'detected', autopay: false },
      { id: 'bill-tax', payee: 'Tax authority (Q3 estimate)', dueDate: dateOnly(now, 9), expected: usd(1850), isPaid: false, origin: 'manual', autopay: false },
      { id: 'bill-ins', payee: 'Health insurance', dueDate: dateOnly(now, 13), expected: usd(138), isPaid: false, origin: 'declared', autopay: true },
      { id: 'bill-host', payee: 'Cloud Host', dueDate: dateOnly(now, 20), expected: usd(12), isPaid: false, origin: 'detected', autopay: true },
    ],
    cashFlow: income.map((inc, i) => ({
      month: monthKey(now, i - 5),
      income: usd(inc),
      expenses: usd(-(spend[i] ?? 0)),
    })),
    independence: {
      notePath: '10-strategy/financial-independence.md',
      targetRunwayMonths: 18,
      runwayMonths: runway,
      monthlyBurn: usd(Math.round(burn)),
      savingsRate: Math.round(((avgIncome - burn) / avgIncome) * 100) / 100,
      targetDate,
      projectedDate,
      basis: 'Checking, runway savings and the index fund, divided by your average monthly spend over six months. The tax set-aside and retirement account are left out.',
    },
    insight: {
      body:
        'You are about 8% under budget this month, which pulls your independence date forward by roughly two weeks. Tools and cloud is the one line near its limit, and the Q3 tax estimate lands next week; your set-aside covers it, so the runway savings stay untouched. Atlas is mocked here, so treat these as sample numbers until the beta connects.',
      cites: [
        { path: '10-strategy/financial-independence.md', title: 'Financial independence plan' },
        { path: '30-knowledge/envelope-budgeting.md', title: 'Envelope budgeting' },
        { path: '10-strategy/decision-atlas-beta.md', title: 'Decision: Atlas beta' },
      ],
    },
  }
}
