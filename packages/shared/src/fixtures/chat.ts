import type { ChatMessage } from '../index'
import { ago, at } from './time'

/**
 * The seeded thread: last evening (one voice message, a Q4 chat, goodnight) and this morning's briefing.
 * Ids and refs are contracts (see STORY.md): `c1` is the morning briefing and references approval
 * `ap-rm-backup`; every note path and approval id used here exists in the other fixtures.
 */
export function buildChat(now: Date): ChatMessage[] {
  // Last evening is anchored to yesterday's clock (not "N hours ago") so it reads right at any time of day.
  const eve = (hhmm: string) => at(now, hhmm, -1)
  return [
    // ---- last evening ----
    {
      id: 'c-e1', role: 'user', createdAt: eve('21:38'), modality: 'voice',
      parts: [{ type: 'text', text: 'Mira, remind me to look at the Atlas migration first thing tomorrow.' }],
    },
    {
      id: 'c-e2', role: 'assistant', createdAt: eve('21:39'), modality: 'text',
      parts: [
        { type: 'tool', tool: 'brain_journal_append', summary: 'added it to tomorrow\'s journal', status: 'done' },
        { type: 'text', emotion: 'happy', text: 'Done. It sits at the top of tomorrow\'s briefing.' },
      ],
    },
    {
      id: 'c-e3', role: 'user', createdAt: eve('21:51'), modality: 'text',
      parts: [{ type: 'text', text: 'Does the Q4 plan still feel right to you?' }],
    },
    {
      id: 'c-e4', role: 'assistant', createdAt: eve('21:52'), modality: 'text',
      parts: [
        { type: 'tool', tool: 'brain_search', summary: 'reread your Q4 positioning', status: 'done' },
        { type: 'text', emotion: 'thinking', text: '"General productivity toolmaker" is too wide. Everything you wrote this week points at independent builders.' },
        { type: 'text', emotion: 'relaxed', text: 'I will sleep on it and bring you a proposal. You review it, I never edit that note on my own.' },
        { type: 'note', note: { path: '10-strategy/q4-positioning.md', title: 'Q4 positioning' } },
      ],
    },
    {
      id: 'c-e5', role: 'user', createdAt: eve('22:03'), modality: 'text',
      parts: [{ type: 'text', text: 'Good. Goodnight, Mira.' }],
    },
    {
      id: 'c-e6', role: 'assistant', createdAt: eve('22:04'), modality: 'text',
      parts: [{ type: 'text', emotion: 'relaxed', text: 'Goodnight. Lights low, agents quiet. I will keep watch.' }],
    },

    // ---- this morning ----
    {
      id: 'c1', role: 'assistant', createdAt: ago(now, 44), modality: 'text',
      parts: [
        { type: 'text', emotion: 'happy', text: 'Good morning! I read your night so you do not have to.' },
        { type: 'text', emotion: 'neutral', text: 'Three things need you: the Atlas migration wants to delete a backup, Priya is waiting on a reply, and I proposed a tweak to your Q4 positioning.' },
        { type: 'tool', tool: 'worklog_status', summary: 'checked your 6 sessions', status: 'done' },
        { type: 'approval', approvalId: 'ap-rm-backup' },
      ],
    },
    {
      id: 'c-m1', role: 'user', createdAt: ago(now, 31), modality: 'text',
      parts: [{ type: 'text', text: 'What is Priya waiting on, exactly?' }],
    },
    {
      id: 'c-m2', role: 'assistant', createdAt: ago(now, 30), modality: 'text',
      parts: [
        { type: 'tool', tool: 'mail_search', summary: 'opened the thread with Priya', status: 'done' },
        { type: 'text', emotion: 'neutral', text: 'The revised homepage, before Thursday. I drafted a short reply with a walkthrough offer.' },
        { type: 'text', emotion: 'relaxed', text: 'It only goes out if you approve it.' },
        { type: 'approval', approvalId: 'ap-reply-priya' },
        { type: 'note', note: { path: '30-knowledge/people/priya-nair.md', title: 'Priya Nair' } },
      ],
    },
  ]
}
