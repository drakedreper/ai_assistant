import type { SettingsSnapshot } from '../index'
import { ago, journalPath } from './time'

/** Persona, Claude lanes, integrations, trust ladder, privacy flows, audit trail. All mock; nothing here leaves the PC. */
export function buildSettings(now: Date): SettingsSnapshot {
  return {
    persona: {
      name: 'Mira',
      tagline: 'Your secretary, your sounding board, your biggest fan.',
      vibe: { warmth: 80, playfulness: 70, directness: 65, proactivity: 55 },
      boundaries: [
        'Always be honest that she is an AI.',
        'Never guilt-trip or nag to keep you engaged.',
        'Affection never authorises an action: sending, spending and deleting always need approval.',
        'Stay quiet during quiet hours unless something is urgent.',
      ],
      quietHours: { from: '22:30', to: '07:00' },
      voice: { provider: 'kokoro', voiceName: 'af_heart', pushToTalk: true },
    },
    claude: {
      mode: 'api-key',
      status: 'connected',
      daemon: 'online',
      sdkVersion: '0.3.316',
      lanes: [
        { id: 'secretary', model: 'claude-sonnet-5-5', effort: 'medium', enabled: true, dailyBudgetUsd: 4, spentTodayUsd: 1.37 },
        { id: 'reader', model: 'claude-haiku-5-5', effort: 'low', enabled: true, dailyBudgetUsd: 1, spentTodayUsd: 0.14 },
        { id: 'voice', model: 'claude-haiku-5-5', effort: 'low', enabled: false, dailyBudgetUsd: 1, spentTodayUsd: 0 },
      ],
      globalDailyCapUsd: 10,
    },
    integrations: [
      { id: 'int-claude', name: 'Claude (Agent SDK)', kind: 'claude', state: 'connected', detail: 'Secretary and Reader lanes online', dataLeaves: 'Chat text, retrieved note snippets and tool results go to Anthropic' },
      { id: 'int-cal', name: 'Google Calendar', kind: 'calendar', state: 'mock', detail: 'Mock data; read-only first', dataLeaves: 'Nothing yet. Later: event titles and times, never attendee emails' },
      { id: 'int-mail', name: 'Gmail', kind: 'mail', state: 'mock', detail: 'Mock data; read and drafts only', dataLeaves: 'Snippets by default; full bodies only on demand and logged' },
      { id: 'int-contacts', name: 'Google Contacts', kind: 'contacts', state: 'needs_auth', detail: 'Waiting for sign-in', dataLeaves: 'Names stay local; only the people you ask about enter a prompt' },
      { id: 'int-atlas', name: 'Atlas (finance)', kind: 'finance', state: 'mock', detail: 'Mock data. Atlas not connected', dataLeaves: 'Aggregates only by default; raw transactions on demand' },
      { id: 'int-sb', name: 'Secondbrain', kind: 'brain', state: 'mock', detail: 'Federated, read-only mirror under secondbrain/', dataLeaves: 'Nothing leaves the PC except through retrieved snippets' },
      { id: 'int-news', name: 'News feeds (RSS)', kind: 'news', state: 'mock', detail: 'Sample feed; ranked on this PC', dataLeaves: 'Headlines only, to the Reader lane. Your notes never go with them' },
      { id: 'int-weather', name: 'Weather', kind: 'weather', state: 'mock', detail: 'Sample forecast for your city', dataLeaves: 'City name to the weather service' },
      { id: 'int-kokoro', name: 'Kokoro voice (local)', kind: 'voice', state: 'connected', detail: 'Speaks on this PC', dataLeaves: 'Nothing. Text to speech runs locally' },
      { id: 'int-eleven', name: 'ElevenLabs voice (cloud)', kind: 'voice', state: 'off', detail: 'Off. Local voice is in use', dataLeaves: 'Her sentences would be sent to the provider to be spoken' },
    ],
    // Original six first, in tier order: the Work screen shows the first rule it finds per tier.
    trustRules: [
      { id: 'tr-read', action: 'Read calendar, mail snippets, notes', description: 'Reading your data to answer questions.', tier: 'T0', mode: 'auto', locked: false, approvals: 0, rejections: 0, promotionSuggested: false },
      { id: 'tr-journal', action: 'Append to your journal', description: 'Append-only and fully reversible.', tier: 'T1', mode: 'auto', locked: false, approvals: 41, rejections: 0, promotionSuggested: false },
      { id: 'tr-notes', action: 'Edit knowledge and project notes', description: 'Every change is a git commit you can undo.', tier: 'T2', mode: 'ask', locked: false, approvals: 17, rejections: 0, promotionSuggested: true },
      {
        id: 'tr-strategy', action: 'Change core or strategy notes', description: 'Always arrives as a proposal with a diff.', tier: 'T3', mode: 'ask',
        locked: true, lockReason: 'Proposals only. She writes the diff, you apply it.', approvals: 5, rejections: 1, promotionSuggested: false,
      },
      { id: 'tr-send', action: 'Send email', description: 'Drafts are free; sending needs you.', tier: 'T4', mode: 'ask', locked: false, approvals: 12, rejections: 2, promotionSuggested: false },
      {
        id: 'tr-money', action: 'Move money', description: 'No tool exists for it in v0.x.', tier: 'T4', mode: 'ask',
        locked: true, lockReason: 'Permanently locked. Atlas is read-only and no approval can change that.', approvals: 0, rejections: 0, promotionSuggested: false,
      },
      { id: 'tr-capture', action: 'Capture ideas into the inbox', description: 'Raw captures land in 50-inbox for you to sort.', tier: 'T1', mode: 'auto', locked: false, approvals: 23, rejections: 0, promotionSuggested: false },
      { id: 'tr-search', action: 'Search the vault and Secondbrain', description: 'Cited snippets only; sensitive notes are skipped.', tier: 'T0', mode: 'auto', locked: false, approvals: 0, rejections: 0, promotionSuggested: false },
      { id: 'tr-task', action: 'Add and move kanban cards', description: 'Cards are easy to undo and never touch code.', tier: 'T2', mode: 'ask', locked: false, approvals: 14, rejections: 0, promotionSuggested: true },
      { id: 'tr-cal', action: 'Create calendar events', description: 'Holds and focus blocks on your own calendar.', tier: 'T4', mode: 'ask', locked: false, approvals: 8, rejections: 1, promotionSuggested: false },
      { id: 'tr-agent', action: 'Approve agent shell commands', description: 'Claude Code sessions asking to run Bash on this PC.', tier: 'T4', mode: 'ask', locked: false, approvals: 31, rejections: 4, promotionSuggested: false },
      {
        id: 'tr-persona', action: 'Change her own persona or boundaries', description: 'Her character is your data, not hers.', tier: 'T3', mode: 'ask',
        locked: true, lockReason: 'She can propose a change. Only you can apply it.', approvals: 2, rejections: 0, promotionSuggested: false,
      },
    ],
    audit: [
      { id: 'au-1', at: ago(now, 30), actor: 'mira', action: 'Read calendar', target: 'Today', outcome: 'auto' },
      { id: 'au-2', at: ago(now, 55), actor: 'job', action: 'Proposed strategy edit', target: '10-strategy/q4-positioning.md', outcome: 'auto', sentToCloud: 'Three journal excerpts and the note (2.1 KB)' },
      { id: 'au-3', at: ago(now, 300), actor: 'you', action: 'Approved send', target: 'Reply to Dana Reyes', outcome: 'approved', sentToCloud: 'Draft text (214 chars)', sensitive: true },
      { id: 'au-4', at: ago(now, 18), actor: 'mira', action: 'Read finance aggregates', target: 'Atlas (mock): net worth, budget, bills', outcome: 'auto', sentToCloud: 'Category totals only (6 numbers)', sensitive: true },
      { id: 'au-5', at: ago(now, 42), actor: 'agent', action: 'Tried to read .env', target: 'C:\\dev\\homelab\\.env', outcome: 'blocked', detail: 'Secrets paths are denied for every agent.', sensitive: true },
      { id: 'au-6', at: ago(now, 75), actor: 'mira', action: 'Appended to journal', target: journalPath(now), outcome: 'auto', detail: 'Added a two-line morning check-in.' },
      { id: 'au-7', at: ago(now, 130), actor: 'you', action: 'Approved calendar hold', target: 'Focus block, tomorrow 09:00', outcome: 'approved' },
      { id: 'au-8', at: ago(now, 210), actor: 'mira', action: 'Searched the vault', target: 'brain_search: "positioning"', outcome: 'auto', sentToCloud: 'Three note snippets (1.2 KB)' },
      { id: 'au-9', at: ago(now, 60 * 5), actor: 'you', action: 'Rejected proposal', target: '00-core/values.md', outcome: 'denied', detail: 'Wording change on "runway beats optimisation".' },
      { id: 'au-10', at: ago(now, 60 * 7), actor: 'job', action: 'Nightly dream: consolidated memory', target: '30-knowledge/', outcome: 'auto', detail: 'Merged two duplicate notes; wrote nothing to core.' },
      { id: 'au-11', at: ago(now, 60 * 9), actor: 'mira', action: 'Asked for raw transactions', target: 'Atlas (mock): last 14 days', outcome: 'blocked', detail: 'Raw rows need a reveal from you first.', sensitive: true },
      { id: 'au-12', at: ago(now, 60 * 22), actor: 'you', action: 'Revealed raw transactions', target: 'Money screen, 14 rows', outcome: 'approved', detail: 'Shown on screen only; nothing went to the cloud.', sensitive: true },
      { id: 'au-13', at: ago(now, 60 * 26), actor: 'mira', action: 'Asked to pay a bill', target: 'finance_move_money', outcome: 'blocked', detail: 'Money movement is locked in v0.x.', sensitive: true },
      { id: 'au-14', at: ago(now, 60 * 30), actor: 'agent', action: 'Ran pnpm test', target: 'C:\\dev\\atlas, session s-contract-tests', outcome: 'approved', sentToCloud: 'Command and test output (3.4 KB)' },
    ],
    privacy: [
      { id: 'pf-chat', source: 'Chat text', sensitivity: 'normal', leavesPc: true, policy: 'Sent to Claude. Stored locally in the daemon database.' },
      { id: 'pf-voice', source: 'Voice audio', sensitivity: 'private', leavesPc: false, policy: 'Speech to text runs on this PC. Only the transcript is sent, and the audio is not kept.' },
      { id: 'pf-vault', source: 'Vault notes', sensitivity: 'private', leavesPc: true, policy: 'Only the snippets retrieved for a question enter Claude context. Notes marked sensitive never do.' },
      { id: 'pf-journal', source: 'Journal and memory', sensitivity: 'sensitive', leavesPc: true, policy: 'Short excerpts on demand. Entries tagged intimate are excluded from cloud context.' },
      { id: 'pf-mail', source: 'Email', sensitivity: 'private', leavesPc: true, policy: 'Snippets by default; full bodies only on demand and logged.' },
      { id: 'pf-cal', source: 'Calendar', sensitivity: 'normal', leavesPc: true, policy: 'Event titles and times. Attendee emails stay local.' },
      { id: 'pf-fin', source: 'Finance (Atlas)', sensitivity: 'sensitive', leavesPc: true, policy: 'Aggregates only; raw transactions on demand with a redaction layer.' },
      { id: 'pf-cam', source: 'Webcam', sensitivity: 'sensitive', leavesPc: false, policy: 'Off by default. Frames go to Claude only when you press "look at this". Never stored.' },
      { id: 'pf-news', source: 'News feeds', sensitivity: 'normal', leavesPc: true, policy: 'Headlines go to the Reader lane, which has no tools and never sees your notes.' },
      { id: 'pf-sb', source: 'Secondbrain (federated)', sensitivity: 'private', leavesPc: false, policy: 'Read-only mirror on this PC. It follows the same retrieval rules as the vault.' },
    ],
    guestMode: false,
    webcam: { enabled: false, retention: 'none' },
    vault: { path: 'C:\\Users\\you\\Vault', commits: 412, lastCommitAt: ago(now, 14) },
  }
}
