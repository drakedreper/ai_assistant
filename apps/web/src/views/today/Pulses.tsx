import { ArrowUpRight, Brain, Globe, Sparkles, TrendingDown, TrendingUp, Wallet } from 'lucide-react'
import { useMemo } from 'react'
import { NoteChip } from '../../components/NoteChip'
import { Badge, Button, Gauge, Panel, Sparkline } from '../../components/ui'
import { api } from '../../api'
import { fmtMoney, moneyToNumber, timeAgo } from '../../lib/format'
import { useSnap, useStore } from '../../state/store'

/** Net worth + budget at a glance. Aggregates only; amounts are blurred in guest mode. */
export function MoneyPulse() {
  const finance = useSnap((d) => d.finance)
  const navigate = useStore((s) => s.navigate)
  const stats = useMemo(() => {
    const nw = finance.netWorth
    const last = nw[nw.length - 1]
    const prev = nw[Math.max(0, nw.length - 2)]
    const planned = finance.budget.reduce((a, b) => a + moneyToNumber(b.planned), 0)
    const actual = finance.budget.reduce((a, b) => a + moneyToNumber(b.actual), 0)
    const delta = last && prev ? moneyToNumber(last.net) - moneyToNumber(prev.net) : 0
    return { last, delta, series: nw.map((p) => moneyToNumber(p.net)), pct: planned ? (actual / planned) * 100 : 0, under: planned - actual }
  }, [finance])
  return (
    <Panel
      title="Money (Atlas)"
      subtitle={finance.connected ? 'Connected' : 'Mock data. Atlas not connected'}
      icon={Wallet}
      area="money"
      actions={<Button size="xs" variant="ghost" onClick={() => navigate('money')}>Open <ArrowUpRight className="size-3" /></Button>}
    >
      <div className="flex items-end justify-between gap-3" data-sensitive>
        <div>
          <div className="text-[11px] tracking-wide text-faint uppercase">Net worth</div>
          <div className="text-xl font-semibold text-fg tabular-nums">{stats.last ? fmtMoney(stats.last.net) : '-'}</div>
          <div className={stats.delta >= 0 ? 'flex items-center gap-1 text-[11px] text-ok' : 'flex items-center gap-1 text-[11px] text-bad'}>
            {stats.delta >= 0 ? <TrendingUp className="size-3" /> : <TrendingDown className="size-3" />}
            {fmtMoney({ amountMinor: String(Math.round(Math.abs(stats.delta) * 100)), currency: 'USD' }, { sign: false })} vs last month
          </div>
        </div>
        <Sparkline values={stats.series} width={110} height={36} color="var(--color-money)" />
      </div>
      <div className="mt-3">
        <div className="mb-1 flex items-center justify-between text-[11px] text-muted">
          <span>Budget this month</span>
          <span className="tabular-nums" data-sensitive>{Math.round(stats.pct)}% used</span>
        </div>
        <Gauge pct={stats.pct} color="var(--color-money)" label="Budget used" />
        <p className="mt-1.5 text-[11px] text-faint">Mira sees aggregates only; raw transactions stay hidden.</p>
      </div>
    </Panel>
  )
}

/** Top two stories for you, ranked by how they connect to your own notes. */
export function WorldPulse() {
  const news = useSnap((d) => d.world.news)
  const navigate = useStore((s) => s.navigate)
  const now = useStore((s) => s.now)
  const top = useMemo(() => [...news].sort((a, b) => b.relevance.score - a.relevance.score).slice(0, 2), [news])
  return (
    <Panel
      title="World, for you"
      subtitle="Ranked by your projects and strategies"
      icon={Globe}
      area="world"
      actions={<Button size="xs" variant="ghost" onClick={() => navigate('world')}>Open <ArrowUpRight className="size-3" /></Button>}
    >
      <ul className="flex flex-col gap-3">
        {top.map((n) => (
          <li key={n.id} className="min-w-0">
            <div className="flex items-center gap-1.5 text-[11px] text-faint">
              <span>{n.source}</span>·<span>{timeAgo(n.publishedAt, now)}</span>
              <Badge tone="world" className="ml-auto">{Math.round(n.relevance.score * 100)}% match</Badge>
            </div>
            <p className="mt-0.5 text-[13px] leading-snug font-medium text-fg">{n.title}</p>
            <p className="mt-0.5 text-[12px] text-muted">{n.relevance.why}</p>
            {n.relevance.note && <div className="mt-1"><NoteChip path={n.relevance.note.path} title={n.relevance.note.title} /></div>}
          </li>
        ))}
      </ul>
    </Panel>
  )
}

/** The second brain's heartbeat: pending proposals and the last nightly consolidation. */
export function BrainPulse() {
  const proposals = useSnap((d) => d.proposals)
  const memory = useSnap((d) => d.memory)
  const notes = useSnap((d) => d.notes)
  const navigate = useStore((s) => s.navigate)
  const now = useStore((s) => s.now)
  const pending = proposals.filter((p) => p.status === 'pending').length
  const last = useMemo(() => [...memory].sort((a, b) => b.at.localeCompare(a.at))[0], [memory])
  return (
    <Panel
      title="Second brain"
      subtitle={`${notes.length} notes · every change is a commit`}
      icon={Brain}
      area="brain"
      actions={<Button size="xs" variant="ghost" onClick={() => navigate('brain')}>Open <ArrowUpRight className="size-3" /></Button>}
    >
      <div className="flex items-center gap-2">
        <Badge tone={pending ? 'mira' : 'ok'}>{pending ? `${pending} proposal${pending > 1 ? 's' : ''} to review` : 'No proposals'}</Badge>
        {pending > 0 && (
          <Button size="xs" variant="ghost" onClick={() => navigate('brain', { tab: 'proposals' })}>Review</Button>
        )}
      </div>
      {last && (
        <div className="mt-3 rounded-lg border border-line bg-white/[0.03] p-2.5">
          <div className="text-[11px] text-faint">{last.title} · {timeAgo(last.at, now)}</div>
          <p className="mt-0.5 text-[12px] leading-relaxed text-muted">{last.summary}</p>
        </div>
      )}
    </Panel>
  )
}

/** Things she picked up about you. Inspectable and forgettable. */
export function LearnedCard() {
  const learned = useSnap((d) => d.learned)
  const navigate = useStore((s) => s.navigate)
  return (
    <Panel
      title="What I learned about you"
      subtitle="Inspect or forget any of it"
      icon={Sparkles}
      actions={<Button size="xs" variant="ghost" onClick={() => navigate('settings', { tab: 'memory' })}>Memory controls</Button>}
    >
      {learned.length === 0 ? (
        <p className="text-[12px] text-faint">Nothing yet. I only remember what you let me.</p>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {learned.map((f) => (
            <li key={f.id} className="flex gap-2">
              <div className="min-w-0 flex-1">
                <p className="text-[13px] leading-snug text-fg">{f.text}</p>
                <div className="mt-1 flex items-center gap-1.5">
                  <Badge tone={f.confidence === 'high' ? 'ok' : 'neutral'}>{f.confidence} confidence</Badge>
                  <NoteChip path={f.source.path} title={f.source.title} />
                </div>
              </div>
              <Button size="xs" variant="ghost" aria-label={`Forget: ${f.text}`} onClick={() => void api.forgetFact(f.id)}>Forget</Button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}
