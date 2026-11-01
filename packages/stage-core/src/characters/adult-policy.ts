/**
 * THE ADULT ENVELOPE. Every character in this system is an adult. This module is the single place that defines what
 * "adult" means numerically, and it is applied in layers:
 *
 *   1. ROLES, NOT NAMES. The envelope governs a small set of semantic roles: apparent age, height, head size, jaw
 *      definition, face roundness, eye size, leg length, shoulder width. Each role has ONE canonical parameter id
 *      (`ADULT_BOUNDS`). A parameter is either a canonical governed id (declared by a character base only, inside the
 *      bounds), or it is OPAQUE and held to a generic bound (-1..1, see `checkOpaqueParams`). An id that LOOKS like a
 *      governed role or like youth (`face.age_years`, `body.stature`, `face.eye_scale`, `body.proportion_kid`) is refused
 *      outright: it is a second slider for the same morph that the envelope could not judge, so a base must map it onto the
 *      canonical id (`governedAliasOf`). Nothing depends on a boolean the manifest asserts about itself: `adult: true` is
 *      still required on a base, but it protects nothing by itself.
 *   2. EVERY ASSET KIND. Hair, outfits and accessories can declare parameters too (and preset tweaks address them), so the
 *      same rules run for every kind: only a character base may declare a canonical governed id, no kind may declare an
 *      alias, and (for anything that is not vetted by the owner of the catalog) opaque scalars stay within -1..1.
 *   3. A BASE MUST EXPOSE THE ROLES. A character base that exposes none of the governed ids cannot be judged at all, so it
 *      is refused unless the owner of the catalog has explicitly vetted it (the daemon vets only its own seed).
 *   4. Every submitted value is clamped into the slider range declared by the base asset (see params.ts), and the seed
 *      bases declare ranges that sit INSIDE the envelope on every governed axis.
 *   5. The whole resolved parameter set is evaluated as a combination (`evaluateAdultEnvelope`): hard floors and ceilings
 *      per governed parameter, plus a weighted "youthfulness" score over several parameters at once, so a third-party base
 *      with wide ranges cannot be steered into a childlike figure by stacking small youthful settings. Anything outside is
 *      refused, never silently accepted. Only OWN properties are read (an inherited key cannot hide a value), accessors and
 *      non-plain inputs are refused, and a parameter set that carries an alias of a governed role is refused.
 *   6. At the point of use, `CharacterService.loadCommand` re-judges the stored character (its base, its parameters, what
 *      she wears) and refuses to describe one that fails, so a stage never receives a figure the envelope would not allow,
 *      whatever state the database is in (see characters/service.ts).
 *
 * LIMITS, said plainly: the daemon sees metadata, not meshes. It cannot tell what an opaque slider does on the stage, so a
 * hostile content pack could still wire an innocuous-looking id to a youthful morph; the vocabulary guard and the -1..1
 * bound stop accidents and sloppy manifests, not a determined author. Content packs are trusted by installing them, and
 * only the seed is vetted.
 */
import type { AssetKind, MorphParam } from '@ai-assistant/shared'

export interface EnvelopeBound {
  min: number
  max: number
}

export type GovernedRole = 'apparent_age' | 'height' | 'head_scale' | 'jaw_definition' | 'roundness' | 'eye_size' | 'leg_length' | 'shoulder_width'

/** Hard per-parameter limits of the envelope (inclusive). Keyed by the CANONICAL id of each governed role. */
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

/** The canonical id of each governed role. */
export const GOVERNED_ROLE_IDS: Readonly<Record<GovernedRole, string>> = {
  apparent_age: 'face.apparent_age',
  height: 'body.height_cm',
  head_scale: 'body.head_scale',
  jaw_definition: 'face.jaw_definition',
  roundness: 'face.roundness',
  eye_size: 'eyes.size',
  leg_length: 'body.leg_length',
  shoulder_width: 'body.shoulder_width',
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

/** Opaque scalar parameters (ids the envelope has no role for) must stay within this symmetric range. */
export const OPAQUE_SCALAR_BOUND: EnvelopeBound = { min: -1, max: 1 }

export interface AdultEnvelopeResult {
  ok: boolean
  /** Human-readable reasons, empty when ok. */
  violations: string[]
  /** 0 (mature) .. 1 (youthful) combined score. */
  neoteny: number
}

const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k)

