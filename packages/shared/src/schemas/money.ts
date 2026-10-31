import { z } from 'zod'
import { NoteRef } from './assistant'
import { Id, IsoDate, IsoDateTime, Money } from './common'

/** Finance contract v0.1. READ-ONLY: no money movement, no write methods. Atlas maps onto this later. */
export const Account = z.object({
  id: Id,
  name: z.string(),
  kind: z.enum(['checking', 'savings', 'credit', 'loan', 'investment', 'cash', 'other']),
  currency: z.string().length(3),
  institution: z.string().optional(),
  isLiability: z.boolean(),
  archived: z.boolean().default(false),
})
export type Account = z.infer<typeof Account>

export const BalanceSnapshot = z.object({
  accountId: Id,
  asOf: IsoDateTime,
  current: Money,
  available: Money.optional(),
  /** Balance about 30 days earlier, for the per-account change chip. */
  previous: Money.optional(),
})
export type BalanceSnapshot = z.infer<typeof BalanceSnapshot>

export const Category = z.object({
  id: Id,
  name: z.string(),
  parentId: Id.optional(),
  kind: z.enum(['income', 'expense', 'transfer']),
  /** Fixed cost (rent, insurance): the budget bar reads "paid" instead of "used". */
  fixed: z.boolean().optional(),
})
export type Category = z.infer<typeof Category>

export const Txn = z.object({
  id: Id,
  accountId: Id,
  postedAt: IsoDateTime,
  amount: Money,
  status: z.enum(['pending', 'posted']),
  merchant: z.string().optional(),
  description: z.string(),
  categoryId: Id.optional(),
  tags: z.array(z.string()).default([]),
})
export type Txn = z.infer<typeof Txn>

export const BudgetLine = z.object({
  categoryId: Id,
  period: z.string().regex(/^\d{4}-\d{2}$/),
  planned: Money,
  actual: Money,
  remaining: Money,
})
export type BudgetLine = z.infer<typeof BudgetLine>

export const NetWorthPoint = z.object({
  date: IsoDate,
  assets: Money,
  liabilities: Money,
  net: Money,
})
export type NetWorthPoint = z.infer<typeof NetWorthPoint>

export const Bill = z.object({
  id: Id,
  payee: z.string(),
  dueDate: IsoDate,
  expected: Money,
  isPaid: z.boolean(),
  origin: z.enum(['declared', 'detected', 'manual']),
  autopay: z.boolean().default(false),
})
export type Bill = z.infer<typeof Bill>

/** One month of cash flow. Expenses are signed (negative = outflow), income positive. */
export const CashFlowPoint = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/),
  income: Money,
  expenses: Money,
})
export type CashFlowPoint = z.infer<typeof CashFlowPoint>

/** The strategy-note-backed independence plan (runway, target and projection). Aggregates only. */
export const FinancialIndependence = z.object({
  /** Vault note that owns the plan; the card cites it. */
  notePath: z.string(),
  targetRunwayMonths: z.number(),
  runwayMonths: z.number(),
  monthlyBurn: Money,
  /** 0..1 share of income that is saved. */
  savingsRate: z.number().min(0).max(1),
  targetDate: IsoDate,
  projectedDate: IsoDate,
  /** How runway is counted, in plain words. */
  basis: z.string(),
})
export type FinancialIndependence = z.infer<typeof FinancialIndependence>

/** Mira's short read of the numbers; it must cite the notes it leans on. */
export const FinanceInsight = z.object({
  body: z.string(),
  cites: z.array(NoteRef).min(1),
})
export type FinanceInsight = z.infer<typeof FinanceInsight>

/** Everything the Money screen shows. Aggregates by default; raw transactions on demand. */
export const FinanceSnapshot = z.object({
  connected: z.boolean(),
  contractVersion: z.literal('0.1'),
  accounts: z.array(Account),
  balances: z.array(BalanceSnapshot),
  categories: z.array(Category),
  recentTransactions: z.array(Txn),
  budget: z.array(BudgetLine),
  netWorth: z.array(NetWorthPoint),
  upcomingBills: z.array(Bill),
  /** Last 6 months, oldest first. */
  cashFlow: z.array(CashFlowPoint).optional(),
  independence: FinancialIndependence.optional(),
  insight: FinanceInsight.optional(),
})
export type FinanceSnapshot = z.infer<typeof FinanceSnapshot>
