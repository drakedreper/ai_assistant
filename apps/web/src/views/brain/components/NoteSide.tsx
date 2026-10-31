import type { MemoryEntry, Note, Proposal } from '@ai-assistant/shared'
import { ArrowUpRight, GitPullRequest, History, Link2, Moon, Sparkles, User } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { Panel } from '../../../components/ui'
import { cn } from '../../../lib/cn'
import { timeAgo } from '../../../lib/format'
import { layerKeyOf } from '../lib/layers'
import { fakeSha, type VaultIndex } from '../lib/vault'
import { useBrain } from '../ui'
import { CommitChip, LayerDot, PROVENANCE } from './atoms'

const BACK_LIMIT = 4
const OUT_LIMIT = 6

function MoreToggle({ shown, total, open, onToggle }: { shown: number; total: number; open: boolean; onToggle: () => void }) {
  if (total <= shown && !open) return null
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="mx-4 mb-2.5 cursor-pointer rounded-md px-1.5 py-0.5 text-left text-[12px] text-brain transition hover:bg-brain/10"
    >
      {open ? 'Show fewer' : `Show all ${total}`}
    </button>
  )
}

function Count({ n }: { n: number }) {
  return <span className="rounded-full bg-white/8 px-1.5 text-[11px] leading-4 text-muted tabular-nums">{n}</span>
}

interface Touch {
  at: string
  icon: ReactNode
  actor: string
  text: string
  commit?: string
  tone?: 'mira' | 'ok' | 'bad'
}

function useTouches(note: Note, proposals: Proposal[], memory: MemoryEntry[]): Touch[] {
  const decisions = useBrain((s) => s.decisions)
  return useMemo(() => {
    const prov = PROVENANCE[note.provenance]
    const ProvIcon = prov.icon
    const list: Touch[] = []
    // Jobs that touched the note are the most precise source, so the generic "created/edited" lines only fill gaps.
    const fromJobs: Touch[] = []
    for (const m of memory) {
      const c = m.changes?.find((x) => x.path === note.path)
      if (!c || c.kind === 'proposed') continue
      const verb = { created: 'created it', updated: 'updated it', merged: 'merged duplicates into it', filed: 'filed it', archived: 'archived it', indexed: 'indexed it' }[c.kind]
      fromJobs.push({
        at: m.at,
        icon: m.kind === 'dream' ? <Moon className="size-3" aria-hidden /> : <Sparkles className="size-3" aria-hidden />,
        actor: m.title,
        text: verb,
        ...(m.commit ? { commit: m.commit } : {}),
      })
    }
    const jobCreated = memory.some((m) => m.changes?.some((x) => x.path === note.path && (x.kind === 'created' || x.kind === 'indexed')))
    const nearUpdate = fromJobs.some((t) => Math.abs(new Date(t.at).getTime() - new Date(note.updated).getTime()) < 3 * 3_600_000)
    if (!jobCreated) list.push({ at: note.created, icon: <ProvIcon className="size-3" aria-hidden />, actor: prov.label, text: 'created the note' })
    if (!nearUpdate && Math.abs(new Date(note.updated).getTime() - new Date(note.created).getTime()) > 120_000) {
      list.push({ at: note.updated, icon: <ProvIcon className="size-3" aria-hidden />, actor: prov.label, text: 'edited the note' })
    }
    list.push(...fromJobs)
    for (const p of proposals) {
      if (p.targetPath !== note.path) continue
      if (p.status === 'pending') list.push({ at: p.createdAt, icon: <GitPullRequest className="size-3" aria-hidden />, actor: 'Mira', text: 'proposed a change, waiting for you', tone: 'mira' })
      else {
        list.push({ at: p.createdAt, icon: <GitPullRequest className="size-3" aria-hidden />, actor: 'Mira', text: 'proposed a change', tone: 'mira' })
        list.push({
          at: p.decidedAt ?? (decisions[p.id] ? new Date(decisions[p.id]?.at ?? 0).toISOString() : p.createdAt),
          icon: <User className="size-3" aria-hidden />,
          actor: 'You',
          text: p.status === 'approved' ? 'approved the proposal' : 'rejected the proposal',
          ...(p.status === 'approved' ? { commit: p.commit ?? fakeSha(p.id) } : {}),
          tone: p.status === 'approved' ? 'ok' : 'bad',
        })
      }
    }
    return list.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 7)
  }, [note, proposals, memory, decisions])
}

