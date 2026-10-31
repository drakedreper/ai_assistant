import type { Approval, Proposal } from '@ai-assistant/shared'
import { Check, ChevronDown, GitCommitHorizontal, GitPullRequest, Inbox, Link2, Moon, ShieldCheck, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../../api'
import { NoteChip } from '../../../components/NoteChip'
import { Badge, Button, EmptyState, Panel } from '../../../components/ui'
import { cn } from '../../../lib/cn'
import { timeAgo } from '../../../lib/format'
import { scrollWithin } from '../lib/scroll'
import { fakeSha } from '../lib/vault'
import { useBrain } from '../ui'
import { CommitChip, PROVENANCE } from './atoms'
import { DiffViewer } from './DiffViewer'

function ProvChip({ value }: { value: Proposal['provenance'] }) {
  if (value === 'dream')
    return (
      <Badge tone="brain" title="Written by the nightly consolidation, from your journal and notes">
        <Moon className="size-3" aria-hidden /> From the nightly dream
      </Badge>
    )
  const p = PROVENANCE[value]
  const Icon = p.icon
  return (
    <Badge tone={p.tone} title={p.hint}>
      <Icon className="size-3" aria-hidden /> {p.label}
    </Badge>
  )
}

function Explainer() {
  const items = [
    { icon: ShieldCheck, tone: 'text-money', title: 'Why proposals', body: 'Core and strategy notes shape everything Mira does. She can suggest edits to them, but only you can apply one.' },
    { icon: GitCommitHorizontal, tone: 'text-brain', title: 'Every approval is a commit', body: 'An approved change is written as one git commit with the diff you saw, so you can undo it from the Memory tab.' },
    { icon: Inbox, tone: 'text-mira', title: 'One decision, two places', body: 'Approving here also resolves the matching item in the Needs you queue on Today. It is the same decision.' },
  ]
  return (
    <section aria-label="How proposals work" className="glass grid gap-x-6 gap-y-3 px-4 py-3.5 @2xl:grid-cols-3">
      {items.map((it) => {
        const Icon = it.icon
        return (
          <div key={it.title} className="flex gap-2.5">
            <Icon className={cn('mt-0.5 size-4 shrink-0', it.tone)} aria-hidden />
            <div className="min-w-0">
              <h3 className="text-[13px] font-semibold text-fg">{it.title}</h3>
              <p className="mt-0.5 text-[12px] leading-relaxed text-muted">{it.body}</p>
            </div>
          </div>
        )
      })}
    </section>
  )
}

function PendingCard({ p, approval, flash, busy, onDecide, now }: { p: Proposal; approval: Approval | undefined; flash: boolean; busy: boolean; onDecide: (d: 'approved' | 'rejected') => void; now: Date }) {
  const ref = useRef<HTMLElement>(null)
  useEffect(() => {
    if (flash) scrollWithin(ref.current?.closest('[role=tabpanel]'), ref.current, { center: true, smooth: true })
  }, [flash])
  return (
    <article
      ref={ref}
      aria-label={`Proposal: ${p.title}`}
      data-proposal-id={p.id}
      className={cn('glass flex flex-col gap-3 p-4 transition-shadow', flash && 'ring-2 ring-mira/60')}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone="mira">
          <GitPullRequest className="size-3" aria-hidden /> Proposal
        </Badge>
        <ProvChip value={p.provenance} />
        {approval && approval.status === 'pending' && (
          <Badge tone="warn" title="This is the same decision as the item on Today">
            <Link2 className="size-3" aria-hidden /> Also in Needs you
          </Badge>
        )}
        <span className="text-[11px] text-faint">{timeAgo(p.createdAt, now)}</span>
      </div>
      <div>
        <h3 className="text-[15px] leading-snug font-semibold text-fg">{p.title}</h3>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-faint">
          <span>Changes</span>
          <NoteChip path={p.targetPath} title={p.targetPath.split('/').pop()?.replace(/\.md$/, '') ?? p.targetPath} />
          <span className="font-mono">{p.targetPath.split('/')[0]}</span>
        </div>
      </div>
      <p className="text-[13px] leading-relaxed text-muted">
        <span className="font-medium text-fg">Why: </span>
        {p.rationale}
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] tracking-wide text-faint uppercase">Evidence</span>
        {p.evidence.map((e) => (
          <NoteChip key={e.path} path={e.path} title={e.title} />
        ))}
      </div>
      <DiffViewer diff={p.diff} path={p.targetPath} />
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ok" size="md" disabled={busy} onClick={() => onDecide('approved')} aria-label={`Approve: ${p.title}`}>
          <Check className="size-4" aria-hidden /> Approve
        </Button>
        <Button variant="danger" size="md" disabled={busy} onClick={() => onDecide('rejected')} aria-label={`Reject: ${p.title}`}>
          <X className="size-4" aria-hidden /> Reject
        </Button>
        <span className="ml-auto text-[11px] text-faint">Approving creates one git commit you can undo.</span>
      </div>
    </article>
  )
}

