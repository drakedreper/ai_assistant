import type { ChatPart, Emotion, Snapshot } from '@ai-assistant/shared'

/**
 * Scripted assistant replies for the mockup. The FixtureClient streams these as if Claude were answering.
 * A step is either a tool chip (shown running then done) or a text sentence with an emotion tag.
 * OWNER: Chat/Room agent enriches this (more intents, better copy). Keep refs valid (see STORY.md).
 */
export type ScriptStep =
  | { kind: 'tool'; tool: string; summary: string }
  | { kind: 'text'; text: string; emotion: Emotion }
  | { kind: 'part'; part: ChatPart }

export function scriptReply(input: string, snap: Snapshot): ScriptStep[] {
  const q = input.toLowerCase()
  const pending = snap.approvals.filter((a) => a.status === 'pending')

  if (/(need|waiting|approve|blocked)/.test(q)) {
    return [
      { kind: 'tool', tool: 'worklog_status', summary: 'checked your sessions' },
      { kind: 'text', emotion: 'neutral', text: `You have ${pending.length} things waiting on you.` },
      { kind: 'text', emotion: 'thinking', text: 'The riskiest one is the delete in the Atlas migration, so that is first.' },
      ...(pending[0] ? [{ kind: 'part', part: { type: 'approval', approvalId: pending[0].id } } as ScriptStep] : []),
    ]
  }
  if (/(calendar|today|schedule|meeting)/.test(q)) {
    return [
      { kind: 'tool', tool: 'calendar_agenda', summary: 'read today\'s agenda' },
      { kind: 'text', emotion: 'happy', text: 'Deep work 09:30 to 11:30, then your call with Dana at 14:00.' },
      { kind: 'text', emotion: 'relaxed', text: 'Coffee with Leo after. I kept the evening clear.' },
    ]
  }
  if (/(brain|note|strategy|q4|position)/.test(q)) {
    return [
      { kind: 'tool', tool: 'brain_search', summary: 'searched your vault for "Q4 positioning"' },
      { kind: 'text', emotion: 'thinking', text: 'Your current wording is still broad. I proposed a sharper wedge last night.' },
      { kind: 'part', part: { type: 'note', note: { path: '10-strategy/q4-positioning.md', title: 'Q4 positioning' } } },
    ]
  }
  return [
    { kind: 'tool', tool: 'brain_search', summary: 'checked what I know about that' },
    { kind: 'text', emotion: 'happy', text: 'I am on it.' },
    { kind: 'text', emotion: 'relaxed', text: 'Ask me what needs you, what is on today, or what I think about your Q4 plan.' },
  ]
}
