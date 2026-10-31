import type { Approval, SessionStatus } from '@ai-assistant/shared'
import type { Tone } from '../components/ui'

export const SESSION_STATUS: Record<
  SessionStatus,
  { label: string; color: string; tone: Tone; pulse: boolean; needsYou: boolean; order: number }
> = {
  blocked_permission: { label: 'Needs permission', color: 'var(--color-bad)', tone: 'bad', pulse: true, needsYou: true, order: 0 },
  waiting_input: { label: 'Waiting for you', color: 'var(--color-warn)', tone: 'warn', pulse: true, needsYou: true, order: 1 },
  running: { label: 'Running', color: 'var(--color-ok)', tone: 'ok', pulse: true, needsYou: false, order: 2 },
  error: { label: 'Error', color: 'var(--color-bad)', tone: 'bad', pulse: false, needsYou: false, order: 3 },
  idle: { label: 'Idle', color: 'var(--color-faint)', tone: 'neutral', pulse: false, needsYou: false, order: 4 },
  stale: { label: 'Stale', color: 'var(--color-faint)', tone: 'neutral', pulse: false, needsYou: false, order: 5 },
  done: { label: 'Done', color: 'var(--color-work)', tone: 'work', pulse: false, needsYou: false, order: 6 },
}

export const RISK_TONE: Record<Approval['risk'], Tone> = { low: 'ok', medium: 'warn', high: 'bad' }

/** Autonomy tiers (T0 read freely .. T4 outward action). */
export const TIER_LABEL: Record<string, string> = {
  T0: 'read',
  T1: 'journal / inbox',
  T2: 'knowledge notes',
  T3: 'core / strategy',
  T4: 'outward action',
}

export const APPROVAL_KIND_LABEL: Record<Approval['kind'], string> = {
  tool_permission: 'Agent permission',
  email_draft: 'Email draft',
  brain_proposal: 'Brain proposal',
  calendar_event: 'Calendar event',
  action: 'Action',
}
