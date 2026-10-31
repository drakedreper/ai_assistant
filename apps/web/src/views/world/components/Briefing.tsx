import type { NewsItem } from '@ai-assistant/shared'
import { ExternalLink, Info, Newspaper, Sparkles, X } from 'lucide-react'
import { useMemo } from 'react'
import { NoteChip } from '../../../components/NoteChip'
import { Badge, EmptyState, Panel, Segmented } from '../../../components/ui'
import { cn } from '../../../lib/cn'
import { timeAgo } from '../../../lib/format'
import { useSnap, useStore } from '../../../state/store'
import { LOW_MATCH, TOPICS, TOPIC_ORDER } from '../lib'
import { useWorld, type NewsSort, type TopicFilter } from '../ui'

/** The user's news, re-ranked by how each story touches their own notes. */
export function Briefing() {
  const news = useSnap((d) => d.world.news)
  const signals = useSnap((d) => d.world.signals)
  const now = useStore((s) => s.now)
  const topic = useWorld((s) => s.topic)
  const setTopic = useWorld((s) => s.setTopic)
  const sort = useWorld((s) => s.sort)
  const setSort = useWorld((s) => s.setSort)
  const signalId = useWorld((s) => s.signalId)
  const setSignal = useWorld((s) => s.setSignal)

  const signal = signalId ? signals?.find((g) => g.id === signalId) : undefined

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: news.length }
    for (const n of news) c[n.topic] = (c[n.topic] ?? 0) + 1
    return c
  }, [news])

  const visible = useMemo(() => {
    let list = news
    if (signal) list = list.filter((n) => signal.itemIds.includes(n.id))
    if (topic !== 'all') list = list.filter((n) => n.topic === topic)
    return list
      .slice()
      .sort((a, b) =>
        sort === 'newest'
          ? b.publishedAt.localeCompare(a.publishedAt)
          : b.relevance.score - a.relevance.score || b.publishedAt.localeCompare(a.publishedAt),
      )
  }, [news, topic, sort, signal])

  const firstLow = sort === 'foryou' ? visible.findIndex((n) => n.relevance.score < LOW_MATCH) : -1

  const chips: Array<{ value: TopicFilter; label: string }> = [
    { value: 'all', label: 'All' },
    ...TOPIC_ORDER.filter((t) => (counts[t] ?? 0) > 0).map((t) => ({ value: t as TopicFilter, label: TOPICS[t].label })),
  ]

  return (
    <Panel flush className="overflow-hidden">
      <header className="flex flex-col gap-3 px-4 pt-3 pb-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="grid size-6 place-items-center rounded-md bg-world/12 text-world">
            <Newspaper className="size-3.5" aria-hidden />
          </span>
          <div className="mr-auto min-w-0">
            <h2 className="text-[13px] font-semibold tracking-wide text-fg">Your briefing</h2>
            <p className="text-[11px] text-faint">
              {visible.length} of {news.length} stories, {sort === 'foryou' ? 'ranked by how they touch your notes' : 'newest first'}
            </p>
          </div>
          <div className="flex items-center gap-2 text-[12px] text-faint">
            Sort
            <Segmented<NewsSort>
              ariaLabel="Sort stories"
              size="xs"
              value={sort}
              onChange={setSort}
              options={[
                { value: 'foryou', label: 'For you' },
                { value: 'newest', label: 'Newest' },
              ]}
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter by topic">
          {chips.map((c) => {
            const active = topic === c.value
            const Icon = c.value === 'all' ? null : TOPICS[c.value].icon
            return (
              <button
                key={c.value}
                type="button"
                aria-pressed={active}
                onClick={() => setTopic(c.value)}
                className={cn(
                  'inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] leading-4 font-medium transition',
                  active ? 'border-world/50 bg-world/12 text-fg' : 'border-line text-muted hover:border-line-strong hover:text-fg',
                )}
              >
                {Icon && <Icon className="size-3" aria-hidden />}
                {c.label}
                <span className={cn('tabular-nums', active ? 'text-world' : 'text-faint')}>{counts[c.value] ?? 0}</span>
              </button>
            )
          })}
          {signal && (
            <button
              type="button"
              onClick={() => setSignal(signal.id)}
              className="ml-1 inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-brain/40 bg-brain/10 px-2.5 py-1 text-[12px] leading-4 font-medium text-brain transition hover:bg-brain/20"
              aria-label={`Clear signal filter: ${signal.title}`}
            >
              <Sparkles className="size-3" aria-hidden />
              <span className="max-w-[220px] truncate">Signal: {signal.title}</span>
              <X className="size-3" aria-hidden />
            </button>
          )}
        </div>
      </header>

      {visible.length === 0 ? (
        <div className="border-t border-line">
          <EmptyState title="No stories match." hint="Try another topic." />
        </div>
      ) : (
        <ol className="divide-y divide-line border-t border-line" aria-label="Stories">
          {visible.map((n, i) => (
            <li key={n.id}>
              {i === firstLow && firstLow > 0 && (
                <div className="flex items-center gap-2 bg-white/[0.03] px-4 py-1.5 text-[11px] text-faint">
                  <span className="h-px flex-1 bg-line" />
                  Low match: filed, not pushed
                  <span className="h-px flex-1 bg-line" />
                </div>
              )}
              <NewsRow n={n} now={now} />
            </li>
          ))}
        </ol>
      )}

      <footer className="flex items-start gap-2 border-t border-line px-4 py-3 text-[11px] leading-snug text-faint">
        <Info className="mt-px size-3.5 shrink-0" aria-hidden />
        <p>Summarised by a tool-less Reader lane. Headlines and short snippets only; links open in your browser. Sources: RSS, Hacker News, Open-Meteo.</p>
      </footer>
    </Panel>
  )
}

