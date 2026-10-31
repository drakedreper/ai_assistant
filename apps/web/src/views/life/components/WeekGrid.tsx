import type { CalendarEvent } from '@ai-assistant/shared'
import { Check, Gift } from 'lucide-react'
import { Button } from '../../../components/ui'
import { cn } from '../../../lib/cn'
import {
  CAL,
  GRID_MINUTES,
  HOUR_END,
  HOUR_PX,
  HOUR_START,
  fmtHM,
  fmtRange,
  fmtWeekday,
  minutesOfDay,
  sameDay,
  type EventState,
  type Placed,
} from '../lib'

export interface TimedEv {
  event: CalendarEvent
  start: number
  end: number
  state: EventState
}

export interface DayData {
  date: Date
  allDay: CalendarEvent[]
  timed: Array<Placed<TimedEv>>
}

const PX_PER_MIN = HOUR_PX / 60
const COLS = 'grid-cols-[44px_repeat(7,minmax(0,1fr))]'
const HOURS = Array.from({ length: HOUR_END - HOUR_START }, (_, i) => HOUR_START + i)
const HOUR_LINES = `repeating-linear-gradient(to bottom, transparent 0, transparent ${HOUR_PX - 1}px, var(--color-line) ${HOUR_PX - 1}px, var(--color-line) ${HOUR_PX}px)`

interface Props {
  days: DayData[]
  now: Date
  selectedId: string | null
  onSelect: (id: string) => void
  onDecide: (e: CalendarEvent, d: 'approved' | 'denied') => void
}

