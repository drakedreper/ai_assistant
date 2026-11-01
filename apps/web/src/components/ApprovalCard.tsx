import { ArrowUpRight, Check, ShieldAlert, X } from 'lucide-react'
import { TERMINAL_ONLY_COPY, api, useApiMode } from '../api'
import { cn } from '../lib/cn'
import { timeAgo } from '../lib/format'
import { APPROVAL_KIND_LABEL, RISK_TONE, TIER_LABEL } from '../lib/status'
import { useStore } from '../state/store'
import { Badge, Button } from './ui'

/**
 * One thing that waits for you: an agent permission, an email draft, a brain proposal, a calendar hold.
 * Used in Today (Needs-you queue), inline in chat, and in Work. Approving or denying goes through the
 * ApiClient, so the same card works against the real daemon.
 */
export function ApprovalCard({ id, variant = 'full', className }: { id: string; variant?: 'full' | 'compact'; className?: string }) {
  const ap = useStore((s) => s.data?.approvals.find((a) => a.id === id))
  const now = useStore((s) => s.now)
  const navigate = useStore((s) => s.navigate)
  const mode = useApiMode()
  const session = useStore((s) => s.data?.sessions.find((x) => x.id === ap?.sessionId))
  if (!ap) return null

  const pending = ap.status === 'pending'
  // Hooks are non-blocking, so a permission asked in the user's own terminal can only be answered there.
  const terminalOnly = pending && mode === 'daemon' && session?.source === 'hook'
  const review = () => {
    if (ap.area === 'work') navigate('work', { tab: 'approvals', approval: ap.id, ...(ap.sessionId ? { session: ap.sessionId } : {}) })
    else if (ap.area === 'brain') navigate('brain', { tab: 'proposals', ...(ap.refId ? { proposal: ap.refId } : {}) })
    else if (ap.area === 'life') navigate('life', { tab: ap.kind === 'email_draft' ? 'inbox' : 'calendar', ...(ap.refId ? { mail: ap.refId } : {}) })
    else navigate(ap.area)
  }

  return (
    <article
      className={cn(
        'fade-up rounded-xl border bg-white/[0.03] p-3',
        pending ? (ap.risk === 'high' ? 'border-bad/35' : 'border-line-strong') : 'border-line opacity-70',
        className,
      )}
      aria-label={`${APPROVAL_KIND_LABEL[ap.kind]}: ${ap.title}`}
    >
      <div className="flex items-start gap-2">
        {ap.risk === 'high' && pending && <ShieldAlert className="mt-0.5 size-4 shrink-0 text-bad" />}
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-1.5">
            <Badge tone={ap.area}>{APPROVAL_KIND_LABEL[ap.kind]}</Badge>
            <Badge tone={RISK_TONE[ap.risk]}>{ap.risk} risk</Badge>
            <Badge title={`Autonomy tier ${ap.tier}`}>
              {ap.tier} · {TIER_LABEL[ap.tier]}
            </Badge>
            <span className="text-[11px] text-faint">{timeAgo(ap.requestedAt, now)}</span>
          </div>
          <h3 className="text-[13px] leading-snug font-semibold text-fg">{ap.title}</h3>
          {variant === 'full' && <p className="mt-0.5 text-xs text-muted">{ap.detail}</p>}
          {ap.preview && (
            <pre
              className="mt-2 max-h-24 overflow-auto rounded-lg border border-line bg-black/30 px-2.5 py-1.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-fg/90"
              data-sensitive={ap.sensitive ? true : undefined}
            >
              {ap.preview}
            </pre>
          )}
        </div>
      </div>

      <div className="mt-2.5 flex items-center gap-1.5">
        {pending && terminalOnly ? (
          <p className="text-[11px] text-muted" data-testid="terminal-only-note">{TERMINAL_ONLY_COPY}</p>
        ) : pending ? (
          <>
            <Button variant="ok" onClick={() => void api.decideApproval(ap.id, 'approved')}>
              <Check className="size-3.5" /> Approve
            </Button>
            <Button variant="danger" onClick={() => void api.decideApproval(ap.id, 'denied')}>
              <X className="size-3.5" /> Deny
            </Button>
            <Button variant="ghost" className="ml-auto" onClick={review}>
              Review <ArrowUpRight className="size-3.5" />
            </Button>
          </>
        ) : (
          <Badge tone={ap.status === 'approved' ? 'ok' : 'bad'}>
            {ap.status === 'approved' ? <Check className="size-3" /> : <X className="size-3" />}
            {ap.status === 'approved' ? 'Approved' : 'Denied'}
          </Badge>
        )}
      </div>
    </article>
  )
}