function HistoryRow({ p, at, now }: { p: Proposal; at: string; now: Date }) {
  const [open, setOpen] = useState(false)
  const approved = p.status === 'approved'
  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={approved ? 'ok' : 'bad'}>
          {approved ? <Check className="size-3" aria-hidden /> : <X className="size-3" aria-hidden />}
          {approved ? 'Approved' : 'Rejected'}
        </Badge>
        <ProvChip value={p.provenance} />
        <span className="text-[11px] text-faint">{timeAgo(at, now)}</span>
        {approved && <CommitChip sha={p.commit ?? fakeSha(p.id)} />}
      </div>
      <p className="mt-1.5 text-[13px] leading-snug font-medium text-fg">{p.title}</p>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <NoteChip path={p.targetPath} title={p.targetPath.split('/').pop()?.replace(/\.md$/, '') ?? p.targetPath} />
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="ml-auto inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted transition hover:bg-white/6 hover:text-fg"
        >
          {open ? 'Hide diff' : 'View diff'}
          <ChevronDown className={cn('size-3 transition-transform', open && 'rotate-180')} aria-hidden />
        </button>
      </div>
      {open && (
        <div className="mt-2">
          <p className="mb-1.5 text-[12px] leading-relaxed text-muted">{p.rationale}</p>
          <DiffViewer diff={p.diff} path={p.targetPath} />
        </div>
      )}
    </li>
  )
}

export function ProposalsTab({ proposals, approvals, now }: { proposals: Proposal[]; approvals: Approval[]; now: Date }) {
  const flash = useBrain((s) => s.flashProposal)
  const setFlash = useBrain((s) => s.setFlashProposal)
  const decisions = useBrain((s) => s.decisions)
  const recordDecision = useBrain((s) => s.recordDecision)
  const dismiss = useBrain((s) => s.dismissDecision)
  const open = useBrain((s) => s.open)
  const setTab = useBrain((s) => s.setTab)
  const [busy, setBusy] = useState<string | null>(null)
  const openNote = (path: string) => {
    open(path)
    setTab('notes')
  }

  const pending = useMemo(() => proposals.filter((p) => p.status === 'pending').sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [proposals])
  const decided = useMemo(
    () =>
      proposals
        .filter((p) => p.status !== 'pending')
        .map((p) => ({ p, at: p.decidedAt ?? (decisions[p.id] ? new Date(decisions[p.id]?.at ?? 0).toISOString() : p.createdAt) }))
        .sort((a, b) => b.at.localeCompare(a.at)),
    [proposals, decisions],
  )
  const banner = Object.values(decisions)
    .filter((d) => !d.dismissed)
    .sort((a, b) => b.at - a.at)[0]

  // The deep-link highlight fades after a few seconds.
  useEffect(() => {
    if (!flash) return
    const t = setTimeout(() => setFlash(null), 3500)
    return () => clearTimeout(t)
  }, [flash, setFlash])

  const decide = async (p: Proposal, decision: 'approved' | 'rejected') => {
    const ap = approvals.find((a) => a.refId === p.id && a.status === 'pending')
    setBusy(p.id)
    recordDecision({ id: p.id, status: decision, title: p.title, path: p.targetPath, at: Date.now(), ...(ap ? { alsoToday: true } : {}) })
    await api.decideProposal(p.id, decision)
    setBusy(null)
  }

  return (
    <div className="@container flex flex-col gap-3">
      <Explainer />

      {banner && (
        <div role="status" className={cn('flex items-center gap-3 rounded-xl border px-3.5 py-2.5', banner.status === 'approved' ? 'border-ok/35 bg-ok/10' : 'border-line-strong bg-white/5')}>
          {banner.status === 'approved' ? <Check className="size-4 shrink-0 text-ok" aria-hidden /> : <X className="size-4 shrink-0 text-muted" aria-hidden />}
          <p className="min-w-0 flex-1 text-[13px] leading-snug text-fg">
            {banner.status === 'approved' ? 'Approved and committed: ' : 'Rejected: '}
            <span className="text-muted">{banner.title}.</span>{' '}
            <span className="text-muted">
              {banner.status === 'approved' ? 'The note now shows the change.' : 'Mira will not bring that wording back unless you ask.'}
              {banner.alsoToday && ' It is also resolved in Needs you on Today.'}
            </span>
          </p>
          {banner.status === 'approved' && (
            <Button size="xs" variant="outline" onClick={() => openNote(banner.path)}>
              Open note
            </Button>
          )}
          <Button size="xs" variant="ghost" onClick={() => dismiss(banner.id)}>
            Dismiss
          </Button>
        </div>
      )}

      <div className="grid gap-3 @4xl:grid-cols-[minmax(0,1fr)_340px] @4xl:items-start">
        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex items-baseline gap-2 px-1">
            <h2 className="text-[13px] font-semibold tracking-wide text-fg">Waiting for you</h2>
            <Badge tone={pending.length ? 'warn' : 'neutral'} className="tabular-nums">
              {pending.length}
            </Badge>
            <span className="text-[12px] text-faint">Core and strategy edits Mira cannot make on her own.</span>
          </div>
          {pending.length === 0 ? (
            <section className="glass">
              <EmptyState title="Nothing waiting" hint="Mira only proposes a change when she has evidence from your own notes." />
            </section>
          ) : (
            pending.map((p) => (
              <PendingCard
                key={p.id}
                p={p}
                approval={approvals.find((a) => a.refId === p.id)}
                flash={flash === p.id}
                busy={busy === p.id}
                onDecide={(d) => void decide(p, d)}
                now={now}
              />
            ))
          )}
        </div>

        <Panel title="Decided" subtitle="History of reviewed proposals" icon={GitCommitHorizontal} area="brain" flush>
          {decided.length === 0 ? (
            <EmptyState title="No history yet" />
          ) : (
            <ul className="divide-y divide-line">
              {decided.map(({ p, at }) => (
                <HistoryRow key={p.id} p={p} at={at} now={now} />
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  )
}
