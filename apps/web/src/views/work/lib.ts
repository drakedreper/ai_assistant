import type { AgentNode, CostDay, Session, Task } from '@ai-assistant/shared'
import { History, Link2, PencilLine, Rocket, Sparkles, SquareTerminal, Webhook, type LucideIcon } from 'lucide-react'
import { timeAgo } from '../../lib/format'
import { SESSION_STATUS } from '../../lib/status'
import type { StatusFilter } from './ui'

/** "claude-sonnet-5-5" -> "Sonnet 5.5". */
export function shortModel(model: string): string {
  const m = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(model)
  if (!m) return model.replace(/^claude-/, '')
  const [, name = '', major = '', minor = ''] = m
  return `${name.charAt(0).toUpperCase()}${name.slice(1)} ${major}.${minor}`
}

/** "Atlas (finance app)" -> "Atlas". */
export function shortProject(name: string): string {
  return name.replace(/\s*\(.*\)\s*$/, '')
}

/**
 * Relative time that never reads "in a moment" for something that just happened: the store clock only ticks every
 * 30 s, so live events can be stamped slightly after it.
 */
export function rel(iso: string, now: Date): string {
  return timeAgo(iso, new Date(Math.max(now.getTime(), new Date(iso).getTime())))
}

/** 9_600_000 ms -> "2 h 40 min". */
export function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 60_000))
  const h = Math.floor(total / 60)
  const m = total % 60
  if (h === 0) return `${m} min`
  if (m === 0) return `${h} h`
  return `${h} h ${String(m).padStart(2, '0')} min`
}

/** "2026-10-31" -> "Fri 31 Oct" (local, no timezone drift). */
export function dayName(date: string, withMonth = true): string {
  const d = new Date(`${date}T12:00:00`)
  return d.toLocaleDateString([], withMonth ? { weekday: 'short', day: 'numeric', month: 'short' } : { weekday: 'short', day: 'numeric' })
}

export function sumValues(rec: Record<string, number>): number {
  return Object.values(rec).reduce((a, b) => a + b, 0)
}

export function dayTotal(d: CostDay): number {
  return sumValues(d.byProject)
}

// ---------- sessions ----------

export const SOURCE_INFO: Record<Session['source'], { label: string; icon: LucideIcon; tip: string }> = {
  hook: {
    label: 'hook',
    icon: Webhook,
    tip: 'Observed through Claude Code hooks. You started it in your own terminal; Mira only listens, so she cannot interrupt it.',
  },
  sdk: {
    label: 'sdk',
    icon: Rocket,
    tip: 'Launched by the Mira daemon through the Agent SDK. Mira can start, steer and interrupt it.',
  },
  import: {
    label: 'import',
    icon: History,
    tip: 'Backfilled from your Claude Code history. No live events were recorded, so the timeline is empty.',
  },
}

export const TASK_SOURCE_INFO: Record<Task['source'], { label: string; icon: LucideIcon; tip: string }> = {
  manual: { label: 'manual', icon: PencilLine, tip: 'Added by hand.' },
  assistant: { label: 'Mira', icon: Sparkles, tip: 'Proposed or added by Mira.' },
  claude_task: { label: 'claude task', icon: SquareTerminal, tip: 'Created from a Claude Code task list.' },
  federated: { label: 'Secondbrain', icon: Link2, tip: 'Federated: comes from your Secondbrain app (read-only source).' },
}

export type SessionGroup = 'needs' | 'running' | 'problem' | 'earlier'

export const GROUP_LABEL: Record<SessionGroup, string> = {
  needs: 'Needs you',
  running: 'Running',
  problem: 'Failed or stale',
  earlier: 'Idle and finished',
}

export const GROUP_ORDER: SessionGroup[] = ['needs', 'running', 'problem', 'earlier']

export function sessionGroup(s: Session): SessionGroup {
  const st = SESSION_STATUS[s.status]
  if (st.needsYou) return 'needs'
  if (s.status === 'running') return 'running'
  if (s.status === 'error' || s.status === 'stale') return 'problem'
  return 'earlier'
}

export function matchesStatus(s: Session, f: StatusFilter): boolean {
  switch (f) {
    case 'all': return true
    case 'needs': return SESSION_STATUS[s.status].needsYou
    case 'running': return s.status === 'running'
    case 'idle': return s.status === 'idle' || s.status === 'stale'
    case 'done': return s.status === 'done'
    case 'error': return s.status === 'error'
  }
}

/** Needs-you first, then running, then the rest; most recently updated first inside a status. */
export function sortSessions(list: Session[]): Session[] {
  return list.slice().sort((a, b) => {
    const d = SESSION_STATUS[a.status].order - SESSION_STATUS[b.status].order
    if (d !== 0) return d
    return a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0
  })
}

/**
 * The simulator only touches the session, never its agent nodes, so the main agent's display status is derived
 * from the session status. Subagents show their own status.
 */
export function agentDisplayStatus(session: Session, agent: AgentNode): AgentNode['status'] {
  if (agent.parentId !== null) return agent.status
  switch (session.status) {
    case 'running': return 'running'
    case 'waiting_input':
    case 'blocked_permission':
    case 'idle':
    case 'stale': return 'waiting'
    case 'done': return 'done'
    case 'error': return 'error'
  }
}

export function activeSubagents(s: Session): number {
  return s.agents.filter((a) => a.parentId !== null && a.status === 'running').length
}

// ---------- cost ----------

// Live cost-by-day lives in state/derived so the top bar and Work always agree.
export { useCostDays } from '../../state/derived'
