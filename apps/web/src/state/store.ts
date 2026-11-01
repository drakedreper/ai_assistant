import type {
  AssistantState,
  ConnectionState,
  AvatarEvent,
  Emotion,
  ServerEvent,
  Session,
  Snapshot,
} from '@ai-assistant/shared'
import { create } from 'zustand'
import { api, apiMode, apiReady } from '../api'
import { startStageFeed } from '../stage/feed'
import type { View } from '../lib/areas'

export type RoomMode = 'mini' | 'quarter' | 'half' | 'full'
export type Preset = 'briefing' | 'deepwork' | 'companion'
export type DayOverride = 'auto' | 'day' | 'night'

/** Deep-link parameters passed with navigate(); a view reads them once and calls clearParams(). */
export interface ViewParams {
  note?: string
  tab?: string
  session?: string
  approval?: string
  proposal?: string
  task?: string
  thread?: string
  mail?: string
}

export interface AppState {
  ready: boolean
  data: Snapshot | null
  /** Link to whatever serves the data (the daemon). The fixture client is always online. */
  connection: ConnectionState
  /** Ticks every 30 s so relative times and day/night stay fresh. */
  now: Date

  view: View
  viewParams: ViewParams
  roomMode: RoomMode
  preset: Preset
  paletteOpen: boolean

  // ---- avatar / presence ----
  /** Explicit avatar pose from events (listening/thinking/speaking). Derived states: see effectiveState(). */
  assistantState: AssistantState
  emotion: Emotion
  emotionIntensity: number
  /** Last thing she said aloud and a counter so the Room can retrigger on identical text. */
  speech: { text: string; seq: number } | null
  lookAt: Extract<AvatarEvent, { type: 'lookAt' }>['target']
  asleep: boolean
  dayOverride: DayOverride
  micOn: boolean
  /** True while a streamed reply is in flight. */
  streaming: boolean

  // ---- actions ----
  init: () => Promise<void>
  navigate: (view: View, params?: ViewParams) => void
  clearParams: () => void
  setRoomMode: (m: RoomMode) => void
  applyPreset: (p: Preset) => void
  setDayOverride: (d: DayOverride) => void
  setAsleep: (a: boolean) => void
  setMic: (on: boolean) => void
  setPalette: (open: boolean) => void
  applyEvent: (e: ServerEvent) => void
  send: (text: string, modality?: 'text' | 'voice') => Promise<void>
}

let emotionTimer: ReturnType<typeof setTimeout> | undefined
let initPromise: Promise<void> | undefined

function isQuietNow(now: Date, quiet: { from: string; to: string }): boolean {
  const toMin = (s: string) => {
    const [h = '0', m = '0'] = s.split(':')
    return Number(h) * 60 + Number(m)
  }
  const cur = now.getHours() * 60 + now.getMinutes()
  const from = toMin(quiet.from)
  const to = toMin(quiet.to)
  return from > to ? cur >= from || cur < to : cur >= from && cur < to
}

function upsertById<T extends { id: string }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id)
  if (i === -1) return [...list, item]
  const next = list.slice()
  next[i] = item
  return next
}

