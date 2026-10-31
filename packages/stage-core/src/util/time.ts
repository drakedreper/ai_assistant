/** Local-time helpers. All take epoch ms so they work with an injected Clock. Local = the process time zone. */

export type TimeOfDay = 'morning' | 'day' | 'evening' | 'night'

export function localMinutes(ms: number): number {
  const d = new Date(ms)
  return d.getHours() * 60 + d.getMinutes()
}

export function localDateKey(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function timeOfDay(ms: number): TimeOfDay {
  const h = new Date(ms).getHours()
  if (h >= 5 && h < 11) return 'morning'
  if (h >= 11 && h < 17) return 'day'
  if (h >= 17 && h < 22) return 'evening'
  return 'night'
}

export interface QuietHoursSpec {
  /** "22:30" */
  from: string
  /** "07:00" */
  to: string
}

/** "HH:MM" to minutes since midnight, or undefined if malformed. */
export function parseHm(s: string): number | undefined {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(s.trim())
  if (!m) return undefined
  return Number(m[1]) * 60 + Number(m[2])
}

/** True inside quiet hours; handles ranges that cross midnight. Malformed specs mean "no quiet hours". */
export function inQuietHours(spec: QuietHoursSpec | undefined, ms: number): boolean {
  if (!spec) return false
  const from = parseHm(spec.from)
  const to = parseHm(spec.to)
  if (from === undefined || to === undefined || from === to) return false
  const now = localMinutes(ms)
  return from < to ? now >= from && now < to : now >= from || now < to
}

/** Milliseconds until quiet hours end (0 when not inside them). */
export function msUntilQuietEnds(spec: QuietHoursSpec | undefined, ms: number): number {
  if (!inQuietHours(spec, ms) || !spec) return 0
  const to = parseHm(spec.to)!
  const now = localMinutes(ms)
  const d = new Date(ms)
  const secs = d.getSeconds() * 1000 + d.getMilliseconds()
  const diffMin = to > now ? to - now : to + 24 * 60 - now
  return diffMin * 60_000 - secs
}
