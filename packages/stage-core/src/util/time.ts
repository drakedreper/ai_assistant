/** Local-time helpers. All take epoch ms so they work with an injected Clock. Local = the process time zone. */

export type TimeOfDay = 'morning' | 'day' | 'evening' | 'night'

export function localMinutes(ms: number): number {
  const d = new Date(ms)
  const m = d.getHours() * 60 + d.getMinutes()
  return Number.isNaN(m) ? 0 : m // an invalid time (NaN, beyond the Date range) is "midnight", never NaN
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

/** "HH:MM" to minutes since midnight, or undefined if malformed (or not text at all: null, a number, an object). */
export function parseHm(s: unknown): number | undefined {
  if (typeof s !== 'string') return undefined
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(s.trim())
  if (!m) return undefined
  return Number(m[1]) * 60 + Number(m[2])
}

/** The two minutes of a quiet-hours spec, or undefined when it is not a usable spec (anything but { from: "HH:MM", to: "HH:MM" } with from != to). */
function quietRange(spec: unknown): { from: number; to: number } | undefined {
  try {
    if (spec === null || typeof spec !== 'object') return undefined
    const from = parseHm((spec as { from?: unknown }).from)
    const to = parseHm((spec as { to?: unknown }).to)
    return from === undefined || to === undefined || from === to ? undefined : { from, to }
  } catch {
    return undefined // a getter that throws, a Proxy: not a usable spec
  }
}

/** Is this a usable quiet-hours spec? */
export function isQuietHoursSpec(spec: unknown): spec is QuietHoursSpec {
  return quietRange(spec) !== undefined
}

/** True inside quiet hours; handles ranges that cross midnight. Malformed specs (of any kind) mean "no quiet hours"; never throws. */
export function inQuietHours(spec: QuietHoursSpec | undefined, ms: number): boolean {
  const r = quietRange(spec)
  if (!r || !Number.isFinite(ms)) return false
  const now = localMinutes(ms)
  return r.from < r.to ? now >= r.from && now < r.to : now >= r.from || now < r.to
}

/** Milliseconds until quiet hours end (0 when not inside them). */
export function msUntilQuietEnds(spec: QuietHoursSpec | undefined, ms: number): number {
  const r = quietRange(spec)
  if (!r || !inQuietHours(spec, ms)) return 0
  const now = localMinutes(ms)
  const d = new Date(ms)
  const secs = d.getSeconds() * 1000 + d.getMilliseconds()
  const diffMin = r.to > now ? r.to - now : r.to + 24 * 60 - now
  return diffMin * 60_000 - secs
}
