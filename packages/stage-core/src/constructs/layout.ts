/**
 * Deterministic seeded 3D force layout for the knowledge constellation.
 *
 *  - DEPTH is the layer: core is nearest (z = 0), inbox is farthest. z is pulled to the layer's depth by a strong
 *    spring, so the layers read as planes in space with a little natural scatter.
 *  - x/y come from a force simulation: all-pairs repulsion, springs along links, gravity toward the axis that is
 *    stronger for important notes (they sit nearer the centre).
 *  - DETERMINISTIC: nodes are sorted by id, each node's start position is derived from (seed, id) only (so adding a
 *    note never reshuffles the others' starting points), the schedule is fixed and nothing reads a clock or Math.random.
 *  - FINITE and BOUNDED: displacements are clamped, coincident nodes get a deterministic push, positions are clamped
 *    into a cylinder and non-finite values fall back to the start position. Output is rounded to millimetres.
 */
import type { BrainLayer } from './layers'
import { LAYER_ORDER } from './layers'
import { createRng, fnv1a32 } from '../util/rng'
import { clamp, clampFinite } from '../util/math'

export interface LayoutNodeInput {
  id: string
  layer?: BrainLayer
  /** 1..5 */
  importance: number
}
export interface LayoutEdgeInput {
  from: string
  to: string
  weight: number
}
export interface LayoutOptions {
  seed?: number | string
  iterations?: number
  /** Metres between layers. */
  depthStep?: number
  /** Maximum distance from the axis in the x/y plane. */
  radius?: number
}

export const DEFAULT_LAYOUT_RADIUS = 6
export const DEFAULT_DEPTH_STEP = 1.2

export function layerDepthIndex(layer: BrainLayer | undefined): number {
  const i = LAYER_ORDER.indexOf(layer ?? 'semantic')
  return i < 0 ? LAYER_ORDER.indexOf('semantic') : i
}

export function layoutGraph(nodes: readonly LayoutNodeInput[], edges: readonly LayoutEdgeInput[], opts: LayoutOptions = {}): Map<string, [number, number, number]> {
  const out = new Map<string, [number, number, number]>()
  const sorted = [...nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const n = sorted.length
  if (n === 0) return out
  const seed = opts.seed ?? 'constellation'
  // options come from callers: a NaN, an Infinity or an absurd value falls back to / is clamped into a sane range
  const iterations = clampFinite(Math.floor(opts.iterations ?? 120), 1, 600, 120)
  const R = clampFinite(opts.radius ?? DEFAULT_LAYOUT_RADIUS, 0.5, 100, DEFAULT_LAYOUT_RADIUS)
  const depthStep = clampFinite(opts.depthStep ?? DEFAULT_DEPTH_STEP, 0.05, 10, DEFAULT_DEPTH_STEP)
  const maxZ = depthStep * (LAYER_ORDER.length - 1) + 0.6

  const index = new Map<string, number>()
  sorted.forEach((nd, i) => index.set(nd.id, i))

  const px = new Float64Array(n)
  const py = new Float64Array(n)
  const pz = new Float64Array(n)
  const tz = new Float64Array(n)
  const imp = new Float64Array(n)
  const x0 = new Float64Array(n)
  const y0 = new Float64Array(n)
  const z0 = new Float64Array(n)

  sorted.forEach((nd, i) => {
    const r = createRng(`${String(seed)}|${nd.id}`)
    const importance = clamp(Number.isFinite(nd.importance) ? nd.importance : 2, 1, 5)
    imp[i] = importance
    const spread = (1.15 - 0.15 * importance) * R * 0.7
    const theta = r.next() * Math.PI * 2
    const rad = Math.sqrt(r.next()) * spread
    tz[i] = layerDepthIndex(nd.layer) * depthStep
    px[i] = Math.cos(theta) * rad
    py[i] = Math.sin(theta) * rad
    pz[i] = tz[i]! + (r.next() - 0.5) * 0.4
    x0[i] = px[i]!
    y0[i] = py[i]!
    z0[i] = pz[i]!
  })

  const links: Array<[number, number, number]> = []
  for (const e of edges) {
    const a = index.get(e.from)
    const b = index.get(e.to)
    if (a === undefined || b === undefined || a === b) continue
    links.push([a, b, clamp(Number.isFinite(e.weight) ? e.weight : 1, 0.1, 5)])
  }

  const fx = new Float64Array(n)
  const fy = new Float64Array(n)
  const fz = new Float64Array(n)
  const kRep = 0.35
  const kSpring = 0.08
  const rest = 1.1
  const kGrav = 0.03
  const kZ = 0.35

  for (let it = 0; it < iterations; it++) {
    const cool = 1 - it / iterations
    fx.fill(0)
    fy.fill(0)
    fz.fill(0)
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = px[i]! - px[j]!
        let dy = py[i]! - py[j]!
        let dz = (pz[i]! - pz[j]!) * 0.3
        let d2 = dx * dx + dy * dy + dz * dz
        if (d2 < 1e-6) {
          // coincident: push apart along a direction derived from the pair, never random
          const ang = ((fnv1a32(`${sorted[i]!.id}|${sorted[j]!.id}`) % 360) * Math.PI) / 180
          dx = Math.cos(ang) * 1e-3
          dy = Math.sin(ang) * 1e-3
          dz = 0
          d2 = dx * dx + dy * dy
        }
        const f = kRep / (d2 + 0.05)
        const inv = 1 / Math.sqrt(d2)
        fx[i] = fx[i]! + dx * inv * f
        fy[i] = fy[i]! + dy * inv * f
        fz[i] = fz[i]! + dz * inv * f * 0.3
        fx[j] = fx[j]! - dx * inv * f
        fy[j] = fy[j]! - dy * inv * f
        fz[j] = fz[j]! - dz * inv * f * 0.3
      }
    }
    for (const [a, b, w] of links) {
      const dx = px[b]! - px[a]!
      const dy = py[b]! - py[a]!
      const d = Math.sqrt(dx * dx + dy * dy) + 1e-6
      const f = kSpring * Math.sqrt(w) * (d - rest)
      fx[a] = fx[a]! + (dx / d) * f
      fy[a] = fy[a]! + (dy / d) * f
      fx[b] = fx[b]! - (dx / d) * f
      fy[b] = fy[b]! - (dy / d) * f
    }
    const maxStep = 0.5 * cool + 0.02
    for (let i = 0; i < n; i++) {
      const g = kGrav * (0.5 + imp[i]! * 0.3)
      fx[i] = fx[i]! - px[i]! * g
      fy[i] = fy[i]! - py[i]! * g
      fz[i] = fz[i]! + (tz[i]! - pz[i]!) * kZ
      px[i] = px[i]! + clamp(fx[i]! * 0.6, -maxStep, maxStep)
      py[i] = py[i]! + clamp(fy[i]! * 0.6, -maxStep, maxStep)
      pz[i] = pz[i]! + clamp(fz[i]! * 0.6, -maxStep, maxStep)
    }
  }

  const r3 = (v: number): number => Math.round(v * 1000) / 1000
  sorted.forEach((nd, i) => {
    let x = px[i]!
    let y = py[i]!
    let z = pz[i]!
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      x = x0[i]!
      y = y0[i]!
      z = z0[i]!
    }
    const rr = Math.hypot(x, y)
    const Rc = Math.max(0, R - 0.002) // leave room for rounding so the bound holds after it
    if (rr > Rc) {
      x = (x / rr) * Rc
      y = (y / rr) * Rc
    }
    z = clamp(z, -0.3, maxZ)
    out.set(nd.id, [r3(x), r3(y), r3(z)])
  })
  return out
}
