import { CalendarDays, Inbox, Lock, Users } from 'lucide-react'
import { useEffect, useMemo } from 'react'
import { MiraDisc } from '../../chat/MiraDisc'
import { Badge, Segmented } from '../../components/ui'
import { useSnap, useStore } from '../../state/store'
import { CalendarTab } from './components/CalendarTab'
import { InboxTab } from './components/InboxTab'
import { PeopleTab } from './components/PeopleTab'
import { buildNudges, draftState, eventState, sameDay } from './lib'
import { useLife, type LifeTab } from './ui'

const TABS: LifeTab[] = ['calendar', 'inbox', 'people']
const isTab = (v: string | undefined): v is LifeTab => !!v && (TABS as string[]).includes(v)

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/**
 * LIFE: the personal-secretary view. A week calendar with Mira's proposals, an inbox she has triaged (snippets only,
 * drafts that wait for approval) and the people around you, with gentle nudges.
 */
export function LifeView() {
  const calendar = useSnap((d) => d.calendar)
  const mail = useSnap((d) => d.mail)
  const contacts = useSnap((d) => d.contacts)
  const approvals = useSnap((d) => d.approvals)
  const now = useStore((s) => s.now)
  const params = useStore((s) => s.viewParams)
  const clearParams = useStore((s) => s.clearParams)

  const tab = useLife((s) => s.tab)
  const setTab = useLife((s) => s.setTab)
  const snoozed = useLife((s) => s.snoozed)

  // Deep links from other screens: apply once, then clear.
  useEffect(() => {
    if (!params || Object.keys(params).length === 0) return
    const ui = useLife.getState()
    if (params.mail) {
      ui.setMailFilter('all')
      ui.selectMail(params.mail)
    }
    const next = isTab(params.tab) ? params.tab : params.mail ? 'inbox' : undefined
    if (next) ui.setTab(next)
    clearParams()
  }, [params, clearParams])

  const eventsToday = useMemo(
    () => calendar.filter((e) => sameDay(new Date(e.start), now) && eventState(e, approvals) !== 'proposed' && eventState(e, approvals) !== 'denied').length,
    [calendar, approvals, now],
  )
  const needReply = useMemo(() => mail.filter((m) => m.triage === 'needs_reply' && draftState(m, approvals) !== 'sent').length, [mail, approvals])
  const toNudge = useMemo(() => buildNudges(contacts, calendar, now).filter((n) => !snoozed[n.id]).length, [contacts, calendar, now, snoozed])
  const proposals = useMemo(() => calendar.filter((e) => eventState(e, approvals) === 'proposed').length, [calendar, approvals])

  return (
    <div className="@container/life flex flex-col gap-3 pb-4">
      <header className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <div className="mr-auto min-w-0">
          <h1 className="text-[17px] leading-tight font-semibold text-fg">Life</h1>
          <p className="mt-1 flex items-center gap-2 text-[13px] text-muted">
            <MiraDisc size={20} />
            <span>
              <b className="font-semibold text-fg tabular-nums">{plural(eventsToday, 'event')}</b> today,{' '}
              <b className="font-semibold text-fg tabular-nums">{plural(needReply, 'thread')}</b> {needReply === 1 ? 'needs' : 'need'} a reply, and{' '}
              <b className="font-semibold text-fg tabular-nums">{plural(toNudge, 'person', 'people')}</b> {toNudge === 1 ? 'is' : 'are'} due a hello.
            </span>
          </p>
        </div>
        <span
          className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-line bg-white/[0.04] px-3 py-1 text-[11px] leading-4 text-muted"
          title="Mira reads snippets by default. Opening a whole message is on demand and appears in your privacy audit."
        >
          <Lock className="size-3 shrink-0 text-life" aria-hidden />
          Snippets only. Full email bodies are fetched on demand and logged
        </span>
      </header>

      <Segmented<LifeTab>
        ariaLabel="Life sections"
        value={tab}
        onChange={setTab}
        className="self-start"
        options={[
          {
            value: 'calendar',
            label: (
              <span className="inline-flex items-center gap-1.5">
                <CalendarDays className="size-3.5" aria-hidden />
                Calendar
                {proposals > 0 && (
                  <Badge tone="brain" className="px-1.5 py-0 tabular-nums" title="Proposed by Mira, waiting for you">
                    {proposals}
                  </Badge>
                )}
              </span>
            ),
          },
          {
            value: 'inbox',
            label: (
              <span className="inline-flex items-center gap-1.5">
                <Inbox className="size-3.5" aria-hidden />
                Inbox
                {needReply > 0 && (
                  <Badge tone="mira" className="px-1.5 py-0 tabular-nums" title="Threads that need a reply">
                    {needReply}
                  </Badge>
                )}
              </span>
            ),
          },
          {
            value: 'people',
            label: (
              <span className="inline-flex items-center gap-1.5">
                <Users className="size-3.5" aria-hidden />
                People
                {toNudge > 0 && (
                  <Badge tone="life" className="px-1.5 py-0 tabular-nums" title="People to nudge">
                    {toNudge}
                  </Badge>
                )}
              </span>
            ),
          },
        ]}
      />

      {tab === 'calendar' && <CalendarTab />}
      {tab === 'inbox' && <InboxTab />}
      {tab === 'people' && <PeopleTab />}
    </div>
  )
}
