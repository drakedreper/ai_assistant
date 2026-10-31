import type { Contact } from '@ai-assistant/shared'
import { Cake, CalendarClock, Check, Clock, HeartHandshake, Sparkles, Users } from 'lucide-react'
import { useMemo } from 'react'
import { NoteChip } from '../../../components/NoteChip'
import { Badge, Button, EmptyState, Initials, Panel, Segmented } from '../../../components/ui'
import { cn } from '../../../lib/cn'
import { useSnap, useStore } from '../../../state/store'
import {
  WARMTH,
  buildComingUp,
  buildNudges,
  daysSince,
  fmtDayMonth,
  lastContactLabel,
  nextBirthday,
  relDays,
  warmthPips,
} from '../lib'
import { useLife, type PeopleSort, type WarmthFilter } from '../ui'
import { WarmthBadge, WarmthMeter } from './atoms'

export function PeopleTab() {
  const contacts = useSnap((d) => d.contacts)
  const calendar = useSnap((d) => d.calendar)
  const now = useStore((s) => s.now)
  const filter = useLife((s) => s.peopleFilter)
  const setFilter = useLife((s) => s.setPeopleFilter)
  const sort = useLife((s) => s.peopleSort)
  const setSort = useLife((s) => s.setPeopleSort)
  const snoozed = useLife((s) => s.snoozed)
  const snooze = useLife((s) => s.snooze)

  const nudges = useMemo(() => buildNudges(contacts, calendar, now).filter((n) => !snoozed[n.id]), [contacts, calendar, now, snoozed])
  const coming = useMemo(() => buildComingUp(contacts, calendar, now), [contacts, calendar, now])

  const counts = useMemo(() => {
    const c = { all: contacts.length, warm: 0, cooling: 0, cold: 0 }
    for (const p of contacts) c[p.warmth]++
    return c
  }, [contacts])

  const list = useMemo(() => {
    const filtered = filter === 'all' ? contacts : contacts.filter((c) => c.warmth === filter)
    const lastDays = (c: Contact) => daysSince(c, now) ?? 9999
    return filtered.slice().sort((a, b) => {
      if (sort === 'name') return a.name.localeCompare(b.name)
      if (sort === 'recent') return lastDays(a) - lastDays(b)
      return WARMTH[a.warmth].order - WARMTH[b.warmth].order || lastDays(b) - lastDays(a)
    })
  }, [contacts, filter, sort, now])

  return (
    <div className="flex flex-col gap-3">
      <Panel title="Coming up" subtitle="Birthdays and the next time you see people" icon={CalendarClock} area="life">
        {coming.length === 0 ? (
          <EmptyState title="Nothing coming up." hint="Mira will tell you when something does." />
        ) : (
          <ul className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1" aria-label="Coming up">
            {coming.map((c) => (
              <li
                key={c.id}
                className="flex w-[200px] shrink-0 items-center gap-2.5 rounded-xl border border-line bg-white/[0.03] px-3 py-2"
              >
                <span
                  className={cn('grid size-8 shrink-0 place-items-center rounded-full', c.kind === 'birthday' ? 'bg-mira/15 text-mira' : 'bg-life/15 text-life')}
                  aria-hidden
                >
                  {c.kind === 'birthday' ? <Cake className="size-4" /> : <Users className="size-4" />}
                </span>
                <span className="min-w-0 leading-tight">
                  <span className="block truncate text-[13px] font-medium text-fg">{c.title}</span>
                  <span className={cn('block truncate text-[12px] tabular-nums', c.kind === 'birthday' && c.days <= 7 ? 'text-mira' : 'text-muted')}>
                    {c.when}
                  </span>
                  <span className="block truncate text-[11px] text-faint">{c.kind === 'birthday' ? fmtDayMonth(c.date) : c.who}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel
        title="Mira's gentle nudges"
        subtitle="Based on how often you usually talk. Never more than a nudge."
        icon={HeartHandshake}
        area="life"
        actions={<Badge tone="life">{nudges.length} to nudge</Badge>}
      >
        {nudges.length === 0 ? (
          <EmptyState title="Everyone is warm." hint="I will say something when that changes." />
        ) : (
          <ul className="grid gap-2 @3xl/life:grid-cols-2">
            {nudges.map((n) => (
              <li key={n.id} className="flex gap-3 rounded-xl border border-line bg-white/[0.03] p-3">
                <Initials name={n.contact.name.replace(/\s*\(.*\)/, '')} className="size-9" />
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] leading-snug text-fg">{n.text}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <WarmthBadge warmth={n.contact.warmth} />
                    {n.contact.notePath && <NoteChip path={n.contact.notePath} title={n.contact.name.replace(/\s*\(.*\)/, '')} />}
                    <span className="ml-auto flex gap-1">
                      <Button size="xs" variant="ghost" onClick={() => snooze(n.id)}>
                        <Clock className="size-3" /> Not now
                      </Button>
                      <Button size="xs" variant="ok" onClick={() => snooze(n.id)}>
                        <Check className="size-3" /> Done
                      </Button>
                    </span>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Segmented<WarmthFilter>
          ariaLabel="Filter by warmth"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: <FilterLabel label="All" n={counts.all} /> },
            { value: 'warm', label: <FilterLabel label="Warm" n={counts.warm} /> },
            { value: 'cooling', label: <FilterLabel label="Cooling" n={counts.cooling} /> },
            { value: 'cold', label: <FilterLabel label="Cold" n={counts.cold} /> },
          ]}
        />
        <div className="ml-auto flex items-center gap-2 text-[12px] text-faint">
          Sort
          <Segmented<PeopleSort>
            ariaLabel="Sort people"
            size="xs"
            value={sort}
            onChange={setSort}
            options={[
              { value: 'warmth', label: 'Coolest first' },
              { value: 'recent', label: 'Most recent' },
              { value: 'name', label: 'A to Z' },
            ]}
          />
        </div>
      </div>

      {list.length === 0 ? (
        <Panel>
          <EmptyState title="No one in this group." />
        </Panel>
      ) : (
        <ul className="grid grid-cols-1 gap-3 @3xl/life:grid-cols-2 @6xl/life:grid-cols-3" aria-label="People">
          {list.map((c) => (
            <ContactCard key={c.id} c={c} now={now} />
          ))}
        </ul>
      )}
    </div>
  )
}

function FilterLabel({ label, n }: { label: string; n: number }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {label}
      <span className="text-faint tabular-nums">{n}</span>
    </span>
  )
}

function ContactCard({ c, now }: { c: Contact; now: Date }) {
  const w = WARMTH[c.warmth]
  const days = daysSince(c, now)
  const bd = c.birthday ? nextBirthday(c.birthday, now) : null
  const overdue = days !== null && c.cadenceDays !== undefined && days > c.cadenceDays
  const person = c.name.replace(/\s*\(.*\)/, '')

  return (
    <li className="glass flex flex-col gap-2.5 p-3.5">
      <div className="flex items-start gap-3">
        <Initials name={person} className="size-10 text-[13px]" />
        <div className="min-w-0 flex-1 leading-tight">
          <h3 className="truncate text-[14px] font-semibold text-fg">{c.name}</h3>
          <p className="truncate text-[12px] text-muted">{[c.role, c.org].filter(Boolean).join(' · ')}</p>
        </div>
        <WarmthBadge warmth={c.warmth} />
      </div>

      <div className="flex items-center gap-2.5 text-[12px]">
        <WarmthMeter pips={warmthPips(c, now)} warmth={c.warmth} />
        <span className={cn('tabular-nums', w.text)}>{lastContactLabel(c, now)}</span>
        {c.cadenceDays ? (
          <span className={cn('truncate tabular-nums', overdue ? 'text-warn' : 'text-faint')}>
            · usually every {c.cadenceDays} d{overdue ? `, ${days! - c.cadenceDays} over` : ''}
          </span>
        ) : (
          <span className="truncate text-faint">· no set rhythm</span>
        )}
      </div>

      {bd && bd.days <= 60 && (
        <p className="flex items-center gap-1.5 text-[12px] text-muted">
          <Cake className="size-3.5 text-mira" aria-hidden />
          Birthday {fmtDayMonth(bd.date)}
          <span className={cn('tabular-nums', bd.days <= 7 ? 'font-medium text-mira' : 'text-faint')}>({relDays(bd.days)})</span>
        </p>
      )}

      {c.miraNote && (
        <p className="flex items-start gap-1.5 text-[12px] leading-snug text-muted">
          <Sparkles className="mt-0.5 size-3 shrink-0 text-mira" aria-hidden />
          {c.miraNote}
        </p>
      )}

      <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-0.5">
        {c.tags.map((t) => (
          <Badge key={t}>{t}</Badge>
        ))}
        {c.notePath && <NoteChip path={c.notePath} title={`${person} note`} className="ml-auto" />}
      </div>
    </li>
  )
}
