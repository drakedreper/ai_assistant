import { cn } from '../lib/cn'

/** Her little avatar disc, used in chat bubbles and headers. */
export function MiraDisc({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <span
      aria-hidden
      style={{ width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.46)) }}
      className={cn(
        'grid shrink-0 place-items-center rounded-full bg-gradient-to-br from-mira to-brain font-bold text-canvas shadow-[0_0_0_2px_rgb(255_143_177/0.18)]',
        className,
      )}
    >
      M
    </span>
  )
}
