import type { Briefing, LearnedFact } from '../index'
import { ago, dateOnly, journalPath } from './time'

export function buildBriefing(now: Date): Briefing {
  return {
    id: `briefing-${dateOnly(now)}`,
    date: dateOnly(now),
    generatedAt: ago(now, 45),
    greeting: 'Good morning',
    summary: 'Two agents are waiting on you, Priya needs a reply, and your Q4 wedge is getting sharper.',
    threads: [
      {
        id: 'th-q4', kind: 'decision', area: 'brain',
        title: 'Your 14:00 call with Dana touches the Q4 positioning decision',
        body: 'Last night I proposed narrowing the wedge to local-first tools for independent builders. If Dana asks "who is this for?", that is your answer.',
        cites: [{ path: '10-strategy/q4-positioning.md', title: 'Q4 positioning' }, { path: '30-knowledge/people/dana-reyes.md', title: 'Dana Reyes' }],
        actionLabel: 'Review the proposal',
      },
      {
        id: 'th-atlas', kind: 'risk', area: 'work',
        title: 'The Atlas migration is blocked on a delete you have not approved',
        body: 'The beta date in your decision note slips a day for every day this waits. The command is low-risk if the backup is verified; I can check first.',
        cites: [{ path: '10-strategy/decision-atlas-beta.md', title: 'Decision: ship the Atlas beta before December' }, { path: '40-projects/atlas/README.md', title: 'Project: Atlas' }],
        actionLabel: 'Open approvals',
      },
      {
        id: 'th-focus', kind: 'reminder', area: 'life',
        title: 'Thursday has no deep-work block yet',
        body: 'Your deep-work system asks for two protected blocks a day. I drafted a 09:00 to 11:00 hold for Thursday.',
        cites: [{ path: '10-strategy/deep-work-system.md', title: 'Deep-work system' }],
        actionLabel: 'Approve the block',
      },
      {
        id: 'th-money', kind: 'opportunity', area: 'money',
        title: 'Runway is ahead of plan this month',
        body: 'Spending is 8% under budget, which moves your financial-independence date forward by about two weeks.',
        cites: [{ path: '10-strategy/financial-independence.md', title: 'Financial independence plan' }],
      },
      {
        id: 'th-reflect', kind: 'reflection', area: 'brain',
        title: 'You have said "local-first" in four of the last five journal entries',
        body: 'That is a pattern worth writing down as a belief. Want me to draft it?',
        cites: [{ path: journalPath(now, -1), title: 'Journal (yesterday)' }, { path: '30-knowledge/local-first-software.md', title: 'Local-first software' }],
        actionLabel: 'Draft the note',
      },
    ],
  }
}

export function buildLearned(now: Date): LearnedFact[] {
  return [
    { id: 'lf-1', text: 'You do your best thinking before 11:00 and prefer calls after lunch.', confidence: 'high', source: { path: '10-strategy/deep-work-system.md', title: 'Deep-work system' }, learnedAt: ago(now, 60 * 24 * 3) },
    { id: 'lf-2', text: 'You would rather get a short answer first and details on request.', confidence: 'medium', source: { path: '00-core/operating-rules.md', title: 'Operating rules' }, learnedAt: ago(now, 60 * 24 * 2) },
    { id: 'lf-3', text: 'Mom\'s birthday is coming up and you usually order flowers a few days early.', confidence: 'medium', source: { path: '00-core/user-profile.md', title: 'About me' }, learnedAt: ago(now, 60 * 24) },
  ]
}