const norm = (v: number, b: EnvelopeBound): number => (b.max === b.min ? 0.5 : Math.min(1, Math.max(0, (v - b.min) / (b.max - b.min))))

// --------------------------------------------------------------------------------------------------------- roles

/** Words that mean youth or age wherever they appear in a parameter id. */
const YOUTH_WORDS: ReadonlySet<string> = new Set([
  'age', 'aged', 'ages', 'aging', 'ageing', 'year', 'years', 'yr', 'yrs', 'youth', 'youthful', 'young', 'younger', 'youngest', 'juvenile', 'minor', 'teen', 'teens', 'teenage', 'teenager',
  'adolescent', 'adolescence', 'puberty', 'pubescent', 'preteen', 'child', 'children', 'childlike', 'childish', 'kid', 'kids', 'baby', 'babyface', 'infant', 'toddler', 'underage', 'loli', 'lolita', 'shota',
  'neoteny', 'neotenic', 'neotenous', 'chibi',
])

/** Words that, next to a body part, mean one of the governed measurements (a SIZE, SCALE, LENGTH or RATIO of it). */
const MEASURE_WORDS: ReadonlySet<string> = new Set(['size', 'scale', 'length', 'ratio', 'width', 'height', 'radius', 'big', 'large', 'small', 'long', 'short', 'proportion', 'proportions', 'definition', 'strength', 'breadth'])

/** Context that makes a bare "height" a body height (a "cheekbone_height" or "bridge_height" is a face shape, not her stature). */
const BODY_CONTEXT: ReadonlySet<string> = new Set(['body', 'character', 'char', 'avatar', 'figure', 'total', 'overall', 'standing', 'full'])
const UNIT_WORDS: ReadonlySet<string> = new Set(['cm', 'mm', 'm', 'in', 'inch', 'inches', 'ft', 'feet', 'metres', 'meters'])

const PART_ROLES: ReadonlyArray<{ role: GovernedRole; parts: readonly string[]; measures?: ReadonlySet<string>; any?: boolean }> = [
  { role: 'height', parts: ['stature', 'tallness', 'tall'], any: true },
  { role: 'height', parts: ['body'], measures: new Set(['size', 'scale', 'ratio']) },
  { role: 'head_scale', parts: ['head', 'skull', 'cranium'], measures: MEASURE_WORDS },
  { role: 'eye_size', parts: ['eye', 'eyes', 'eyeball', 'eyeballs'], measures: new Set(['size', 'scale', 'ratio', 'radius', 'big', 'large', 'width', 'height', 'proportion', 'proportions']) },
  { role: 'leg_length', parts: ['leg', 'legs'], measures: MEASURE_WORDS },
  { role: 'jaw_definition', parts: ['jaw', 'jawline'], measures: new Set(['definition', 'strength', 'size', 'width', 'scale', 'square', 'soft', 'weak']) },
  { role: 'roundness', parts: ['round', 'roundness', 'rounded', 'chubby', 'chubbiness', 'pudgy', 'babyfat'], any: true },
  { role: 'shoulder_width', parts: ['shoulder', 'shoulders'], measures: MEASURE_WORDS },
]

function tokensOf(id: string): string[] {
  return id
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0)
}

export interface GovernedAlias {
  /** The role the id appears to be about; `youth` for ids that are about age or childlike proportions in general. */
  role: GovernedRole | 'youth'
  /** What the id should be called instead (the canonical id), when there is one. */
  use?: string
}

/**
 * If a NON-canonical id looks like one of the governed roles (or about youth in general), say which. This is a vocabulary
 * guard, not a proof: it catches `face.age_years`, `body.stature`, `face.eye_scale`, `legs.scale`, `body.proportion_kid`,
 * `ageSlider` and the like, and nothing it does not recognise. The canonical ids themselves return undefined.
 */
