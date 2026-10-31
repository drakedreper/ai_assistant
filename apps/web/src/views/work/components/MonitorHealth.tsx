import { Radio, ShieldCheck } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { StatusDot } from '../../../components/ui'
import { cn } from '../../../lib/cn'
import { useSnap, useStore } from '../../../state/store'
import { rel } from '../lib'

const HOOK_ADDR = '127.0.0.1:47821'
const ROSTER_CMD = 'claude agents --json'

/**
 * "Monitor health" chip with a details popover. The point is honesty about how we know what we know:
 * interactive sessions only expose busy / waiting / idle through the roster, so hooks are the live feed.
 */
export function MonitorHealth() {
  const lastEvent = useSnap((d) => d.events[0])
  const sessions = useSnap((d) => d.sessions)
  const now = useStore((s) => s.now)
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const lastTs = lastEvent?.ts
  const quiet = lastTs ? now.getTime() - new Date(lastTs).getTime() > 30 * 60_000 : true
  const color = quiet ? 'var(--color-warn)' : 'var(--color-ok)'
  const ago = lastTs ? rel(lastTs, now) : 'never'
  const bySource = (src: string) => sessions.filter((s) => s.source === src).length

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="monitor-health-popover"
        onClick={() => setOpen((o) => !o)}
        className="glass flex h-9 cursor-pointer items-center gap-2 px-3 text-xs text-muted transition hover:text-fg"
      >
        <StatusDot color={color} pulse={!quiet} />
        <span className="font-medium text-fg">Monitor health</span>
        <span className="hidden text-faint @5xl:inline">hooks on 127.0.0.1 · last event {ago}</span>
      </button>

      {open && (
        <div
          id="monitor-health-popover"
          role="dialog"
          aria-label="Monitor health details"
          className="glass fade-up absolute top-11 right-0 z-30 w-[min(400px,calc(100vw-2rem))] p-4 shadow-2xl"
          style={{ background: 'var(--color-surface)' }}
        >
          <div className="mb-3 flex items-center gap-2">
            <ShieldCheck className="size-4 text-ok" aria-hidden />
            <h3 className="text-[13px] font-semibold text-fg">{quiet ? 'Quiet: no recent hook events' : 'Listening, events are flowing'}</h3>
          </div>
          <dl className="grid grid-cols-[110px_minmax(0,1fr)] gap-x-3 gap-y-2 text-[12px]">
            <dt className="text-faint">Hook receiver</dt>
            <dd className="text-fg">
              Listening on <code className="font-mono text-[11px] text-work">{HOOK_ADDR}</code>
              <span className="block text-muted">Loopback only. Nothing leaves this PC.</span>
            </dd>
            <dt className="text-faint">Last event</dt>
            <dd className="text-fg tabular-nums">
              {lastEvent ? (
                <>
                  <code className="font-mono text-[11px]">{lastEvent.hookEvent}</code> · {ago}
                  <span className="block text-muted">{lastEvent.summary}</span>
                </>
              ) : (
                'none yet'
              )}
            </dd>
            <dt className="text-faint">Roster</dt>
            <dd className="text-fg">
              <code className="font-mono text-[11px] text-work">{ROSTER_CMD}</code>
              <span className="block text-muted">Research preview. Polled every 15 s as a cross-check.</span>
            </dd>
            <dt className="text-faint">Sessions seen</dt>
            <dd className="text-fg tabular-nums">
              {bySource('hook')} via hooks · {bySource('sdk')} launched by Mira · {bySource('import')} imported
            </dd>
          </dl>
          <div className={cn('mt-3 rounded-lg border border-line bg-white/[0.03] p-2.5 text-[12px] leading-relaxed text-muted')}>
            <p className="flex items-start gap-1.5">
              <Radio className="mt-0.5 size-3.5 shrink-0 text-work" aria-hidden />
              <span>
                Interactive sessions only expose <b className="text-fg">busy</b>, <b className="text-fg">waiting</b> or <b className="text-fg">idle</b> through the
                roster. Hooks are the primary live feed; the roster catches sessions whose hooks went quiet and marks them Stale.
              </span>
            </p>
            <p className="mt-1.5 pl-5">PreToolUse is deliberately not hooked: it would add latency to every tool call.</p>
          </div>
        </div>
      )}
    </div>
  )
}
