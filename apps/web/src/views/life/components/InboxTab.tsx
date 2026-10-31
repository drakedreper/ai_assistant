import type { MailThread } from '@ai-assistant/shared'
import { Inbox, Lock } from 'lucide-react'
import { useMemo } from 'react'
import { EmptyState, Panel } from '../../../components/ui'
import { cn } from '../../../lib/cn'
import { timeAgo } from '../../../lib/format'
import { useSnap, useStore } from '../../../state/store'
import { TRIAGE, TRIAGE_ORDER, draftState, isSensitive } from '../lib'
import { useLife, type MailFilter } from '../ui'
import { DraftBadge, TriageBadge } from './atoms'
import { ThreadDetail } from './ThreadDetail'

export function InboxTab() {
  const mail = useSnap((d) => d.mail)
  const approvals = useSnap((d) => d.approvals)
  const now = useStore((s) => s.now)
  const filter = useLife((s) => s.mailFilter)
  const setFilter = useLife((s) => s.setMailFilter)
  const selectedId = useLife((s) => s.selectedMail)
  const selectMail = useLife((s) => s.selectMail)
  const readIds = useLife((s) => s.readIds)
  const markRead = useLife((s) => s.markRead)

  const sorted = useMemo(() => mail.slice().sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)), [mail])
  const visible = useMemo(() => (filter === 'all' ? sorted : sorted.filter((m) => m.triage === filter)), [sorted, filter])

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: mail.length }
    for (const m of mail) c[m.triage] = (c[m.triage] ?? 0) + 1
    return c
  }, [mail])

  const draftsReady = useMemo(() => mail.filter((m) => draftState(m, approvals) === 'pending').length, [mail, approvals])
  const unread = mail.filter((m) => m.unread && !readIds[m.id]).length
  const needReply = mail.filter((m) => m.triage === 'needs_reply' && draftState(m, approvals) !== 'sent').length

  // The open thread defaults to the one Mira wants you to look at: a draft waiting on approval, else the newest.
  const selected =
    (selectedId ? mail.find((m) => m.id === selectedId) : undefined) ??
    visible.find((m) => draftState(m, approvals) === 'pending') ??
    visible[0]
  const selectedVisible = selected && visible.some((m) => m.id === selected.id)

  const filters: Array<{ value: MailFilter; label: string }> = [
    { value: 'all', label: 'All' },
    ...TRIAGE_ORDER.map((t) => ({ value: t as MailFilter, label: TRIAGE[t].label })),
  ]

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div role="tablist" aria-label="Triage filter" className="flex flex-wrap gap-1.5">
          {filters.map((f) => {
            const active = filter === f.value
            const n = counts[f.value] ?? 0
            return (
              <button
                key={f.value}
                role="tab"
                type="button"
                aria-selected={active}
                onClick={() => setFilter(f.value)}
                className={cn(
                  'inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] leading-4 font-medium transition',
                  active ? 'border-mira/50 bg-mira/12 text-fg' : 'border-line text-muted hover:border-line-strong hover:text-fg',
                  n === 0 && !active && 'opacity-50',
                )}
              >
                {f.label}
                <span className={cn('tabular-nums', active ? 'text-mira' : 'text-faint')}>{n}</span>
              </button>
            )
          })}
        </div>
        <p className="text-[12px] text-faint" aria-live="polite">
          <span className="font-semibold text-muted tabular-nums">{unread}</span> unread ·{' '}
          <span className="font-semibold text-muted tabular-nums">{needReply}</span> need a reply ·{' '}
          <span className="font-semibold text-muted tabular-nums">{draftsReady}</span> {draftsReady === 1 ? 'draft' : 'drafts'} waiting on you
        </p>
      </div>

      <div className="grid items-start gap-3 @3xl/life:grid-cols-[minmax(300px,380px)_minmax(0,1fr)]">
        <Panel flush className="overflow-hidden" title="Threads" subtitle="Triaged by Mira, newest first" icon={Inbox} area="life">
          {visible.length === 0 ? (
            <EmptyState title="Nothing here." hint="Try another filter." />
          ) : (
            <ul className="divide-y divide-line border-t border-line" aria-label="Mail threads">
              {visible.map((m) => (
                <ThreadRow
                  key={m.id}
                  m={m}
                  now={now}
                  selected={selectedVisible && selected?.id === m.id}
                  unread={m.unread && !readIds[m.id]}
                  draft={draftState(m, approvals)}
                  onSelect={() => {
                    selectMail(m.id)
                    markRead(m.id)
                  }}
                />
              ))}
            </ul>
          )}
        </Panel>

        <div className="@3xl/life:sticky @3xl/life:top-0">
          {selected ? (
            <ThreadDetail thread={selected} />
          ) : (
            <Panel>
              <EmptyState title="No thread selected." hint="Pick one from the list." />
            </Panel>
          )}
        </div>
      </div>
    </div>
  )
}

function ThreadRow({
  m,
  now,
  selected,
  unread,
  draft,
  onSelect,
}: {
  m: MailThread
  now: Date
  selected: boolean | undefined
  unread: boolean
  draft: ReturnType<typeof draftState>
  onSelect: () => void
}) {
  const sensitive = isSensitive(m)
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? 'true' : undefined}
        aria-label={`${m.from}: ${m.subject}${unread ? ', unread' : ''}`}
        className={cn(
          'flex w-full cursor-pointer gap-2.5 border-l-2 px-3 py-2.5 text-left transition',
          selected ? 'border-l-mira bg-white/[0.06]' : 'border-l-transparent hover:bg-white/[0.035]',
        )}
      >
        <span className="mt-1.5 grid size-2 shrink-0 place-items-center" aria-hidden>
          {unread && <span className="size-2 rounded-full bg-mira" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className={cn('truncate text-[13px]', unread ? 'font-semibold text-fg' : 'font-medium text-muted')}>{m.from}</span>
            {sensitive && <Lock className={cn('size-3 shrink-0', m.sensitivity === 'sensitive' ? 'text-warn' : 'text-faint')} aria-label={m.sensitivity} />}
            <span className="ml-auto shrink-0 text-[11px] text-faint tabular-nums">{timeAgo(m.receivedAt, now)}</span>
          </span>
          <span data-sensitive={sensitive ? '' : undefined} className={cn('mt-0.5 block truncate text-[13px]', unread ? 'text-fg' : 'text-muted')}>
            {m.subject}
          </span>
          <span data-sensitive={sensitive ? '' : undefined} className="mt-0.5 line-clamp-2 block text-[12px] leading-snug text-faint">
            {m.snippet}
          </span>
          <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <TriageBadge triage={m.triage} draft={draft} />
            <DraftBadge draft={draft} />
          </span>
        </span>
      </button>
    </li>
  )
}

