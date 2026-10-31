import type { BriefingThread } from '@ai-assistant/shared'
import { AlertTriangle, ArrowUpRight, Clock, Scale, Sparkles, TrendingUp, type LucideIcon } from 'lucide-react'
import { NoteChip } from '../../components/NoteChip'
import { Badge, Button, type Tone } from '../../components/ui'
import { AREA } from '../../lib/areas'
import { journalPath } from '@ai-assistant/shared/fixtures'
import { useStore, type ViewParams } from '../../state/store'

const KIND: Record<BriefingThread['kind'], { label: string; icon: LucideIcon; tone: Tone }> = {
  decision: { label: 'Decision', icon: Scale, tone: 'brain' },
  opportunity: { label: 'Opportunity', icon: TrendingUp, tone: 'ok' },
  risk: { label: 'Risk', icon: AlertTriangle, tone: 'bad' },
  reminder: { label: 'Reminder', icon: Clock, tone: 'warn' },
  reflection: { label: 'Reflection', icon: Sparkles, tone: 'mira' },
}

/** Where a thread's action button leads. */
function target(t: BriefingThread, now: Date): { view: 'work' | 'brain' | 'life' | 'money' | 'world'; params: ViewParams } {
  switch (t.area) {
    case 'work':
      return { view: 'work', params: { tab: 'approvals' } }
    case 'brain':
      return t.kind === 'decision'
        ? { view: 'brain', params: { tab: 'proposals', proposal: 'pr-q4' } }
        : { view: 'brain', params: { tab: 'notes', note: t.cites[0]?.path ?? journalPath(now, -1) } }
    case 'life':
      return { view: 'life', params: { tab: 'calendar' } }
    default:
      return { view: t.area, params: {} }
  }
}

/** One "thread of thinking". Every thread cites the user's own notes: that is what makes the briefing personal. */
export function ThreadCard({ thread }: { thread: BriefingThread }) {
  const navigate = useStore((s) => s.navigate)
  const now = useStore((s) => s.now)
  const k = KIND[thread.kind]
  const a = AREA[thread.area]
  const Icon = k.icon
  const go = target(thread, now)
  return (
    <article className="fade-up group flex min-h-0 flex-1 flex-col gap-2 rounded-xl border border-line bg-white/[0.03] p-3.5 transition hover:border-line-strong hover:bg-white/[0.05]">
      <div className="flex items-center gap-1.5">
        <Badge tone={k.tone}>
          <Icon className="size-3" /> {k.label}
        </Badge>
        <Badge tone={thread.area}>
          <a.icon className="size-3" /> {a.label}
        </Badge>
      </div>
      <h3 className="text-[14px] leading-snug font-semibold text-fg">{thread.title}</h3>
      <p className="text-[13px] leading-relaxed text-muted">{thread.body}</p>
      <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-1">
        <span className="text-[10px] font-semibold tracking-widest text-faint uppercase">Draws on</span>
        {thread.cites.map((c) => (
          <NoteChip key={c.path} path={c.path} title={c.title} />
        ))}
        {thread.actionLabel && (
          <Button size="xs" variant="ghost" className="ml-auto" onClick={() => navigate(go.view, go.params)}>
            {thread.actionLabel} <ArrowUpRight className="size-3" />
          </Button>
        )}
      </div>
    </article>
  )
}
