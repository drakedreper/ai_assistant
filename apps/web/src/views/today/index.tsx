import { MessageCircle } from 'lucide-react'
import { useMemo } from 'react'
import { SessionMini } from '../../components/SessionMini'
import { Badge, Button, Panel } from '../../components/ui'
import { SESSION_STATUS } from '../../lib/status'
import { greeting, timeAgo } from '../../lib/format'
import { useSnap, useStore } from '../../state/store'
import { Activity } from 'lucide-react'
import { AgendaCard } from './AgendaCard'
import { NeedsYou } from './NeedsYou'
import { BrainPulse, LearnedCard, MoneyPulse, WorldPulse } from './Pulses'
import { ThreadCard } from './ThreadCard'

/**
 * TODAY: her briefing as "threads of thinking" (each cites your own notes), what needs you, what the
 * agents are doing, and a pulse of money, world and brain. Calm, dense, personal.
 */
export function TodayView() {
  const briefing = useSnap((d) => d.briefing)
  const sessions = useSnap((d) => d.sessions)
  const now = useStore((s) => s.now)
  const send = useStore((s) => s.send)
  const navigate = useStore((s) => s.navigate)

  const live = useMemo(
    () =>
      sessions
        .filter((s) => s.status !== 'done' && s.status !== 'stale')
        .sort((a, b) => SESSION_STATUS[a.status].order - SESSION_STATUS[b.status].order)
        .slice(0, 5),
    [sessions],
  )
  const needs = live.filter((s) => SESSION_STATUS[s.status].needsYou).length

  return (
    <div className="@container">
    <div className="grid grid-cols-1 gap-3 pb-3 @4xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
      {/* ---------- left: briefing ---------- */}
      <div className="@container flex min-w-0 flex-col gap-3">
        <section className="glass relative overflow-hidden px-5 pt-4 pb-5">
          <div aria-hidden className="pointer-events-none absolute -top-24 -right-16 size-64 rounded-full bg-mira/10 blur-3xl" />
          <div className="relative flex flex-wrap items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-[11px] tracking-widest text-faint uppercase">
                <span>Mira's briefing</span>·<span>prepared {timeAgo(briefing.generatedAt, now)}</span>
              </div>
              <h1 className="mt-1 text-2xl font-semibold tracking-tight text-fg">{greeting(now)}.</h1>
              <p className="mt-1 max-w-[62ch] text-[14px] leading-relaxed text-muted">{briefing.summary}</p>
            </div>
            <div className="flex gap-2">
              <Button variant="primary" size="md" onClick={() => void send('What needs me?')}>
                <MessageCircle className="size-4" /> Talk it through
              </Button>
            </div>
          </div>
        </section>

        <div className="flex items-baseline gap-2 px-1">
          <h2 className="text-[13px] font-semibold tracking-wide text-fg">Threads of thinking</h2>
          <span className="text-[12px] text-faint">Each one draws on your own notes, not just your calendar.</span>
        </div>
        <div className="grid grid-cols-1 gap-3 @2xl:grid-cols-2">
          {briefing.threads.map((t, i) => (
            <div key={t.id} className={briefing.threads.length % 2 === 1 && i === briefing.threads.length - 1 ? 'flex flex-col @2xl:col-span-2' : 'flex flex-col'}>
              <ThreadCard thread={t} />
            </div>
          ))}
        </div>

        <div className="grid grid-cols-1 gap-3 @2xl:grid-cols-2">
          <BrainPulse />
          <LearnedCard />
        </div>
      </div>

      {/* ---------- right: act ---------- */}
      <div className="flex min-w-0 flex-col gap-3">
        <NeedsYou />
        <Panel
          title="Agents now"
          subtitle={needs ? `${needs} need you` : 'Your Claude sessions'}
          icon={Activity}
          area="work"
          actions={
            <>
              {needs > 0 && <Badge tone="bad">{needs} blocked</Badge>}
              <Button size="xs" variant="ghost" onClick={() => navigate('work')}>Open</Button>
            </>
          }
          bodyClassName="px-2 pb-2"
        >
          <div className="flex flex-col">
            {live.map((s) => (
              <SessionMini key={s.id} session={s} />
            ))}
          </div>
        </Panel>
        <AgendaCard />
        <MoneyPulse />
        <WorldPulse />
      </div>
    </div>
    </div>
  )
}
