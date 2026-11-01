import { AUTHORITY_PRESENCE, CharacterProfile, PresenceStyle, VoiceProfile } from '@ai-assistant/shared'
import type { Asset, Equipped, OutfitPreset, RigFamily, WardrobeSlot } from '@ai-assistant/shared'
import type { AssetCatalog } from '../assets/catalog'
import type { AssetManifest } from '../assets/manifest'
import type { CharacterRepo, CharacterRole } from './repo'
import { ADULT_BOUNDS, evaluateAdultEnvelope, governedAliasOf } from './adult-policy'
import { defaultParams, scalarsOf, validateParams } from './params'
import type { ParamSet } from './params'
import { ALL_SLOTS, equippedAssetIds, normalizeEquipped } from '../core/equipped'
import { baselineEquipped, completeBaseline, coverageProblem, validateEquipped } from '../wardrobe/slots'
import { SEED_OUTFIT_PRESETS } from '../wardrobe/presets'
import { cleanText, isSafeId } from '../util/safe'
import { clampFinite } from '../util/math'
import { fail, ok } from '../util/result'
import type { Result } from '../util/result'
import type { Clock } from '../util/clock'
import { isoFromMs } from '../util/clock'
import type { IdGenerator } from '../util/ids'
import type { CommandDraft } from '../util/commands'

export type CharacterCode =
  | 'invalid_input'
  | 'not_found'
  | 'base_unusable'
  | 'invalid_params'
  | 'adult_envelope'
  | 'invalid_equipped'
  | 'no_baseline'
  | 'duplicate'
  | 'last_assistant'

/** Presence for the user's own representation: relaxed and unstylised. */
export const USER_PRESENCE: PresenceStyle = {
  uprightness: 0.5,
  gestureEconomy: 0.5,
  gazeHold: 0.5,
  pace: 0.5,
  athleticism: 0.4,
  baseline: { valence: 0.1, arousal: 0, dominance: 0.2 },
}

export const DEFAULT_VOICE: VoiceProfile = { provider: 'kokoro', voiceId: 'default', speed: 1, pitchSemitones: 0 }

export interface CreateCharacterInput {
  /** Optional stable id (path-safe); generated otherwise. */
  id?: string
  name: string
  role?: CharacterRole
  baseAssetId: string
  /** Only needed when the base fits several rigs. */
  rigFamily?: RigFamily
  params?: Record<string, number | string>
  /** Wearing at creation; defaults to the clothed baseline for the rig. Validated like any outfit. */
  equipped?: Partial<Equipped>
  voice?: unknown
  presence?: unknown
  personaId?: string
  homeAnchor?: string
  presets?: OutfitPreset[]
}

export interface UpdateCharacterInput {
  name?: string
  params?: Record<string, number | string>
  voice?: unknown
  presence?: unknown
  personaId?: string
  /** null clears it. */
  homeAnchor?: string | null
}

export interface RestoreReport {
  assistant?: CharacterProfile
  user?: CharacterProfile
  /** Slots cleared (and saved) because their asset vanished, no longer fits, no longer covers, or its licence now forbids it. */
  repaired: Array<{ characterId: string; slot: WardrobeSlot; assetId: string; reason: string }>
  /** Parameters that were out of range for the (possibly updated) base and were clamped, or dropped. */
  paramsAdjusted: Array<{ characterId: string; ids: string[] }>
  /**
   * Characters that could NOT be made safe from this catalog (no usable base, parameters the adult envelope cannot accept,
   * no way to re-establish the clothed baseline). Such a character is NOT changed in a way that would hide the problem
   * and is NOT described to a stage (`loadCommand` refuses it) until the catalog can make her whole again.
   */
  problems: Array<{ characterId: string; message: string }>
}

/** A reason a character may not be shown on a stage, with the code `loadCommand` answers with. */
export interface CharacterProblem {
  code: CharacterCode
  message: string
}

export interface CharacterServiceDeps {
  repo: CharacterRepo
  catalog: AssetCatalog
  clock: Clock
  newId: IdGenerator
  /** Presets copied into new characters. Default: the seed presets. */
  seedPresets?: readonly OutfitPreset[]
}

export class CharacterService {
  constructor(private readonly deps: CharacterServiceDeps) {}

  private nowIso(): string {
    return isoFromMs(this.deps.clock.now())
  }

