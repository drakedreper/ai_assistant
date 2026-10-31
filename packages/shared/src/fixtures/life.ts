import type { CalendarEvent, Contact, MailThread } from '../index'
import { ago, at, dateOnly } from './time'

type NoteRef = { path: string; title: string }

const Q4: NoteRef = { path: '10-strategy/q4-positioning.md', title: 'Q4 positioning' }
const DEEP: NoteRef = { path: '10-strategy/deep-work-system.md', title: 'Deep-work system' }
const ATLAS_DECISION: NoteRef = { path: '10-strategy/decision-atlas-beta.md', title: 'Decision: ship the Atlas beta before December' }
const FIRE: NoteRef = { path: '10-strategy/financial-independence.md', title: 'Financial independence plan' }
const LOCAL_FIRST: NoteRef = { path: '30-knowledge/local-first-software.md', title: 'Local-first software' }
const ATLAS: NoteRef = { path: '40-projects/atlas/README.md', title: 'Project: Atlas (finance app)' }
const ASSISTANT: NoteRef = { path: '40-projects/assistant/README.md', title: 'Project: ai_assistant' }
const HOMELAB: NoteRef = { path: '40-projects/homelab/README.md', title: 'Project: home-lab' }
const DANA: NoteRef = { path: '30-knowledge/people/dana-reyes.md', title: 'Dana Reyes' }
const LEO: NoteRef = { path: '30-knowledge/people/leo-park.md', title: 'Leo Park' }
const PRIYA: NoteRef = { path: '30-knowledge/people/priya-nair.md', title: 'Priya Nair' }

/** JS getDay() numbering: Sunday 0 ... Saturday 6. */
const THU = 4

/** Day offset of the next given weekday strictly after today (1..7). */
function upcoming(now: Date, jsDay: number): number {
  return ((jsDay - now.getDay() + 7) % 7) || 7
}

/** Weekday name of the day `offset` days from now, e.g. "Wednesday". */
function dayName(now: Date, offset: number): string {
  const d = new Date(now)
  d.setDate(d.getDate() + offset)
  return d.toLocaleDateString('en-US', { weekday: 'long' })
}

interface Slot {
  /** 0 = Monday ... 6 = Sunday. */
  dow: number
  /** 0 = this Mon-Sun week, 1 = next week. */
  week: 0 | 1
  /** Keep on today's column even though today has its own fixed events (afternoon items only). */
  keepToday?: boolean
  ev: Omit<CalendarEvent, 'start' | 'end' | 'allDay' | 'attendees'> & { from: string; to: string; attendees?: string[] }
}

/**
 * A full week of calendar events around "now". Today has four fixed events (their ids are contracts);
 * the rest of the Mon-Sun week and a little of next week are filled from a weekday template, so the week
 * view looks full whichever day the mockup is opened on. One proposed block (ap-focus-block) waits on the
 * upcoming Thursday.
 */
