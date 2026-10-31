import type { Contact, MailThread } from '@ai-assistant/shared'
import { create } from 'zustand'
import type { CalKind } from './lib'

/**
 * View-local UI state for the Life screen. It lives in a module-level store because the shell re-mounts a view
 * whenever you leave and come back; the open week, thread, edited drafts and filters should survive that.
 * Nothing here is domain data: approvals and mail in the main store stay the source of truth.
 */

export type LifeTab = 'calendar' | 'inbox' | 'people'
export type MailFilter = 'all' | MailThread['triage']
export type WarmthFilter = 'all' | Contact['warmth']
export type PeopleSort = 'warmth' | 'recent' | 'name'

interface LifeUi {
  tab: LifeTab
  setTab: (t: LifeTab) => void

  // ---- calendar
  /** Weeks from the current Mon-Sun week. */
  weekOffset: number
  setWeekOffset: (n: number) => void
  selectedEvent: string | null
  selectEvent: (id: string | null) => void
  hiddenCals: CalKind[]
  toggleCal: (k: CalKind) => void
  flash: { id: number; text: string } | null
  setFlash: (text: string | null) => void

  // ---- inbox
  mailFilter: MailFilter
  setMailFilter: (f: MailFilter) => void
  selectedMail: string | null
  selectMail: (id: string | null) => void
  /** Threads opened by hand; the snapshot's `unread` flag is a fixture and never changes. */
  readIds: Record<string, true>
  markRead: (id: string) => void
  /** Draft editing state per thread. */
  editing: Record<string, boolean>
  setEditing: (id: string, on: boolean) => void
  drafts: Record<string, string>
  setDraft: (id: string, text: string) => void
  /** When you decided a draft, so "Sent 3 min ago" has a real time. */
  decidedAt: Record<string, number>
  markDecided: (id: string) => void

  // ---- people
  peopleFilter: WarmthFilter
  setPeopleFilter: (f: WarmthFilter) => void
  peopleSort: PeopleSort
  setPeopleSort: (s: PeopleSort) => void
  snoozed: Record<string, true>
  snooze: (id: string) => void
}

let flashSeq = 0

export const useLife = create<LifeUi>((set) => ({
  tab: 'calendar',
  setTab: (tab) => set({ tab }),

  weekOffset: 0,
  setWeekOffset: (weekOffset) => set({ weekOffset }),
  selectedEvent: null,
  selectEvent: (selectedEvent) => set({ selectedEvent }),
  hiddenCals: [],
  toggleCal: (k) => set((s) => ({ hiddenCals: s.hiddenCals.includes(k) ? s.hiddenCals.filter((x) => x !== k) : [...s.hiddenCals, k] })),
  flash: null,
  setFlash: (text) => set({ flash: text ? { id: ++flashSeq, text } : null }),

  mailFilter: 'all',
  setMailFilter: (mailFilter) => set({ mailFilter }),
  selectedMail: null,
  selectMail: (selectedMail) => set({ selectedMail }),
  readIds: {},
  markRead: (id) => set((s) => (s.readIds[id] ? s : { readIds: { ...s.readIds, [id]: true } })),
  editing: {},
  setEditing: (id, on) => set((s) => ({ editing: { ...s.editing, [id]: on } })),
  drafts: {},
  setDraft: (id, text) => set((s) => ({ drafts: { ...s.drafts, [id]: text } })),
  decidedAt: {},
  markDecided: (id) => set((s) => ({ decidedAt: { ...s.decidedAt, [id]: Date.now() } })),

  peopleFilter: 'all',
  setPeopleFilter: (peopleFilter) => set({ peopleFilter }),
  peopleSort: 'warmth',
  setPeopleSort: (peopleSort) => set({ peopleSort }),
  snoozed: {},
  snooze: (id) => set((s) => ({ snoozed: { ...s.snoozed, [id]: true } })),
}))