export function NoteSide({ note, index, proposals, memory, now, inline }: { note: Note; index: VaultIndex; proposals: Proposal[]; memory: MemoryEntry[]; now: Date; inline?: boolean }) {
  const open = useBrain((s) => s.open)
  const [allBacks, setAllBacks] = useState(false)
  const [allOuts, setAllOuts] = useState(false)
  const backs = index.backlinks.get(note.path) ?? []
  const outs = index.outgoing.get(note.path) ?? []
  const shownBacks = allBacks ? backs : backs.slice(0, BACK_LIMIT)
  const shownOuts = allOuts ? outs : outs.slice(0, OUT_LIMIT)
  const touches = useTouches(note, proposals, memory)
  const federated = note.source === 'secondbrain'

  return (
    <aside aria-label="Connections" className={cn('flex flex-col gap-3', !inline && 'h-full min-h-0 overflow-y-auto pr-0.5')}>
      <Panel title="Backlinks" subtitle="Notes that link here" icon={Link2} area="brain" actions={<Count n={backs.length} />} flush className="shrink-0">
        {backs.length === 0 ? (
          <p className="px-4 pb-3 text-[12px] text-faint">Nothing links here yet. Orphan notes are surfaced by the monthly lint.</p>
        ) : (
          <ul className="flex flex-col pb-1.5">
            {shownBacks.map((b) => (
              <li key={b.from.path}>
                <button
                  type="button"
                  onClick={() => open(b.from.path)}
                  className="flex w-full cursor-pointer flex-col gap-0.5 px-4 py-2 text-left transition hover:bg-white/5"
                >
                  <span className="flex items-center gap-1.5">
                    <LayerDot layer={layerKeyOf(b.from)} />
                    <span className="min-w-0 truncate text-[13px] font-medium text-fg">{b.from.title}</span>
                  </span>
                  <span className="line-clamp-2 text-[12px] leading-snug text-muted" data-sensitive={b.from.sensitivity !== 'normal' ? '' : undefined}>
                    {b.context.before}
                    {b.context.hit && <span className="rounded bg-brain/15 px-0.5 text-brain">{b.context.hit}</span>}
                    {b.context.after}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <MoreToggle shown={BACK_LIMIT} total={backs.length} open={allBacks} onToggle={() => setAllBacks((v) => !v)} />
      </Panel>

      <Panel title="Outgoing links" subtitle="Notes this one points to" icon={ArrowUpRight} area="brain" actions={<Count n={outs.length} />} flush className="shrink-0">
        {outs.length === 0 ? (
          <p className="px-4 pb-3 text-[12px] text-faint">No links. {federated ? 'Federated notes are read as they are.' : 'A good note usually links to at least two others.'}</p>
        ) : (
          <ul className="flex flex-col pb-1.5">
            {shownOuts.map((o) => (
              <li key={o.note?.path ?? o.target}>
                {o.note ? (
                  <button
                    type="button"
                    onClick={() => open(o.note?.path ?? '', o.heading ? { heading: o.heading } : {})}
                    className="flex w-full cursor-pointer items-center gap-1.5 px-4 py-1.5 text-left transition hover:bg-white/5"
                  >
                    <LayerDot layer={layerKeyOf(o.note)} />
                    <span className="min-w-0 flex-1 truncate text-[13px] text-muted hover:text-fg">{o.note.title}</span>
                    {o.heading && <span className="max-w-[40%] truncate text-[11px] text-faint">{o.heading}</span>}
                  </button>
                ) : (
                  <span className="mx-4 my-1 flex items-center gap-1.5 rounded border border-dashed border-faint/60 px-1.5 py-0.5 text-[12px] text-muted" title="Not in the vault yet">
                    {o.alias ?? o.target}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        <MoreToggle shown={OUT_LIMIT} total={outs.length} open={allOuts} onToggle={() => setAllOuts((v) => !v)} />
      </Panel>

      <Panel title="Who touched this" subtitle="From git history" icon={History} area="brain" flush className="shrink-0">
        <ol className="relative flex flex-col gap-2.5 px-4 pb-3.5">
          <span aria-hidden className="absolute top-1 bottom-4 left-[22px] w-px bg-line" />
          {touches.map((t, i) => (
            <li key={i} className="relative flex items-start gap-2.5">
              <span
                className={cn(
                  'z-10 mt-0.5 grid size-[14px] shrink-0 place-items-center rounded-full border bg-surface',
                  t.tone === 'mira' ? 'border-mira/50 text-mira' : t.tone === 'ok' ? 'border-ok/50 text-ok' : t.tone === 'bad' ? 'border-bad/50 text-bad' : 'border-line-strong text-muted',
                )}
              >
                <span className="scale-[0.8]">{t.icon}</span>
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[12px] leading-snug text-muted">
                  <span className="font-medium text-fg">{t.actor}</span> {t.text}
                </p>
                <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-faint">
                  <span>{timeAgo(t.at, now)}</span>
                  {t.commit && <CommitChip sha={t.commit} />}
                </p>
              </div>
            </li>
          ))}
        </ol>
      </Panel>
    </aside>
  )
}