  private persist(next: CharacterProfile): Result<CharacterProfile, CharacterCode> {
    const parsed = CharacterProfile.safeParse(next)
    if (!parsed.success) return fail('invalid_input', parsed.error.issues[0]?.message ?? 'invalid character')
    this.deps.repo.save(parsed.data)
    return ok(structuredClone(parsed.data))
  }

  private baseOf(profile: Pick<CharacterProfile, 'baseAssetId'>): AssetManifest | undefined {
    return this.deps.catalog.get(profile.baseAssetId)
  }

  create(input: CreateCharacterInput): Result<CharacterProfile, CharacterCode> {
    const { catalog, repo } = this.deps
    if (typeof input !== 'object' || input === null) return fail('invalid_input', 'character input must be an object')
    const name = typeof input.name === 'string' ? cleanText(input.name, 60) : ''
    if (name.length === 0) return fail('invalid_input', 'a character needs a name')
    const role: CharacterRole = input.role === 'user' ? 'user' : 'assistant'

    const base = catalog.get(input.baseAssetId)
    if (!base) return fail('base_unusable', `base asset "${String(input.baseAssetId)}" is not in the catalog`)
    if (base.kind !== 'character_base') return fail('base_unusable', `"${base.name}" is a ${base.kind}, not a character base`)
    const lic = catalog.canUse(base.id, 'personal')
    if (!lic.ok) return fail('base_unusable', lic.reasons.join('; '))
    if (base.adult !== true) return fail('base_unusable', `"${base.name}" is not attested as an adult character base`)
    const rig = input.rigFamily ?? base.rigFamilies[0]
    if (!rig || !base.rigFamilies.includes(rig)) return fail('base_unusable', `"${base.name}" does not use a ${String(input.rigFamily)} rig`)

    let id = input.id
    if (id !== undefined) {
      if (!isSafeId(id)) return fail('invalid_input', 'character id must be path-safe')
      if (repo.get(id)) return fail('duplicate', `character "${id}" already exists`)
    } else {
      do id = this.deps.newId('char')
      while (repo.get(id))
    }

    const pv = validateParams(base, input.params ?? {})
    if (!pv.ok) return fail('invalid_params', pv.errors.join('; '))
    const env = evaluateAdultEnvelope(scalarsOf(pv.params))
    if (!env.ok) return fail('adult_envelope', env.violations.join('; '))

    let equipped: Equipped
    if (input.equipped !== undefined) {
      equipped = normalizeEquipped(input.equipped)
    } else {
      const b = baselineEquipped(catalog, rig)
      if (!b) return fail('no_baseline', `the catalog has no clothed baseline (baseline-tagged top and bottom) for a ${rig} rig`)
      equipped = b
    }
    const issues = validateEquipped(equipped, catalog, rig)
    if (issues.length > 0) return fail('invalid_equipped', issues.map((i) => i.message).join('; '))

    const voice = VoiceProfile.safeParse(input.voice ?? DEFAULT_VOICE)
    if (!voice.success) return fail('invalid_input', `voice: ${voice.error.issues[0]?.message ?? 'invalid'}`)
    const presence = PresenceStyle.safeParse(input.presence ?? (role === 'assistant' ? AUTHORITY_PRESENCE : USER_PRESENCE))
    if (!presence.success) return fail('invalid_input', `presence: ${presence.error.issues[0]?.message ?? 'invalid'}`)

    const presets = (input.presets ?? [...(this.deps.seedPresets ?? SEED_OUTFIT_PRESETS)]).filter((p) => validateEquipped(normalizeEquipped(p.equipped), catalog, rig).length === 0)
    const now = this.nowIso()
    const parsed = CharacterProfile.safeParse({
      id,
      role,
      name,
      baseAssetId: base.id,
      rigFamily: rig,
      params: pv.params,
      equipped,
      presets: structuredClone(presets),
      voice: voice.data,
      presence: presence.data,
      personaId: input.personaId ?? 'default',
      ...(input.homeAnchor !== undefined ? { homeAnchor: input.homeAnchor } : {}),
      createdAt: now,
      updatedAt: now,
    })
    if (!parsed.success) return fail('invalid_input', parsed.error.issues[0]?.message ?? 'invalid character')
    repo.save(parsed.data)
    if (!repo.getActiveId(role)) repo.setActiveId(role, parsed.data.id)
    return ok(structuredClone(parsed.data))
  }

