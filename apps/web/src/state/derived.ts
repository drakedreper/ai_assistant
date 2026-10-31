import type { CostDay, Session } from '@ai-assistant/shared'
import { useMemo } from 'react'
import { useSnap } from './store'

export interface CostTotals {
  byProject: Record<string, number>
  byModel: Record<string, number>
}

/** Sum of session costs, by project and model. */
export function sessionCostTotals(sessions: Session[]): CostTotals {
  const byProject: Record<string, number> = {}
  const byModel: Record<string, number> = {}
  for (const s of sessions) {
    byProject[s.projectId] = (byProject[s.projectId] ?? 0) + s.costUsd
    byModel[s.model] = (byModel[s.model] ?? 0) + s.costUsd
  }
  return { byProject, byModel }
}

/** Session totals captured once at startup; live growth since then is added to today's CostDay. */
let baseline: CostTotals | null = null

/**
 * The CostDays with today's row nudged by how much live sessions have cost since the app started, so every
 * number that shows "cost today" (top bar, Work header, charts) ticks up together and always agrees.
 * All figures are API-equivalent estimates, never a bill.
 */
export function useCostDays(): CostDay[] {
  const sessions = useSnap((d) => d.sessions)
  const costDays = useSnap((d) => d.costDays)
  return useMemo(() => {
    const cur = sessionCostTotals(sessions)
    baseline ??= cur
    const base = baseline
    const last = costDays[costDays.length - 1]
    if (!last) return costDays
    const bump = (rec: Record<string, number>, now: Record<string, number>, was: Record<string, number>) => {
      const out = { ...rec }
      for (const [k, v] of Object.entries(now)) {
        const delta = v - (was[k] ?? v)
        if (delta > 0.0001) out[k] = +((out[k] ?? 0) + delta).toFixed(2)
      }
      return out
    }
    return [
      ...costDays.slice(0, -1),
      { ...last, byProject: bump(last.byProject, cur.byProject, base.byProject), byModel: bump(last.byModel, cur.byModel, base.byModel) },
    ]
  }, [sessions, costDays])
}

/** Today's total (API-equivalent estimate), live. */
export function useCostToday(): number {
  const days = useCostDays()
  const last = days[days.length - 1]
  return last ? Object.values(last.byProject).reduce((a, b) => a + b, 0) : 0
}
