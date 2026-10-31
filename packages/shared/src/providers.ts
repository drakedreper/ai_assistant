/**
 * Provider contracts. Every integration sits behind one of these. Each has a Mock (used by the mockup
 * and by tests) and, later, real implementations (Google, Atlas, RSS...). The UI reads only from the
 * daemon's normalised cache; the assistant reaches the same data through narrow MCP tools (see tools.ts).
 *
 * Rules: read-only by default; no money movement; typed errors; never leak provider-specific shapes
 * outside the adapter (anti-corruption layer).
 */
import type {
  Account,
  BalanceSnapshot,
  Bill,
  BudgetLine,
  CalendarEvent,
  Category,
  Contact,
  MailThread,
  NetWorthPoint,
  NewsItem,
  Txn,
  WeatherNow,
} from './index'

export type ProviderError =
  | { kind: 'Unauthorized' }
  | { kind: 'RateLimited'; retryAfterSec: number }
  | { kind: 'NotSupported'; capability: string }
  | { kind: 'Stale'; asOf: string }

export interface DateRange {
  from: string
  to: string
}

export interface FinanceCapabilities {
  transactions: boolean
  budgets: boolean
  bills: boolean
  netWorthHistory: boolean
  investments: boolean
  realtimeEvents: boolean
}

/** Finance contract v0.1 (read-only). Atlas, a mock, or Actual/Firefly can all implement it. */
export interface FinanceProvider {
  readonly contractVersion: '0.1'
  capabilities(): FinanceCapabilities
  listAccounts(): Promise<Account[]>
  getBalances(asOf?: string): Promise<BalanceSnapshot[]>
  /** Cursor-based sync (Plaid-style). Pull every page until hasMore is false. */
  syncTransactions(
    cursor?: string,
    opts?: { accountIds?: string[]; since?: string },
  ): Promise<{ added: Txn[]; modified: Txn[]; removedIds: string[]; nextCursor: string; hasMore: boolean }>
  listCategories(): Promise<Category[]>
  getBudget(period: string): Promise<BudgetLine[]>
  getNetWorth(range: DateRange & { step: 'day' | 'week' | 'month' }, baseCurrency?: string): Promise<NetWorthPoint[]>
  listUpcomingBills(horizonDays: number): Promise<Bill[]>
}

export interface CalendarProvider {
  listEvents(range: DateRange): Promise<CalendarEvent[]>
}

export interface MailProvider {
  listThreads(opts?: { query?: string; limit?: number }): Promise<MailThread[]>
  /** Creates a DRAFT only. Sending is a separate T4 action that always needs an approval. */
  createDraft(threadId: string, body: string): Promise<{ draftId: string }>
}

export interface ContactsProvider {
  list(): Promise<Contact[]>
  find(query: string): Promise<Contact[]>
}

export interface NewsProvider {
  latest(opts?: { topics?: string[]; limit?: number }): Promise<NewsItem[]>
}

export interface WeatherProvider {
  now(location: string): Promise<WeatherNow>
}