/** Mon-Sun time grid, 07:00-20:00, with an all-day strip and a live "now" line on today. */
export function WeekGrid({ days, now, selectedId, onSelect, onDecide }: Props) {
  const todayIdx = days.findIndex((d) => sameDay(d.date, now))
  const nowMin = minutesOfDay(now)
  const showNow = todayIdx >= 0 && nowMin >= HOUR_START * 60 && nowMin <= HOUR_END * 60
  const bodyH = (HOUR_END - HOUR_START) * HOUR_PX
  const hasAllDay = days.some((d) => d.allDay.length > 0)

  return (
    <div className="overflow-x-auto">
      <div className="min-w-[640px]" role="group" aria-label="Week calendar">
        {/* Day headers */}
        <div className={cn('grid border-b border-line', COLS)}>
          <div />
          {days.map((d, i) => {
            const today = i === todayIdx
            const past = !today && d.date < now
            return (
              <div key={i} className="flex flex-col items-center gap-0.5 border-l border-line py-2" aria-current={today ? 'date' : undefined}>
                <span className={cn('text-[11px] font-medium tracking-wide uppercase', today ? 'text-life' : 'text-faint')}>
                  <span className="@2xl/life:hidden">{fmtWeekday(d.date).slice(0, 1)}</span>
                  <span className="hidden @2xl/life:inline">{fmtWeekday(d.date)}</span>
                </span>
                <span
                  className={cn(
                    'grid size-7 place-items-center rounded-full text-[13px] font-semibold tabular-nums',
                    today ? 'bg-life text-canvas' : past ? 'text-faint' : 'text-fg',
                  )}
                >
                  {d.date.getDate()}
                </span>
              </div>
            )
          })}
        </div>

        {/* All-day strip */}
        {hasAllDay && (
          <div className={cn('grid border-b border-line', COLS)}>
            <div className="py-1.5 pr-2 text-right text-[11px] leading-5 text-faint">All day</div>
            {days.map((d, i) => (
              <div key={i} className="flex min-w-0 flex-col gap-1 border-l border-line p-1">
                {d.allDay.map((e) => (
                  <button
                    key={e.id}
                    type="button"
                    onClick={() => onSelect(e.id)}
                    aria-label={`${e.title}, all day, ${CAL[e.calendar].label}`}
                    className={cn(
                      'flex min-w-0 cursor-pointer items-center gap-1 rounded-md border px-1.5 py-0.5 text-left text-[11px] leading-4 font-medium transition hover:brightness-125',
                      CAL[e.calendar].chip,
                      selectedId === e.id && 'ring-2 ring-fg/70',
                    )}
                  >
                    {e.calendar === 'family' && <Gift className="size-3 shrink-0" aria-hidden />}
                    <span className="truncate">{e.title}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}

        {/* Time grid */}
        <div className={cn('relative grid pt-3 pb-1', COLS)}>
          <div className="relative" style={{ height: bodyH }} aria-hidden>
            {HOURS.map((h, i) =>
              // The "now" pill takes over when it sits on top of an hour label.
              showNow && Math.abs(i * HOUR_PX - (nowMin - HOUR_START * 60) * PX_PER_MIN) < 10 ? null : (
                <span key={h} className="absolute right-2 -translate-y-1/2 text-[11px] leading-none text-faint tabular-nums" style={{ top: i * HOUR_PX }}>
                  {String(h).padStart(2, '0')}:00
                </span>
              ),
            )}
            {showNow && (
              <span
                className="absolute right-1 z-20 -translate-y-1/2 rounded bg-mira px-1 text-[11px] leading-4 font-semibold text-canvas tabular-nums"
                style={{ top: (nowMin - HOUR_START * 60) * PX_PER_MIN }}
              >
                {fmtHM(now)}
              </span>
            )}
          </div>

          {days.map((d, di) => (
            <div
              key={di}
              role="group"
              aria-label={d.date.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}
              className={cn('relative min-w-0 border-l border-line', di === todayIdx && 'bg-life/[0.045]')}
              style={{ height: bodyH, backgroundImage: HOUR_LINES }}
            >
              {d.timed.map((p) => (
                <EventBlock
                  key={p.item.event.id}
                  p={p}
                  past={new Date(p.item.event.end) <= now}
                  selected={selectedId === p.item.event.id}
                  onSelect={onSelect}
                  onDecide={onDecide}
                />
              ))}
            </div>
          ))}

          {showNow && (
            <div
              aria-hidden
              className="pointer-events-none absolute z-10 bg-mira/85"
              style={{ left: 44, right: 0, height: 1.5, top: 12 + (nowMin - HOUR_START * 60) * PX_PER_MIN - 0.75 }}
            />
          )}
        </div>
      </div>
    </div>
  )
}

function EventBlock({
  p,
  past,
  selected,
  onSelect,
  onDecide,
}: {
  p: Placed<TimedEv>
  past: boolean
  selected: boolean
  onSelect: (id: string) => void
  onDecide: (e: CalendarEvent, d: 'approved' | 'denied') => void
}) {
  const { event: e, start, end, state } = p.item
  const top = (Math.max(start, HOUR_START * 60) - HOUR_START * 60) * PX_PER_MIN
  const bottom = (Math.min(end, HOUR_START * 60 + GRID_MINUTES) - HOUR_START * 60) * PX_PER_MIN
  const height = Math.max(22, bottom - top - 2)
  const style = {
    top: top + 1,
    height,
    left: `calc(${(p.col / p.cols) * 100}% + 2px)`,
    width: `calc(${100 / p.cols}% - 4px)`,
  }
  const cal = CAL[e.calendar]
  const label = `${e.title}, ${fmtRange(e)}, ${cal.label}${state === 'proposed' ? ', proposed by Mira, waiting for your approval' : ''}`

  if (state === 'proposed') {
    return (
      <div
        className={cn(
          'absolute flex flex-col overflow-hidden rounded-lg border border-dashed border-brain/80 bg-brain/[0.09] p-1.5',
          selected && 'z-10 ring-2 ring-fg/70',
        )}
        style={style}
        data-proposed
      >
        <button type="button" onClick={() => onSelect(e.id)} aria-label={label} className="min-h-0 flex-1 cursor-pointer text-left">
          <span className="block truncate text-[11px] leading-4 font-medium text-brain">Proposed by Mira</span>
          <span className="mt-0.5 line-clamp-2 text-[12px] leading-tight font-semibold text-fg">{e.title}</span>
        </button>
        <div className="mt-1 flex gap-1">
          <Button size="xs" variant="ok" className="flex-1 px-1.5" onClick={() => onDecide(e, 'approved')} aria-label={`Approve: ${e.title}`}>
            Approve
          </Button>
          <Button size="xs" variant="danger" className="px-1.5" onClick={() => onDecide(e, 'denied')} aria-label={`Deny: ${e.title}`}>
            Deny
          </Button>
        </div>
      </div>
    )
  }

  return (
    <button
      type="button"
      onClick={() => onSelect(e.id)}
      aria-label={label}
      aria-pressed={selected}
      className={cn(
        'absolute cursor-pointer overflow-hidden rounded-md px-1.5 py-1 text-left transition',
        cal.block,
        past && 'opacity-60',
        selected && 'z-10 ring-2 ring-fg/70',
      )}
      style={style}
    >
      <span className={cn('block text-[12px] leading-tight font-semibold text-fg', height >= 62 ? 'line-clamp-2' : 'truncate')}>{e.title}</span>
      {height >= 40 && (
        <span className="mt-px flex items-center gap-1 text-[11px] leading-4 text-muted tabular-nums">
          {state === 'approved' && <Check className="size-3 shrink-0 text-ok" aria-label="Approved" />}
          <span className="truncate">{fmtRange(e)}</span>
        </span>
      )}
      {height >= 70 && e.location && <span className="block truncate text-[11px] leading-4 text-faint">{e.location}</span>}
    </button>
  )
}
