import type { Session } from '@ai-assistant/shared'
import { CheckCircle2, MessageCircleQuestion, Send, ShieldAlert, Terminal, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { TERMINAL_ONLY_COPY, useApiMode } from '../../../api'
import { ApprovalCard } from '../../../components/ApprovalCard'
import { Button, Gauge, StatusDot } from '../../../components/ui'
import { cn } from '../../../lib/cn'
import { fmtUsd } from '../../../lib/format'
import { SESSION_STATUS } from '../../../lib/status'
import { useSnap, useStore } from '../../../state/store'
import { rel } from '../lib'
import { useWork } from '../ui'
import { BranchChip, ModelBadge, ProjectChip, SourceBadge, StatusText } from './Atoms'

/**
 * With the real daemon, a session seen only through Claude Code hooks can be watched but not answered: hooks are
 * non-blocking, so there is nothing for an Approve, Deny or Reply button to talk to. (The mockup fakes those controls.)
 */
export function useWatchOnly(session: Session): boolean {
  const daemon = useApiMode() === 'daemon'
  return daemon && session.source === 'hook' && (session.status === 'blocked_permission' || session.status === 'waiting_input')
}

export function TerminalOnlyNote({ className }: { className?: string }) {
  return (
    <div className={cn('flex items-center gap-2 rounded-lg border border-warn/30 bg-warn/[0.06] px-2.5 py-2 text-[12px] text-fg', className)}>
      <Terminal className="size-3.5 shrink-0 text-warn" aria-hidden />
      <p data-testid="terminal-only-note">{TERMINAL_ONLY_COPY}</p>
    </div>
  )
}

/** Inline reply for a session that stopped to ask a question. Local only in the mockup. */
function ReplyBox({ session }: { session: Session }) {
  const sent = useWork((s) => s.replies[session.id])
  const sendReply = useWork((s) => s.sendReply)
  const [text, setText] = useState('')
  const main = session.agents[0]
  const question = main?.status === 'waiting' ? main.lastMessage : 'The session paused and is waiting for your reply.'

  if (sent) {
    return (
      <div className="relative z-10 mt-3 flex items-start gap-2 rounded-lg border border-ok/30 bg-ok/[0.07] px-2.5 py-2 text-[12px]">
        <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-ok" aria-hidden />
        <p className="min-w-0 text-muted">
          <span className="font-medium text-ok">Reply queued.</span> You said: <span className="text-fg">&ldquo;{sent}&rdquo;</span> (mock, nothing is sent yet)
        </p>
      </div>
    )
  }

  return (
    <div className="relative z-10 mt-3 rounded-lg border border-warn/30 bg-warn/[0.06] p-2.5">
      <p className="flex items-start gap-2 text-[12.5px] leading-snug text-fg">
        <MessageCircleQuestion className="mt-0.5 size-3.5 shrink-0 text-warn" aria-hidden />
        <span>{question}</span>
      </p>
      <form
        className="mt-2 flex gap-1.5"
        onSubmit={(e) => {
          e.preventDefault()
          const v = text.trim()
          if (!v) return
          sendReply(session.id, v)
          setText('')
        }}
      >
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label={`Reply to "${session.title}"`}
          placeholder="Type a one-line reply"
          className="h-7 min-w-0 flex-1 rounded-lg border border-line-strong bg-black/25 px-2.5 text-xs text-fg placeholder:text-faint"
        />
        <Button type="submit" variant="primary" disabled={!text.trim()}>
          <Send className="size-3" aria-hidden /> Reply
        </Button>
      </form>
    </div>
  )
}

/**
 * One session. The title is a real button stretched over the whole card (so the card is selectable without
 * nesting buttons); the inline actions sit above it with z-10.
 */
export function SessionCard({ session, selected }: { session: Session; selected: boolean }) {
  const project = useSnap((d) => d.projects.find((p) => p.id === session.projectId))
  const approvalId = useSnap((d) => d.approvals.find((a) => a.sessionId === session.id && a.status === 'pending')?.id)
  const now = useStore((s) => s.now)
  const select = useWork((s) => s.selectSession)
  const setTab = useWork((s) => s.setTab)
  const st = SESSION_STATUS[session.status]
  const watchOnly = useWatchOnly(session)
  const main = session.agents[0]
  const running = session.status === 'running'
  const detailLine =
    session.status === 'done' || session.status === 'idle' ? (session.summary ?? main?.lastMessage) : session.status === 'running' ? main?.lastMessage : undefined

  return (
    <article
      aria-label={`${session.title}, ${st.label}`}
      data-session-id={session.id}
      className={cn(
        'relative rounded-xl border p-3 transition',
        'has-[.session-select:focus-visible]:outline-2 has-[.session-select:focus-visible]:outline-offset-2 has-[.session-select:focus-visible]:outline-mira',
        selected ? 'border-work/45 bg-work/[0.07]' : 'border-line bg-white/[0.025] hover:border-line-strong hover:bg-white/[0.045]',
        st.needsYou && !selected && 'border-warn/25',
      )}
    >
      <div className="flex items-start gap-3">
        <span className="mt-[7px] shrink-0">
          <StatusDot color={st.color} pulse={st.pulse} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[11px]">
            <StatusText status={session.status} />
            <span className="text-faint">· {session.kind}</span>
            <span className="ml-auto shrink-0 text-faint tabular-nums">{rel(session.updatedAt, now)}</span>
          </div>
          <button
            type="button"
            onClick={() => select(session.id)}
            aria-current={selected ? 'true' : undefined}
            className="session-select mt-0.5 block w-full cursor-pointer truncate text-left text-[13.5px] font-semibold text-fg focus-visible:outline-none! after:absolute after:inset-0 after:rounded-xl after:content-['']"
          >
            {session.title}
          </button>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
            <ProjectChip project={project} />
            <BranchChip branch={session.branch} className="max-w-[170px]" />
            <ModelBadge model={session.model} />
            <SourceBadge source={session.source} />
          </div>
          {running && (
            <div className="mt-2 flex min-w-0 items-center gap-2 text-[12px]">
              <StatusDot color="var(--color-work)" pulse />
              {session.currentTool && <code className="rounded bg-white/8 px-1.5 py-px font-mono text-[11px] text-fg">{session.currentTool}</code>}
              <span className="min-w-0 truncate text-muted">{detailLine}</span>
            </div>
          )}
          {!running && detailLine && <p className="mt-2 truncate text-[12px] text-muted">{detailLine}</p>}
          {(session.status === 'error' || session.status === 'stale') && session.error && (
            <p className="mt-2 flex items-start gap-1.5 text-[12px] leading-snug text-bad/90">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span className="line-clamp-2">{session.error}</span>
            </p>
          )}
        </div>
        <div className="w-[84px] shrink-0 text-right">
          <div className="text-[13px] font-semibold text-fg tabular-nums" title="API-equivalent estimate, not a bill">
            {fmtUsd(session.costUsd)}
          </div>
          <div className="mt-1.5 text-[11px] text-faint tabular-nums">ctx {session.contextPct}%</div>
          <Gauge pct={session.contextPct} height={4} className="mt-1" label={`Context window used by ${session.title}`} />
        </div>
      </div>

      {watchOnly && <TerminalOnlyNote className="relative z-10 mt-3" />}
      {!watchOnly &&
        session.status === 'blocked_permission' &&
        (approvalId ? (
          <div className="relative z-10 mt-3">
            <ApprovalCard id={approvalId} variant="compact" className="border-bad/30 bg-bad/[0.05]" />
          </div>
        ) : (
          <div className="relative z-10 mt-3 flex items-center gap-2 rounded-lg border border-bad/30 bg-bad/[0.06] px-2.5 py-2 text-[12px] text-muted">
            <ShieldAlert className="size-3.5 shrink-0 text-bad" aria-hidden />
            Waiting on a permission whose request is not in the queue.
            <Button variant="ghost" size="xs" className="ml-auto" onClick={() => setTab('approvals')}>
              Open approvals
            </Button>
          </div>
        ))}
      {!watchOnly && session.status === 'waiting_input' && <ReplyBox session={session} />}
    </article>
  )
}
