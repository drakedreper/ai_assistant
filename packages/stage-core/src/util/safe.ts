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

/** Strip control characters and collapse whitespace; used for display names and memory text. */
export function cleanText(input: string, maxLen: number): string {
  // eslint-disable-next-line no-control-regex
  const stripped = input.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
  return stripped.replace(/[ \t]+/g, ' ').trim().slice(0, maxLen)
}
