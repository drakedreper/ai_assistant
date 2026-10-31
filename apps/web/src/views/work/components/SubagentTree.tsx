import type { AgentNode, Session } from '@ai-assistant/shared'
import { CheckCircle2, CircleDashed, CircleDot, XCircle, type LucideIcon } from 'lucide-react'
import { cn } from '../../../lib/cn'
import { agentDisplayStatus } from '../lib'

const STATUS: Record<AgentNode['status'], { label: string; icon: LucideIcon; cls: string; pulse?: boolean }> = {
  running: { label: 'running', icon: CircleDot, cls: 'text-ok', pulse: true },
  waiting: { label: 'waiting', icon: CircleDashed, cls: 'text-warn' },
  done: { label: 'done', icon: CheckCircle2, cls: 'text-work' },
  error: { label: 'failed', icon: XCircle, cls: 'text-bad' },
}

function Node({
  session,
  agent,
  childrenOf,
  depth,
  last,
}: {
  session: Session
  agent: AgentNode
  childrenOf: Map<string, AgentNode[]>
  depth: number
  last: boolean
}) {
  const status = agentDisplayStatus(session, agent)
  const st = STATUS[status]
  const Icon = st.icon
  const kids = childrenOf.get(agent.id) ?? []
  const isMain = agent.parentId === null
  return (
    <li
      className={cn(
        'relative',
        depth > 0 && 'pl-5',
        // vertical connector (stops at the elbow for the last child) and the horizontal elbow
        depth > 0 && "before:absolute before:top-0 before:left-0 before:w-px before:bg-line-strong before:content-[''] after:absolute after:top-[17px] after:left-0 after:h-px after:w-4 after:bg-line-strong after:content-['']",
        depth > 0 && (last ? 'before:h-[17px]' : 'before:h-full'),
      )}
    >
      <div className="flex items-start gap-2 rounded-lg px-2 py-1.5 transition hover:bg-white/[0.035]">
        <Icon className={cn('mt-0.5 size-3.5 shrink-0', st.cls, st.pulse && 'pulse-dot')} aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="text-[12.5px] font-semibold text-fg">{isMain ? 'Main agent' : agent.type}</span>
            <span className={cn('text-[11px] font-medium', st.cls)}>{st.label}</span>
            {status === 'running' && (agent.currentTool || (isMain && session.currentTool)) && (
              <code className="rounded bg-white/8 px-1.5 py-px font-mono text-[11px] text-fg">{agent.currentTool ?? session.currentTool}</code>
            )}
          </div>
          {agent.description && !isMain && <p className="truncate text-[11px] text-faint" title={agent.description}>Asked: {agent.description}</p>}
          <p className="truncate text-[12px] text-muted" title={agent.lastMessage}>{agent.lastMessage}</p>
        </div>
      </div>
      {kids.length > 0 && (
        <ul className="ml-[15px]">
          {kids.map((k, i) => (
            <Node key={k.id} session={session} agent={k} childrenOf={childrenOf} depth={depth + 1} last={i === kids.length - 1} />
          ))}
        </ul>
      )}
    </li>
  )
}

/** Agents of a session as an indented tree with connector lines (main agent, subagents, nested subagents). */
export function SubagentTree({ session }: { session: Session }) {
  const childrenOf = new Map<string, AgentNode[]>()
  const roots: AgentNode[] = []
  for (const a of session.agents) {
    if (a.parentId === null) roots.push(a)
    else childrenOf.set(a.parentId, [...(childrenOf.get(a.parentId) ?? []), a])
  }
  return (
    <ul aria-label={`Agents in ${session.title}`}>
      {roots.map((r, i) => (
        <Node key={r.id} session={session} agent={r} childrenOf={childrenOf} depth={0} last={i === roots.length - 1} />
      ))}
    </ul>
  )
}
