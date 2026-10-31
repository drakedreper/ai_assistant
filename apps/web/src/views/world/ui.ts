import type { NewsItem } from '@ai-assistant/shared'
import { create } from 'zustand'

/**
 * View-local UI state for the World screen (module-level, so it survives leaving and coming back).
 * News itself always comes from the snapshot.
 */
export type TopicFilter = 'all' | NewsItem['topic']
export type NewsSort = 'foryou' | 'newest'

interface WorldUi {
  topic: TopicFilter
  setTopic: (t: TopicFilter) => void
  sort: NewsSort
  setSort: (s: NewsSort) => void
  /** Show only the stories behind one of Mira's signals. */
  signalId: string | null
  setSignal: (id: string | null) => void
}

export const useWorld = create<WorldUi>((set) => ({
  topic: 'all',
  setTopic: (topic) => set({ topic }),
  sort: 'foryou',
  setSort: (sort) => set({ sort }),
  signalId: null,
  setSignal: (signalId) => set((s) => ({ signalId: s.signalId === signalId ? null : signalId })),
}))
