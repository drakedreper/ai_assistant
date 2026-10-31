import type { Session, Task } from '@ai-assistant/shared'
import { FileText, Link2, OctagonX, Plus, TriangleAlert } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Badge, Button, Gauge, StatusDot } from '../../../components/ui'
import { NoteChip } from '../../../components/NoteChip'
import { cn } from '../../../lib/cn'
import { fmtUsd } from '../../../lib/format'
import { SESSION_STATUS } from '../../../lib/status'
import { useSnap, useStore } from '../../../state/store'
import { rel } from '../lib'
import { useWork } from '../ui'
import { BranchChip, ModelBadge, ProjectChip, SourceBadge } from './Atoms'
import { EventTimeline } from './EventTimeline'
import { SubagentTree } from './SubagentTree'

function Section({ title, count, children, hint }: { title: string; count?: number; children: ReactNode; hint?: string }) {
  return (
    <section className="border-t border-line px-4 py-3">
      <div className="mb-2 flex items-baseline gap-2">
        <h3 className="text-[12px] font-semibold tracking-wide text-fg">{title}</h3>
        {count !== undefined && <span className="text-[11px] text-faint tabular-nums">{count}</span>}
        {hint && <span className="ml-auto truncate text-[11px] text-faint">{hint}</span>}
      </div>
      {children}
    </section>
  )
}

function Meta({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] tracking-wide text-faint uppercase">{label}</div>
      <div className="text-[13px] font-medium text-fg tabular-nums">{children}</div>
    </div>
  )
}

/** Linking a session to a kanban card (there is no link call in the ApiClient yet, so the link is local). */
function LinkToCard({ session, linked }: { session: Session; linked: Task[] }) {
  const [open, setOpen] = useState(false)
  const tasks = useSnap((d) => d.tasks)
  const linkSession = useWork((s) => s.linkSession)
  const toast = useWork((s) => s.toast)
  const extra = useWork((s) => s.extraLinks)
  const candidates = tasks.filter(
    (t) => t.column !== 'done' && !t.sessionIds.includes(session.id) && !(extra[t.id] ?? []).includes(session.id) && (!t.projectId || t.projectId === session.projectId),
  )
  return (
    <>
      <Button variant="outline" aria-expanded={open} aria-controls={`link-picker-${session.id}`} onClick={() => setOpen((o) => !o)}>
        <Link2 className="size-3.5" aria-hidden /> Link to card
      </Button>
      {open && (
        <div id={`link-picker-${session.id}`} role="group" aria-label="Cards to link" className="fade-up max-h-56 w-full basis-full overflow-y-auto rounded-xl border border-line-strong bg-black/25 p-1.5">
          {candidates.length === 0 ? (
            <p className="px-2 py-3 text-center text-[12px] text-faint">{linked.length ? 'Every open card of this project is already linked.' : 'No open cards for this project.'}</p>
          ) : (
            candidates.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => {
                  linkSession(t.id, session.id)
                  setOpen(false)
                  toast(`Linked to "${t.title}".`, 'ok')
                }}
                className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12.5px] text-fg transition hover:bg-white/8"
              >
                <Plus className="size-3 shrink-0 text-faint" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{t.title}</span>
                <span className="text-[11px] text-faint">{t.column}</span>
              </button>
            ))
          )}
        </div>
      )}
    </>
  )
}

