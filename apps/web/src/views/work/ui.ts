import type { TaskColumn } from '@ai-assistant/shared'
import { create } from 'zustand'

/**
 * View-local UI state for the Work screen. It lives in a module-level store (not component state) because the
 * shell re-mounts a view whenever you leave and come back, and the selected session, filters and board order
 * should survive that. Nothing here is domain data: the snapshot in the main store stays the source of truth.
 */

export type WorkTab = 'overview' | 'board' | 'cost' | 'approvals'
export type StatusFilter = 'all' | 'needs' | 'running' | 'idle' | 'done' | 'error'

export interface Toast {
  id: number
  text: string
  tone: 'ok' | 'info' | 'warn'
}

interface WorkUi {
  tab: WorkTab
  setTab: (t: WorkTab) => void

  /** null = follow the first visible session. */
  sessionId: string | null
  selectSession: (id: string | null) => void

  projectFilter: string[]
  toggleProject: (id: string) => void
  clearProjects: () => void
  statusFilter: StatusFilter
  setStatusFilter: (f: StatusFilter) => void
  query: string
  setQuery: (q: string) => void

  /** Replies typed into a waiting session (local only in the mockup). */
  replies: Record<string, string>
  sendReply: (sessionId: string, text: string) => void

  /** Session-to-card links made in the UI (the schema has no link call yet). */
  extraLinks: Record<string, string[]>
  linkSession: (taskId: string, sessionId: string) => void

  /** Visual order of cards on the board (ids). Columns come from the snapshot. */
  taskOrder: string[]
  setTaskOrder: (ids: string[]) => void
  /** Optimistic column while a move is in flight. */
  moveOverride: Record<string, TaskColumn>
  setOverride: (taskId: string, col: TaskColumn | null) => void

  includeAllAreas: boolean
  setIncludeAllAreas: (v: boolean) => void

  /** Deep-link highlight; cleared automatically. */
  highlight: { approval?: string; task?: string }
  flash: (h: { approval?: string; task?: string }) => void

  toasts: Toast[]
  toast: (text: string, tone?: Toast['tone']) => void
  dismissToast: (id: number) => void
}

let toastSeq = 0
let flashTimer: ReturnType<typeof setTimeout> | undefined

export const useWork = create<WorkUi>((set, get) => ({
  tab: 'overview',
  setTab: (tab) => set({ tab }),

  sessionId: null,
  selectSession: (sessionId) => set({ sessionId }),

  projectFilter: [],
  toggleProject: (id) =>
    set((s) => ({ projectFilter: s.projectFilter.includes(id) ? s.projectFilter.filter((p) => p !== id) : [...s.projectFilter, id] })),
  clearProjects: () => set({ projectFilter: [] }),
  statusFilter: 'all',
  setStatusFilter: (statusFilter) => set({ statusFilter }),
  query: '',
  setQuery: (query) => set({ query }),

  replies: {},
  sendReply: (sessionId, text) => {
    set((s) => ({ replies: { ...s.replies, [sessionId]: text } }))
    get().toast('Reply queued for the session (mock: no daemon connected).', 'ok')
  },

  extraLinks: {},
  linkSession: (taskId, sessionId) =>
    set((s) => {
      const cur = s.extraLinks[taskId] ?? []
      return cur.includes(sessionId) ? s : { extraLinks: { ...s.extraLinks, [taskId]: [...cur, sessionId] } }
    }),

  taskOrder: [],
  setTaskOrder: (taskOrder) => set({ taskOrder }),
  moveOverride: {},
  setOverride: (taskId, col) =>
    set((s) => {
      const next = { ...s.moveOverride }
      if (col) next[taskId] = col
      else delete next[taskId]
      return { moveOverride: next }
    }),

  includeAllAreas: false,
  setIncludeAllAreas: (includeAllAreas) => set({ includeAllAreas }),

  highlight: {},
  flash: (highlight) => {
    set({ highlight })
    clearTimeout(flashTimer)
    flashTimer = setTimeout(() => set({ highlight: {} }), 3200)
  },

  toasts: [],
  toast: (text, tone = 'info') => {
    const id = ++toastSeq
    set((s) => ({ toasts: [...s.toasts.slice(-2), { id, text, tone }] }))
    setTimeout(() => get().dismissToast(id), 4200)
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}))
