/**
 * THE ADULT ENVELOPE. Every character in this system is an adult. This module is the single place that defines what
 * "adult" means numerically, and it is applied in three layers:
 *
 *   1. A base character asset whose DECLARED slider ranges reach outside the envelope is refused when it is added
 *      to the catalog (`checkBaseDeclaration`).
 *   2. Every submitted value is clamped into the slider range declared by the base asset (see params.ts), and the
 *      seed bases declare ranges that sit INSIDE the envelope on every governed axis.
 *   3. The whole resolved parameter set is evaluated as a combination (`evaluateAdultEnvelope`): hard floors and
 *      ceilings per governed parameter, plus a weighted "youthfulness" score over several parameters at once, so a
 *      third-party base with wide ranges cannot be steered into a childlike figure by stacking small youthful
 *      settings. Anything outside is refused, never silently accepted.
 *
 * Only parameters that exist in the set are judged; absent ones count as neutral. The ids are the conventions used by
 * the seed bases; a base that does not expose them must carry the manifest attestation `adult: true` instead.
 */
import type { MorphParam } from '@ai-assistant/shared'

export interface EnvelopeBound {
  min: number
  max: number
}

/** Hard per-parameter limits of the envelope (inclusive). */
export const ADULT_BOUNDS: Readonly<Record<string, EnvelopeBound>> = {
  /** Apparent age of the face in years. */
  'face.apparent_age': { min: 25, max: 65 },
  'body.height_cm': { min: 158, max: 200 },
  /** Head size relative to the body: large heads read as childlike. */
  'body.head_scale': { min: 0.9, max: 1.04 },
  /** How defined the jaw and chin are. */
  'face.jaw_definition': { min: 0.2, max: 1 },
  /** Face roundness (soft, round faces read younger). */
  'face.roundness': { min: -0.6, max: 0.5 },
  'eyes.size': { min: -0.4, max: 0.4 },
  /** Leg length relative to torso; short legs read as childlike proportions. */
  'body.leg_length': { min: -0.2, max: 0.8 },
  'body.shoulder_width': { min: -0.3, max: 0.8 },
}

/** Components of the youthfulness score. `invert` means a LOW value is the youthful end. */
const SCORE_TERMS: ReadonlyArray<{ id: string; weight: number; invert: boolean }> = [
  { id: 'eyes.size', weight: 0.22, invert: false },
  { id: 'face.roundness', weight: 0.18, invert: false },
  { id: 'face.jaw_definition', weight: 0.2, invert: true },
  { id: 'body.head_scale', weight: 0.15, invert: false },
  { id: 'body.leg_length', weight: 0.1, invert: true },
  { id: 'face.apparent_age', weight: 0.15, invert: true },
]

/** A combined youthfulness score above this is refused even if every single parameter is inside its own bound. */
export const NEOTENY_MAX = 0.8

export interface AdultEnvelopeResult {
  ok: boolean
  /** Human-readable reasons, empty when ok. */
  violations: string[]
  /** 0 (mature) .. 1 (youthful) combined score. */
  neoteny: number
}

const norm = (v: number, b: EnvelopeBound): number => (b.max === b.min ? 0.5 : Math.min(1, Math.max(0, (v - b.min) / (b.max - b.min))))

/** Youthfulness score of a parameter set (missing parameters count as neutral 0.5). */
export function neotenyScore(params: Readonly<Record<string, unknown>>): number {
  let s = 0
  for (const t of SCORE_TERMS) {
    const b = ADULT_BOUNDS[t.id]!
    const raw = params[t.id]
    const n = typeof raw === 'number' && Number.isFinite(raw) ? norm(raw, b) : 0.5
    s += t.weight * (t.invert ? 1 - n : n)
  }
  return s
}

/** Validate a WHOLE parameter set against the adult envelope. Pure; never throws. */
export function evaluateAdultEnvelope(params: Readonly<Record<string, unknown>>): AdultEnvelopeResult {
  const violations: string[] = []
  for (const [id, b] of Object.entries(ADULT_BOUNDS)) {
    if (!Object.prototype.hasOwnProperty.call(params, id)) continue
    const v = params[id]
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      violations.push(`${id} must be a finite number`)
    } else if (v < b.min || v > b.max) {
      violations.push(`${id}=${v} is outside the adult range ${b.min}..${b.max}`)
    }
  }
  const neoteny = neotenyScore(params)
  if (neoteny > NEOTENY_MAX) {
    violations.push(`combined youthfulness ${neoteny.toFixed(2)} exceeds the adult limit ${NEOTENY_MAX}`)
  }
  return { ok: violations.length === 0, violations, neoteny }
}

/**
 * A base asset's DECLARED slider ranges must sit inside the envelope on every governed axis. Returns violations
 * (empty when fine). Colour parameters and ungoverned ids are ignored.
 */
export function checkBaseDeclaration(params: readonly MorphParam[]): string[] {
  const out: string[] = []
  for (const p of params) {
    const b = ADULT_BOUNDS[p.id]
    if (!b) continue
    if (p.type === 'color') {
      out.push(`${p.id} is governed by the adult envelope and cannot be a colour parameter`)
      continue
    }
    if (p.min < b.min || p.max > b.max) out.push(`${p.id} declares ${p.min}..${p.max}, outside the adult range ${b.min}..${b.max}`)
    if (p.default < b.min || p.default > b.max) out.push(`${p.id} default ${p.default} is outside the adult range ${b.min}..${b.max}`)
  }
  return out
}

/** The worst (most youthful) score reachable inside a base's declared ranges; every corner is checked (the score is linear per axis). */
export function worstCaseNeoteny(params: readonly MorphParam[]): number {
  const governed = SCORE_TERMS.map((t) => ({ t, p: params.find((x) => x.id === t.id) })).filter((x) => x.p && x.p.type !== 'color')
  let worst = 0
  const n = governed.length
  for (let mask = 0; mask < 1 << n; mask++) {
    const set: Record<string, number> = {}
    governed.forEach((g, i) => {
      set[g.t.id] = mask & (1 << i) ? g.p!.max : g.p!.min
    })
    worst = Math.max(worst, neotenyScore(set))
  }
  return worst
}