  get(id: string): CharacterProfile | undefined {
    return this.deps.repo.get(id)
  }

  list(role?: CharacterRole): CharacterProfile[] {
    const all = this.deps.repo.list()
    return role ? all.filter((c) => c.role === role) : all
  }

  /** The active character of a role (exactly one active assistant whenever any assistant exists). */
  getActive(role: CharacterRole = 'assistant'): CharacterProfile | undefined {
    const id = this.deps.repo.getActiveId(role)
    const c = id ? this.deps.repo.get(id) : undefined
    return c && c.role === role ? c : undefined
  }

  /** Make a character the active one of its role. The previous active one of that role is deselected. */
  select(id: string): Result<CharacterProfile, CharacterCode> {
    const c = this.deps.repo.get(id)
    if (!c) return fail('not_found', `character "${id}" does not exist`)
    this.deps.repo.setActiveId(c.role, c.id)
    return ok(c)
  }

  update(id: string, patch: UpdateCharacterInput): Result<CharacterProfile, CharacterCode> {
    const cur = this.deps.repo.get(id)
    if (!cur) return fail('not_found', `character "${id}" does not exist`)
    if (typeof patch !== 'object' || patch === null) return fail('invalid_input', 'patch must be an object')
    const next: CharacterProfile = structuredClone(cur)

    if (patch.name !== undefined) {
      const n = typeof patch.name === 'string' ? cleanText(patch.name, 60) : ''
      if (n.length === 0) return fail('invalid_input', 'a character needs a name')
      next.name = n
    }
    if (patch.params !== undefined) {
      const r = this.resolveParams(cur, patch.params)
      if (!r.ok) return r
      next.params = r.value
    }
    if (patch.voice !== undefined) {
      const v = VoiceProfile.safeParse(patch.voice)
      if (!v.success) return fail('invalid_input', `voice: ${v.error.issues[0]?.message ?? 'invalid'}`)
      next.voice = v.data
    }
    if (patch.presence !== undefined) {
      const p = PresenceStyle.safeParse(patch.presence)
      if (!p.success) return fail('invalid_input', `presence: ${p.error.issues[0]?.message ?? 'invalid'}`)
      next.presence = p.data
    }
    if (patch.personaId !== undefined) {
      if (typeof patch.personaId !== 'string' || !isSafeId(patch.personaId)) return fail('invalid_input', 'personaId must be path-safe')
      next.personaId = patch.personaId
    }
    if (patch.homeAnchor !== undefined) {
      if (patch.homeAnchor === null) delete next.homeAnchor
      else if (typeof patch.homeAnchor === 'string' && isSafeId(patch.homeAnchor)) next.homeAnchor = patch.homeAnchor
      else return fail('invalid_input', 'homeAnchor must be path-safe')
    }
    next.updatedAt = this.nowIso()
    return this.persist(next)
  }

  /** Validate a morph patch for a character without saving. The result is the full resolved parameter set. */
  resolveParams(profile: CharacterProfile, patch: unknown): Result<ParamSet, CharacterCode> {
    const base = this.baseOf(profile)
    if (!base) return fail('base_unusable', `base asset "${profile.baseAssetId}" is not in the catalog`)
    const pv = validateParams(base, patch, profile.params)
    if (!pv.ok) return fail('invalid_params', pv.errors.join('; '))
    const env = evaluateAdultEnvelope(scalarsOf(pv.params))
    if (!env.ok) return fail('adult_envelope', env.violations.join('; '))
    return ok(pv.params)
  }

  /** Apply a morph patch and return the `character.params` command with only what changed. */
  setParams(id: string, patch: Record<string, number | string>, blendMs = 0): Result<{ profile: CharacterProfile; changed: string[]; command?: CommandDraft }, CharacterCode> {
    const cur = this.deps.repo.get(id)
    if (!cur) return fail('not_found', `character "${id}" does not exist`)
    // the blend time goes to the stage: NaN means "now", anything else is held to 0..5000 ms (REST already says so)
    const blend = clampFinite(typeof blendMs === 'number' ? blendMs : 0, 0, 5000, 0)
    const r = this.resolveParams(cur, patch)
    if (!r.ok) return r
    const changed = Object.keys(r.value).filter((k) => cur.params[k] !== r.value[k])
    const saved = this.persist({ ...cur, params: r.value, updatedAt: this.nowIso() })
    if (!saved.ok) return saved
    if (changed.length === 0) return ok({ profile: saved.value, changed })
    const send: Record<string, number | string> = {}
    for (const k of changed) send[k] = r.value[k]!
    return ok({ profile: saved.value, changed, command: { type: 'character.params', characterId: id, params: send, blendMs: blend } })
  }

