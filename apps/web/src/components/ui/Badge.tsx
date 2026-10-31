import type { ReactNode } from 'react'
import { AREA, type Area } from '../../lib/areas'
import { cn } from '../../lib/cn'

export type Tone = 'neutral' | 'ok' | 'warn' | 'bad' | 'info' | 'mira' | Area

const TONE: Record<string, string> = {
  neutral: 'bg-white/6 text-muted border-line',
  ok: 'bg-ok/12 text-ok border-ok/30',
  warn: 'bg-warn/12 text-warn border-warn/30',
  bad: 'bg-bad/12 text-bad border-bad/30',
  info: 'bg-world/12 text-world border-world/30',
  mira: 'bg-mira/12 text-mira border-mira/30',
}

/** Small pill. Pass an area name to get that area's hue. */
export function Badge({ tone = 'neutral', children, className, title }: { tone?: Tone; children: ReactNode; className?: string; title?: string }) {
  const cls = tone in AREA ? `${AREA[tone as Area].bg} ${AREA[tone as Area].text} ${AREA[tone as Area].border}` : (TONE[tone] ?? TONE.neutral)
  return (
    <span
      title={title}
      className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] leading-4 font-medium whitespace-nowrap', cls, className)}
    >
      {children}
    </span>
  )
}
