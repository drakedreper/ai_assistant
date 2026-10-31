import type { Snapshot } from '../index'
import { buildBriefing, buildLearned } from './assistant'
import { buildChat } from './chat'
import { buildMemory, buildNotes, buildProposals } from './brain'
import { buildCalendar, buildContacts, buildMail } from './life'
import { buildFinance } from './money'
import { buildSettings } from './settings'
import { buildApprovals, buildCostDays, buildEvents, buildProjects, buildSessions, buildTasks, buildUsageBlock } from './work'
import { buildWorld } from './world'

export * from './time'

/** Build the complete mock snapshot, relative to `now` so the mockup always looks like "today". */
export function buildSnapshot(now: Date = new Date()): Snapshot {
  return {
    now: now.toISOString(),
    briefing: buildBriefing(now),
    learned: buildLearned(now),
    chat: buildChat(now),
    projects: buildProjects(),
    sessions: buildSessions(now),
    events: buildEvents(now),
    tasks: buildTasks(),
    approvals: buildApprovals(now),
    costDays: buildCostDays(now),
    usageBlock: buildUsageBlock(now),
    notes: buildNotes(now),
    proposals: buildProposals(now),
    memory: buildMemory(now),
    calendar: buildCalendar(now),
    mail: buildMail(now),
    contacts: buildContacts(now),
    finance: buildFinance(now),
    world: buildWorld(now),
    settings: buildSettings(now),
  }
}
