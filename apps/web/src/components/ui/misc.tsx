import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-line-strong bg-white/6 px-1.5 py-px font-mono text-[10px] text-muted">{children}</kbd>
  )
}

/** Colored status dot; `pulse` for live things. */
export function StatusDot({ color, pulse, className }: { color: string; pulse?: boolean; className?: string }) {
  return <span className={cn('inline-block size-2 rounded-full', pulse && 'pulse-dot', className)} style={{ background: color }} />
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="grid place-items-center gap-1 py-8 text-center">
      <p className="text-sm text-muted">{title}</p>
      {hint && <p className="text-xs text-faint">{hint}</p>}
    </div>
  )
}

/** Big number + label tile. */
export function Stat({ label, value, sub, className }: { label: string; value: ReactNode; sub?: ReactNode; className?: string }) {
  return (
    <div className={cn('min-w-0', className)}>
      <div className="text-[11px] tracking-wide text-faint uppercase">{label}</div>
      <div className="truncate text-lg leading-tight font-semibold text-fg tabular-nums">{value}</div>
      {sub && <div className="truncate text-[11px] text-muted">{sub}</div>}
    </div>
  )
}

/** Round initials chip. */
export function Initials({ name, className }: { name: string; className?: string }) {
  const t = name
    .split(/\s+/)
    .map((p) => p[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase()
  return <span className={cn('grid size-7 place-items-center rounded-full bg-white/10 text-[11px] font-semibold text-fg', className)}>{t}</span>
}
