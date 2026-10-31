/** Time helpers. Fixtures are built relative to `now` so the mockup always looks like "today". */

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** Local calendar date (YYYY-MM-DD) of `now` shifted by `dayOffset` days. */
export function dateOnly(now: Date, dayOffset = 0): string {
  const d = new Date(now)
  d.setDate(d.getDate() + dayOffset)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** ISO timestamp for local time "HH:MM" on the day `dayOffset` days from `now`. */
export function at(now: Date, hhmm: string, dayOffset = 0): string {
  const [h = '0', m = '0'] = hhmm.split(':')
  const d = new Date(now)
  d.setDate(d.getDate() + dayOffset)
  d.setHours(Number(h), Number(m), 0, 0)
  return d.toISOString()
}

/** ISO timestamp `minutes` before `now` (negative = after). */
export function ago(now: Date, minutes: number): string {
  return new Date(now.getTime() - minutes * 60_000).toISOString()
}

/** Vault path of the journal note for a day. */
export function journalPath(now: Date, dayOffset = 0): string {
  const date = dateOnly(now, dayOffset)
  return `20-journal/${date.slice(0, 4)}/${date}.md`
}

/** USD money in minor units (cents) from dollars. Negative = outflow. */
export function usd(dollars: number): { amountMinor: string; currency: string } {
  return { amountMinor: String(Math.round(dollars * 100)), currency: 'USD' }
}
