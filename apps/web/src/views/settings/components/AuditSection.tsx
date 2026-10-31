import type { AuditEntry } from '@ai-assistant/shared'
import { Bot, Moon, ScrollText, Sparkles, User, type LucideIcon } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Badge, EmptyState, Panel, Segmented, type Tone } from '../../../components/ui'
import { fmtTime, timeAgo } from '../../../lib/format'
import { useSnap, useStore } from '../../../state/store'
import { SectionHeader } from './Atoms'

const ACTOR: Record<AuditEntry['actor'], { label: string; icon: LucideIcon }> = {
  you: { label: 'You', icon: User },
  mira: { label: 'Mira', icon: Sparkles },
  agent: { label: 'Agent', icon: Bot },
  job: { label: 'Night job', icon: Moon },
}

const OUTCOME: Record<AuditEntry['outcome'], { label: string; tone: Tone }> = {
  approved: { label: 'Approved', tone: 'ok' },
  auto: { label: 'Auto', tone: 'info' },
  denied: { label: 'Denied', tone: 'warn' },
  blocked: { label: 'Blocked', tone: 'bad' },
}

type Filter = 'all' | AuditEntry['outcome']

/** AUDIT LOG: every action with who did it, what happened and what, if anything, was sent to the cloud. */
export function AuditSection() {
  const audit = useSnap((d) => d.settings.audit)
  const now = useStore((s) => s.now)
  const [filter, setFilter] = useState<Filter>('all')
  const sorted = useMemo(() => audit.slice().sort((a, b) => (a.at < b.at ? 1 : -1)), [audit])
  const rows = useMemo(() => sorted.filter((a) => filter === 'all' || a.outcome === filter), [sorted, filter])
  const cloud = audit.filter((a) => a.sentToCloud).length

  return (
    <div className="@container flex flex-col gap-3">
      <SectionHeader icon={ScrollText} title="Audit log">
        An append-only record of what happened, who did it, and what was sent to the cloud. It lives in the local daemon database.
      </SectionHeader>
      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          ariaLabel="Filter by outcome"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: `All ${audit.length}` },
            { value: 'approved', label: 'Approved' },
            { value: 'auto', label: 'Auto' },
            { value: 'denied', label: 'Denied' },
            { value: 'blocked', label: 'Blocked' },
          ]}
        />
        <p className="text-[12px] text-faint tabular-nums">{cloud} of {audit.length} entries sent something to the cloud model.</p>
      </div>
      <Panel flush>
        {rows.length === 0 ? (
          <EmptyState title="Nothing with that outcome" hint="Try another filter." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left">
              <caption className="sr-only">Audit log, newest first</caption>
              <thead className="border-b border-line text-[11px] tracking-wide text-faint uppercase">
                <tr>
                  <th scope="col" className="px-4 py-1.5 font-medium">When</th>
                  <th scope="col" className="px-2 py-1.5 font-medium">Who</th>
                  <th scope="col" className="px-2 py-1.5 font-medium">Action</th>
                  <th scope="col" className="px-2 py-1.5 font-medium">Outcome</th>
                  <th scope="col" className="px-4 py-1.5 font-medium">Sent to the cloud</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((a) => {
                  const actor = ACTOR[a.actor]
                  const Icon = actor.icon
                  const out = OUTCOME[a.outcome]
                  return (
                    <tr key={a.id} className="align-top hover:bg-white/[0.025]">
                      <td className="px-4 py-2.5 whitespace-nowrap" title={new Date(a.at).toLocaleString()}>
                        <div className="text-[12px] text-fg tabular-nums">{timeAgo(a.at, now)}</div>
                        <div className="text-[11px] text-faint tabular-nums">{fmtTime(a.at)}</div>
                      </td>
                      <td className="px-2 py-2.5">
                        <span className="inline-flex items-center gap-1.5 text-[12px] text-muted">
                          <Icon className="size-3.5" aria-hidden /> {actor.label}
                        </span>
                      </td>
                      <td className="px-2 py-2.5">
                        <div className="text-[13px] font-medium text-fg">{a.action}</div>
                        <div className="max-w-[44ch] truncate font-mono text-[11px] text-muted" title={a.target} {...(a.sensitive ? { 'data-sensitive': true } : {})}>
                          {a.target}
                        </div>
                        {a.detail && <div className="mt-0.5 text-[11px] leading-snug text-faint" {...(a.sensitive ? { 'data-sensitive': true } : {})}>{a.detail}</div>}
                      </td>
                      <td className="px-2 py-2.5">
                        <Badge tone={out.tone}>{out.label}</Badge>
                      </td>
                      <td className="px-4 py-2.5 text-[12px] leading-snug">
                        {a.sentToCloud ? <span className="text-warn" {...(a.sensitive ? { 'data-sensitive': true } : {})}>{a.sentToCloud}</span> : <span className="text-faint">Nothing sent</span>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  )
}
