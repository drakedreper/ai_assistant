import type { LearnedFact, MemoryChange, MemoryEntry } from '@ai-assistant/shared'
import { CalendarCheck, ChevronDown, ChevronRight, Clock, History, Inbox, Layers, Mic, Moon, Sparkles, Trash2, Wrench, Zap, type LucideIcon } from 'lucide-react'
import { useMemo, useState } from 'react'
import { api } from '../../../api'
import { NoteChip } from '../../../components/NoteChip'
import { Badge, Button, EmptyState, Panel, type Tone } from '../../../components/ui'
import { cn } from '../../../lib/cn'
import { fmtTime, fmtUsd, timeAgo } from '../../../lib/format'
import { LAYERS, tint, type LayerKey } from '../lib/layers'
import { CommitChip, LayerDot } from './atoms'

/* --------------------------------------------------------------- layer diagram */

const CHAIN: Array<{ layer: LayerKey; load: string; how: string }> = [
  { layer: 'core', load: 'always loaded', how: 'Goes into every conversation, so persona, values, profile and rules never have to be searched for.' },
  { layer: 'strategy', load: 'by topic', how: 'Pulled in when a question touches a goal or a decision, so advice is checked against what you decided.' },
  { layer: 'episodic', load: 'recent plus search', how: 'The last days arrive as a short recap. Older days are searched, never replayed in full.' },
  { layer: 'semantic', load: 'by relevance', how: 'Concept and people notes are found by keywords and meaning together, and only when they help.' },
  { layer: 'project', load: 'by active project', how: 'The hub of the project you are in comes along, linked to its live sessions in Work.' },
]

function LayersDiagram() {
  return (
    <section aria-label="How memory layers are used" className="glass px-4 py-3.5">
      <div className="mb-2.5 flex flex-wrap items-baseline gap-x-2">
        <h2 className="text-[13px] font-semibold tracking-wide text-fg">How she remembers</h2>
        <p className="text-[12px] text-faint">Each reply starts at the left and reaches only as far right as it needs to.</p>
      </div>
      <ol className="grid gap-3.5 @2xl:grid-cols-5">
        {CHAIN.map((c, i) => {
          const m = LAYERS[c.layer]
          return (
            <li key={c.layer} className="relative flex">
              <div className="flex w-full flex-col gap-1.5 rounded-xl border px-3 py-2.5" style={{ borderColor: tint(m.hex, 0.35), background: tint(m.hex, 0.07) }}>
                <div className="flex items-center gap-1.5">
                  <LayerDot layer={c.layer} size={9} />
                  <span className="text-[13px] font-semibold" style={{ color: m.hex }}>
                    {m.label}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="w-fit rounded-full bg-white/8 px-2 py-px text-[11px] leading-4 text-muted">{c.load}</span>
                  <span className="font-mono text-[10.5px] text-faint">{m.folder}</span>
                </div>
                <p className="text-[12px] leading-relaxed text-muted">{c.how}</p>
              </div>
              {i < CHAIN.length - 1 && (
                <ChevronRight className="absolute top-1/2 -right-[14px] z-10 hidden size-3.5 -translate-y-1/2 text-faint @2xl:block" aria-hidden />
              )}
            </li>
          )
        })}
      </ol>
      <p className="mt-2.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12px] text-faint">
        <LayerDot layer="inbox" />
        Captures land in the inbox and the nightly dream files them into this chain.
        <LayerDot layer="federated" className="ml-2" />
        Secondbrain is searched too, read-only.
      </p>
    </section>
  )
}

/* ------------------------------------------------------------------- timeline */

const KIND: Record<MemoryEntry['kind'], { icon: LucideIcon; label: string; ring: string; text: string; tone: Tone }> = {
  dream: { icon: Moon, label: 'Nightly dream', ring: 'border-brain/50 bg-brain/12', text: 'text-brain', tone: 'brain' },
  weekly_review: { icon: CalendarCheck, label: 'Weekly review', ring: 'border-world/50 bg-world/12', text: 'text-world', tone: 'world' },
  triage: { icon: Inbox, label: 'Inbox triage', ring: 'border-life/50 bg-life/12', text: 'text-life', tone: 'life' },
  capture: { icon: Mic, label: 'Capture', ring: 'border-mira/50 bg-mira/12', text: 'text-mira', tone: 'mira' },
  lint: { icon: Wrench, label: 'Vault lint', ring: 'border-work/50 bg-work/12', text: 'text-work', tone: 'work' },
}

const STAT_LABEL: Record<string, string> = {
  created: 'created',
  updated: 'updated',
  merged: 'merged',
  proposals: 'proposals',
  captures: 'captures read',
  filed: 'filed',
  linked: 'linked',
  left: 'left for you',
  links: 'new links',
  reflections: 'reflections',
  openLoops: 'open loops',
  stale: 'stale',
  checked: 'checked',
  orphans: 'orphans',
  fixed: 'fixed',
  indexed: 'indexed',
}