  /**
   * Commit an equipped state (and optionally presets). Used by the wardrobe service; refuses anything that is not a
   * valid, clothed state, whoever the caller is.
   */
  setEquipped(id: string, equipped: Equipped, presets?: OutfitPreset[]): Result<CharacterProfile, CharacterCode> {
    const cur = this.deps.repo.get(id)
    if (!cur) return fail('not_found', `character "${id}" does not exist`)
    const eq = normalizeEquipped(equipped)
    const issues = validateEquipped(eq, this.deps.catalog, cur.rigFamily)
    if (issues.length > 0) return fail('invalid_equipped', issues.map((i) => i.message).join('; '))
    return this.persist({ ...cur, equipped: eq, ...(presets ? { presets } : {}), updatedAt: this.nowIso() })
  }

  setPresets(id: string, presets: OutfitPreset[]): Result<CharacterProfile, CharacterCode> {
    const cur = this.deps.repo.get(id)
    if (!cur) return fail('not_found', `character "${id}" does not exist`)
    return this.persist({ ...cur, presets, updatedAt: this.nowIso() })
  }

  delete(id: string): Result<true, CharacterCode> {
    const { repo } = this.deps
    const c = repo.get(id)
    if (!c) return fail('not_found', `character "${id}" does not exist`)
    if (c.role === 'assistant' && this.list('assistant').length === 1) return fail('last_assistant', 'the last assistant cannot be deleted; create another one first')
    const wasActive = repo.getActiveId(c.role) === id
    repo.delete(id)
    if (wasActive) {
      const successor = this.list(c.role)[0]
      repo.setActiveId(c.role, successor?.id)
    }
    return ok(true)
  }

  /** Assets a stage needs to show this character now: base, hair and everything worn. */
  assetsFor(profile: CharacterProfile): Asset[] {
    const ids = new Set<string>([profile.baseAssetId, ...equippedAssetIds(profile.equipped)])
    const out: Asset[] = []
    for (const id of [...ids].sort()) {
      const a = this.deps.catalog.get(id)
      if (a) out.push(a)
    }
    return out
  }

  /**
   * Everything that stops this character from being shown on a stage right now (empty = she may be shown). It FAILS
   * CLOSED: the base must exist, be a character base with a personal-use licence and the adult attestation; the stored
   * parameters must be valid for it and acceptable to the adult envelope as a whole; and what she wears must be a valid
   * clothed state in the current catalog (every item exists, fits, is licensed, covers what its slot must cover).
   * The resolved parameter set (what a stage may be told) comes with it.
   */
  assess(profile: CharacterProfile): { problems: CharacterProblem[]; params?: ParamSet } {
    const { catalog } = this.deps
    const problems: CharacterProblem[] = []
    const base = this.baseOf(profile)
    let params: ParamSet | undefined
    if (!base) {
      problems.push({ code: 'base_unusable', message: `base asset "${profile.baseAssetId}" is not in the catalog` })
    } else {
      if (base.kind !== 'character_base') problems.push({ code: 'base_unusable', message: `"${base.name}" is a ${base.kind}, not a character base` })
      const lic = catalog.canUse(base.id, 'personal')
      if (!lic.ok) problems.push({ code: 'base_unusable', message: lic.reasons.join('; ') })
      if (base.adult !== true) problems.push({ code: 'base_unusable', message: `"${base.name}" is not attested as an adult character base` })
      if (!base.rigFamilies.includes(profile.rigFamily)) problems.push({ code: 'base_unusable', message: `"${base.name}" does not use a ${profile.rigFamily} rig` })
      const pv = validateParams(base, {}, profile.params)
      if (!pv.ok) problems.push({ code: 'invalid_params', message: pv.errors.join('; ') })
      else {
        params = pv.params
        const env = evaluateAdultEnvelope(scalarsOf(pv.params))
        if (!env.ok) problems.push({ code: 'adult_envelope', message: env.violations.join('; ') })
      }
    }
    const issues = validateEquipped(normalizeEquipped(profile.equipped), catalog, profile.rigFamily)
    if (issues.length > 0) problems.push({ code: 'invalid_equipped', message: issues.map((i) => i.message).join('; ') })
    return { problems, ...(params ? { params } : {}) }
  }

