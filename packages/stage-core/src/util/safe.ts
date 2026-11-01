/** Input hygiene shared by every module that accepts keys or ids from outside (tools, JSON, stage events). */

/** Keys that must never be accepted as property names (prototype pollution). */
export const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])

export const isSafeKey = (key: string): boolean => !FORBIDDEN_KEYS.has(key)

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

/** Own property names including a literal "__proto__" key created by JSON.parse. */
export function ownKeys(obj: object): string[] {
  return Object.getOwnPropertyNames(obj)
}

/** True if the object (or any nested plain object/array, up to depth) has a forbidden own key. */
export function hasForbiddenKeys(value: unknown, depth = 6): boolean {
  if (depth < 0 || value === null || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some((v) => hasForbiddenKeys(v, depth - 1))
  for (const k of ownKeys(value)) {
    if (FORBIDDEN_KEYS.has(k)) return true
    if (hasForbiddenKeys((value as Record<string, unknown>)[k], depth - 1)) return true
  }
  return false
}

/** Ids: short, printable, no separators that could confuse paths or logs. */
export const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/
export const isSafeId = (id: unknown): id is string => typeof id === 'string' && SAFE_ID.test(id) && !FORBIDDEN_KEYS.has(id)

/**
 * Clean one line of display text (names, preset names, memory text). Tabs, newlines and other line breaks become a space (a
 * name cannot start a second log line); control characters, invisible format characters (zero-width characters, bidi marks
 * and overrides, the BOM, soft hyphens), line and paragraph separators and lone surrogates are removed; whitespace is
 * collapsed and trimmed; the cut to `maxLen` UTF-16 units never splits a surrogate pair. Never throws.
 */
export function cleanText(input: string, maxLen: number): string {
  if (typeof input !== 'string') return ''
  const oneLine = input.replace(/[\t\n\r\u000b\u000c\u0085\u2028\u2029]+/g, ' ')
  const stripped = oneLine.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/gu, '')
  const collapsed = stripped.replace(/\s+/g, ' ').trim()
  return truncateUnits(collapsed, maxLen)
}

/** Cut to at most `max` UTF-16 units without leaving half of a surrogate pair at the end. */
export function truncateUnits(s: string, max: number): string {
  const n = Number.isFinite(max) ? Math.max(0, Math.floor(max)) : s.length
  if (s.length <= n) return s
  let end = n
  const last = end > 0 ? s.charCodeAt(end - 1) : 0
  if (last >= 0xd800 && last <= 0xdbff) end-- // the cut would split a pair
  return s.slice(0, end).trim()
}