export function buildCalendar(now: Date): CalendarEvent[] {
  const monday = -((now.getDay() + 6) % 7)

  const fixed: CalendarEvent[] = [
    { id: 'ev-standup', title: 'Morning planning with Mira', start: at(now, '08:30'), end: at(now, '09:00'), allDay: false, attendees: [], calendar: 'personal', relatedNote: DEEP, prep: 'I will read the briefing and park everything that is not urgent until after your focus block.' },
    { id: 'ev-deep', title: 'Deep work: Atlas beta', start: at(now, '09:30'), end: at(now, '11:30'), allDay: false, attendees: [], calendar: 'focus', relatedNote: ATLAS_DECISION, prep: 'Phone on silent. The migration approval is the first thing to clear; I hold everything else until 11:30.' },
    { id: 'ev-dana', title: 'Call with Dana Reyes', start: at(now, '14:00'), end: at(now, '14:45'), allDay: false, location: 'Video call', attendees: ['Dana Reyes'], calendar: 'work', relatedNote: { path: '10-strategy/q4-positioning.md', title: 'Q4 positioning' }, prep: 'Bring the sharper wedge: local-first tools for independent builders.' },
    { id: 'ev-leo', title: 'Coffee with Leo', start: at(now, '17:30'), end: at(now, '18:30'), allDay: false, location: 'The corner cafe', attendees: ['Leo Park'], calendar: 'personal', relatedNote: LEO, prep: 'It has been 12 days. He is bringing printed onboarding screens for Atlas, so ask what he would cut.' },
    { id: 'ev-dentist', title: 'Dentist: check-up', start: at(now, '15:00', 2), end: at(now, '15:45', 2), allDay: false, location: 'Elm Street Dental', attendees: [], calendar: 'personal', prep: 'Routine check-up. Leave 15 minutes early; the clinic is a short walk.' },
    { id: 'ev-mom', title: "Mom's birthday", start: at(now, '00:00', 5), end: at(now, '23:59', 5), allDay: true, attendees: ['Elena (Mom)'], calendar: 'family', prep: 'You usually order flowers a few days early. I will remind you the day before.' },
  ]

  const thu = upcoming(now, THU)
  const thursday: CalendarEvent[] = [
    // Proposed by Mira: tentative until ap-focus-block is approved.
    { id: 'ev-focus-thu', title: 'Deep work: Atlas beta', start: at(now, '09:00', thu), end: at(now, '11:00', thu), allDay: false, attendees: [], calendar: 'focus', relatedNote: DEEP, prep: 'Two protected hours before the end of the week. I will hold notifications until 11:00.', approvalId: 'ap-focus-block' },
    { id: 'ev-priya-due', title: 'Due: revised homepage for Priya', start: at(now, '12:00', thu), end: at(now, '12:30', thu), allDay: false, attendees: ['Priya Nair'], calendar: 'work', relatedNote: PRIYA, prep: 'She asked for it before Thursday. Approve the reply in your inbox and the deadline clears itself.' },
  ]

  const slots: Slot[] = [
    // This week
    { dow: 0, week: 0, ev: { id: 'ev-w0-mon-plan', title: 'Weekly planning with Mira', from: '08:30', to: '09:15', calendar: 'personal', relatedNote: DEEP, prep: 'One page: open Atlas tasks, the week\'s calls, and the two blocks I would protect first.' } },
    { dow: 0, week: 0, ev: { id: 'ev-w0-mon-deep', title: 'Deep work: Atlas beta', from: '09:30', to: '12:00', calendar: 'focus', relatedNote: ATLAS_DECISION, prep: 'Start with the importer cut list. The beta date does not move for anything else.' } },
    { dow: 0, week: 0, ev: { id: 'ev-w0-mon-gym', title: 'Gym', from: '18:15', to: '19:15', calendar: 'personal', location: 'Riverside gym' } },
    { dow: 1, week: 0, ev: { id: 'ev-w0-tue-deep', title: 'Deep work: daemon health', from: '09:00', to: '11:30', calendar: 'focus', relatedNote: ASSISTANT, prep: 'The daemon session is running; review its diff when you surface.' } },
    { dow: 1, week: 0, ev: { id: 'ev-w0-tue-lab', title: 'Home-lab: certs and backups', from: '13:00', to: '13:30', calendar: 'work', relatedNote: HOMELAB, prep: 'Certificates were renewed early. Only the cold-storage restore test is left.' } },
    { dow: 2, week: 0, ev: { id: 'ev-w0-wed-deep', title: 'Deep work: Atlas beta', from: '09:00', to: '11:30', calendar: 'focus', relatedNote: ATLAS_DECISION } },
    { dow: 2, week: 0, ev: { id: 'ev-w0-wed-beta', title: 'Beta feedback triage', from: '13:30', to: '14:30', calendar: 'work', relatedNote: ATLAS, prep: 'Sort the first tester reports into must-fix and later.' } },
    { dow: 3, week: 0, ev: { id: 'ev-w0-thu-gym', title: 'Gym', from: '18:15', to: '19:15', calendar: 'personal', location: 'Riverside gym' } },
    { dow: 4, week: 0, ev: { id: 'ev-w0-fri-deep', title: 'Deep work: ai_assistant', from: '09:30', to: '12:00', calendar: 'focus', relatedNote: ASSISTANT } },
    { dow: 4, week: 0, keepToday: true, ev: { id: 'ev-w0-fri-review', title: 'Friday review', from: '16:30', to: '17:15', calendar: 'work', relatedNote: Q4, prep: 'Did the week move the Q4 wedge? I will bring journal highlights and the cost summary.' } },
    { dow: 5, week: 0, ev: { id: 'ev-w0-sat-market', title: 'Market run', from: '10:00', to: '11:00', calendar: 'personal', location: 'Old Town market' } },
    { dow: 6, week: 0, ev: { id: 'ev-w0-sun-dinner', title: 'Sunday dinner at Mom and Dad\'s', from: '18:00', to: '20:00', calendar: 'family', location: 'Elena and Henrik\'s place', attendees: ['Elena (Mom)', 'Henrik (Dad)'], prep: 'Her birthday plans will come up. I have notes on what she mentioned last month.' } },
    // Next week
    { dow: 0, week: 1, ev: { id: 'ev-w1-mon-plan', title: 'Weekly planning with Mira', from: '08:30', to: '09:15', calendar: 'personal', relatedNote: DEEP } },
    { dow: 0, week: 1, ev: { id: 'ev-w1-mon-deep', title: 'Deep work: Atlas beta', from: '09:30', to: '12:00', calendar: 'focus', relatedNote: ATLAS_DECISION } },
    { dow: 2, week: 1, ev: { id: 'ev-w1-wed-deep', title: 'Deep work: ai_assistant', from: '09:00', to: '11:30', calendar: 'focus', relatedNote: ASSISTANT } },
    { dow: 4, week: 1, ev: { id: 'ev-w1-fri-review', title: 'Friday review', from: '16:30', to: '17:15', calendar: 'work', relatedNote: Q4 } },
  ]

  const templated: CalendarEvent[] = []
  for (const s of slots) {
    const offset = monday + s.week * 7 + s.dow
    if (offset === 0 && !s.keepToday) continue
    const { from, to, attendees, ...rest } = s.ev
    templated.push({ ...rest, start: at(now, from, offset), end: at(now, to, offset), allDay: false, attendees: attendees ?? [] })
  }

  return [...fixed, ...thursday, ...templated].sort((a, b) => a.start.localeCompare(b.start))
}

