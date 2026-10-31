import { CheckCircle2, Info, TriangleAlert, X } from 'lucide-react'
import { createPortal } from 'react-dom'
import { cn } from '../../../lib/cn'
import { IconButton } from '../../../components/ui'
import { useWork } from '../ui'

const TONE = {
  ok: { icon: CheckCircle2, cls: 'text-ok' },
  info: { icon: Info, cls: 'text-work' },
  warn: { icon: TriangleAlert, cls: 'text-warn' },
} as const

/**
 * Small confirmation toasts for actions that have no daemon behind them yet. Portaled to the body because the
 * screen root is a size container, which would otherwise become the containing block of position: fixed.
 */
export function Toasts() {
  const toasts = useWork((s) => s.toasts)
  const dismiss = useWork((s) => s.dismissToast)
  return createPortal(
    <div className="pointer-events-none fixed right-5 bottom-5 z-50 flex w-[min(360px,calc(100vw-2rem))] flex-col gap-2" role="status" aria-live="polite">
      {toasts.map((t) => {
        const T = TONE[t.tone]
        return (
          <div key={t.id} className="glass fade-up pointer-events-auto flex items-start gap-2.5 px-3 py-2.5 shadow-2xl">
            <T.icon className={cn('mt-0.5 size-4 shrink-0', T.cls)} aria-hidden />
            <p className="min-w-0 flex-1 text-[13px] leading-snug text-fg">{t.text}</p>
            <IconButton aria-label="Dismiss message" className="-mt-1 -mr-1.5 size-6" onClick={() => dismiss(t.id)}>
              <X className="size-3.5" />
            </IconButton>
          </div>
        )
      })}
    </div>,
    document.body,
  )
}
