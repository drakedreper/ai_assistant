import type { AgentEvent, Session } from '@ai-assistant/shared'
import { useMemo, useState } from 'react'
import { Badge, EmptyState } from '../../../components/ui'
import { cn } from '../../../lib/cn'
import { useSnap, useStore } from '../../../state/store'
import { rel } from '../lib'
import { hookTone } from './Atoms'

const LEVEL = {
  info: { dot: 'var(--color-faint)', text: 'text-muted', label: 'info' },
  warn: { dot: 'var(--color-warn)', text: 'text-warn', label: 'warning' },
  error: { dot: 'var(--color-bad)', text: 'text-bad', label: 'error' },
} as const

const LIMIT = 14

function fullTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
}

function Row({ ev, session, now, last }: { ev: AgentEvent; session: Session; now: Date; last: boolean }) {
  const lv = LEVEL[ev.level]
  const agent = ev.agentId && ev.agentId !== 'main' ? session.agents.find((a) => a.id === ev.agentId) : undefined
  return (
    <li className="fade-up relative flex gap-2.5 pb-3">
      <span className="relative flex w-3 shrink-0 justify-center">
        {!last && <span className="absolute top-3.5 -bottom-3 w-px bg-line" aria-hidden />}
        <span className="mt-1.5 size-2 rounded-full ring-2 ring-surface" style={{ background: lv.dot }} aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone={hookTone(ev.hookEvent)} className="font-mono">{ev.hookEvent}</Badge>
          {ev.toolName && <code className="rounded bg-white/8 px-1.5 py-px font-mono text-[11px] text-fg">{ev.toolName}</code>}
          {agent && <span className="rounded border border-line px-1.5 text-[11px] text-muted" title={agent.description}>{agent.type}</span>}
          <time dateTime={ev.ts} title={fullTime(ev.ts)} className="ml-auto shrink-0 text-[11px] text-faint tabular-nums">
            {rel(ev.ts, now)}
          </time>
        </div>
        <p className={cn('mt-0.5 text-[12px] leading-snug break-words', lv.text)}>
          <span className="sr-only">{lv.label}: </span>
          {ev.summary}
        </p>
      </div>
    </li>
  )
}

/** Live hook-event feed for one session, newest first. Reads the store, so new events slide in as they arrive. */
export function EventTimeline({ session }: { session: Session }) {
  const events = useSnap((d) => d.events)
  const now = useStore((s) => s.now)
  const [all, setAll] = useState(false)
  // Dedupe by id: in dev, StrictMode can subscribe the store to the live feed twice.
  const mine = useMemo(() => {
    const seen = new Set<string>()
    return events.filter((e) => {
      if (e.sessionId !== session.id || seen.has(e.id)) return false
      seen.add(e.id)
      return true
    })
  }, [events, session.id])
  const shown = all ? mine : mine.slice(0, LIMIT)

  if (mine.length === 0) {
    return (
      <EmptyState
        title={session.source === 'import' ? 'No live events for imported history' : 'No hook events yet'}
        hint={session.source === 'import' ? 'Backfilled sessions only carry their summary and cost.' : 'Events appear here as soon as the hook receiver sees them.'}
      />
    )
  }
  return (
    <div>
      <ol aria-label={`Events for ${session.title}, newest first`}>
        {shown.map((ev, i) => (
          <Row key={ev.id} ev={ev} session={session} now={now} last={i === shown.length - 1} />
        ))}
      </ol>
      {mine.length > LIMIT && (
        <button type="button" onClick={() => setAll((a) => !a)} className="cursor-pointer text-[12px] text-work hover:underline">
          {all ? 'Show fewer' : `Show all ${mine.length} events`}
        </button>
      )}
    </div>
  )
}
