import type { BudgetGuard, ChatMessage, LaneId, LaneStore } from '@ai-assistant/shared'
import { dateOnly } from '@ai-assistant/shared/fixtures'
import type { IdGen } from '../ids'
import type { Store } from './store'

const sessionKey = (lane: LaneId) => `lane.${lane}.backendSessionId`

export interface LaneStoreOptions {
  now: () => Date
  newId: IdGen
  /** Called when the lane reports its backend session id, so the hook receiver can stop projecting that session. */
  onOwnedSession?: (sessionId: string, lane: LaneId) => void
}

/** The LaneStore seam from shared/agent.ts on top of SQLite. The lane never touches a database itself. */
export function createLaneStore(store: Store, opts: LaneStoreOptions): LaneStore {
  return {
    loadBackendSessionId(lane) {
      const v = store.kvGet<string>(sessionKey(lane))
      return typeof v === 'string' && v.length > 0 ? v : undefined
    },
    saveBackendSessionId(lane, id) {
      store.kvSet(sessionKey(lane), id, opts.now().toISOString())
      store.addLaneSession(id, lane, opts.now().toISOString())
      opts.onOwnedSession?.(id, lane)
    },
    upsertChat(message: ChatMessage) {
      store.upsertChat(message)
    },
    recentChat(limit) {
      return store.recentChat(limit)
    },
    saveApproval(approval) {
      store.upsertApproval(approval, 'lane')
    },
    setApprovalStatus(id, status) {
      store.setApprovalStatus(id, status, opts.now().toISOString())
    },
    audit(entry) {
      store.insertAudit({ ...entry, id: opts.newId('au') })
    },
  }
}

export interface RecordingBudgetOptions {
  now: () => Date
  /** Model id per lane, for the per-model cost split. */
  laneModels: Record<LaneId, string>
}

/**
 * Replays today's persisted spend into a fresh BudgetGuard, so a daemon restart does not reset the daily caps.
 * Call it BEFORE wrapping with createRecordingBudget (otherwise the replay would be recorded twice).
 */
export function hydrateBudget(inner: BudgetGuard, store: Store, now: Date): void {
  const today = dateOnly(now)
  for (const row of store.listUsage(today)) {
    if (row.day === today && row.costUsd > 0 && (row.lane === 'secretary' || row.lane === 'reader' || row.lane === 'voice')) {
      inner.record(row.lane, row.costUsd)
    }
  }
}

/** Decorates a BudgetGuard so every recorded cost is also persisted, which is what costDays are computed from. */
export function createRecordingBudget(inner: BudgetGuard, store: Store, opts: RecordingBudgetOptions): BudgetGuard {
  return {
    check: (lane) => inner.check(lane),
    status: () => inner.status(),
    record(lane, costUsd) {
      inner.record(lane, costUsd)
      if (Number.isFinite(costUsd) && costUsd > 0) {
        store.addUsage(dateOnly(opts.now()), lane, opts.laneModels[lane], costUsd)
      }
    },
  }
}