export function governedAliasOf(id: string): GovernedAlias | undefined {
  if (hasOwn(ADULT_BOUNDS, id)) return undefined
  const hit = ALIAS_CACHE.get(id)
  if (hit !== undefined) return hit ?? undefined
  const found = aliasOf(id)
  if (ALIAS_CACHE.size >= 4096) ALIAS_CACHE.clear() // ids come from a handful of manifests; a flood of distinct ids just resets the memo
  ALIAS_CACHE.set(id, found ?? null)
  return found
}

/** Parameter ids repeat endlessly (every evaluation looks at every key), so the verdict per id is remembered; the function is pure. */
const ALIAS_CACHE = new Map<string, GovernedAlias | null>()

function aliasOf(id: string): GovernedAlias | undefined {
  const toks = tokensOf(id)
  if (toks.length === 0) return undefined
  const set = new Set(toks)
  const squashed = toks.join('')
  if (set.has('height') && (toks.length === 1 || toks.some((t) => BODY_CONTEXT.has(t) || UNIT_WORDS.has(t)))) return { role: 'height', use: GOVERNED_ROLE_IDS.height }
  for (const r of PART_ROLES) {
    const hit = r.parts.some((p) => set.has(p) || (p.length >= 6 && squashed.includes(p)))
    if (!hit) continue
    if (r.any || (r.measures && toks.some((t) => r.measures!.has(t)))) return { role: r.role, use: GOVERNED_ROLE_IDS[r.role] }
  }
  if (toks.some((t) => YOUTH_WORDS.has(t))) return { role: 'youth', use: GOVERNED_ROLE_IDS.apparent_age }
  if (/(apparentage|faceage|bodyage|youthful|childlike|childish|babyface|underage|preteen|juvenile|neotenic)/.test(squashed)) return { role: 'youth', use: GOVERNED_ROLE_IDS.apparent_age }
  return undefined
}

/** Does a parameter list expose at least one of the governed (canonical) ids as a scalar? */
export function exposesGovernedRole(params: readonly MorphParam[]): boolean {
  return params.some((p) => hasOwn(ADULT_BOUNDS, p.id) && p.type !== 'color')
}

// ------------------------------------------------------------------------------------------------- param sets

/** A copy of the OWN, enumerable, string-keyed DATA properties of a plain object, or undefined for anything else. */
function plainSnapshot(params: unknown): { snap: Record<string, unknown>; accessors: string[] } | undefined {
  try {
    if (params === null || typeof params !== 'object' || Array.isArray(params)) return undefined
    const proto = Object.getPrototypeOf(params)
    if (proto !== Object.prototype && proto !== null) return undefined
    const snap: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    const accessors: string[] = []
    for (const k of Object.keys(params)) {
      const d = Object.getOwnPropertyDescriptor(params, k)
      if (d && 'value' in d) snap[k] = d.value
      else accessors.push(k)
    }
    return { snap, accessors }
  } catch {
    return undefined
  }
}

/** Youthfulness score of a parameter set (missing parameters count as neutral 0.5). Reads own properties only. */
export function neotenyScore(params: Readonly<Record<string, unknown>>): number {
  const p = plainSnapshot(params)
  return p ? scoreOf(p.snap) : 1 // not a plain object: nothing can be said for it, so it counts as the most youthful
}

function scoreOf(snap: Record<string, unknown>): number {
  let s = 0
  for (const t of SCORE_TERMS) {
    const b = ADULT_BOUNDS[t.id]!
    const raw = hasOwn(snap, t.id) ? snap[t.id] : undefined
    const n = typeof raw === 'number' && Number.isFinite(raw) ? norm(raw, b) : 0.5
    s += t.weight * (t.invert ? 1 - n : n)
  }
  return s
}

