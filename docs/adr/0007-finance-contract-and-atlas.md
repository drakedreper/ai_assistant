# ADR 0007: Finance contract and the Atlas adapter

Status: Accepted (contract v0.1, read-only). The Atlas adapter itself is deferred to Phase 4 and its surface is unknown. Date: 2026-10-31.

## Context

The user has a local personal-finance app called "Atlas", with its own database and files, and a beta planned before December (per the fixture story bible). Its API is not final. The assistant should show a Money screen and answer questions about money without ever being able to move it, and without sending more financial detail to the cloud than a question needs.

Research findings ([research/integrations.md](../research/integrations.md)):

- Plaid's `/transactions/sync` is the pattern to copy: cursor-based, returns `added`, `modified`, `removed` (id-only), `next_cursor` and `has_more`; pull every page before stopping. Plaid's amount sign convention could not be verified (from memory positive means money out), so our convention must be stated explicitly.
- Comparable self-hosted finance backends useful as extra providers and contract sanity checks: Actual Budget (MIT, local-first, `@actual-app/api`) and Firefly III (AGPL-3.0, REST, double entry).
- Money is integer minor units plus an ISO 4217 currency, never floats.
- The user's Secondbrain MCP (connected in the research session) has its own "Atlas" knowledge-graph feature, which collides with the finance app's name.

## Decision

1. Define `FinanceProvider` v0.1 (`packages/shared/src/providers.ts`), read-only:
   - `capabilities()` returning `transactions`, `budgets`, `bills`, `netWorthHistory`, `investments`, `realtimeEvents`;
   - `listAccounts()`, `getBalances(asOf?)`, `listCategories()`, `getBudget(period)`, `getNetWorth(range with step day, week or month, baseCurrency?)`, `listUpcomingBills(horizonDays)`;
   - `syncTransactions(cursor?, { accountIds?, since? })` returning `{ added, modified, removedIds, nextCursor, hasMore }`.
2. `Money` is `{ amountMinor: string, currency: string }`: a signed integer in minor units carried as a string so 64-bit values never lose precision. Amounts are signed from the account's perspective: negative is outflow, positive is inflow. This is documented once and applies everywhere, including cash-flow points where expenses are negative.
3. Typed errors: `Unauthorized`, `RateLimited { retryAfterSec }`, `NotSupported { capability }`, `Stale { asOf }`. Pagination everywhere.
4. No money movement and no write methods in v0.x. The `finance_move_money` tool exists only as a locked placeholder with no lane, and the trust ladder shows "Move money" as permanently locked.
5. Anti-corruption layer: provider-specific shapes never leave the adapter. When Atlas stabilises only an `AtlasFinanceProvider` (HTTP, IPC or database mapping) is written.
6. Deliver a `MockFinanceProvider` (seeded generator) and a contract-test suite that every provider (Mock, Atlas, optionally Actual or Firefly) must pass. The mockup's `FinanceSnapshot` has `connected: false` and the Money screen carries a "mock data, Atlas not connected" banner.
7. Privacy defaults ([ADR 0005](0005-privacy-tiers-and-autonomy.md)): the assistant sees aggregates through `finance_summary` (T0); raw transactions through `finance_transactions` (T1) only on demand, behind a redaction layer and a per-call audit entry. Finance data is `sensitive` and carries `data-sensitive` in the UI so Guest mode blurs it.
8. Naming: the UI says "Money (Atlas)" for finance and never uses "Atlas" for graphs. Secondbrain's graph is never called Atlas in our UI.
9. The `FinanceSnapshot` the UI renders also carries aggregates the daemon computes: `cashFlow` (last 6 months), `independence` (runway, savings rate, target and projected dates, backed by a strategy note) and an `insight` that must cite notes.

Differences from the research sketch, all deferred as additive optional fields: an `extensions` bag for unknown provider fields, `authorizedAt`, `transferGroupId` and `source` on transactions, `recurrence` and `accountId` on bills, `rollover` on budget lines, a `breakdown` on net-worth points, and an optional `subscribe` method. The research also proposed a JSON Schema or TypeSpec source of truth; we use zod as the source of truth, per the critic's cut.

## Consequences

- The Money screen, the briefing and the independence plan can be built and tested now on mock data, and the real adapter is a bounded task later.
- The contract-test suite is what keeps Atlas, a mock and any alternative provider interchangeable; it is a Phase 1 seam.
- Cursor semantics are ours to define (how long a cursor stays valid, what `removedIds` means for reorganised data) once Atlas's change tracking is known.
- Open question for the user: Atlas's stack and surface (REST, IPC, a SQLite file, an MCP server), its auth, and which entities exist today (accounts, transactions, budgets, holdings, bills).
- Market data for holdings, when needed, sits behind a separate `MarketDataProvider` (Frankfurter and ECB for FX; equity and crypto free tiers are tight and change often).

## Alternatives considered

| Option | Why not |
|---|---|
| Integrate Atlas directly now | Its API is not final; early coupling would break |
| Adopt Actual Budget or Firefly III as the finance backend | The user has their own app; Firefly is AGPL. Useful only as extra providers and contract checks |
| Floating-point amounts | Rounding errors; integer minor units are the standard |
| OpenAPI, TypeSpec, Prism and MSW generated mocks | Critic cut: pick one mock mechanism (in-app fixtures) and skip codegen |
| Letting the assistant propose payments for approval | Deferred indefinitely; money movement is a hard limit in v0.x |
| Plaid itself | Not applicable to a local app; used only as the sync-pattern precedent |

## Sources

- https://docs.rs/plaid/latest/plaid/model/struct.TransactionsSyncResponse.html
- https://github.com/actualbudget/actual and https://registry.npmjs.org/@actual-app/api/latest
- https://github.com/firefly-iii/firefly-iii
- https://registry.npmjs.org/zod/latest
- https://frankfurter.dev/providers/ecb/ (FX, for the later market-data provider)
- `packages/shared/src/fixtures/STORY.md` (Atlas story and naming rule)
