/** Seeded randomness. All "random" behaviour in stage-core draws from an injected Rng, so runs are reproducible. */

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number
  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number
  /** Uniform in [min, max). */
  range(min: number, max: number): number
  chance(p: number): boolean
  pick<T>(items: readonly T[]): T | undefined
  /** Weighted pick; items with weight <= 0 or non-finite are never chosen. Undefined when nothing has weight. */
  weighted<T>(items: readonly T[], weight: (item: T) => number): T | undefined
  /** An independent stream derived from this seed and a label (does not advance this stream). */
  fork(label: string): Rng
  readonly seed: number
}

/** FNV-1a 32-bit over UTF-8 bytes. Also the utteranceId hash of the binary protocol (documented in README). */
export function fnv1a32(input: string | Uint8Array): number {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input
  let h = 0x811c9dc5
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

export function seedFrom(seed: number | string): number {
  if (typeof seed === 'number') return Number.isFinite(seed) ? seed >>> 0 : 0
  return fnv1a32(seed)
}

/** mulberry32: small, fast, good enough for behaviour variation. */
export function createRng(seed: number | string = 1): Rng {
  const s0 = seedFrom(seed)
  let a = s0
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const rng: Rng = {
    seed: s0,
    next,
    int(min, max) {
      const lo = Math.ceil(Math.min(min, max))
      const hi = Math.floor(Math.max(min, max))
      return lo + Math.floor(next() * (hi - lo + 1))
    },
    range(min, max) {
      return min + next() * (max - min)
    },
    chance(p) {
      if (!(p > 0)) return false
      if (p >= 1) return true
      return next() < p
    },
    pick(items) {
      if (items.length === 0) return undefined
      return items[Math.min(items.length - 1, Math.floor(next() * items.length))]
    },
    weighted(items, weight) {
      let total = 0
      const ws: number[] = []
      for (const it of items) {
        const w = weight(it)
        const ok = Number.isFinite(w) && w > 0 ? w : 0
        ws.push(ok)
        total += ok
      }
      if (!(total > 0)) return undefined
      let r = next() * total
      for (let i = 0; i < items.length; i++) {
        r -= ws[i]!
        if (r < 0 && ws[i]! > 0) return items[i]
      }
      for (let i = items.length - 1; i >= 0; i--) if (ws[i]! > 0) return items[i]
      return undefined
    },
    fork(label) {
      return createRng((s0 ^ fnv1a32(label)) >>> 0)
    },
  }
  return rng
}
