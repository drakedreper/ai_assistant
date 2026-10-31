/**
 * Daemon-level spend control: a daily budget per lane plus a global daily cap, resetting at LOCAL midnight.
 * Everything here is an API-equivalent ESTIMATE (the SDK's total_cost_usd), not a bill.
 *
 * Pure and synchronous. The clock is injected, so tests move time with a variable instead of timers.
 * Fail closed: a lane that was never configured has no budget, so it may not spend.
 */
import type { BudgetGuard, BudgetStatus, LaneId } from '@ai-assistant/shared'

export interface BudgetGuardOptions {
  lanes: Array<{ lane: LaneId; dailyBudgetUsd: number }>
  globalDailyCapUsd: number
  now?: () => Date
}

/** What a restart can put back: the daemon persists spend, because a restart must not reset the day's budget. */
export interface BudgetRestore {
  lanes?: Partial<Record<LaneId, number>>
  globalUsd?: number
}

export interface BudgetGuardImpl extends BudgetGuard {
  /** Replace limits (Settings changed). Spend is kept. */
  configure(opts: { lanes?: Array<{ lane: LaneId; dailyBudgetUsd: number }>; globalDailyCapUsd?: number }): void
  /** Seed today's spend after a daemon restart. Ignored fields stay as they are. */
  restore(spent: BudgetRestore): void
}

const money = (n: number): string => `$${n.toFixed(2)}`
/** Float noise from repeated additions would leak into the UI; spend is tracked to the millionth of a dollar. */
const round6 = (n: number): number => Math.round(n * 1e6) / 1e6
const finite = (n: number): number => (Number.isFinite(n) && n > 0 ? n : 0)

const dayKey = (d: Date): string => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`

export function createBudgetGuard(opts: BudgetGuardOptions): BudgetGuardImpl {
  const now = opts.now ?? (() => new Date())
  const budgets = new Map<LaneId, number>()
  const spent = new Map<LaneId, number>()
  let globalCap = finite(opts.globalDailyCapUsd)
  let globalSpent = 0
  let day = dayKey(now())

  for (const l of opts.lanes) budgets.set(l.lane, finite(l.dailyBudgetUsd))

  /** Local midnight passed: a new day starts from zero. Called by every entry point, so no timer is needed. */
  const rollover = (): void => {
    const key = dayKey(now())
    if (key === day) return
    day = key
    spent.clear()
    globalSpent = 0
  }

  const laneSpent = (lane: LaneId): number => spent.get(lane) ?? 0

  return {
    check(lane) {
      rollover()
      if (globalSpent >= globalCap) {
        return { ok: false, reason: `The global daily cap of ${money(globalCap)} is used up (${money(round6(globalSpent))} spent). It resets at midnight.` }
      }
      const budget = budgets.get(lane)
      if (budget === undefined) return { ok: false, reason: `No daily budget is configured for the ${lane} lane, so it may not spend anything.` }
      if (laneSpent(lane) >= budget) {
        return { ok: false, reason: `The ${lane} lane's daily budget of ${money(budget)} is used up (${money(round6(laneSpent(lane)))} spent). It resets at midnight.` }
      }
      return { ok: true }
    },

    record(lane, costUsd) {
      rollover()
      const c = finite(costUsd)
      if (c === 0) return
      spent.set(lane, round6(laneSpent(lane) + c))
      globalSpent = round6(globalSpent + c)
    },

    status() {
      rollover()
      const lanes: BudgetStatus[] = [...budgets.entries()].map(([lane, dailyBudgetUsd]) => ({
        lane,
        dailyBudgetUsd,
        spentTodayUsd: round6(laneSpent(lane)),
      }))
      return { lanes, globalDailyCapUsd: globalCap, globalSpentTodayUsd: round6(globalSpent) }
    },

    configure(next) {
      rollover()
      if (next.lanes) {
        budgets.clear()
        for (const l of next.lanes) budgets.set(l.lane, finite(l.dailyBudgetUsd))
      }
      if (next.globalDailyCapUsd !== undefined) globalCap = finite(next.globalDailyCapUsd)
    },

    restore(seed) {
      rollover()
      for (const [lane, usd] of Object.entries(seed.lanes ?? {}) as Array<[LaneId, number]>) spent.set(lane, round6(finite(usd)))
      if (seed.globalUsd !== undefined) globalSpent = round6(finite(seed.globalUsd))
      else if (seed.lanes) globalSpent = round6([...spent.values()].reduce((a, b) => a + b, 0))
    },
  }
}
