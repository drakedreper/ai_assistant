import type { Money } from '@ai-assistant/shared'

/** "4 min ago", "2 h ago", "3 d ago". `now` defaults to the real clock. */
export function timeAgo(iso: string, now: Date = new Date()): string {
  const diff = Math.round((now.getTime() - new Date(iso).getTime()) / 1000)
  const abs = Math.abs(diff)
  const fut = diff < 0
  const unit = (n: number, s: string) => (fut ? `in ${n} ${s}` : `${n} ${s} ago`)
  // Items created by the live simulator carry the real clock while `now` ticks every 30 s, so tiny future offsets mean "just now".
  if (abs < 90) return 'just now'
  if (abs < 3600) return unit(Math.round(abs / 60), 'min')
  if (abs < 86400) return unit(Math.round(abs / 3600), 'h')
  return unit(Math.round(abs / 86400), 'd')
}

/** "14:05" in the viewer's local time. */
export function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
}

/** "Mon 2 Nov". */
export function fmtDay(iso: string): string {
  return new Date(iso).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })
}

export function fmtUsd(n: number, digits = 2): string {
  return `$${n.toFixed(digits)}`
}

/** Money (signed minor units) to "$1,234.56" / "-$12.00". */
export function fmtMoney(m: Money, opts: { sign?: boolean; compact?: boolean } = {}): string {
  const v = Number(m.amountMinor) / 100
  const abs = Math.abs(v)
  const body = opts.compact && abs >= 10_000
    ? `${(abs / 1000).toFixed(1)}k`
    : abs.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const sym = m.currency === 'USD' ? '$' : m.currency === 'EUR' ? '€' : `${m.currency} `
  const sign = v < 0 ? '-' : opts.sign && v > 0 ? '+' : ''
  return `${sign}${sym}${body}`
}

export function moneyToNumber(m: Money): number {
  return Number(m.amountMinor) / 100
}

export function greeting(now: Date = new Date()): string {
  const h = now.getHours()
  if (h < 5) return 'Still up?'
  if (h < 12) return 'Good morning'
  if (h < 18) return 'Good afternoon'
  return 'Good evening'
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}
