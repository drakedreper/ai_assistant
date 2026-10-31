import { useId, type ReactNode } from 'react'
import { cn } from '../../../lib/cn'

/**
 * Small CSS tooltip that shows on hover and on keyboard focus. Disabled buttons cannot take focus or fire
 * hover reliably, so `focusable` wraps them in a focusable span that carries the description.
 */
export function Tip({
  text,
  children,
  side = 'bottom',
  align = 'center',
  focusable,
  className,
}: {
  text: ReactNode
  children: ReactNode
  side?: 'top' | 'bottom'
  align?: 'start' | 'center' | 'end'
  focusable?: boolean
  className?: string
}) {
  const id = useId()
  return (
    <span className={cn('group/tip relative inline-flex', className)}>
      <span tabIndex={focusable ? 0 : undefined} aria-describedby={id} className="inline-flex rounded-lg">
        {children}
      </span>
      <span
        id={id}
        role="tooltip"
        className={cn(
          'pointer-events-none absolute z-40 w-max max-w-[260px] rounded-lg border border-line-strong bg-raised px-2.5 py-1.5 text-left text-[11px] leading-snug font-normal whitespace-normal text-muted opacity-0 shadow-xl transition-opacity duration-150',
          'group-hover/tip:opacity-100 group-hover/tip:delay-200 group-focus-within/tip:opacity-100',
          side === 'top' ? 'bottom-full mb-1.5' : 'top-full mt-1.5',
          align === 'end' ? 'right-0' : align === 'start' ? 'left-0' : 'left-1/2 -translate-x-1/2',
        )}
      >
        {text}
      </span>
    </span>
  )
}