const CHANGE: Record<MemoryChange['kind'], { label: string; tone: Tone }> = {
  created: { label: 'Created', tone: 'ok' },
  updated: { label: 'Updated', tone: 'info' },
  merged: { label: 'Merged', tone: 'brain' },
  proposed: { label: 'Proposed', tone: 'mira' },
  filed: { label: 'Filed', tone: 'life' },
  archived: { label: 'Archived', tone: 'neutral' },
  indexed: { label: 'Indexed', tone: 'neutral' },
}

function EntryCard({ e, now, last }: { e: MemoryEntry; now: Date; last: boolean }) {
  const [open, setOpen] = useState(false)
  const k = KIND[e.kind]
  const Icon = k.icon
  const changes = e.changes ?? []
  const stats = Object.entries(e.stats).filter(([, v]) => v > 0)
  return (
    <li className="relative flex gap-3 pb-4 last:pb-0">
      {!last && <span aria-hidden className="absolute top-8 bottom-0 left-[15px] w-px bg-line" />}
      <span className={cn('z-10 grid size-8 shrink-0 place-items-center rounded-full border', k.ring, k.text)}>
        <Icon className="size-4" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <h3 className="text-[14px] font-semibold text-fg">{e.title}</h3>
          {e.title !== k.label && e.title !== 'Nightly dream' && <Badge tone={k.tone}>{k.label}</Badge>}
          <span className="text-[11px] text-faint" title={new Date(e.at).toLocaleString()}>
            {timeAgo(e.at, now)} · {fmtTime(e.at)}
          </span>
        </div>
        <p className="mt-1 text-[13px] leading-relaxed text-muted">{e.summary}</p>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {stats.map(([key, v]) => (
            <span key={key} className="inline-flex items-baseline gap-1 rounded-md bg-white/6 px-1.5 py-0.5 text-[11px] leading-4 text-muted">
              <span className="font-semibold text-fg tabular-nums">{v}</span>
              {STAT_LABEL[key] ?? key}
            </span>
          ))}
          <span className="text-[11px] text-faint tabular-nums" title="Estimated model cost of this job">
            {e.costUsd > 0 ? fmtUsd(e.costUsd) : 'no model cost'}
          </span>
          {e.durationSec !== undefined && <span className="text-[11px] text-faint tabular-nums">{e.durationSec >= 60 ? `${Math.round(e.durationSec / 60)} min` : `${e.durationSec} s`}</span>}
          {e.commit && <CommitChip sha={e.commit} />}
          {changes.length > 0 && (
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
              className="ml-auto inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted transition hover:bg-white/6 hover:text-fg"
            >
              What changed ({changes.length})
              <ChevronDown className={cn('size-3 transition-transform', open && 'rotate-180')} aria-hidden />
            </button>
          )}
        </div>
        {open && (
          <ul className="mt-2.5 flex flex-col gap-1.5 rounded-xl border border-line bg-white/[0.025] p-2.5">
            {changes.map((c, i) => (
              <li key={`${c.path}-${i}`} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <Badge tone={CHANGE[c.kind].tone} className="w-[72px] justify-center">
                  {CHANGE[c.kind].label}
                </Badge>
                <NoteChip path={c.path} title={c.title} />
                {c.note && <span className="min-w-0 text-[12px] text-muted">{c.note}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </li>
  )
}

/* ------------------------------------------------------------------- schedule */

function nextAt(now: Date, hour: number, weekday?: number): Date {
  const d = new Date(now)
  d.setHours(hour, 0, 0, 0)
  if (weekday === undefined) {
    if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1)
  } else {
    let add = (weekday - d.getDay() + 7) % 7
    if (add === 0 && d.getTime() <= now.getTime()) add = 7
    d.setDate(d.getDate() + add)
  }
  return d
}

function Schedule({ memory, now }: { memory: MemoryEntry[]; now: Date }) {
  const dream = nextAt(now, 3)
  const weekly = nextAt(now, 18, 0)
  const lastTriage = memory.filter((m) => m.kind === 'triage').sort((a, b) => b.at.localeCompare(a.at))[0]
  const triageMin = lastTriage ? Math.round((new Date(lastTriage.at).getTime() + 2 * 3_600_000 - now.getTime()) / 60_000) : null
  const firstOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1, 4, 0, 0)
  const rows: Array<{ icon: LucideIcon; text: string; title: string; when: string; rel: string; color: string }> = [
    { icon: Moon, title: 'Next dream', text: 'Compress the day, merge duplicates, queue proposals', when: 'Tonight 03:00', rel: timeAgo(dream.toISOString(), now), color: 'text-brain' },
    { icon: CalendarCheck, title: 'Weekly review', text: 'Progress against strategy, stale projects, open loops', when: 'Sunday 18:00', rel: timeAgo(weekly.toISOString(), now), color: 'text-world' },
    { icon: Inbox, title: 'Inbox triage', text: 'File captures while you work', when: 'Every 2 hours', rel: triageMin !== null && triageMin > 0 ? `in ${triageMin} min` : 'any minute', color: 'text-life' },
    { icon: Wrench, title: 'Vault lint', text: 'Broken links, orphans, stale review dates', when: '1st of the month', rel: timeAgo(firstOfMonth.toISOString(), now), color: 'text-work' },
  ]
  return (
    <Panel title="What happens next" subtitle="Scheduled by the daemon, all local" icon={Clock} area="brain">
      <ul className="flex flex-col gap-2.5">
        {rows.map((r) => {
          const Icon = r.icon
          return (
            <li key={r.title} className="flex items-start gap-2.5">
              <Icon className={cn('mt-0.5 size-4 shrink-0', r.color)} aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-baseline gap-x-2 text-[13px] text-fg">
                  <span className="font-medium">{r.title}</span>
                  <span className="text-muted">{r.when}</span>
                  <span className="ml-auto text-[11px] text-faint tabular-nums">{r.rel}</span>
                </p>
                <p className="text-[12px] leading-snug text-faint">{r.text}</p>
              </div>
            </li>
          )
        })}
      </ul>
      <p className="mt-3 flex items-start gap-2 rounded-xl border border-dashed border-line-strong px-3 py-2 text-[12px] leading-relaxed text-muted">
        <Zap className="mt-0.5 size-3.5 shrink-0 text-warn" aria-hidden />
        <span>
          <strong className="font-semibold text-fg">Catch-up runs.</strong> If the PC was asleep at 03:00, the missed job runs when it wakes, oldest first, before anything new.
        </span>
      </p>
    </Panel>
  )
}

/* -------------------------------------------------------------------- learned */

function Learned({ facts, now }: { facts: LearnedFact[]; now: Date }) {
  return (
    <Panel title="What I have learned about you" subtitle="Inspect it, or have me forget it" icon={Sparkles} area="brain">
      {facts.length === 0 ? (
        <EmptyState title="Nothing inferred right now" hint="New observations show up here the morning after the dream." />
      ) : (
        <ul className="flex flex-col gap-3">
          {facts.map((f) => (
            <li key={f.id} className="rounded-xl border border-line bg-white/[0.025] p-3">
              <p className="text-[13px] leading-relaxed text-fg" data-sensitive>
                {f.text}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <Badge tone={f.confidence === 'high' ? 'ok' : f.confidence === 'medium' ? 'warn' : 'neutral'}>{f.confidence} confidence</Badge>
                <NoteChip path={f.source.path} title={f.source.title} />
                <span className="text-[11px] text-faint">{timeAgo(f.learnedAt, now)}</span>
                <Button size="xs" variant="ghost" className="ml-auto hover:text-bad" onClick={() => void api.forgetFact(f.id)} aria-label={`Forget: ${f.text}`}>
                  <Trash2 className="size-3" aria-hidden /> Forget
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-[12px] leading-relaxed text-faint">Forgetting removes the observation from memory and from future context. The note it came from stays as you wrote it.</p>
    </Panel>
  )
}

export function MemoryTab({ memory, learned, now }: { memory: MemoryEntry[]; learned: LearnedFact[]; now: Date }) {
  const sorted = useMemo(() => [...memory].sort((a, b) => b.at.localeCompare(a.at)), [memory])
  const week = useMemo(() => {
    const cutoff = now.getTime() - 7 * 86_400_000
    const recent = memory.filter((m) => new Date(m.at).getTime() >= cutoff)
    return { jobs: recent.length, cost: recent.reduce((a, m) => a + m.costUsd, 0) }
  }, [memory, now])
  return (
    <div className="@container flex flex-col gap-3">
      <LayersDiagram />
      <div className="grid gap-3 @4xl:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)] @4xl:items-start">
        <Panel
          title="Memory timeline"
          subtitle="Everything she did to the vault, newest first"
          icon={History}
          area="brain"
          actions={
            <span className="text-[11px] text-faint tabular-nums">
              {week.jobs} jobs this week · {fmtUsd(week.cost)}
            </span>
          }
        >
          <ol className="mt-1">
            {sorted.map((e, i) => (
              <EntryCard key={e.id} e={e} now={now} last={i === sorted.length - 1} />
            ))}
          </ol>
          <p className="mt-3 flex items-center gap-1.5 text-[12px] text-faint">
            <Layers className="size-3.5" aria-hidden /> Each job is one git commit. Revert the commit and the vault is exactly as it was.
          </p>
        </Panel>
        <div className="flex min-w-0 flex-col gap-3">
          <Schedule memory={memory} now={now} />
          <Learned facts={learned} now={now} />
        </div>
      </div>
    </div>
  )
}
