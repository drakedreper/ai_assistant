import { api } from '../api'
import type { StageLive, StageSnapshot } from '@ai-assistant/shared'
import { create } from 'zustand'
import { createDraftStage, type RoomPatch } from './draftStage'
import { describeStageError, stageClient } from './stageClient'

/**
 * The stage state the Settings tab shows: the last StageSnapshot from the daemon plus the live part. It follows the
 * daemon's `stage.live` events (a new `rev` means "refetch GET /api/stage") and a `snapshot.reset`, and it also feeds
 * the draft Room (draftStage.ts). Daemon mode only: in the mockup nothing here ever starts.
 */

interface StageFeedState {
  snapshot: StageSnapshot | null
  live: StageLive | null
  /** The last refresh failed: why, in words. */
  error: string | null
  /** Replace the snapshot (after a mutation answered, or a manual refresh). */
  refresh: () => Promise<void>
}

let started = false
let fetching: Promise<void> | undefined
let again = false

export const useStageFeed = create<StageFeedState>((set) => ({
  snapshot: null,
  live: null,
  error: null,
  refresh: () => {
    // coalesce: one request in flight, one more queued if something changed meanwhile
    if (fetching) {
      again = true
      return fetching
    }
    fetching = stageClient
      .getStage()
      .then((snapshot) => set({ snapshot, error: null }))
      .catch((err: unknown) => set({ error: describeStageError(err) }))
      .finally(() => {
        fetching = undefined
        if (again) {
          again = false
          void useStageFeed.getState().refresh()
        }
      })
    return fetching
  },
}))

export interface StageFeedHooks {
  /** The stage part of the snapshot the app already loaded. */
  initial: () => StageSnapshot | undefined
  /** Set fields of the Room's store (the draft stage). */
  applyRoom: (patch: Partial<RoomPatch>) => void
}

/** Start following the daemon's stage feed (idempotent). Call once, in daemon mode, after the first snapshot. */
export function startStageFeed(hooks: StageFeedHooks): void {
  if (started) return
  started = true
  const draft = createDraftStage(hooks.applyRoom)
  const first = hooks.initial()
  if (first) useStageFeed.setState({ snapshot: first })
  let lastRev = first?.rev ?? -1
  api.subscribe((e) => {
    if (e.type === 'stage.live') {
      useStageFeed.setState({ live: e.live })
      draft.update(e.live)
      if (e.live.rev !== lastRev) {
        lastRev = e.live.rev
        void useStageFeed.getState().refresh()
      }
    } else if (e.type === 'snapshot.reset') {
      const s = e.snapshot.stage
      if (s) {
        lastRev = s.rev ?? lastRev
        useStageFeed.setState({ snapshot: s })
      }
    }
  })
}
