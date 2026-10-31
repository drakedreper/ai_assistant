import { z } from 'zod'
import { Id, IsoDate, IsoDateTime, Sensitivity } from './common'

export const CalendarEvent = z.object({
  id: Id,
  title: z.string(),
  start: IsoDateTime,
  end: IsoDateTime,
  allDay: z.boolean().default(false),
  location: z.string().optional(),
  attendees: z.array(z.string()).default([]),
  calendar: z.enum(['personal', 'work', 'family', 'focus']),
  /** Strategy/knowledge note this event touches; shown in the briefing. */
  relatedNote: z.object({ path: z.string(), title: z.string() }).optional(),
  prep: z.string().optional(),
  /** Set on an event Mira PROPOSED: it is a tentative hold until this approval is decided (T4 outward action). */
  approvalId: Id.optional(),
})
export type CalendarEvent = z.infer<typeof CalendarEvent>

export const MailThread = z.object({
  id: Id,
  from: z.string(),
  fromEmail: z.string(),
  subject: z.string(),
  snippet: z.string(),
  receivedAt: IsoDateTime,
  unread: z.boolean(),
  /** How she triaged it. */
  triage: z.enum(['needs_reply', 'fyi', 'waiting_on', 'newsletter', 'receipt']),
  sensitivity: Sensitivity.default('normal'),
  /** A reply drafted by her. It is NEVER sent without your approval (tier T4). */
  suggestedDraft: z.string().optional(),
  approvalId: Id.optional(),
  /** One line from Mira: why she triaged it this way and what she suggests. */
  miraNote: z.string().optional(),
  /** Strategy/knowledge note this thread touches. */
  relatedNote: z.object({ path: z.string(), title: z.string() }).optional(),
})
export type MailThread = z.infer<typeof MailThread>

export const Contact = z.object({
  id: Id,
  name: z.string(),
  role: z.string().optional(),
  org: z.string().optional(),
  email: z.string().optional(),
  lastContact: IsoDate.optional(),
  /** Month-day birthday, e.g. 11-03. */
  birthday: z.string().optional(),
  notePath: z.string().optional(),
  tags: z.array(z.string()).default([]),
  /** How warm the relationship is, based on contact cadence. */
  warmth: z.enum(['cold', 'cooling', 'warm']),
  /** Usual rhythm in days between contacts. Past this, Mira suggests a gentle nudge. */
  cadenceDays: z.number().int().positive().optional(),
  /** What Mira remembers about the relationship, one line. */
  miraNote: z.string().optional(),
  /** What she would suggest doing when a nudge is due. */
  nudgeHint: z.string().optional(),
})
export type Contact = z.infer<typeof Contact>