  /** `ok` when the character may be shown on a stage, else the first reason (see `assess` for all of them). */
  check(id: string): Result<true, CharacterCode> {
    const c = this.deps.repo.get(id)
    if (!c) return fail('not_found', `character "${id}" does not exist`)
    const { problems } = this.assess(c)
    return problems.length === 0 ? ok(true) : fail(problems[0]!.code, problems.map((p) => p.message).join('; '))
  }

  /**
   * The `character.load` command for a character. It is a GATE: a character whose base is missing or unlicensed, whose
   * parameters the adult envelope would not accept, or who is not validly clothed in the current catalog gets a refusal
   * and no command, so a stage never receives such a figure. What is sent is the RESOLVED parameter set (the base's
   * defaults with the stored values clamped in), never stale or unknown ids.
   */
  loadCommand(id: string): Result<CommandDraft, CharacterCode> {
    const c = this.deps.repo.get(id)
    if (!c) return fail('not_found', `character "${id}" does not exist`)
    const { problems, params } = this.assess(c)
    if (problems.length > 0 || !params) return fail(problems[0]?.code ?? 'base_unusable', problems.map((p) => p.message).join('; ') || 'the character cannot be shown')
    const shown: CharacterProfile = { ...c, params }
    return ok({ type: 'character.load', characterId: c.id, character: shown, assets: this.assetsFor(shown) })
  }

