import type { CalendarEvent } from '@ai-assistant/shared'
import { CalendarDays, Check } from 'lucide-react'
import { NoteChip } from '../../../components/NoteChip'
import { Badge, EmptyState, Panel } from '../../../components/ui'
import { cn } from '../../../lib/cn'
import { CAL, fmtHM } from '../lib'

/** Today's agenda with Now/Next markers and Mira's prep hints. */
export function AgendaToday({
  events,
  now,
  selectedId,
  onSelect,
}: {
  events: CalendarEvent[]
  now: Date
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  const allDay = events.filter((e) => e.allDay)
  const timed = events.filter((e) => !e.allDay)
  const nextId = timed.find((e) => new Date(e.end) > now)?.id

  return (
    <Panel title="Agenda today" subtitle={`${events.length} ${events.length === 1 ? 'event' : 'events'}, with prep`} icon={CalendarDays} area="life">
      {events.length === 0 ? (
        <EmptyState title="A clear day." hint="Mira kept it that way on purpose." />
      ) : (
        <ol className="flex flex-col gap-1">
          {allDay.map((e) => (
            <li key={e.id} className="px-2 py-1 text-[12px] text-muted">
              <span className={cn('mr-1.5 inline-block size-2 rounded-full align-middle', CAL[e.calendar].dot)} aria-hidden />
              {e.title} <span className="text-faint">· all day</span>
            </li>
          ))}
          {timed.map((e) => {
            const current = new Date(e.start) <= now && new Date(e.end) > now
            const past = new Date(e.end) <= now
            const next = e.id === nextId
            return (
              <li key={e.id}>
                <button
                  type="button"
                  onClick={() => onSelect(e.id)}
                  aria-pressed={selectedId === e.id}
                  className={cn(
                    'flex w-full cursor-pointer gap-3 rounded-lg px-2 py-1.5 text-left transition hover:bg-white/[0.05]',
                    (current || next) && 'bg-white/[0.04]',
                    selectedId === e.id && 'ring-1 ring-line-strong',
                    past && 'opacity-55',
                  )}
                >
                  <span className="w-11 shrink-0 pt-0.5 text-right text-[12px] text-muted tabular-nums">{fmtHM(new Date(e.start))}</span>
                  <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', CAL[e.calendar].dot)} aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-[13px] font-medium text-fg">{e.title}</span>
                      {current && <Badge tone="ok">Now</Badge>}
                      {!current && next && <Badge tone="mira">Next</Badge>}
                      {past && <Check className="size-3.5 shrink-0 text-ok" aria-label="Done" />}
                    </span>
                    {!past && e.prep && <span className="mt-0.5 line-clamp-2 block text-[12px] leading-snug text-muted">{e.prep}</span>}
                  </span>
                </button>
                {!past && e.relatedNote && (
                  <div className="pt-0.5 pb-1 pl-[72px]">
                    <NoteChip path={e.relatedNote.path} title={e.relatedNote.title} />
                  </div>
                )}
              </li>
            )
          })}
        </ol>
      )}
    </Panel>
  )
}
