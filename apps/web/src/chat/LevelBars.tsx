import { useEffect, useRef } from 'react'
import { cn } from '../lib/cn'

/**
 * Fake live level meter / waveform. Heights are written straight to the DOM from a requestAnimationFrame
 * loop (about 24 fps) so it never re-renders React. With prefers-reduced-motion the bars sit still.
 */
export function LevelBars({
  active,
  bars = 5,
  className,
  barClassName,
  height = 16,
}: {
  active: boolean
  bars?: number
  className?: string
  barClassName?: string
  height?: number
}) {
  const refs = useRef<Array<HTMLSpanElement | null>>([])

  useEffect(() => {
    const els = refs.current
    const calm = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    const paint = (t: number) => {
      for (let i = 0; i < els.length; i++) {
        const el = els[i]
        if (!el) continue
        const wave = active && !calm ? 0.5 + 0.5 * Math.sin(t / 130 + i * 1.7) * Math.sin(t / 310 + i * 0.9) : 0.28
        const v = active && calm ? 0.5 : wave
        el.style.height = `${Math.max(14, Math.round(v * 100))}%`
      }
    }
    paint(0)
    if (!active || calm) return
    let raf = 0
    let last = 0
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop)
      if (t - last < 42) return
      last = t
      paint(t)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [active, bars])

  return (
    <span className={cn('inline-flex items-center gap-[2px]', className)} style={{ height }} aria-hidden>
      {Array.from({ length: bars }, (_, i) => (
        <span
          key={i}
          ref={(el) => {
            refs.current[i] = el
          }}
          className={cn('w-[3px] rounded-full bg-mira', barClassName)}
          style={{ height: '28%' }}
        />
      ))}
    </span>
  )
}