function Ring({ score }: { score: number }) {
  const pct = Math.round(score * 100)
  const r = 16
  const c = 2 * Math.PI * r
  const color = score >= 0.75 ? 'var(--color-world)' : score >= LOW_MATCH ? 'var(--color-brain)' : 'var(--color-faint)'
  return (
    <div className="flex w-11 shrink-0 flex-col items-center gap-0.5" role="meter" aria-label="Relevance to you" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
      <svg width="40" height="40" viewBox="0 0 40 40" aria-hidden>
        <circle cx="20" cy="20" r={r} fill="none" stroke="rgb(255 255 255 / 0.09)" strokeWidth="3.5" />
        <circle
          cx="20"
          cy="20"
          r={r}
          fill="none"
          stroke={color}
          strokeWidth="3.5"
          strokeLinecap="round"
          strokeDasharray={`${(c * score).toFixed(1)} ${c.toFixed(1)}`}
          transform="rotate(-90 20 20)"
        />
        <text x="20" y="24.2" textAnchor="middle" fontSize="12" fontWeight="600" fill="var(--color-fg)" style={{ fontVariantNumeric: 'tabular-nums' }}>
          {pct}
        </text>
      </svg>
      <span className="text-[11px] leading-none text-faint">match</span>
    </div>
  )
}

function NewsRow({ n, now }: { n: NewsItem; now: Date }) {
  const T = TOPICS[n.topic]
  const low = n.relevance.score < LOW_MATCH
  return (
    <article className="flex gap-3.5 px-4 py-3.5" aria-label={n.title}>
      <Ring score={n.relevance.score} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-faint">
          <span className="font-medium text-muted">{n.source}</span>
          {n.via === 'hn' && (
            <Badge title="Hacker News">
              HN{n.points !== undefined && <span className="tabular-nums"> · {n.points} pts</span>}
            </Badge>
          )}
          <span aria-hidden>·</span>
          <time dateTime={n.publishedAt}>{timeAgo(n.publishedAt, now)}</time>
          <Badge className="ml-auto">
            <T.icon className="size-3" aria-hidden /> {T.label}
          </Badge>
        </div>

        <a
          href={n.url}
          target="_blank"
          rel="noopener noreferrer"
          className="group mt-1 inline-flex max-w-full items-start gap-1.5 text-[14px] leading-snug font-semibold text-fg hover:text-world"
        >
          <span className="group-hover:underline">{n.title}</span>
          <ExternalLink className="mt-1 size-3.5 shrink-0 text-faint group-hover:text-world" aria-label="(opens in your browser)" />
        </a>

        <p className="mt-1 flex items-start gap-1.5 text-[13px] leading-snug text-muted">
          <Sparkles className="mt-0.5 size-3.5 shrink-0 text-mira" aria-label="Summary by Mira" />
          {n.summary}
        </p>

        <div className={cn('mt-2.5 rounded-lg border px-3 py-2', low ? 'border-line bg-white/[0.02]' : 'border-brain/20 bg-brain/[0.06]')}>
          <div className={cn('text-[11px] font-medium tracking-wide uppercase', low ? 'text-faint' : 'text-brain')}>Why this matters to you</div>
          <p className="mt-0.5 text-[12px] leading-snug text-fg/90">{n.relevance.why}</p>
          {n.relevance.note && (
            <div className="mt-1.5">
              <NoteChip path={n.relevance.note.path} title={n.relevance.note.title} />
            </div>
          )}
        </div>
      </div>
    </article>
  )
}
