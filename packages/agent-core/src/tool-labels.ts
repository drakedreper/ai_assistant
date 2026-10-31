/**
 * Human-readable strings about tool calls: the chip label in the chat ("checking your calendar" while it runs,
 * "checked your calendar" when done) and the short "what went to the cloud" line for the audit log.
 * Pure; inputs are truncated so a long query never fills a chip.
 */
import { isRecord, oneLine, truncate } from './util'

export type ToolPhase = 'running' | 'done'

const s = (input: unknown, key: string, max = 40): string => {
  const v = isRecord(input) ? input[key] : undefined
  return typeof v === 'string' ? truncate(oneLine(v), max) : ''
}

/** [while running, when done] */
type Labels = readonly [running: string, done: string]

function labels(tool: string, input: unknown): Labels {
  switch (tool) {
    case 'brain_search':
      return s(input, 'query') ? [`searching your notes for "${s(input, 'query')}"`, `searched your notes for "${s(input, 'query')}"`] : ['searching your notes', 'searched your notes']
    case 'brain_read':
      return s(input, 'path', 60) ? [`reading ${s(input, 'path', 60)}`, `read ${s(input, 'path', 60)}`] : ['reading a note', 'read a note']
    case 'brain_list':
      return ['listing your notes', 'listed your notes']
    case 'brain_today':
      return ["checking today's journal", "checked today's journal"]
    case 'brain_journal_append':
      return ['adding to your journal', 'added to your journal']
    case 'brain_capture':
      return ['capturing it to your inbox', 'captured it to your inbox']
    case 'brain_upsert_note':
      return s(input, 'path', 60) ? [`editing ${s(input, 'path', 60)}`, `edited ${s(input, 'path', 60)}`] : ['editing a note', 'edited a note']
    case 'brain_propose':
      return s(input, 'targetPath', 60) ? [`proposing a change to ${s(input, 'targetPath', 60)}`, `proposed a change to ${s(input, 'targetPath', 60)}`] : ['proposing a change', 'proposed a change']
    case 'calendar_agenda':
      return ['checking your calendar', 'checked your calendar']
    case 'calendar_propose_event':
      return s(input, 'title') ? [`proposing "${s(input, 'title')}"`, `proposed "${s(input, 'title')}"`] : ['proposing an event', 'proposed an event']
    case 'mail_search':
      return ['searching your mail', 'searched your mail']
    case 'mail_draft_reply':
      return ['drafting a reply', 'drafted a reply']
    case 'mail_send':
      return ['sending the email', 'sent the email']
    case 'contacts_find':
      return s(input, 'query') ? [`looking up ${s(input, 'query')}`, `looked up ${s(input, 'query')}`] : ['looking someone up', 'looked someone up']
    case 'finance_summary':
      return ['checking your finances', 'checked your finances']
    case 'finance_transactions':
      return ['looking at recent transactions', 'looked at recent transactions']
    case 'finance_move_money':
      return ['trying to move money', 'tried to move money']
    case 'worklog_status':
      return ['checking your sessions', 'checked your sessions']
    case 'worklog_create_task':
      return s(input, 'title') ? [`adding a card: ${s(input, 'title')}`, `added a card: ${s(input, 'title')}`] : ['adding a card', 'added a card']
    case 'news_briefing':
      return ['checking the news', 'checked the news']
    default:
      return [`using ${truncate(tool, 40)}`, `used ${truncate(tool, 40)}`]
  }
}

/** The chip label: present tense while the tool runs, past tense once it has finished. */
export function toolLabel(tool: string, input: unknown, phase: ToolPhase = 'done'): string {
  return labels(tool, input)[phase === 'running' ? 0 : 1]
}

const CLOUD: Record<string, string> = {
  brain_search: 'Note snippets returned by the search (capped)',
  brain_read: 'The text of the note that was read',
  brain_list: 'Note paths and titles',
  brain_today: "Today's journal note and open loops",
  calendar_agenda: 'Event titles and times',
  mail_search: 'Mail snippets (no full bodies)',
  contacts_find: 'Names and roles of the people asked about',
  finance_summary: 'Aggregates only: balances by kind, budget totals, upcoming bills',
  finance_transactions: 'A redacted sample of raw transactions (merchant, category, amount, date)',
  worklog_status: 'Session titles and statuses',
  news_briefing: 'Headlines and short summaries',
}

/** What a tool's result sends to the model, for the audit log. Undefined for tools that return nothing sensitive. */
export const cloudNote = (tool: string): string | undefined => CLOUD[tool]