export const useStore = create<AppState>((set, get) => ({
  ready: false,
  data: null,
  connection: 'online',
  now: new Date(),

  view: 'today',
  viewParams: {},
  roomMode: 'quarter',
  preset: 'briefing',
  paletteOpen: false,

  assistantState: 'idle',
  emotion: 'neutral',
  emotionIntensity: 0,
  speech: null,
  lookAt: 'user',
  asleep: false,
  dayOverride: 'auto',
  micOn: false,
  streaming: false,

  // One shared promise: React StrictMode (dev) calls init twice, and a second subscription would apply every event twice.
  init: () => (initPromise ??= (async () => {
    // The backend (mockup or daemon) is chosen and verified first; only then is there anything to read.
    await apiReady
    const data = await api.getSnapshot()
    set({
      data,
      ready: true,
      now: new Date(data.now),
      asleep: isQuietNow(new Date(), data.settings.persona.quietHours),
    })
    api.subscribe((e) => get().applyEvent(e))
    api.onConnection?.((connection) => set({ connection }))
    // The stage backend's live feed (daemon mode only): the Stage tab's state and the draft Room's mood, gaze and sleep.
    if (apiMode() === 'daemon') startStageFeed({ initial: () => get().data?.stage, applyRoom: (patch) => set(patch) })
    // Keep "now" (and everything relative to it) fresh.
    setInterval(() => set({ now: new Date() }), 30_000)
  })()),

  navigate: (view, params = {}) => set({ view, viewParams: params }),
  clearParams: () => set({ viewParams: {} }),

  setRoomMode: (roomMode) => set({ roomMode }),
  applyPreset: (preset) => {
    // Presets arrange the whole screen: how big she is, and what is on stage.
    const arrangement: Record<Preset, { roomMode: RoomMode; view: View }> = {
      briefing: { roomMode: 'quarter', view: 'today' },
      deepwork: { roomMode: 'mini', view: 'work' },
      companion: { roomMode: 'half', view: 'today' },
    }
    set({ preset, ...arrangement[preset], viewParams: {} })
  },
  setDayOverride: (dayOverride) => set({ dayOverride }),
  setAsleep: (asleep) => set({ asleep }),
  setMic: (micOn) => set({ micOn, assistantState: micOn ? 'listening' : 'idle' }),
  setPalette: (paletteOpen) => set({ paletteOpen }),

  send: async (text, modality = 'text') => {
    if (get().asleep) set({ asleep: false })
    set({ streaming: true, assistantState: 'thinking' })
    await api.sendChat(text, modality)
  },

  applyEvent: (e) =>
    set((s) => {
      if (!s.data) return s
      const d = s.data
      switch (e.type) {
        case 'chat.message':
          return { data: { ...d, chat: upsertById(d.chat, e.message) } }
        case 'chat.delta':
          return {
            data: {
              ...d,
              chat: d.chat.map((m) => {
                if (m.id !== e.messageId) return m
                const parts = m.parts.slice()
                for (let i = parts.length - 1; i >= 0; i--) {
                  const p = parts[i]
                  if (p && p.type === 'text') {
                    parts[i] = { ...p, text: p.text + e.text }
                    break
                  }
                }
                return { ...m, parts }
              }),
            },
          }
        case 'chat.done':
          return { streaming: false }
        case 'avatar': {
          const ev = e.event
          if (ev.type === 'pose') return { assistantState: ev.state }
          if (ev.type === 'lookAt') return { lookAt: ev.target }
          if (ev.type === 'speak') return { speech: { text: ev.text, seq: (s.speech?.seq ?? 0) + 1 } }
          // expression: apply, then relax back to neutral after a few seconds
          clearTimeout(emotionTimer)
          emotionTimer = setTimeout(() => set({ emotion: 'neutral', emotionIntensity: 0 }), 4500)
          return { emotion: ev.emotion, emotionIntensity: ev.intensity }
        }
        case 'session.update':
          return { data: { ...d, sessions: upsertById(d.sessions, e.session) } }
        case 'agent.event':
          return { data: { ...d, events: [e.event, ...d.events].slice(0, 200) } }
        case 'approval.new':
          return { data: { ...d, approvals: upsertById(d.approvals, e.approval) } }
        case 'approval.resolved':
          return {
            data: {
              ...d,
              approvals: d.approvals.map((a) => {
                if (a.id !== e.id) return a
                // A card that held private text (what she wanted to remember) keeps no copy once it is decided, like the daemon's.
                const { preview: _gone, ...rest } = a
                return a.sensitive ? { ...rest, status: e.status } : { ...a, status: e.status }
              }),
            },
          }
        case 'task.update':
          return { data: { ...d, tasks: upsertById(d.tasks, e.task) } }
        case 'task.removed':
          return { data: { ...d, tasks: d.tasks.filter((t) => t.id !== e.id) } }
        case 'project.update':
          return { data: { ...d, projects: upsertById(d.projects, e.project) } }
        case 'proposal.update':
          return { data: { ...d, proposals: upsertById(d.proposals, e.proposal) } }
        case 'settings.update':
          return { data: { ...d, settings: e.settings } }
        case 'learned.update':
          return { data: { ...d, learned: e.learned } }
        case 'snapshot.reset':
          return { data: e.snapshot, now: new Date(e.snapshot.now) }
        default:
          return s
      }
    }),
}))

// ---------- selectors (pure; usable inside useStore(...)) ----------

/** Snapshot accessor for views; the app only renders views once `ready` is true. */
export function useSnap<T>(selector: (d: Snapshot) => T): T {
  return useStore((s) => selector(s.data as Snapshot))
}

export const needsYouStatuses: ReadonlyArray<Session['status']> = ['waiting_input', 'blocked_permission']

export function pendingApprovals(d: Snapshot) {
  return d.approvals.filter((a) => a.status === 'pending')
}

function toMinutes(hhmm: string): number {
  const [h = '0', m = '0'] = hhmm.split(':')
  return Number(h) * 60 + Number(m)
}

export function isNightNow(s: Pick<AppState, 'now' | 'dayOverride' | 'data'>): boolean {
  if (s.dayOverride !== 'auto') return s.dayOverride === 'night'
  const w = s.data?.world.weather
  const cur = s.now.getHours() * 60 + s.now.getMinutes()
  const rise = toMinutes(w?.sunrise ?? '07:00')
  const set_ = toMinutes(w?.sunset ?? '19:00')
  return cur < rise || cur >= set_
}

/** What the avatar is actually doing: explicit pose, else asleep, else working while agents run, else idle. */
export function effectiveState(s: Pick<AppState, 'assistantState' | 'asleep' | 'data'>): AssistantState {
  if (s.assistantState !== 'idle') return s.assistantState
  if (s.asleep) return 'sleeping'
  const running = s.data?.sessions.some((x) => x.status === 'running') ?? false
  return running ? 'working' : 'idle'
}
