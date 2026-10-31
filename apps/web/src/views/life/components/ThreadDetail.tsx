import type { Approval, MailThread } from '@ai-assistant/shared'
import { Check, FileLock2, Pencil, Send, ShieldCheck, Sparkles, X } from 'lucide-react'
import { NoteChip } from '../../../components/NoteChip'
import { Badge, Button, Initials } from '../../../components/ui'
import { cn } from '../../../lib/cn'
import { fmtDay, fmtTime, timeAgo } from '../../../lib/format'
import { RISK_TONE, TIER_LABEL } from '../../../lib/status'
import { useSnap, useStore } from '../../../state/store'
import { decideDraft } from '../actions'
import { draftState, isSensitive, type DraftState } from '../lib'
import { useLife } from '../ui'
import { SensitivityBadge, TriageBadge } from './atoms'

export function ThreadDetail({ thread }: { thread: MailThread }) {
  const approval = useSnap((d) => (thread.approvalId ? d.approvals.find((a) => a.id === thread.approvalId) : undefined))
  const approvals = useSnap((d) => d.approvals)
  const now = useStore((s) => s.now)
  const draft = draftState(thread, approvals)
  const sensitive = isSensitive(thread)

  return (
    <article className="glass flex flex-col gap-4 p-4" aria-label={`Thread: ${thread.subject}`}>
      <header className="flex flex-col gap-2.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <TriageBadge triage={thread.triage} draft={draft} />
          <SensitivityBadge level={thread.sensitivity} />
        </div>
        <h2 data-sensitive={sensitive ? '' : undefined} className="text-[16px] leading-snug font-semibold text-fg">
          {thread.subject}
        </h2>
        <div className="flex items-center gap-2.5">
          <Initials name={thread.from} className="size-8" />
          <div className="min-w-0 flex-1 leading-tight">
            <div className="truncate text-[13px] font-medium text-fg">{thread.from}</div>
            <div className="truncate text-[12px] text-faint">{thread.fromEmail}</div>
          </div>
          <div className="shrink-0 text-right text-[12px] leading-tight text-muted tabular-nums">
            <div>{timeAgo(thread.receivedAt, now)}</div>
            <div className="text-faint">
              {fmtDay(thread.receivedAt)}, {fmtTime(thread.receivedAt)}
            </div>
          </div>
        </div>
      </header>

      {/* Snippet only: the full body is never stored. */}
      <section aria-label="Message snippet" className="flex flex-col gap-2">
        <div data-sensitive={sensitive ? '' : undefined} className="rounded-xl border border-line bg-black/20 px-3.5 py-3">
          <div className="mb-1 text-[11px] font-medium tracking-wide text-faint uppercase">Snippet</div>
          <p className="text-[14px] leading-relaxed text-fg">{thread.snippet}</p>
        </div>
        <div className="flex items-start gap-2.5 rounded-xl border border-dashed border-line-strong px-3.5 py-3">
          <FileLock2 className="mt-0.5 size-4 shrink-0 text-faint" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-[12px] leading-snug text-muted">
              <span className="font-medium text-fg">Full body fetched on demand.</span> Mira has read this snippet only. Opening the whole message is logged in your privacy audit.
            </p>
            <div className="mt-2 flex flex-col gap-1.5" aria-hidden>
              <span className="h-1.5 w-11/12 rounded-full bg-white/6" />
              <span className="h-1.5 w-9/12 rounded-full bg-white/6" />
              <span className="h-1.5 w-10/12 rounded-full bg-white/6" />
            </div>
          </div>
        </div>
      </section>

      {thread.miraNote && (
        <section aria-label="Why Mira triaged it this way" className="rounded-xl border border-mira/20 bg-mira/[0.06] p-3">
          <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-mira uppercase">
            <Sparkles className="size-3" aria-hidden /> Why I put it here
          </div>
          <p className="text-[13px] leading-snug text-fg/90">{thread.miraNote}</p>
          {thread.relatedNote && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[12px] text-muted">
              <span>Touches</span>
              <NoteChip path={thread.relatedNote.path} title={thread.relatedNote.title} />
            </div>
          )}
        </section>
      )}

      {thread.suggestedDraft ? (
        <DraftCard thread={thread} approval={approval} state={draft} />
      ) : thread.triage === 'needs_reply' ? (
        <section className="rounded-xl border border-dashed border-line-strong p-3 text-[12px] leading-snug text-muted">
          <span className="font-medium text-fg">No draft yet.</span> I hold a draft back when your own words matter more, or when I am missing your answer. Tell me what to say and I will write it up for your approval.
        </section>
      ) : (
        <p className="flex items-center gap-1.5 text-[12px] text-faint">
          <Check className="size-3.5" aria-hidden /> Nothing to answer. I will keep it out of your way.
        </p>
      )}
    </article>
  )
}

