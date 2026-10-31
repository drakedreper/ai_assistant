import type { Approval, TrustRule } from '@ai-assistant/shared'
import { BookOpen, FileText, Lock, NotebookPen, Send } from 'lucide-react'
import { useEffect, useMemo, type ReactNode } from 'react'
import { ApprovalCard } from '../../../components/ApprovalCard'
import { Badge, Button, EmptyState, Panel, Segmented } from '../../../components/ui'
import { cn } from '../../../lib/cn'
import { TIER_LABEL } from '../../../lib/status'
import { useSnap } from '../../../state/store'
import { useWork } from '../ui'

const TIERS: Array<{ tier: 'T1' | 'T2' | 'T3' | 'T4'; icon: ReactNode; title: string; body: string; examples: string }> = [
  {
    tier: 'T1',
    icon: <NotebookPen className="size-3.5" aria-hidden />,
    title: 'Journal and inbox',
    body: 'Append-only and fully reversible. Mira can do it herself once you trust it.',
    examples: 'Log a line in today\'s journal, file a captured idea.',
  },
  {
    tier: 'T2',
    icon: <BookOpen className="size-3.5" aria-hidden />,
    title: 'Knowledge notes',
    body: 'Every edit is a git commit in your vault, one click to undo.',
    examples: 'Update a concept note, tidy a project README.',
  },
  {
    tier: 'T3',
    icon: <FileText className="size-3.5" aria-hidden />,
    title: 'Core and strategy',
    body: 'Always arrives as a proposal with a diff. Never silent, never batched.',
    examples: 'Rewording your Q4 positioning.',
  },
  {
    tier: 'T4',
    icon: <Send className="size-3.5" aria-hidden />,
    title: 'Outward action',
    body: 'Anything that leaves the vault or touches your machine. Asks every time unless you promote one specific action.',
    examples: 'Send an email, add a calendar hold, run rm, install a package, git push.',
  },
]

function Group({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2" aria-label={title}>
      <h3 className="flex items-center gap-2 text-[11px] font-semibold tracking-wide text-faint uppercase">
        {title}
        <Badge>{count}</Badge>
      </h3>
      {children}
    </section>
  )
}

function Item({ a, highlighted }: { a: Approval; highlighted: boolean }) {
  const session = useSnap((d) => d.sessions.find((s) => s.id === a.sessionId))
  const selectSession = useWork((s) => s.selectSession)
  const setTab = useWork((s) => s.setTab)
  return (
    <div id={`approval-${a.id}`} className={cn('rounded-xl transition', highlighted && 'ring-2 ring-work/70 ring-offset-2 ring-offset-canvas')}>
      <ApprovalCard id={a.id} variant="full" />
      {session && (
        <p className="mt-1 flex items-center gap-1 px-1 text-[11px] text-faint">
          From session
          <button
            type="button"
            onClick={() => {
              selectSession(session.id)
              setTab('overview')
            }}
            className="cursor-pointer truncate font-medium text-work hover:underline"
          >
            {session.title}
          </button>
        </p>
      )}
    </div>
  )
}

