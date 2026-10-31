import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'

/** Segmented control / tab strip. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  className,
  size = 'sm',
  ariaLabel,
}: {
  value: T
  onChange: (v: T) => void
  options: Array<{ value: T; label: ReactNode; title?: string }>
  className?: string
  size?: 'xs' | 'sm'
  ariaLabel?: string
}) {
  return (
    <div role="tablist" aria-label={ariaLabel} className={cn('inline-flex rounded-lg border border-line bg-white/4 p-0.5', className)}>
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          type="button"
          aria-selected={o.value === value}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cn(
            'cursor-pointer rounded-md font-medium transition',
            size === 'xs' ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-1 text-xs',
            o.value === value ? 'bg-white/12 text-fg shadow-sm' : 'text-muted hover:text-fg',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
