import type { CalendarEvent } from '@ai-assistant/shared'
import { CalendarCheck, ChevronLeft, ChevronRight, Sparkles } from 'lucide-react'
import { useEffect, useMemo } from 'react'
import { Button, IconButton, Panel } from '../../../components/ui'
import { cn } from '../../../lib/cn'
import { useSnap, useStore } from '../../../state/store'
import { decideEvent } from '../actions'
import {
  CAL,
  CAL_ORDER,
  addDays,
  eventState,
  fmtDayMonth,
  fmtHours,
  fmtRange,
  fmtWeekday,
  layoutColumns,
  mondayOf,
  minutesOfDay,
  sameDay,
} from '../lib'
import { useLife } from '../ui'
import { AgendaToday } from './AgendaToday'
import { EventCard } from './EventCard'
import { WeekGrid, type DayData } from './WeekGrid'

export function CalendarTab() {
  const calendar = useSnap((d) => d.calendar)
  const approvals = useSnap((d) => d.approvals)
  const now = useStore((s) => s.now)

  const weekOffset = useLife((s) => s.weekOffset)
  const setWeekOffset = useLife((s) => s.setWeekOffset)
  const selectedId = useLife((s) => s.selectedEvent)
  const selectEvent = useLife((s) => s.selectEvent)
  const hidden = useLife((s) => s.hiddenCals)
  const toggleCal = useLife((s) => s.toggleCal)
  const flash = useLife((s) => s.flash)
  const setFlash = useLife((s) => s.setFlash)

  const weekStart = useMemo(() => addDays(mondayOf(now), weekOffset * 7), [now, weekOffset])
  const weekEnd = useMemo(() => addDays(weekStart, 7), [weekStart])

  // Denied proposals vanish; pending ones stay (dashed); approved ones become ordinary solid events.
  const live = useMemo(
    () =>
      calendar
        .map((event) => ({ event, state: eventState(event, approvals) }))
        .filter((x) => x.state !== 'denied')
        .sort((a, b) => a.event.start.localeCompare(b.event.start)),
    [calendar, approvals],
  )

  const days = useMemo<DayData[]>(() => {
    return Array.from({ length: 7 }, (_, i) => {
      const date = addDays(weekStart, i)
      const dayEvents = live.filter((x) => !hidden.includes(x.event.calendar) && sameDay(new Date(x.event.start), date))
      const timed = layoutColumns(
        dayEvents
          .filter((x) => !x.event.allDay)
          .map((x) => ({ event: x.event, state: x.state, start: minutesOfDay(new Date(x.event.start)), end: minutesOfDay(new Date(x.event.end)) })),
      )
      return { date, allDay: dayEvents.filter((x) => x.event.allDay).map((x) => x.event), timed }
    })
  }, [live, weekStart, hidden])

  // Hours per calendar type this week (proposals do not count until you approve them).
  const hours = useMemo(() => {
    const m: Record<string, number> = { focus: 0, work: 0, personal: 0, family: 0 }
    for (const x of live) {
      const s = new Date(x.event.start)
      if (x.event.allDay || x.state === 'proposed' || s < weekStart || s >= weekEnd) continue
      m[x.event.calendar] = (m[x.event.calendar] ?? 0) + (new Date(x.event.end).getTime() - s.getTime()) / 60_000
    }
    return m
  }, [live, weekStart, weekEnd])

  const todays = useMemo(
    () =>
      live
        .filter((x) => x.state !== 'proposed' && sameDay(new Date(x.event.start), now))
        .map((x) => x.event),
    [live, now],
  )

  const selected = selectedId ? live.find((x) => x.event.id === selectedId) : undefined
  const nextUp = useMemo(() => {
    const t = todays.filter((e) => !e.allDay && new Date(e.end) > now)[0]
    return t ? live.find((x) => x.event.id === t.id) : undefined
  }, [todays, live, now])

  // Proposals that live outside the visible week still need to be seen.
  const offscreen = useMemo(
    () => live.filter((x) => x.state === 'proposed' && (new Date(x.event.start) < weekStart || new Date(x.event.start) >= weekEnd)),
    [live, weekStart, weekEnd],
  )

  useEffect(() => {
    if (!flash) return
    const t = setTimeout(() => setFlash(null), 5000)
    return () => clearTimeout(t)
  }, [flash, setFlash])

  const jumpTo = (e: CalendarEvent) => {
    const diff = Math.round((mondayOf(new Date(e.start)).getTime() - mondayOf(now).getTime()) / (7 * 86_400_000))
    setWeekOffset(diff)
    selectEvent(e.id)
  }

  const thisWeek = weekOffset === 0
  const caption = weekOffset === 0 ? 'This week' : weekOffset === 1 ? 'Next week' : weekOffset === -1 ? 'Last week' : weekOffset > 0 ? `In ${weekOffset} weeks` : `${-weekOffset} weeks ago`
  const range = `${fmtDayMonth(weekStart)} – ${fmtDayMonth(addDays(weekStart, 6))}`

  // Narrow stages show the details card over the grid, on the side away from the selected day.
  const selectedDayIdx = selected ? days.findIndex((d) => sameDay(d.date, new Date(selected.event.start))) : -1
  const overlayLeft = selectedDayIdx >= 4

  return (
    <div className="grid gap-3 @6xl/life:grid-cols-[minmax(0,1fr)_304px]">
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <div className="flex items-center gap-1">
            <IconButton aria-label="Previous week" onClick={() => setWeekOffset(weekOffset - 1)}>
              <ChevronLeft className="size-4" />
            </IconButton>
            <IconButton aria-label="Next week" onClick={() => setWeekOffset(weekOffset + 1)}>
              <ChevronRight className="size-4" />
            </IconButton>
            <Button variant="outline" onClick={() => setWeekOffset(0)} disabled={thisWeek} className="ml-1">
              Today
            </Button>
          </div>
          <div className="leading-tight">
            <div className="text-[14px] font-semibold text-fg tabular-nums">{range}</div>
            <div className="text-[11px] text-faint">{caption}, {weekStart.getFullYear()}</div>
          </div>
          <div className="min-w-0 text-[12px]" role="status" aria-live="polite">
            {flash && (
              <span className="inline-flex items-center gap-1.5 text-ok">
                <CalendarCheck className="size-3.5 shrink-0" aria-hidden /> {flash.text}
              </span>
            )}
          </div>
          <ul className="ml-auto flex flex-wrap items-center gap-1.5" aria-label="Calendars">
            {CAL_ORDER.map((k) => {
              const off = hidden.includes(k)
              return (
                <li key={k}>
                  <button
                    type="button"
                    aria-pressed={!off}
                    title={off ? `Show ${CAL[k].label}` : `Hide ${CAL[k].label}`}
                    onClick={() => toggleCal(k)}
                    className={cn(
                      'inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] leading-4 transition',
                      off ? 'border-line text-faint line-through' : 'border-line-strong bg-white/[0.04] text-fg hover:bg-white/8',
                    )}
                  >
                    <span className={cn('size-2 rounded-full', CAL[k].dot, off && 'opacity-40')} aria-hidden />
                    {CAL[k].label}
                    <span className="text-faint tabular-nums">{fmtHours(hours[k] ?? 0)}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        </div>

        {offscreen.map((x) => (
          <div
            key={x.event.id}
            role="status"
            className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-dashed border-brain/50 bg-brain/[0.07] px-3 py-2 text-[12px]"
          >
            <Sparkles className="size-4 shrink-0 text-brain" aria-hidden />
            <span className="min-w-0 flex-1 text-fg">
              <b className="font-semibold">Mira proposed</b> {x.event.title} on {fmtWeekday(new Date(x.event.start), 'long')} {fmtDayMonth(new Date(x.event.start))}, {fmtRange(x.event)}.
            </span>
            <Button size="xs" variant="ghost" onClick={() => jumpTo(x.event)}>
              Show in calendar
            </Button>
            <Button size="xs" variant="ok" onClick={() => void decideEvent(x.event, 'approved')}>
              Approve
            </Button>
            <Button size="xs" variant="danger" onClick={() => void decideEvent(x.event, 'denied')}>
              Deny
            </Button>
          </div>
        ))}

        <div className="relative">
          <Panel flush className="overflow-hidden">
            <WeekGrid
              days={days}
              now={now}
              selectedId={selectedId}
              onSelect={(id) => selectEvent(selectedId === id ? null : id)}
              onDecide={(e, d) => void decideEvent(e, d)}
            />
          </Panel>
          {selected && (
            <div className={cn('absolute top-24 z-30 w-[300px] shadow-2xl @6xl/life:hidden', overlayLeft ? 'left-14' : 'right-2')}>
              <EventCard event={selected.event} state={selected.state} now={now} onClose={() => selectEvent(null)} onDecide={(e, d) => void decideEvent(e, d)} />
            </div>
          )}
        </div>
      </div>

      <aside className="flex min-w-0 flex-col gap-3" aria-label="Event details and agenda">
        {(selected ?? nextUp) && (
          <div className="hidden @6xl/life:block">
            <EventCard
              event={(selected ?? nextUp)!.event}
              state={(selected ?? nextUp)!.state}
              now={now}
              label={selected ? undefined : new Date((nextUp ?? selected)!.event.start) <= now ? 'Now' : 'Next up'}
              onClose={selected ? () => selectEvent(null) : undefined}
              onDecide={(e, d) => void decideEvent(e, d)}
            />
          </div>
        )}
        <AgendaToday events={todays} now={now} selectedId={selectedId} onSelect={(id) => { setWeekOffset(0); selectEvent(id) }} />
      </aside>
    </div>
  )
}

