import type { Session } from '@ai-assistant/shared'
import { GitBranch } from 'lucide-react'
import { cn } from '../lib/cn'
import { fmtUsd, timeAgo } from '../lib/format'
import { SESSION_STATUS } from '../lib/status'
import { useStore } from '../state/store'
import { Gauge, StatusDot } from './ui'

/** Compact one-row session summary (Today). Work has the full card. */
export function SessionMini({ session, className }: { session: Session; className?: string }) {
  const project = useStore((s) => s.data?.projects.find((p) => p.id === session.projectId))
  const navigate = useStore((s) => s.navigate)
  const now = useStore((s) => s.now)
  const st = SESSION_STATUS[session.status]
  return (
    <button
      type="button"
      onClick={() => navigate('work', { session: session.id })}
      className={cn(
        'group flex w-full cursor-pointer items-center gap-3 rounded-xl border border-transparent px-2.5 py-2 text-left transition hover:border-line hover:bg-white/[0.04]',
        className,
      )}
    >
      <StatusDot color={st.color} pulse={st.pulse} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-medium text-fg">{session.title}</span>
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-[11px] text-faint">
          <span className="inline-flex items-center gap-1" style={{ color: project?.color }}>
            <span className="size-1.5 rounded-full" style={{ background: project?.color }} />
            {project?.name ?? session.projectId}
          </span>
          {session.branch && (
            <span className="inline-flex items-center gap-0.5 truncate">
              <GitBranch className="size-3" />
              {session.branch}
            </span>
          )}
          <span>· {st.label}</span>
          {session.currentTool && session.status === 'running' && <span className="font-mono text-muted">· {session.currentTool}</span>}
        </div>
      </div>
      <div className="hidden w-20 shrink-0 text-right sm:block">
        <div className="text-[11px] text-muted tabular-nums">{fmtUsd(session.costUsd)}</div>
        <Gauge pct={session.contextPct} height={3} className="mt-1" label="context" />
        <div className="mt-0.5 text-[10px] text-faint">{timeAgo(session.updatedAt, now)}</div>
      </div>
    </button>
  )
}
