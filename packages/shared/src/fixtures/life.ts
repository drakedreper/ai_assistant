import type { CalendarEvent, Contact, MailThread } from '../index'
import { ago, at, dateOnly } from './time'

/** SEED. The Life owner enriches (a full week of events, more mail/contacts). */
export function buildCalendar(now: Date): CalendarEvent[] {
  return [
    { id: 'ev-standup', title: 'Morning planning with Mira', start: at(now, '08:30'), end: at(now, '09:00'), allDay: false, attendees: [], calendar: 'personal' },
    { id: 'ev-deep', title: 'Deep work: Atlas beta', start: at(now, '09:30'), end: at(now, '11:30'), allDay: false, attendees: [], calendar: 'focus' },
    { id: 'ev-dana', title: 'Call with Dana Reyes', start: at(now, '14:00'), end: at(now, '14:45'), allDay: false, location: 'Video call', attendees: ['Dana Reyes'], calendar: 'work', relatedNote: { path: '10-strategy/q4-positioning.md', title: 'Q4 positioning' }, prep: 'Bring the sharper wedge: local-first tools for independent builders.' },
    { id: 'ev-leo', title: 'Coffee with Leo', start: at(now, '17:30'), end: at(now, '18:30'), allDay: false, location: 'The corner cafe', attendees: ['Leo Park'], calendar: 'personal' },
    { id: 'ev-mom', title: "Mom's birthday", start: at(now, '00:00', 5), end: at(now, '23:59', 5), allDay: true, attendees: [], calendar: 'family' },
  ]
}

export function buildMail(now: Date): MailThread[] {
  return [
    { id: 'm-priya', from: 'Priya Nair', fromEmail: 'priya@example.com', subject: 'Re: Site revisions', snippet: 'Thanks for the update, could you send the revised homepage before Thursday?', receivedAt: ago(now, 70), unread: true, triage: 'needs_reply', sensitivity: 'normal', suggestedDraft: 'Hi Priya,\n\nThe revised homepage is attached. I would love to walk you through it on Thursday if that works.\n\nBest', approvalId: 'ap-reply-priya' },
    { id: 'm-marcus', from: 'Marcus Webb', fromEmail: 'marcus@example.com', subject: 'Q3 estimated tax', snippet: 'Numbers attached, please confirm by Friday.', receivedAt: ago(now, 300), unread: true, triage: 'waiting_on', sensitivity: 'sensitive' },
    { id: 'm-dana', from: 'Dana Reyes', fromEmail: 'dana@example.com', subject: 'Intro to a seed investor', snippet: 'Happy to connect you. Tell me one sentence about who this is for.', receivedAt: ago(now, 600), unread: false, triage: 'needs_reply', sensitivity: 'normal' },
    { id: 'm-news', from: 'Builders Weekly', fromEmail: 'news@example.com', subject: 'Local-first is having a moment', snippet: 'This week: sync engines, CRDTs, and one very good essay.', receivedAt: ago(now, 900), unread: true, triage: 'newsletter', sensitivity: 'normal' },
    { id: 'm-receipt', from: 'Cloud Host', fromEmail: 'billing@example.com', subject: 'Your receipt', snippet: 'Payment of $12.00 received.', receivedAt: ago(now, 1200), unread: false, triage: 'receipt', sensitivity: 'private' },
  ]
}

export function buildContacts(now: Date): Contact[] {
  return [
    { id: 'ct-dana', name: 'Dana Reyes', role: 'Mentor', org: 'Ex-founder', email: 'dana@example.com', lastContact: dateOnly(now, -1), notePath: '30-knowledge/people/dana-reyes.md', tags: ['mentor'], warmth: 'warm' },
    { id: 'ct-leo', name: 'Leo Park', role: 'Designer', email: 'leo@example.com', lastContact: dateOnly(now, -12), notePath: '30-knowledge/people/leo-park.md', tags: ['friend'], warmth: 'cooling' },
    { id: 'ct-priya', name: 'Priya Nair', role: 'Client', email: 'priya@example.com', lastContact: dateOnly(now, 0), notePath: '30-knowledge/people/priya-nair.md', tags: ['client'], warmth: 'warm' },
    { id: 'ct-marcus', name: 'Marcus Webb', role: 'Accountant', email: 'marcus@example.com', lastContact: dateOnly(now, -30), tags: ['finance'], warmth: 'cold' },
    { id: 'ct-mom', name: 'Elena (Mom)', role: 'Family', birthday: dateOnly(now, 5).slice(5), lastContact: dateOnly(now, -3), tags: ['family'], warmth: 'warm' },
  ]
}