export function buildMail(now: Date): MailThread[] {
  const dentistDay = dayName(now, 2)
  return [
    { id: 'm-leo', from: 'Leo Park', fromEmail: 'leo@example.com', subject: 'Re: Tonight', snippet: 'I will bring the printed onboarding screens. Corner cafe at 17:30, same table as last time?', receivedAt: ago(now, 40), unread: true, triage: 'fyi', sensitivity: 'normal', miraNote: 'Nothing to answer. I added the printouts to your coffee prep.', relatedNote: LEO },
    { id: 'm-priya', from: 'Priya Nair', fromEmail: 'priya@example.com', subject: 'Re: Site revisions', snippet: 'Thanks for the update, could you send the revised homepage before Thursday?', receivedAt: ago(now, 70), unread: true, triage: 'needs_reply', sensitivity: 'normal', suggestedDraft: 'Hi Priya,\n\nThe revised homepage is attached. I would love to walk you through it on Thursday if that works.\n\nBest', approvalId: 'ap-reply-priya', miraNote: 'She needs the homepage before Thursday. I drafted a short reply that offers a walkthrough. It only goes out if you approve it.', relatedNote: PRIYA },
    { id: 'm-mom', from: 'Elena (Mom)', fromEmail: 'elena@example.com', subject: 'Birthday dinner?', snippet: 'Would Sunday work for dinner, or shall we do it on the day itself? Dad says hi.', receivedAt: ago(now, 150), unread: true, triage: 'needs_reply', sensitivity: 'normal', miraNote: 'Her birthday is in 5 days. You usually order flowers a few days early; I will remind you the day before.' },
    { id: 'm-sam', from: 'Sam Ortiz', fromEmail: 'sam@example.com', subject: 'Atlas beta: two small bugs', snippet: 'CSV import worked, but the envelope totals are off by a cent on my second budget. Happy to send the file.', receivedAt: ago(now, 240), unread: true, triage: 'needs_reply', sensitivity: 'normal', miraNote: 'The first real beta feedback. Worth a reply today: it bears on the Atlas beta date.', relatedNote: ATLAS_DECISION },
    { id: 'm-marcus', from: 'Marcus Webb', fromEmail: 'marcus@example.com', subject: 'Q3 estimated tax', snippet: 'Numbers attached, please confirm by Friday.', receivedAt: ago(now, 300), unread: true, triage: 'waiting_on', sensitivity: 'sensitive', miraNote: 'He is waiting on a yes from you. I only see this snippet, never the attachment. I set a reminder for Thursday.', relatedNote: FIRE },
    { id: 'm-dana', from: 'Dana Reyes', fromEmail: 'dana@example.com', subject: 'Intro to a seed investor', snippet: 'Happy to connect you. Tell me one sentence about who this is for.', receivedAt: ago(now, 600), unread: false, triage: 'needs_reply', sensitivity: 'normal', miraNote: 'Your one sentence already exists in your Q4 positioning: local-first tools for independent builders. No draft yet, because you talk to her at 14:00.', relatedNote: Q4 },
    { id: 'm-news', from: 'Builders Weekly', fromEmail: 'news@example.com', subject: 'Local-first is having a moment', snippet: 'This week: sync engines, CRDTs, and one very good essay.', receivedAt: ago(now, 900), unread: true, triage: 'newsletter', sensitivity: 'normal', miraNote: 'I pulled the one story that matters into your World briefing. The rest can wait.', relatedNote: LOCAL_FIRST },
    { id: 'm-receipt', from: 'Cloud Host', fromEmail: 'billing@example.com', subject: 'Your receipt', snippet: 'Payment of $12.00 received.', receivedAt: ago(now, 1200), unread: false, triage: 'receipt', sensitivity: 'private', miraNote: 'Matches the monthly hosting line. Filed, nothing to do.' },
    { id: 'm-dentist', from: 'Elm Street Dental', fromEmail: 'reception@example.com', subject: 'Appointment reminder', snippet: `You are booked for ${dentistDay} at 15:00. Reply C to confirm or call us to move it.`, receivedAt: ago(now, 1500), unread: false, triage: 'fyi', sensitivity: 'sensitive', miraNote: 'Already on your calendar. It is a health email, so I keep the time and nothing else.' },
    { id: 'm-hosting', from: 'Cloud Host Support', fromEmail: 'support@example.com', subject: 'Re: Certificate renewal question', snippet: 'We are looking into the renewal error and expect to update you within two business days.', receivedAt: ago(now, 1700), unread: false, triage: 'waiting_on', sensitivity: 'normal', miraNote: 'Waiting on them since yesterday. I will flag it if nothing arrives by the end of tomorrow.', relatedNote: HOMELAB },
  ]
}

