import { cn } from '../../lib/cn'

/** Horizontal meter. Color shifts to warn/bad as it fills unless `color` is given. */
export function Gauge({ pct, color, className, height = 5, label }: { pct: number; color?: string; className?: string; height?: number; label?: string }) {
  const v = Math.max(0, Math.min(100, pct))
  const auto = v >= 85 ? 'var(--color-bad)' : v >= 65 ? 'var(--color-warn)' : 'var(--color-ok)'
  return (
    <div
      role="meter"
      aria-valuenow={Math.round(v)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
      className={cn('w-full overflow-hidden rounded-full bg-white/8', className)}
      style={{ height }}
    >
      <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${v}%`, background: color ?? auto }} />
    </div>
  )
}
