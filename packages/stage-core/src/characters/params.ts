/**
 * Morph-parameter validation against the BASE asset's MorphParam definitions.
 *
 * Rules: the input must be a plain object without prototype-pollution keys; every id must be defined by the base;
 * scalar values must be finite numbers (no strings, NaN, Infinity) and are CLAMPED into [min, max]; colour values are
 * "#rgb"/"#rrggbb" strings or 24-bit integers and are normalised to "#rrggbb". The result is the full resolved set
 * (defaults filled in), so a stage always receives every parameter.
 */
import type { Asset, MorphParam } from '@ai-assistant/shared'
import { COLOR_MAX } from '../assets/manifest'
import { FORBIDDEN_KEYS, isPlainObject, ownKeys } from '../util/safe'

export type ParamValue = number | string
export type ParamSet = Record<string, ParamValue>

export type ParamValidation =
  | { ok: true; params: ParamSet; clamped: string[]; changed: string[] }
  | { ok: false; errors: string[] }

const MAX_KEYS = 256

export const colorToHex = (n: number): string => `#${Math.max(0, Math.min(COLOR_MAX, Math.trunc(n))).toString(16).padStart(6, '0')}`

/** Accepts "#rgb", "#rrggbb" (any case) or an integer 0..0xFFFFFF; returns "#rrggbb" or undefined. */
export function normalizeColor(v: unknown): string | undefined {
  if (typeof v === 'number') return Number.isInteger(v) && v >= 0 && v <= COLOR_MAX ? colorToHex(v) : undefined
  if (typeof v !== 'string') return undefined
  const m3 = /^#([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/.exec(v)
  if (m3) return `#${m3[1]}${m3[1]}${m3[2]}${m3[2]}${m3[3]}${m3[3]}`.toLowerCase()
  if (/^#[0-9a-fA-F]{6}$/.test(v)) return v.toLowerCase()
  return undefined
}

/** Defaults of a base asset's parameters (colours as "#rrggbb"). */
export function defaultParams(base: Pick<Asset, 'params'>): ParamSet {
  const out: ParamSet = {}
  for (const p of base.params) out[p.id] = p.type === 'color' ? colorToHex(p.default) : p.default
  return out
}

/** Validate one value against one definition. */
export function validateParamValue(def: MorphParam, value: unknown): { ok: true; value: ParamValue; clamped: boolean } | { ok: false; error: string } {
  if (def.type === 'color') {
    const hex = normalizeColor(value)
    return hex === undefined ? { ok: false, error: `${def.id} must be a colour like "#aabbcc"` } : { ok: true, value: hex, clamped: false }
  }
  if (typeof value !== 'number') return { ok: false, error: `${def.id} must be a number` }
  if (!Number.isFinite(value)) return { ok: false, error: `${def.id} must be finite` }
  const clamped = Math.min(def.max, Math.max(def.min, value))
  return { ok: true, value: clamped === 0 ? 0 : clamped, clamped: clamped !== value }
}

/**
 * Resolve `input` (a patch) on top of `current` (or the defaults) for the given base. Rejects the WHOLE input when any
 * entry is invalid, so a partially applied morph never happens.
 */
export function validateParams(base: Pick<Asset, 'params'>, input: unknown, current?: Readonly<Record<string, ParamValue>>): ParamValidation {
  if (!isPlainObject(input)) return { ok: false, errors: ['parameters must be an object of paramId to value'] }
  const keys = ownKeys(input)
  if (keys.length > MAX_KEYS) return { ok: false, errors: [`too many parameters (max ${MAX_KEYS})`] }
  const errors: string[] = []
  const defs = new Map<string, MorphParam>(base.params.map((p) => [p.id, p]))

  const resolved: ParamSet = { ...defaultParams(base) }
  if (current) {
    for (const [k, v] of Object.entries(current)) {
      const d = defs.get(k)
      if (!d || FORBIDDEN_KEYS.has(k)) continue // drop stale ids from an older base manifest
      const r = validateParamValue(d, v)
      if (r.ok) resolved[k] = r.value
    }
  }

  const clamped: string[] = []
  const changed: string[] = []
  for (const key of keys) {
    if (FORBIDDEN_KEYS.has(key)) {
      errors.push(`parameter id "${key}" is not allowed`)
      continue
    }
    const def = defs.get(key)
    if (!def) {
      errors.push(`unknown parameter "${key}"`)
      continue
    }
    const r = validateParamValue(def, (input as Record<string, unknown>)[key])
    if (!r.ok) {
      errors.push(r.error)
      continue
    }
    if (r.clamped) clamped.push(key)
    if (resolved[key] !== r.value) changed.push(key)
    resolved[key] = r.value
  }
  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, params: resolved, clamped, changed }
}

/** Only the numeric (scalar) entries: what the adult envelope judges. */
export function scalarsOf(params: Readonly<Record<string, ParamValue>>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(params)) if (typeof v === 'number') out[k] = v
  return out
}
