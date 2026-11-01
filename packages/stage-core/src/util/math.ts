export const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

/**
 * Clamp that also repairs what is not a usable number: NaN AND anything that is not a number at all (a string, null, an
 * object, a Symbol) become `fallback`; +-Infinity clamp to the ends. Never throws, whatever it is given.
 */
export function clampFinite(v: number, lo: number, hi: number, fallback = 0): number {
  if (typeof v !== 'number' || Number.isNaN(v)) return clamp(fallback, lo, hi)
  return clamp(v, lo, hi)
}

export const clamp01 = (v: number): number => clampFinite(v, 0, 1, 0)

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

export const round = (v: number, decimals: number): number => {
  const f = 10 ** decimals
  return Math.round(v * f) / f
}

/** Smooth 0..1 ramp. */
export const smoothstep = (edge0: number, edge1: number, x: number): number => {
  if (edge0 === edge1) return x < edge0 ? 0 : 1
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1)
  return t * t * (3 - 2 * t)
}
