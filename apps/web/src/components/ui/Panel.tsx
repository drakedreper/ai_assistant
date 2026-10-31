import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { AREA, type Area } from '../../lib/areas'
import { cn } from '../../lib/cn'

interface PanelProps {
  title?: string
  /** Small caption under/after the title. */
  subtitle?: string
  icon?: LucideIcon
  area?: Area
  actions?: ReactNode
  children?: ReactNode
  className?: string
  bodyClassName?: string
  /** Remove body padding (for lists/tables that bleed to the edge). */
  flush?: boolean
}

/** The glass card every screen is built from. */
export function Panel({ title, subtitle, icon: Icon, area, actions, children, className, bodyClassName, flush }: PanelProps) {
  const a = area ? AREA[area] : null
  return (
    <section className={cn('glass flex min-h-0 flex-col', className)}>
      {(title || actions) && (
        <header className="flex items-center gap-2 px-4 pt-3 pb-2">
          {Icon && (
            <span className={cn('grid size-6 place-items-center rounded-md', a ? a.bg : 'bg-white/5', a ? a.text : 'text-muted')}>
              <Icon className="size-3.5" />
            </span>
          )}
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[13px] font-semibold tracking-wide text-fg">{title}</h2>
            {subtitle && <p className="truncate text-[11px] text-faint">{subtitle}</p>}
          </div>
          {actions}
        </header>
      )}
      <div className={cn('min-h-0 flex-1', flush ? '' : 'px-4 pb-4', !title && !actions && !flush && 'pt-4', bodyClassName)}>{children}</div>
    </section>
  )
}
