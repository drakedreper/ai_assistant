import type { SettingsSnapshot } from '../index'
import { ago } from './time'

/** SEED. The Settings owner enriches. */
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
      { id: 'int-claude', name: 'Claude (Agent SDK)', kind: 'claude', state: 'connected', detail: 'Secretary + Reader lanes online', dataLeaves: 'Chat text and tool results go to Anthropic' },
      { id: 'int-cal', name: 'Google Calendar', kind: 'calendar', state: 'mock', detail: 'Mock data', dataLeaves: 'Nothing yet' },
      { id: 'int-mail', name: 'Gmail', kind: 'mail', state: 'mock', detail: 'Mock data, read + drafts only', dataLeaves: 'Snippets by default; bodies only on demand' },
      { id: 'int-atlas', name: 'Atlas (finance)', kind: 'finance', state: 'mock', detail: 'Mock data. Atlas not connected', dataLeaves: 'Aggregates only by default' },
      { id: 'int-sb', name: 'Secondbrain', kind: 'brain', state: 'mock', detail: 'Federated, read-only', dataLeaves: 'Nothing leaves the PC except via Claude context' },
    ],
    trustRules: [
      { id: 'tr-read', action: 'Read calendar, mail snippets, notes', description: 'Reading your data to answer questions.', tier: 'T0', mode: 'auto', locked: false, approvals: 0, rejections: 0, promotionSuggested: false },
      { id: 'tr-journal', action: 'Append to your journal / inbox', description: 'Append-only; fully reversible.', tier: 'T1', mode: 'auto', locked: false, approvals: 41, rejections: 0, promotionSuggested: false },
      { id: 'tr-notes', action: 'Edit knowledge and project notes', description: 'Every change is a git commit you can undo.', tier: 'T2', mode: 'ask', locked: false, approvals: 17, rejections: 0, promotionSuggested: true },
      { id: 'tr-strategy', action: 'Change core or strategy notes', description: 'Always arrives as a proposal with a diff.', tier: 'T3', mode: 'ask', locked: false, approvals: 5, rejections: 1, promotionSuggested: false },
      { id: 'tr-send', action: 'Send email', description: 'Outward action. Drafts are free; sending needs you.', tier: 'T4', mode: 'ask', locked: false, approvals: 12, rejections: 2, promotionSuggested: false },
      { id: 'tr-money', action: 'Move money', description: 'Permanently locked in v0.x.', tier: 'T4', mode: 'ask', locked: true, approvals: 0, rejections: 0, promotionSuggested: false },
    ],
    audit: [
      { id: 'au-1', at: ago(now, 30), actor: 'mira', action: 'Read calendar', target: 'Today', outcome: 'auto' },
      { id: 'au-2', at: ago(now, 55), actor: 'job', action: 'Proposed strategy edit', target: '10-strategy/q4-positioning.md', outcome: 'auto' },
      { id: 'au-3', at: ago(now, 300), actor: 'you', action: 'Approved send', target: 'Reply to Dana Reyes', outcome: 'approved', sentToCloud: 'Draft text (214 chars)' },
    ],
    privacy: [
      { id: 'pf-chat', source: 'Chat text', sensitivity: 'normal', leavesPc: true, policy: 'Sent to Claude. Stored locally in the daemon DB.' },
      { id: 'pf-mail', source: 'Email', sensitivity: 'private', leavesPc: true, policy: 'Snippets by default; full bodies only on demand and logged.' },
      { id: 'pf-fin', source: 'Finance (Atlas)', sensitivity: 'sensitive', leavesPc: true, policy: 'Aggregates only; raw transactions on demand with a redaction layer.' },
      { id: 'pf-cam', source: 'Webcam', sensitivity: 'sensitive', leavesPc: false, policy: 'Off by default. Frames go to Claude only when you press "look at this". Never stored.' },
    ],
    guestMode: false,
    webcam: { enabled: false, retention: 'none' },
  }
}
