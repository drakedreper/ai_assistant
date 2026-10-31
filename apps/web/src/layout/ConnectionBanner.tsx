import { Info, Loader2, TriangleAlert, WifiOff, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { dismissNotice, useApiUi } from '../api'
import { cn } from '../lib/cn'
import { useStore } from '../state/store'

/** A short grace period so a brief handshake (page load, a quick blip) does not flash a banner. */
const GRACE_MS = 800

/**
 * True while the daemon link is down in daemon mode, once it has been down for a moment. The fixture client is always
 * online, so this is false for the mockup. Shared by the banner, the TopBar badge and the Shell's read-only look.
 */
export function useLinkDown(): boolean {
  const connection = useStore((s) => s.connection)
  const daemon = useApiUi().mode === 'daemon'
  const down = daemon && connection !== 'online'
  const [late, setLate] = useState(false)
  useEffect(() => {
    if (!down) {
      setLate(false)
      return
    }
    const t = setTimeout(() => setLate(true), GRACE_MS)
    return () => clearTimeout(t)
  }, [down])
  return down && late
}

/**
 * A slim strip above the top bar. Three independent messages, each only when it applies:
 *  - the mockup is showing although a daemon was expected (why);
 *  - the daemon link is down (the last known data stays on screen, dimmed);
 *  - a command just failed (it did not happen, and what to do).
 * Polite live regions, so a screen reader hears them without being interrupted.
 */
export function ConnectionBanner() {
  const ui = useApiUi()
  const linkDown = useLinkDown()
  const [dismissedFallback, setDismissedFallback] = useState<string | null>(null)

  const showFallback = ui.mode === 'fixtures' && ui.fallbackNote !== null && dismissedFallback !== ui.fallbackNote
  if (!showFallback && !linkDown && ui.notices.length === 0) return null

  return (
    <div className="flex shrink-0 flex-col gap-1.5 px-3 pt-2">
      {showFallback && (
        <div role="status" className="flex items-start gap-2 rounded-lg border border-world/30 bg-world/10 px-3 py-1.5 text-[12px] leading-snug text-muted">
          <Info className="mt-px size-3.5 shrink-0 text-world" aria-hidden />
          <p className="min-w-0 flex-1">{ui.fallbackNote}</p>
          <button
            type="button"
            onClick={() => setDismissedFallback(ui.fallbackNote)}
            aria-label="Dismiss this message"
            className="grid size-5 shrink-0 cursor-pointer place-items-center rounded text-faint transition hover:text-fg"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        </div>
      )}

      {linkDown && (
        <div role="status" aria-live="polite" className="flex items-start gap-2 rounded-lg border border-warn/35 bg-warn/[0.08] px-3 py-1.5 text-[12px] leading-snug text-fg">
          <Loader2 className="mt-px size-3.5 shrink-0 animate-spin text-warn" aria-hidden />
          <p className="min-w-0 flex-1">
            <span className="font-medium text-warn">Reconnecting to the daemon&hellip;</span>{' '}
            <span className="text-muted">
              {ui.connectionNote ?? 'You are looking at the last data received. Changes are paused until it is back.'}
            </span>
          </p>
          <WifiOff className="mt-px size-3.5 shrink-0 text-warn/70" aria-hidden />
        </div>
      )}

      {ui.notices.map((n) => (
        <div
          key={n.id}
          role={n.level === 'error' ? 'alert' : 'status'}
          className={cn(
            'flex items-start gap-2 rounded-lg border px-3 py-1.5 text-[12px] leading-snug',
            n.level === 'error' ? 'border-bad/35 bg-bad/10 text-fg' : 'border-line-strong bg-white/5 text-muted',
          )}
        >
          {n.level === 'error' ? <TriangleAlert className="mt-px size-3.5 shrink-0 text-bad" aria-hidden /> : <Info className="mt-px size-3.5 shrink-0 text-faint" aria-hidden />}
          <p className="min-w-0 flex-1">{n.text}</p>
          <button
            type="button"
            onClick={() => dismissNotice(n.id)}
            aria-label="Dismiss this message"
            className="grid size-5 shrink-0 cursor-pointer place-items-center rounded text-faint transition hover:text-fg"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        </div>
      ))}
    </div>
  )
}
