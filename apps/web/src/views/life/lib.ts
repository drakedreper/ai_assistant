import type { Approval, CalendarEvent, Contact, MailThread } from '@ai-assistant/shared'
import { Hourglass, Info, Newspaper, Receipt, Reply, type LucideIcon } from 'lucide-react'
import type { Tone } from '../../components/ui'

// ---------------------------------------------------------------- calendar geometry

export const HOUR_START = 7
export const HOUR_END = 20
export const HOUR_PX = 46
export const GRID_MINUTES = (HOUR_END - HOUR_START) * 60

export type CalKind = CalendarEvent['calendar']

/** One hue per calendar type; same dots as the Today agenda. Class strings are literal for Tailwind. */
export const CAL: Record<CalKind, { label: string; dot: string; text: string; block: string; chip: string }> = {
  personal: {
    label: 'Personal',
    dot: 'bg-world',
    text: 'text-world',
    block: 'border-l-[3px] border-l-world bg-world/16 hover:bg-world/24',
    chip: 'border-world/30 bg-world/12 text-world',
  },
  work: {
    label: 'Work',
    dot: 'bg-work',
    text: 'text-work',
    block: 'border-l-[3px] border-l-work bg-work/16 hover:bg-work/24',
    chip: 'border-work/30 bg-work/12 text-work',
  },
  family: {
    label: 'Family',
    dot: 'bg-mira',
    text: 'text-mira',
    block: 'border-l-[3px] border-l-mira bg-mira/16 hover:bg-mira/24',
    chip: 'border-mira/30 bg-mira/12 text-mira',
  },
  focus: {
    label: 'Focus',
    dot: 'bg-brain',
    text: 'text-brain',
    block: 'border-l-[3px] border-l-brain bg-brain/16 hover:bg-brain/24',
    chip: 'border-brain/30 bg-brain/12 text-brain',
  },
}

export const CAL_ORDER: CalKind[] = ['focus', 'work', 'personal', 'family']

// ---------------------------------------------------------------- dates

export const startOfDay = (d: Date): Date => {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}

export const addDays = (d: Date, n: number): Date => {
  const x = new Date(d)
  x.setDate(x.getDate() + n)
  return x
}

export const sameDay = (a: Date, b: Date): boolean =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()

/** Monday 00:00 of the week that contains `d`. */
export const mondayOf = (d: Date): Date => addDays(startOfDay(d), -((d.getDay() + 6) % 7))

export const minutesOfDay = (d: Date): number => d.getHours() * 60 + d.getMinutes()

/** Whole calendar days from a to b (local dates). */
export function dayDiff(a: Date, b: Date): number {
  const ms = startOfDay(b).getTime() - startOfDay(a).getTime()
  return Math.round(ms / 86_400_000)
}

/** Parse "YYYY-MM-DD" as a local date. */
export function parseDate(s: string): Date {
  const [y = '1970', m = '1', d = '1'] = s.split('-')
  return new Date(Number(y), Number(m) - 1, Number(d))
}

