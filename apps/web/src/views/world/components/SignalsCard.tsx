import { Activity, ChevronRight, Eye, Filter, ShieldCheck, TrendingUp } from 'lucide-react'
import { NoteChip } from '../../../components/NoteChip'
import { Badge, Panel } from '../../../components/ui'
import { cn } from '../../../lib/cn'
import { useSnap } from '../../../state/store'
import { useWorld } from '../ui'

const STRENGTH = {
  strong: { label: 'Strong', tone: 'ok', icon: TrendingUp },
  growing: { label: 'Growing', tone: 'info', icon: Activity },
  watching: { label: 'Watching', tone: 'neutral', icon: Eye },
} as const

/** Two or three cross-cutting themes Mira noticed, each tied to the user's own notes. */
export function SignalsCard() {
  const signals = useSnap((d) => d.world.signals)
  const activeId = useWorld((s) => s.signalId)
  const setSignal = useWorld((s) => s.setSignal)
  if (!signals || signals.length === 0) return null

  return (
    <Panel title="Signals" subtitle="Themes Mira noticed across stories" icon={Activity} area="world">
      <ul className="flex flex-col gap-2.5">
        {signals.map((g) => {
          const S = STRENGTH[g.strength]
          const active = activeId === g.id
          return (
            <li key={g.id} className={cn('rounded-xl border p-3 transition', active ? 'border-brain/50 bg-brain/[0.08]' : 'border-line bg-white/[0.03]')}>
              <div className="flex items-start gap-2">
                <h3 className="min-w-0 flex-1 text-[13px] leading-snug font-semibold text-fg">{g.title}</h3>
                <Badge tone={S.tone}>
                  <S.icon className="size-3" aria-hidden /> {S.label}
                </Badge>
              </div>
              <p className="mt-1 text-[12px] leading-snug text-muted">{g.summary}</p>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  aria-pressed={active}
                  onClick={() => setSignal(g.id)}
                  className={cn(
                    'inline-flex cursor-pointer items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] leading-4 font-medium transition',
                    active ? 'border-brain/50 bg-brain/20 text-fg' : 'border-line-strong text-muted hover:bg-white/6 hover:text-fg',
                  )}
                >
                  {active ? 'Showing' : 'Show'} {g.itemIds.length} stories
                  <ChevronRight className="size-3" aria-hidden />
                </button>
                {g.notes.map((n) => (
                  <NoteChip key={n.path} path={n.path} title={n.title} />
                ))}
              </div>
            </li>
          )
        })}
      </ul>
    </Panel>
  )
}

/** How the ranking works, in three honest lines. */
export function RankingNote() {
  return (
    <Panel title="How I rank" icon={Filter} area="world">
      <ul className="flex flex-col gap-2 text-[12px] leading-snug text-muted">
        <li className="flex items-start gap-2">
          <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-world" aria-hidden />
          Matched against your strategy, knowledge and project notes, not against what is popular.
        </li>
        <li className="flex items-start gap-2">
          <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-world" aria-hidden />
          Nothing here tracks your clicks. Opening a story is your browser's business.
        </li>
        <li className="flex items-start gap-2">
          <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-world" aria-hidden />
          Low matches are filed at the bottom instead of pushed at you.
        </li>
      </ul>
    </Panel>
  )
}