export function buildContacts(now: Date): Contact[] {
  return [
    { id: 'ct-dana', name: 'Dana Reyes', role: 'Mentor', org: 'Ex-founder', email: 'dana@example.com', lastContact: dateOnly(now, -1), notePath: DANA.path, tags: ['mentor', 'investor intro'], warmth: 'warm', cadenceDays: 30, miraNote: 'Asks one hard question per call. May introduce a seed investor if the wedge is sharp.' },
    { id: 'ct-leo', name: 'Leo Park', role: 'Designer', email: 'leo@example.com', lastContact: dateOnly(now, -12), notePath: LEO.path, tags: ['friend', 'design'], warmth: 'cooling', cadenceDays: 10, miraNote: 'Drew the Atlas onboarding screens. Best ideas come over coffee, not chat.', nudgeHint: 'Ask what he would cut from the onboarding.' },
    { id: 'ct-priya', name: 'Priya Nair', role: 'Client', org: 'Portfolio site', email: 'priya@example.com', lastContact: dateOnly(now, 0), notePath: PRIYA.path, tags: ['client'], warmth: 'warm', cadenceDays: 14, miraNote: 'Likes short, warm updates and a walkthrough over a long email.' },
    { id: 'ct-marcus', name: 'Marcus Webb', role: 'Accountant', org: 'Webb & Co', email: 'marcus@example.com', lastContact: dateOnly(now, -30), tags: ['finance'], warmth: 'cold', cadenceDays: 21, miraNote: 'Quarterly rhythm. Currently waiting on your yes to the Q3 numbers.', nudgeHint: 'He is waiting on your confirmation of the Q3 numbers, due Friday.' },
    { id: 'ct-mom', name: 'Elena (Mom)', role: 'Family', birthday: dateOnly(now, 5).slice(5), lastContact: dateOnly(now, -3), tags: ['family'], warmth: 'warm', cadenceDays: 7, miraNote: 'Calls on Sundays. Appreciates flowers that arrive a day early.', nudgeHint: 'You usually order flowers a few days early.' },
    { id: 'ct-sam', name: 'Sam Ortiz', role: 'Beta tester', org: 'Atlas beta list', email: 'sam@example.com', lastContact: dateOnly(now, -4), tags: ['beta', 'atlas'], warmth: 'warm', cadenceDays: 14, miraNote: 'Sent the first real bug report. Careful and kind in feedback.' },
    { id: 'ct-nora', name: 'Nora Lindqvist', role: 'Co-working friend', org: 'Studio Nine', email: 'nora@example.com', lastContact: dateOnly(now, -19), birthday: dateOnly(now, 12).slice(5), tags: ['friend', 'co-working'], warmth: 'cooling', cadenceDays: 14, miraNote: 'Moved to a new studio in October and has not said how it went.', nudgeHint: 'Ask how the new studio is working out.' },
    { id: 'ct-amara', name: 'Amara Okafor', role: 'Fellow builder', org: 'Indie Builders Circle', email: 'amara@example.com', lastContact: dateOnly(now, -6), tags: ['peer', 'local-first'], warmth: 'warm', cadenceDays: 21, miraNote: 'Building a sync engine. A good sounding board for Atlas sync.' },
    { id: 'ct-henrik', name: 'Henrik (Dad)', role: 'Family', birthday: dateOnly(now, 140).slice(5), lastContact: dateOnly(now, -2), tags: ['family'], warmth: 'warm', cadenceDays: 7, miraNote: 'Prefers a call to a message. Sunday dinner is the usual slot.' },
    { id: 'ct-jonas', name: 'Jonas Becker', role: 'Landlord', email: 'jonas@example.com', lastContact: dateOnly(now, -120), tags: ['home'], warmth: 'cold', miraNote: 'Only needs contact around the lease renewal in spring. No nudges.' },
  ]
}