export function fmtHM(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function fmtRange(e: Pick<CalendarEvent, 'start' | 'end'>): string {
  return `${fmtHM(new Date(e.start))}–${fmtHM(new Date(e.end))}`
}

export function fmtDuration(mins: number): string {
  if (mins < 60) return `${mins} min`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m ? `${h} h ${m}` : `${h} h`
}

export function fmtHours(mins: number): string {
  const h = mins / 60
  return `${Number.isInteger(h) ? h : h.toFixed(1)} h`
}

export function fmtWeekday(d: Date, style: 'short' | 'long' = 'short'): string {
  return d.toLocaleDateString('en-GB', { weekday: style })
}

export function fmtDayMonth(d: Date): string {
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

/** "today", "tomorrow", "in 5 days", "yesterday", "3 days ago". */
export function relDays(n: number): string {
  if (n === 0) return 'today'
  if (n === 1) return 'tomorrow'
  if (n === -1) return 'yesterday'
  return n > 0 ? `in ${n} days` : `${-n} days ago`
}

/** Name for the day of an event: "today", "tomorrow" or the weekday. */
export function dayWord(d: Date, now: Date): string {
  const n = dayDiff(now, d)
  if (n === 0) return 'today'
  if (n === 1) return 'tomorrow'
  return `on ${fmtWeekday(d, 'long')}`
}

// ---------------------------------------------------------------- events

export type EventState = 'normal' | 'proposed' | 'approved' | 'denied'

/** A proposed event is tentative until its approval is decided; denied ones disappear. */
export function eventState(e: CalendarEvent, approvals: Approval[]): EventState {
  if (!e.approvalId) return 'normal'
  const ap = approvals.find((a) => a.id === e.approvalId)
  if (!ap) return 'normal'
  if (ap.status === 'pending') return 'proposed'
  return ap.status === 'approved' ? 'approved' : 'denied'
}

export interface Placed<T> {
  item: T
  col: number
  cols: number
}

/** Side-by-side columns for overlapping events (classic calendar packing). */
export function layoutColumns<T extends { start: number; end: number }>(items: T[]): Array<Placed<T>> {
  const sorted = items.slice().sort((a, b) => a.start - b.start || b.end - a.end)
  const out: Array<Placed<T>> = []
  let cluster: Array<Placed<T>> = []
  let clusterEnd = -1
  let colEnds: number[] = []

  const flush = () => {
    for (const p of cluster) p.cols = colEnds.length
    out.push(...cluster)
    cluster = []
    colEnds = []
    clusterEnd = -1
  }

  for (const item of sorted) {
    if (cluster.length && item.start >= clusterEnd) flush()
    let col = colEnds.findIndex((end) => end <= item.start)
    if (col === -1) {
      col = colEnds.length
      colEnds.push(item.end)
    } else {
      colEnds[col] = item.end
    }
    cluster.push({ item, col, cols: 1 })
    clusterEnd = Math.max(clusterEnd, item.end)
  }
  if (cluster.length) flush()
  return out
}

/** Short relative phrase for an event: "now", "starts in 3 h", "ended 2 h ago". */
export function eventTiming(e: CalendarEvent, now: Date): { label: string; live: boolean; past: boolean } {
  const s = new Date(e.start)
  const en = new Date(e.end)
  if (e.allDay) return { label: relDays(dayDiff(now, s)), live: false, past: dayDiff(now, s) < 0 }
  if (s <= now && now < en) return { label: 'Happening now', live: true, past: false }
  const mins = Math.round(Math.abs(s.getTime() - now.getTime()) / 60_000)
  const span = mins < 60 ? `${mins} min` : mins < 60 * 24 ? `${Math.round(mins / 60)} h` : `${Math.round(mins / 1440)} d`
  if (s > now) return { label: `Starts in ${span}`, live: false, past: false }
  const endedMins = Math.round((now.getTime() - en.getTime()) / 60_000)
  const endedSpan = endedMins < 60 ? `${endedMins} min` : endedMins < 60 * 24 ? `${Math.round(endedMins / 60)} h` : `${Math.round(endedMins / 1440)} d`
  return { label: `Ended ${endedSpan} ago`, live: false, past: true }
}

// ---------------------------------------------------------------- mail

export const TRIAGE: Record<MailThread['triage'], { label: string; tone: Tone; icon: LucideIcon; hint: string }> = {
  needs_reply: { label: 'Needs reply', tone: 'mira', icon: Reply, hint: 'Someone is waiting for an answer from you' },
  fyi: { label: 'FYI', tone: 'info', icon: Info, hint: 'Nothing to do, good to know' },
  waiting_on: { label: 'Waiting on', tone: 'warn', icon: Hourglass, hint: 'Open loop: a reply or a decision is pending' },
  newsletter: { label: 'Newsletter', tone: 'neutral', icon: Newspaper, hint: 'Digests, summarised in World' },
  receipt: { label: 'Receipt', tone: 'neutral', icon: Receipt, hint: 'Filed, nothing to do' },
}

export const TRIAGE_ORDER: Array<MailThread['triage']> = ['needs_reply', 'fyi', 'waiting_on', 'newsletter', 'receipt']

export type DraftState = 'none' | 'pending' | 'sent' | 'dismissed' | 'unknown'

/** Draft state is derived from the approval, which is the single source of truth. */
export function draftState(m: MailThread, approvals: Approval[]): DraftState {
  if (!m.suggestedDraft) return 'none'
  if (!m.approvalId) return 'unknown'
  const ap = approvals.find((a) => a.id === m.approvalId)
  if (!ap) return 'unknown'
  if (ap.status === 'pending') return 'pending'
  return ap.status === 'approved' ? 'sent' : 'dismissed'
}

export const isSensitive = (m: Pick<MailThread, 'sensitivity'>): boolean => m.sensitivity !== 'normal'

// ---------------------------------------------------------------- people

export const WARMTH: Record<Contact['warmth'], { label: string; text: string; bar: string; tone: Tone; order: number }> = {
  warm: { label: 'Warm', text: 'text-ok', bar: 'bg-ok', tone: 'ok', order: 2 },
  cooling: { label: 'Cooling', text: 'text-warn', bar: 'bg-warn', tone: 'warn', order: 1 },
  cold: { label: 'Cold', text: 'text-world', bar: 'bg-world', tone: 'info', order: 0 },
}

export function daysSince(c: Contact, now: Date): number | null {
  return c.lastContact ? dayDiff(parseDate(c.lastContact), now) : null
}

/** Filled pips (of 5) for the warmth meter; stays inside the band of its label. */
export function warmthPips(c: Contact, now: Date): number {
  const days = daysSince(c, now)
  const cadence = c.cadenceDays
  const ratio = days !== null && cadence ? days / cadence : null
  if (c.warmth === 'warm') return ratio !== null && ratio > 0.6 ? 4 : 5
  if (c.warmth === 'cooling') return ratio !== null && ratio > 1.5 ? 2 : 3
  return 1
}

/** "Elena (Mom)" is "Mom"; otherwise the first name. */
export function shortName(name: string): string {
  const m = /\(([^)]+)\)/.exec(name)
  if (m?.[1]) return m[1]
  return name.split(/\s+/)[0] ?? name
}

export function lastContactLabel(c: Contact, now: Date): string {
  const d = daysSince(c, now)
  if (d === null) return 'No contact yet'
  if (d === 0) return 'Today'
  if (d === 1) return 'Yesterday'
  return `${d} days ago`
}

/** Next occurrence of a "MM-DD" birthday, today included. */
export function nextBirthday(mmdd: string, now: Date): { date: Date; days: number } {
  const [m = '1', d = '1'] = mmdd.split('-')
  let date = new Date(now.getFullYear(), Number(m) - 1, Number(d))
  if (date < startOfDay(now)) date = new Date(now.getFullYear() + 1, Number(m) - 1, Number(d))
  return { date, days: dayDiff(now, date) }
}

export interface Nudge {
  id: string
  contact: Contact
  kind: 'rhythm' | 'birthday'
  text: string
  /** Lower sorts first. */
  score: number
}

const BIRTHDAY_WINDOW = 14

/** The next real meeting with this person, if one is on the calendar this week. */
function nextMeeting(contact: Contact, calendar: CalendarEvent[], now: Date): CalendarEvent | undefined {
  const horizon = addDays(startOfDay(now), 8)
  return calendar
    .filter((e) => !e.allDay && !e.approvalId && e.attendees.includes(contact.name) && new Date(e.end) > now && new Date(e.start) < horizon)
    .sort((a, b) => a.start.localeCompare(b.start))[0]
}

/** Gentle nudges, computed from last contact vs. the person's usual rhythm, birthdays and the calendar. */
export function buildNudges(contacts: Contact[], calendar: CalendarEvent[], now: Date): Nudge[] {
  const out: Nudge[] = []
  for (const c of contacts) {
    const name = shortName(c.name)
    const days = daysSince(c, now)
    if (c.birthday) {
      const b = nextBirthday(c.birthday, now)
      if (b.days <= BIRTHDAY_WINDOW) {
        const overdue = days !== null && c.cadenceDays !== undefined && days > c.cadenceDays
        out.push({
          id: `${c.id}:birthday`,
          contact: c,
          kind: 'birthday',
          text: `${name}'s birthday is ${relDays(b.days)}${overdue ? `, and it has been ${days} days since you talked` : ''}. ${c.nudgeHint ?? 'A message on the day goes a long way.'}`,
          score: b.days - 20,
        })
        continue
      }
    }
    if (days !== null && c.cadenceDays && days > c.cadenceDays) {
      const meet = nextMeeting(c, calendar, now)
      const when = meet ? `${meet.title} is on the calendar at ${fmtHM(new Date(meet.start))} ${dayWord(new Date(meet.start), now)}.` : ''
      out.push({
        id: `${c.id}:rhythm`,
        contact: c,
        kind: 'rhythm',
        text: `It has been ${days} days since you talked to ${name}. ${when || c.nudgeHint || 'A two-line message would do.'}`,
        score: -(days - c.cadenceDays) - (meet && dayDiff(now, new Date(meet.start)) === 0 ? 20 : 0),
      })
    }
  }
  return out.sort((a, b) => a.score - b.score)
}

export interface ComingUp {
  id: string
  kind: 'birthday' | 'meeting'
  title: string
  who: string
  date: Date
  when: string
  days: number
}

/** The "Coming up" strip: birthdays within 30 days and the next meetings with people. */
export function buildComingUp(contacts: Contact[], calendar: CalendarEvent[], now: Date): ComingUp[] {
  const out: ComingUp[] = []
  for (const c of contacts) {
    if (!c.birthday) continue
    const b = nextBirthday(c.birthday, now)
    if (b.days > 30) continue
    out.push({ id: `${c.id}:bd`, kind: 'birthday', title: `${shortName(c.name)}'s birthday`, who: c.name, date: b.date, when: relDays(b.days), days: b.days })
  }
  const horizon = addDays(startOfDay(now), 8)
  for (const e of calendar) {
    if (e.allDay || e.approvalId || e.attendees.length === 0) continue
    const s = new Date(e.start)
    if (new Date(e.end) <= now || s >= horizon) continue
    const d = dayDiff(now, s)
    out.push({ id: e.id, kind: 'meeting', title: e.title, who: e.attendees.join(', '), date: s, when: `${d === 0 ? 'today' : d === 1 ? 'tomorrow' : fmtWeekday(s)} ${fmtHM(s)}`, days: d })
  }
  return out.sort((a, b) => a.date.getTime() - b.date.getTime()).slice(0, 7)
}
