import { z } from 'zod'
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
})
export type BalanceSnapshot = z.infer<typeof BalanceSnapshot>

export const Category = z.object({
  id: Id,
  name: z.string(),
  parentId: Id.optional(),
  kind: z.enum(['income', 'expense', 'transfer']),
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
})
export type FinanceSnapshot = z.infer<typeof FinanceSnapshot>
