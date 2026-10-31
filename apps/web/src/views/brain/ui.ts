import { create } from 'zustand'
import type { LayerKey } from './lib/layers'

/**
 * View-local UI state for the Brain screen. It lives in a module-level store (not component state) because the shell
 * re-mounts a view whenever you leave and come back; the open note, history, filters and folder state should survive.
 * Nothing here is domain data: the snapshot in the main store stays the source of truth.
 */

export type BrainTab = 'notes' | 'graph' | 'proposals' | 'memory'

export const DEFAULT_NOTE = '10-strategy/q4-positioning.md'

/** Folders that start collapsed. Everything else is open. */
const COLLAPSED_DEFAULT: Record<string, boolean> = {
  '20-journal': true,
  '40-projects': true,
}

export interface DecisionNote {
  id: string
  status: 'approved' | 'rejected'
  title: string
  /** Target note path. */
  path: string
  at: number
  /** The proposal also had an item in Today's Needs-you queue, which the decision resolved. */
  alsoToday?: boolean
  /** The confirmation line was closed; the time stays for the history list. */
  dismissed?: boolean
}

interface BrainUi {
  tab: BrainTab
  setTab: (t: BrainTab) => void

  // ---- notes
  /** Currently open note path. */
  path: string
  history: string[]
  cursor: number
  open: (path: string, opts?: { heading?: string; push?: boolean }) => void
  back: () => void
  forward: () => void
  /** Heading to scroll to once the note has rendered. */
  heading: string | null
  clearHeading: () => void
  source: boolean
  setSource: (on: boolean) => void
  propsOpen: boolean
  setPropsOpen: (on: boolean) => void
  query: string
  setQuery: (q: string) => void
  collapsed: Record<string, boolean>
  toggleFolder: (key: string) => void
  expand: (keys: string[]) => void

  // ---- graph
  hiddenLayers: LayerKey[]
  toggleLayer: (k: LayerKey) => void
  graphSel: string | null
  selectGraph: (p: string | null) => void

  // ---- proposals
  flashProposal: string | null
  setFlashProposal: (id: string | null) => void
  /** Local record of decisions made in this session (for the confirmation line and "just now" times). */
  decisions: Record<string, DecisionNote>
  recordDecision: (d: DecisionNote) => void
  dismissDecision: (id: string) => void
}

export const useBrain = create<BrainUi>((set, get) => ({
  tab: 'notes',
  setTab: (tab) => set({ tab }),

  path: DEFAULT_NOTE,
  history: [DEFAULT_NOTE],
  cursor: 0,
  open: (path, opts = {}) => {
    const { history, cursor, path: cur } = get()
    const push = opts.push ?? true
    if (push && path !== cur) {
      const next = [...history.slice(0, cursor + 1), path]
      set({ path, history: next, cursor: next.length - 1, heading: opts.heading ?? null, query: '', source: false })
    } else {
      set({ path, heading: opts.heading ?? null, query: '', source: false })
    }
  },
  back: () => {
    const { history, cursor } = get()
    if (cursor <= 0) return
    const c = cursor - 1
    set({ cursor: c, path: history[c] ?? get().path, heading: null, query: '', source: false })
  },
  forward: () => {
    const { history, cursor } = get()
    if (cursor >= history.length - 1) return
    const c = cursor + 1
    set({ cursor: c, path: history[c] ?? get().path, heading: null, query: '', source: false })
  },
  heading: null,
  clearHeading: () => set({ heading: null }),
  source: false,
  setSource: (source) => set({ source }),
  propsOpen: typeof window === 'undefined' ? true : window.innerWidth >= 1500,
  setPropsOpen: (propsOpen) => set({ propsOpen }),
  query: '',
  setQuery: (query) => set({ query }),
  collapsed: COLLAPSED_DEFAULT,
  toggleFolder: (key) => set((s) => ({ collapsed: { ...s.collapsed, [key]: !s.collapsed[key] } })),
  expand: (keys) =>
    set((s) => {
      if (!keys.some((k) => s.collapsed[k])) return s
      const next = { ...s.collapsed }
      for (const k of keys) next[k] = false
      return { collapsed: next }
    }),

  hiddenLayers: [],
  toggleLayer: (k) => set((s) => ({ hiddenLayers: s.hiddenLayers.includes(k) ? s.hiddenLayers.filter((x) => x !== k) : [...s.hiddenLayers, k] })),
  graphSel: null,
  selectGraph: (graphSel) => set({ graphSel }),

  flashProposal: null,
  setFlashProposal: (flashProposal) => set({ flashProposal }),
  decisions: {},
  recordDecision: (d) => set((s) => ({ decisions: { ...s.decisions, [d.id]: d } })),
  dismissDecision: (id) =>
    set((s) => {
      const cur = s.decisions[id]
      return cur ? { decisions: { ...s.decisions, [id]: { ...cur, dismissed: true } } } : s
    }),
}))