function DraftCard({ thread, approval, state }: { thread: MailThread; approval: Approval | undefined; state: DraftState }) {
  const now = useStore((s) => s.now)
  const navigate = useStore((s) => s.navigate)
  const rule = useSnap((d) => d.settings.trustRules.find((r) => r.id === 'tr-send'))
  const editing = useLife((s) => !!s.editing[thread.id])
  const setEditing = useLife((s) => s.setEditing)
  const text = useLife((s) => s.drafts[thread.id] ?? thread.suggestedDraft ?? '')
  const setDraft = useLife((s) => s.setDraft)
  const decidedAt = useLife((s) => s.decidedAt[thread.id])
  const edited = text !== thread.suggestedDraft
  const pending = state === 'pending'
  const sent = state === 'sent'
  const dismissed = state === 'dismissed'
  const first = thread.from.split(/\s+/)[0]

  return (
    <section
      aria-label="Mira's suggested reply"
      className={cn(
        'rounded-xl border p-3',
        pending ? 'border-mira/35 bg-mira/[0.05]' : sent ? 'border-ok/30 bg-ok/[0.05]' : 'border-line bg-white/[0.02]',
      )}
    >
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-fg">
          <Sparkles className="size-3.5 text-mira" aria-hidden /> Mira's suggested reply
        </span>
        <Badge title={`Autonomy tier T4: ${TIER_LABEL.T4}. Sending needs your approval.`}>T4 · {TIER_LABEL.T4}</Badge>
        {approval && pending && <Badge tone={RISK_TONE[approval.risk]}>{approval.risk} risk</Badge>}
        {sent && (
          <Badge tone="ok">
            <Check className="size-3" aria-hidden /> Sent{decidedAt ? ` ${timeAgo(new Date(decidedAt).toISOString(), now)}` : ''}
          </Badge>
        )}
        {dismissed && (
          <Badge>
            <X className="size-3" aria-hidden /> Dismissed
          </Badge>
        )}
        {edited && !dismissed && <Badge tone="info">Edited by you</Badge>}
      </div>

      <div className={cn('rounded-lg border bg-black/25', editing ? 'border-mira/60' : 'border-line', dismissed && 'opacity-60')}>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 border-b border-line px-3 py-2 text-[12px]">
          <dt className="text-faint">To</dt>
          <dd className="truncate text-muted">{thread.from} &lt;{thread.fromEmail}&gt;</dd>
          <dt className="text-faint">Subject</dt>
          <dd className="truncate text-muted">{thread.subject}</dd>
        </dl>
        {editing ? (
          <textarea
            value={text}
            onChange={(e) => setDraft(thread.id, e.target.value)}
            rows={7}
            aria-label={`Edit the reply to ${first}`}
            className="block w-full resize-y rounded-b-lg bg-transparent px-3 py-2.5 text-[13px] leading-relaxed text-fg outline-none placeholder:text-faint"
          />
        ) : (
          <p className={cn('px-3 py-2.5 text-[13px] leading-relaxed whitespace-pre-wrap text-fg', dismissed && 'line-through decoration-faint')}>{text}</p>
        )}
      </div>

      {pending && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button variant="primary" size="md" onClick={() => void decideDraft(thread, 'approved')}>
            <Send className="size-3.5" /> Approve and send
          </Button>
          <Button variant="outline" size="md" onClick={() => setEditing(thread.id, !editing)} aria-pressed={editing}>
            <Pencil className="size-3.5" /> {editing ? 'Done editing' : 'Edit'}
          </Button>
          <Button variant="ghost" size="md" onClick={() => void decideDraft(thread, 'denied')}>
            <X className="size-3.5" /> Dismiss
          </Button>
        </div>
      )}
      {sent && (
        <p className="mt-2.5 flex items-center gap-1.5 text-[12px] text-ok">
          <Check className="size-3.5" aria-hidden /> {edited ? 'Sent with your edit. ' : 'Sent. '}I will tell you when {first} replies.
        </p>
      )}
      {dismissed && <p className="mt-2.5 text-[12px] text-muted">You dismissed this draft. Nothing was sent, and the thread still waits for you.</p>}
      {state === 'unknown' && <p className="mt-2.5 text-[12px] text-muted">This draft has no pending approval, so it cannot be sent from here.</p>}

      <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-line pt-2.5 text-[11px] leading-snug text-faint">
        <ShieldCheck className="size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1">
          Sending email always needs your approval until you promote it on the trust ladder in Settings
          {rule ? ` (${rule.approvals} approved, ${rule.rejections} rejected so far).` : '.'}
        </span>
        <Button variant="ghost" size="xs" onClick={() => navigate('settings')}>
          Trust ladder
        </Button>
      </div>
    </section>
  )
}