function TierPanel({ pendingByTier, rules }: { pendingByTier: Record<string, number>; rules: TrustRule[] }) {
  return (
    <Panel title="Autonomy tiers" subtitle="what Mira may do alone, and what always asks" area="work" className="@4xl:sticky @4xl:top-0">
      <ol className="flex flex-col gap-2.5">
        {TIERS.map((t) => {
          const rule = rules.find((r) => r.tier === t.tier && !r.locked) ?? rules.find((r) => r.tier === t.tier)
          return (
            <li key={t.tier} className="rounded-xl border border-line bg-white/[0.025] p-3">
              <div className="flex items-center gap-2">
                <span className="grid size-6 place-items-center rounded-md bg-white/6 text-muted">{t.icon}</span>
                <h3 className="text-[13px] font-semibold text-fg">
                  {t.tier} <span className="font-normal text-muted">· {TIER_LABEL[t.tier]}</span>
                </h3>
                {pendingByTier[t.tier] ? <Badge tone="warn" className="ml-auto">{pendingByTier[t.tier]} waiting</Badge> : rule ? <Badge className="ml-auto" tone={rule.mode === 'auto' ? 'ok' : 'neutral'}>{rule.mode === 'auto' ? 'auto' : 'asks'}</Badge> : null}
              </div>
              <p className="mt-1.5 text-[12.5px] leading-snug text-muted">{t.body}</p>
              <p className="mt-1 text-[11px] text-faint">e.g. {t.examples}</p>
              {rule && (
                <p className="mt-1.5 text-[11px] text-faint tabular-nums">
                  {rule.action}: {rule.approvals} approved, {rule.rejections} rejected
                  {rule.promotionSuggested && <span className="text-mira"> · Mira suggests letting her do this alone</span>}
                </p>
              )}
            </li>
          )
        })}
      </ol>
      <div className="mt-3 space-y-1.5 rounded-xl border border-line bg-white/[0.025] p-3 text-[12px] leading-relaxed text-muted">
        <p>
          <b className="text-fg">Agent permissions are T4.</b> A Claude Code session asking to run Bash, edit outside its repo or fetch the web acts on your
          machine. Read, Grep and Glob are T0 and never ask.
        </p>
        <p className="flex items-start gap-1.5">
          <Lock className="mt-0.5 size-3.5 shrink-0 text-faint" aria-hidden />
          Moving money is locked in v0.x. No approval can unlock it.
        </p>
      </div>
    </Panel>
  )
}

export function ApprovalsTab() {
  const approvals = useSnap((d) => d.approvals)
  const rules = useSnap((d) => d.settings.trustRules)
  const includeAll = useWork((s) => s.includeAllAreas)
  const setIncludeAll = useWork((s) => s.setIncludeAllAreas)
  const highlight = useWork((s) => s.highlight.approval)

  const scoped = useMemo(() => approvals.filter((a) => includeAll || a.area === 'work'), [approvals, includeAll])
  const pending = useMemo(() => scoped.filter((a) => a.status === 'pending').sort((a, b) => (a.requestedAt < b.requestedAt ? 1 : -1)), [scoped])
  const history = useMemo(() => scoped.filter((a) => a.status !== 'pending').sort((a, b) => (a.requestedAt < b.requestedAt ? 1 : -1)), [scoped])
  const pendingByTier = useMemo(() => {
    const out: Record<string, number> = {}
    for (const a of scoped) if (a.status === 'pending') out[a.tier] = (out[a.tier] ?? 0) + 1
    return out
  }, [scoped])
  const otherAreas = approvals.filter((a) => a.area !== 'work' && a.status === 'pending').length

  useEffect(() => {
    if (!highlight) return
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    document.getElementById(`approval-${highlight}`)?.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' })
  }, [highlight, scoped.length])

  return (
    <div className="grid items-start gap-3 @4xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <div className="flex min-w-0 flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            ariaLabel="Approval scope"
            value={includeAll ? 'all' : 'work'}
            onChange={(v) => setIncludeAll(v === 'all')}
            options={[
              { value: 'work', label: 'Work only' },
              { value: 'all', label: `All areas${otherAreas ? ` (+${otherAreas})` : ''}` },
            ]}
          />
          <p className="text-[12px] text-faint">
            {includeAll ? 'Agent permissions, email drafts, brain proposals and calendar holds.' : 'Permissions requested by Claude Code sessions.'}
          </p>
        </div>

        <Group title="Waiting for you" count={pending.length}>
          {pending.length === 0 ? (
            <div className="glass">
              <EmptyState title="Nothing is waiting" hint="Agents keep going on their own until they need a decision." />
            </div>
          ) : (
            pending.map((a) => <Item key={a.id} a={a} highlighted={highlight === a.id} />)
          )}
        </Group>

        <Group title="History" count={history.length}>
          {history.length === 0 ? (
            <div className="glass">
              <EmptyState title="No decisions yet" />
            </div>
          ) : (
            history.map((a) => <Item key={a.id} a={a} highlighted={highlight === a.id} />)
          )}
        </Group>
        {!includeAll && otherAreas > 0 && (
          <Button variant="ghost" className="self-start" onClick={() => setIncludeAll(true)}>
            Show {otherAreas} more from other areas
          </Button>
        )}
      </div>

      <TierPanel pendingByTier={pendingByTier} rules={rules} />
    </div>
  )
}
