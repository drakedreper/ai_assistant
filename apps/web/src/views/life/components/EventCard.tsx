import type { CalendarEvent } from '@ai-assistant/shared'
import { CalendarDays, Check, Clock, MapPin, ShieldCheck, Sparkles, Users, X } from 'lucide-react'
import { NoteChip } from '../../../components/NoteChip'
import { Badge, Button, IconButton, Initials } from '../../../components/ui'
import { cn } from '../../../lib/cn'
import { CAL, dayDiff, eventTiming, fmtDayMonth, fmtDuration, fmtRange, fmtWeekday, relDays, type EventState } from '../lib'

/** Side card for one event: time, place, people, Mira's prep and the note it touches. */
export function EventCard({
  event,
  state,
  now,
  label,
  onClose,
  onDecide,
  className,
}: {
  event: CalendarEvent
  state: EventState
  now: Date
  /** Small caption above the title, e.g. "Next up". */
  label?: string
  onClose?: () => void
  onDecide: (e: CalendarEvent, d: 'approved' | 'denied') => void
  className?: string
}) {
  const cal = CAL[event.calendar]
  const start = new Date(event.start)
  const end = new Date(event.end)
  const proposed = state === 'proposed'
  const timing = eventTiming(event, now)
  const mins = Math.round((end.getTime() - start.getTime()) / 60_000)

  return (
    <section
      aria-label={`Event details: ${event.title}`}
      className={cn(
        'glass overflow-hidden',
        proposed && 'border-dashed border-brain/60',
        className,
      )}
    >
      <div className={cn('h-1', proposed ? 'bg-brain/50' : cal.dot)} aria-hidden />
      <div className="flex flex-col gap-3 p-4">
        <header className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex flex-wrap items-center gap-1.5">
              {label && <span className="text-[11px] font-medium tracking-wide text-faint uppercase">{label}</span>}
              <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] leading-4 font-medium', cal.chip)}>
                <span className={cn('size-1.5 rounded-full', cal.dot)} aria-hidden />
                {cal.label}
              </span>
              {proposed && (
                <Badge tone="brain">
                  <Sparkles className="size-3" aria-hidden /> Proposed by Mira
                </Badge>
              )}
              {state === 'approved' && (
                <Badge tone="ok">
                  <Check className="size-3" aria-hidden /> Approved
                </Badge>
              )}
            </div>
            <h3 className="text-[15px] leading-snug font-semibold text-fg">{event.title}</h3>
          </div>
          {onClose && (
            <IconButton aria-label="Close event details" onClick={onClose} className="-mt-1 -mr-1 size-7">
              <X className="size-4" />
            </IconButton>
          )}
        </header>

        <dl className="flex flex-col gap-1.5 text-[13px]">
          <div className="flex items-start gap-2">
            <dt className="mt-0.5 text-faint"><CalendarDays className="size-3.5" aria-label="Date" /></dt>
            <dd className="text-fg">
              {fmtWeekday(start, 'long')} {fmtDayMonth(start)}
              <span className="text-faint"> · {relDays(dayDiff(now, start))}</span>
            </dd>
          </div>
          <div className="flex items-start gap-2">
            <dt className="mt-0.5 text-faint"><Clock className="size-3.5" aria-label="Time" /></dt>
            <dd className="text-fg tabular-nums">
              {event.allDay ? 'All day' : `${fmtRange(event)} · ${fmtDuration(mins)}`}
              <span className={cn('ml-1.5 text-[12px]', timing.live ? 'font-medium text-ok' : 'text-faint')}>{timing.label}</span>
            </dd>
          </div>
          {event.location && (
            <div className="flex items-start gap-2">
              <dt className="mt-0.5 text-faint"><MapPin className="size-3.5" aria-label="Location" /></dt>
              <dd className="text-fg">{event.location}</dd>
            </div>
          )}
          {event.attendees.length > 0 && (
            <div className="flex items-start gap-2">
              <dt className="mt-0.5 text-faint"><Users className="size-3.5" aria-label="Attendees" /></dt>
              <dd className="flex flex-wrap gap-1.5">
                {event.attendees.map((a) => (
                  <span key={a} className="inline-flex items-center gap-1.5 rounded-full border border-line bg-white/4 py-0.5 pr-2 pl-0.5 text-[12px] text-fg">
                    <Initials name={a.replace(/\s*\(.*\)/, '')} className="size-5 text-[11px]" />
                    {a}
                  </span>
                ))}
              </dd>
            </div>
          )}
        </dl>

        <div className="rounded-xl border border-mira/20 bg-mira/[0.06] p-3">
          <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-mira uppercase">
            <Sparkles className="size-3" aria-hidden /> Mira's prep
          </div>
          <p className="text-[13px] leading-snug text-fg/90">
            {event.prep ?? 'Nothing to prepare. I will nudge you ten minutes before.'}
          </p>
          {event.relatedNote && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[12px] text-muted">
              <span>Touches</span>
              <NoteChip path={event.relatedNote.path} title={event.relatedNote.title} />
            </div>
          )}
        </div>

        {proposed && (
          <div className="flex flex-col gap-2">
            <div className="flex gap-2">
              <Button variant="ok" size="md" className="flex-1" onClick={() => onDecide(event, 'approved')}>
                <Check className="size-4" /> Approve
              </Button>
              <Button variant="danger" size="md" onClick={() => onDecide(event, 'denied')}>
                <X className="size-4" /> Deny
              </Button>
            </div>
            <p className="flex items-start gap-1.5 text-[11px] leading-snug text-faint">
              <ShieldCheck className="mt-px size-3.5 shrink-0" aria-hidden />
              Adding to your calendar is an outward action (T4). Nothing changes until you approve.
            </p>
          </div>
        )}
      </div>
    </section>
  )
}
