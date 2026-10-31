import { CalendarDays } from 'lucide-react'
import { useMemo } from 'react'
import { NoteChip } from '../../components/NoteChip'
import { Badge, EmptyState, Panel } from '../../components/ui'
import { cn } from '../../lib/cn'
import { fmtTime } from '../../lib/format'
import { useSnap, useStore } from '../../state/store'

const CAL_DOT: Record<string, string> = {
  personal: 'bg-world',
  work: 'bg-work',
  family: 'bg-mira',
  focus: 'bg-brain',
}

/** Today's agenda with a live "now / next" marker and prep hints. */
export function AgendaCard() {
  const calendar = useSnap((d) => d.calendar)
  const now = useStore((s) => s.now)
  const navigate = useStore((s) => s.navigate)

  const events = useMemo(
    () =>
      calendar
        .filter((e) => !e.allDay && new Date(e.start).toDateString() === now.toDateString())
        .sort((a, b) => a.start.localeCompare(b.start)),
    [calendar, now],
  )
  const nextId = events.find((e) => new Date(e.end) > now)?.id

  return (
    <Panel
      title="Today"
      subtitle={`${events.length} on your calendar`}
      icon={CalendarDays}
      area="life"
      actions={
        <button type="button" onClick={() => navigate('life', { tab: 'calendar' })} className="cursor-pointer text-[11px] text-muted hover:text-fg">
          Open calendar
        </button>
      }
    >
      {events.length === 0 ? (
        <EmptyState title="A clear day." hint="Mira kept it that way on purpose." />
      ) : (
        <ol className="relative flex flex-col gap-1">
          {events.map((e) => {
            const current = new Date(e.start) <= now && new Date(e.end) > now
            const next = e.id === nextId
            return (
              <li key={e.id} className={cn('flex gap-3 rounded-lg px-2 py-1.5', (current || next) && 'bg-white/[0.04]')}>
                <div className="w-11 shrink-0 pt-0.5 text-right text-[12px] text-muted tabular-nums">{fmtTime(e.start)}</div>
                <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', CAL_DOT[e.calendar] ?? 'bg-faint')} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-[13px] font-medium text-fg">{e.title}</span>
                    {current && <Badge tone="ok">Now</Badge>}
                    {!current && next && <Badge tone="mira">Next</Badge>}
                  </div>
                  {(current || next) && e.prep && <p className="mt-0.5 text-[12px] text-muted">{e.prep}</p>}
                  {e.relatedNote && (
                    <div className="mt-1">
                      <NoteChip path={e.relatedNote.path} title={e.relatedNote.title} />
                    </div>
                  )}
                </div>
              </li>
            )
          })}
        </ol>
      )}
    </Panel>
  )
}