/** Right-hand panel of the Overview: everything about one session. */
export function SessionDetail({ session }: { session: Session }) {
  const project = useSnap((d) => d.projects.find((p) => p.id === session.projectId))
  const tasks = useSnap((d) => d.tasks)
  const notes = useSnap((d) => d.notes)
  const now = useStore((s) => s.now)
  const toast = useWork((s) => s.toast)
  const setTab = useWork((s) => s.setTab)
  const flash = useWork((s) => s.flash)
  const extraLinks = useWork((s) => s.extraLinks)
  const st = SESSION_STATUS[session.status]
  const active = session.status === 'running' || st.needsYou
  const canInterrupt = active && session.source === 'sdk'
  const linked = tasks.filter((t) => t.sessionIds.includes(session.id) || (extraLinks[t.id] ?? []).includes(session.id))
  const main = session.agents[0]
  const latest = session.error ?? session.summary ?? main?.lastMessage
  const interruptTip = canInterrupt
    ? 'Ask the SDK to stop the current turn'
    : session.source === 'sdk'
      ? 'Nothing is running right now'
      : session.source === 'hook'
        ? 'Observed via hooks: only sessions launched by Mira can be interrupted'
        : 'Imported history cannot be controlled'

  return (
    <div className="glass flex max-h-[calc(100dvh-5.5rem)] min-h-0 flex-col overflow-hidden" aria-label={`Session detail: ${session.title}`}>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <header className="px-4 pt-4 pb-3">
          <div className="flex items-center gap-2 text-[11px]">
            <StatusDot color={st.color} pulse={st.pulse} />
            <Badge tone={st.tone}>{st.label}</Badge>
            <span className="ml-auto text-faint tabular-nums">updated {rel(session.updatedAt, now)}</span>
          </div>
          <h2 className="mt-2 text-[16px] leading-snug font-semibold text-fg">{session.title}</h2>
          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5">
            <ProjectChip project={project} />
            <BranchChip branch={session.branch} />
            <ModelBadge model={session.model} />
            <SourceBadge source={session.source} />
          </div>
          <div className="mt-3 grid grid-cols-3 gap-3">
            <Meta label="Cost (est.)">{fmtUsd(session.costUsd)}</Meta>
            <Meta label="Context">
              <span>{session.contextPct}%</span>
              <Gauge pct={session.contextPct} height={4} className="mt-1.5" label="Context window used" />
            </Meta>
            <Meta label="Agents">{session.agents.length}</Meta>
          </div>
          <p className="mt-2 truncate text-[11px] text-faint" title={session.cwd}>
            {session.kind} session · started {rel(session.startedAt, now)} · <span className="font-mono">{session.cwd}</span>
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span title={interruptTip}>
              <Button
                variant="danger"
                disabled={!canInterrupt}
                onClick={() => toast(`Interrupt sent to "${session.title}" (mock: no daemon connected).`, 'warn')}
              >
                <OctagonX className="size-3.5" aria-hidden /> Interrupt
              </Button>
            </span>
            <span title="Phase 1: transcripts need the daemon">
              <Button variant="outline" disabled aria-label="Open transcript (available in Phase 1)">
                <FileText className="size-3.5" aria-hidden /> Open transcript
              </Button>
            </span>
            <LinkToCard session={session} linked={linked} />
          </div>
        </header>

        {latest && (
          <Section title={session.error ? 'What went wrong' : session.summary ? 'Summary' : 'Latest message'}>
            <p className={cn('flex items-start gap-2 text-[13px] leading-relaxed', session.error ? 'text-bad/90' : 'text-fg/90')}>
              {session.error && <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />}
              <span>{latest}</span>
            </p>
          </Section>
        )}

        {(session.relatedNotes?.length ?? 0) > 0 && (
          <Section title="Touches your notes" hint="Why Mira cares about this one">
            <div className="flex flex-wrap gap-1.5">
              {session.relatedNotes?.map((p) => <NoteChip key={p} path={p} title={notes.find((n) => n.path === p)?.title} />)}
            </div>
          </Section>
        )}

        <Section title="Cards" count={linked.length}>
          {linked.length === 0 ? (
            <p className="text-[12px] text-faint">Not linked to a card yet.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {linked.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setTab('board')
                      flash({ task: t.id })
                    }}
                    className="flex w-full cursor-pointer items-center gap-2 rounded-lg border border-line px-2.5 py-1.5 text-left text-[12.5px] text-fg transition hover:border-line-strong hover:bg-white/[0.04]"
                  >
                    <span className="size-2 shrink-0 rounded-sm" style={{ background: project?.color }} aria-hidden />
                    <span className="min-w-0 flex-1 truncate">{t.title}</span>
                    <Badge>{t.column}</Badge>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Agents" count={session.agents.length} hint="main agent and subagents">
          <SubagentTree session={session} />
        </Section>

        <Section title="Event timeline" hint="hook events, newest first">
          <EventTimeline session={session} />
        </Section>

      </div>
    </div>
  )
}