/**
 * Validate a WHOLE parameter set against the adult envelope. Pure; never throws. The input must be a plain object (a
 * null-prototype object is fine); only its own data properties are read, so an inherited key, an accessor or a Proxy
 * cannot smuggle a value past the bounds. A key that is an alias of a governed role is a violation: it is a value the
 * envelope cannot judge.
 */
export function evaluateAdultEnvelope(params: Readonly<Record<string, unknown>>): AdultEnvelopeResult {
  const p = plainSnapshot(params)
  if (!p) return { ok: false, violations: ['parameters must be a plain object of parameter id to value'], neoteny: 1 }
  const { snap, accessors } = p
  const violations: string[] = []
  for (const k of accessors) violations.push(`${k} must be a plain value, not an accessor`)
  for (const [id, b] of Object.entries(ADULT_BOUNDS)) {
    if (!hasOwn(snap, id)) continue
    const v = snap[id]
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      violations.push(`${id} must be a finite number`)
    } else if (v < b.min || v > b.max) {
      violations.push(`${id}=${v} is outside the adult range ${b.min}..${b.max}`)
    }
  }
  for (const k of Object.keys(snap)) {
    const alias = governedAliasOf(k)
    if (alias) violations.push(`${k} looks like a governed parameter (${alias.role.replace('_', ' ')}) that the adult envelope cannot judge${alias.use ? `; use ${alias.use}` : ''}`)
  }
  const neoteny = scoreOf(snap)
  if (neoteny > NEOTENY_MAX) {
    violations.push(`combined youthfulness ${neoteny.toFixed(2)} exceeds the adult limit ${NEOTENY_MAX}`)
  }
  return { ok: violations.length === 0, violations, neoteny }
}

// ----------------------------------------------------------------------------------------------- declarations

/**
 * A base asset's DECLARED slider ranges must sit inside the envelope on every governed axis. Returns violations
 * (empty when fine). Colour parameters and ungoverned ids are ignored here (see `checkParamDeclarations`).
 */
export function checkBaseDeclaration(params: readonly MorphParam[]): string[] {
  const out: string[] = []
  for (const p of params) {
    const b = hasOwn(ADULT_BOUNDS, p.id) ? ADULT_BOUNDS[p.id] : undefined
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

/**
 * The declaration rules that hold for EVERY asset kind and need nothing from the catalog: only a character base may
 * declare a canonical governed id (and then inside the envelope); nothing may declare an alias of a governed role.
 */
export function checkParamDeclarations(kind: AssetKind, params: readonly MorphParam[]): string[] {
  const out: string[] = []
  if (kind === 'character_base') out.push(...checkBaseDeclaration(params))
  for (const p of params) {
    if (hasOwn(ADULT_BOUNDS, p.id)) {
      if (kind !== 'character_base') out.push(`${p.id} is governed by the adult envelope; only a character base can declare it (a ${kind} cannot)`)
      continue
    }
    const alias = governedAliasOf(p.id)
    if (alias) out.push(`parameter id "${p.id}" looks like a governed parameter (${alias.role.replace('_', ' ')}) that the adult envelope could not judge${alias.use ? `; declare it as ${alias.use} or rename it` : ''}`)
  }
  return out
}

/**
 * The rule for assets nobody has vetted: scalar parameters the envelope has no role for stay within -1..1 (normalised
 * offsets, not years or centimetres). Colours are exempt. Returns violations.
 */
export function checkOpaqueParams(params: readonly MorphParam[]): string[] {
  const out: string[] = []
  const b = OPAQUE_SCALAR_BOUND
  for (const p of params) {
    if (p.type === 'color' || hasOwn(ADULT_BOUNDS, p.id)) continue
    if (p.min < b.min || p.max > b.max || p.default < b.min || p.default > b.max) {
      out.push(`parameter "${p.id}" declares ${p.min}..${p.max}: a slider the adult envelope has no role for must stay within ${b.min}..${b.max} (an asset vetted by the owner of the catalog is exempt)`)
    }
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
    worst = Math.max(worst, scoreOf(Object.assign(Object.create(null) as Record<string, unknown>, set)))
  }
  return worst
}