  /**
   * Called on daemon start: make persisted state safe again, and FAIL CLOSED where it cannot.
   *
   * Repaired and saved: equipped items whose asset vanished, no longer fit, no longer cover what their slot must cover,
   * or whose licence changed are cleared and the clothed baseline is refilled from the VETTED baseline picks; parameters
   * are re-clamped against the current base manifest; stored parameters the adult envelope rejects are reset to the
   * base's defaults (when those are acceptable themselves).
   *
   * Never "repaired" into something worse: if the clothed baseline cannot be re-established from this catalog, NOTHING
   * about what she wears is saved (an unclothed state is never persisted, and a temporarily missing asset does not
   * destroy her wardrobe: she is whole again when it returns). If her base is missing, unlicensed or not an adult base, or
   * her parameters cannot be made acceptable, the character is reported in `problems` and `loadCommand` refuses to
   * describe her to a stage. If the active character of a role cannot be shown and another one can, the other becomes the
   * active one (reported too). Exactly one active assistant is guaranteed whenever an assistant exists.
   */
  restore(): RestoreReport {
    const { repo, catalog } = this.deps
    const report: RestoreReport = { repaired: [], paramsAdjusted: [], problems: [] }
    const problem = (characterId: string, message: string): void => void report.problems.push({ characterId, message })
    for (const c of repo.list()) {
      let changed = false
      const next: CharacterProfile = structuredClone(c)

      // ---- what she wears
      const eq = normalizeEquipped(c.equipped)
      const repairs: RestoreReport['repaired'] = []
      for (const slot of ALL_SLOTS) {
        const aid = eq[slot]
        if (!aid) continue
        const a = catalog.get(aid)
        let reason: string | undefined
        if (!a) reason = 'asset is no longer in the catalog'
        else if (!a.slots.includes(slot)) reason = 'asset does not fit the slot'
        else if (a.rigFamilies.length > 0 && !a.rigFamilies.includes(c.rigFamily)) reason = `asset does not fit a ${c.rigFamily} rig`
        else {
          const lic = catalog.canUse(aid, 'personal')
          if (!lic.ok) reason = lic.reasons.join('; ')
          else reason = coverageProblem(a, slot)
        }
        if (reason) {
          repairs.push({ characterId: c.id, slot, assetId: aid, reason })
          // clear every slot that item occupied so a half-worn multi-slot item cannot survive
          for (const s of ALL_SLOTS) if (eq[s] === aid) eq[s] = null
        }
      }
      let mixed = false
      if (eq.fullBody && (eq.top || eq.bottom)) {
        eq.top = null
        eq.bottom = null
        mixed = true
      }
      const completed = completeBaseline(eq, catalog, c.rigFamily)
      if (!completed) {
        // fail closed: keep what is stored (never an unclothed state) and say so; loadCommand will refuse her
        problem(c.id, 'the clothed baseline could not be restored from this catalog (no vetted top and bottom are left to refill it); her look is kept as stored and she is not shown until it can be')
      } else {
        report.repaired.push(...repairs)
        if (repairs.length > 0 || completed.filled.length > 0 || mixed) {
          next.equipped = completed.equipped
          changed = true
        }
      }

      // ---- her base and her parameters
      const base = this.baseOf(c)
      if (!base) {
        problem(c.id, `base asset "${c.baseAssetId}" is not in the catalog, so she cannot be shown`)
        // Without a base there is nothing to re-judge the parameters against, but the adult envelope still applies to what is
        // stored: a governed value that violates it (or that is not even a number), or a combination that is too youthful, is
        // REMOVED, so nothing out of the envelope stays in her record. Her base sets those values again when it returns.
        const governed = Object.keys(c.params).filter((k) => Object.prototype.hasOwnProperty.call(ADULT_BOUNDS, k) || governedAliasOf(k) !== undefined)
        const env = evaluateAdultEnvelope(scalarsOf(c.params))
        if (!env.ok || governed.some((k) => typeof c.params[k] !== 'number')) {
          next.params = Object.fromEntries(Object.entries(c.params).filter(([k]) => !governed.includes(k)))
          changed = true
          problem(c.id, `stored parameters violated the adult envelope (${env.violations.join('; ') || 'a governed value was not a number'}); the governed values were cleared and are set from her base again when it returns`)
        }
      } else {
        const lic = catalog.canUse(base.id, 'personal')
        if (!lic.ok) problem(c.id, `her base "${base.name}" can no longer be used: ${lic.reasons.join('; ')}`)
        if (base.kind !== 'character_base' || base.adult !== true) problem(c.id, `her base "${base.name}" is not an adult character base`)
        const defs = new Map(base.params.map((p) => [p.id, p]))
        const adjusted: string[] = []
        for (const k of Object.keys(c.params)) if (!defs.has(k)) adjusted.push(k)
        const pv = validateParams(base, {}, c.params)
        if (pv.ok) {
          for (const [k, v] of Object.entries(pv.params)) if (c.params[k] !== v) adjusted.push(k)
          if (adjusted.length > 0) {
            next.params = pv.params
            changed = true
            report.paramsAdjusted.push({ characterId: c.id, ids: [...new Set(adjusted)] })
          }
          const env = evaluateAdultEnvelope(scalarsOf(next.params))
          if (!env.ok) {
            // an updated base can never reach here with in-range values; if it does, fall back to the base defaults, if THEY are acceptable
            const defaults = defaultParams(base)
            if (evaluateAdultEnvelope(scalarsOf(defaults)).ok) {
              next.params = defaults
              changed = true
              problem(c.id, `stored parameters violated the adult envelope and were reset to the base defaults (${env.violations.join('; ')})`)
            } else {
              problem(c.id, `stored parameters violate the adult envelope and the base defaults do not satisfy it either (${env.violations.join('; ')}); she is not shown`)
            }
          }
        } else {
          problem(c.id, `stored parameters are not valid for her base (${pv.errors.join('; ')}); she is not shown`)
        }
      }
      if (changed) {
        next.updatedAt = this.nowIso()
        const parsed = CharacterProfile.safeParse(next)
        if (parsed.success) repo.save(parsed.data)
        else problem(c.id, 'the repaired character could not be saved')
      }
    }

    // exactly one active assistant (and at most one user) pointing at a real character of the right role, preferring one that can be shown
    const usable = (p: CharacterProfile): boolean => this.assess(p).problems.length === 0
    for (const role of ['assistant', 'user'] as const) {
      const active = this.getActive(role)
      if (active && usable(active)) continue
      const alt = this.list(role).find(usable)
      if (alt && alt.id !== active?.id) {
        repo.setActiveId(role, alt.id)
        if (active) problem(active.id, `${active.name} cannot be shown, so ${alt.name} is now the active ${role}`)
      } else if (!active) repo.setActiveId(role, this.list(role)[0]?.id)
    }
    const a = this.getActive('assistant')
    const u = this.getActive('user')
    if (a) report.assistant = a
    if (u) report.user = u
    return report
  }
}

export function createCharacterService(deps: CharacterServiceDeps): CharacterService {
  return new CharacterService(deps)
}
