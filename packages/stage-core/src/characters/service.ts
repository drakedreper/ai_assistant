import { AUTHORITY_PRESENCE, CharacterProfile, PresenceStyle, VoiceProfile } from '@ai-assistant/shared'
import type { Asset, Equipped, OutfitPreset, RigFamily, WardrobeSlot } from '@ai-assistant/shared'
import type { AssetCatalog } from '../assets/catalog'
import type { CharacterRepo, CharacterRole } from './repo'
import { evaluateAdultEnvelope } from './adult-policy'
import { defaultParams, scalarsOf, validateParams } from './params'
import type { ParamSet } from './params'
import { ALL_SLOTS, equippedAssetIds, normalizeEquipped } from '../core/equipped'
import { baselineEquipped, completeBaseline, validateEquipped } from '../wardrobe/slots'
import { SEED_OUTFIT_PRESETS } from '../wardrobe/presets'
import { cleanText, isSafeId } from '../util/safe'
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
  /** Slots cleared because their asset vanished, no longer fits, or its licence now forbids it. */
  repaired: Array<{ characterId: string; slot: WardrobeSlot; assetId: string; reason: string }>
  /** Parameters that were out of range for the (possibly updated) base and were clamped, or dropped. */
  paramsAdjusted: Array<{ characterId: string; ids: string[] }>
  /** Characters whose clothed baseline could not be restored from this catalog. */
  problems: Array<{ characterId: string; message: string }>
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

  private baseOf(profile: Pick<CharacterProfile, 'baseAssetId'>): Asset | undefined {
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
    const r = this.resolveParams(cur, patch)
    if (!r.ok) return r
    const changed = Object.keys(r.value).filter((k) => cur.params[k] !== r.value[k])
    const saved = this.persist({ ...cur, params: r.value, updatedAt: this.nowIso() })
    if (!saved.ok) return saved
    if (changed.length === 0) return ok({ profile: saved.value, changed })
    const send: Record<string, number | string> = {}
    for (const k of changed) send[k] = r.value[k]!
    return ok({ profile: saved.value, changed, command: { type: 'character.params', characterId: id, params: send, blendMs } })
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

  /** The `character.load` command for a character. */
  loadCommand(id: string): Result<CommandDraft, CharacterCode> {
    const c = this.deps.repo.get(id)
    if (!c) return fail('not_found', `character "${id}" does not exist`)
    return ok({ type: 'character.load', characterId: c.id, character: c, assets: this.assetsFor(c) })
  }

  /**
   * Called on daemon start: make persisted state safe again. Equipped items whose asset vanished, no longer fit, or
   * whose licence changed are cleared; the clothed baseline is refilled; parameters are re-clamped against the current
   * base manifest; exactly one active assistant is guaranteed whenever an assistant exists.
   */
  restore(): RestoreReport {
    const { repo, catalog } = this.deps
    const report: RestoreReport = { repaired: [], paramsAdjusted: [], problems: [] }
    for (const c of repo.list()) {
      let changed = false
      const next: CharacterProfile = structuredClone(c)

      // equipped
      const eq = normalizeEquipped(c.equipped)
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
        }
        if (reason) {
          report.repaired.push({ characterId: c.id, slot, assetId: aid, reason })
          // clear every slot that item occupied so a half-worn multi-slot item cannot survive
          for (const s of ALL_SLOTS) if (eq[s] === aid) eq[s] = null
          changed = true
        }
      }
      if (eq.fullBody && (eq.top || eq.bottom)) {
        eq.top = null
        eq.bottom = null
        changed = true
      }
      const completed = completeBaseline(eq, catalog, c.rigFamily)
      if (!completed) report.problems.push({ characterId: c.id, message: 'the clothed baseline could not be restored from this catalog' })
      else if (completed.filled.length > 0) {
        Object.assign(eq, completed.equipped)
        changed = true
      }
      next.equipped = eq

      // params against the current base
      const base = this.baseOf(c)
      if (base) {
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
            // an updated base can never reach here with in-range values; if it does, fall back to the base defaults
            next.params = defaultParams(base)
            changed = true
            report.problems.push({ characterId: c.id, message: `stored parameters violated the adult envelope and were reset to the base defaults (${env.violations.join('; ')})` })
          }
        }
      } else {
        report.problems.push({ characterId: c.id, message: `base asset "${c.baseAssetId}" is not in the catalog` })
      }
      if (changed) {
        next.updatedAt = this.nowIso()
        const parsed = CharacterProfile.safeParse(next)
        if (parsed.success) repo.save(parsed.data)
      }
    }

    // exactly one active assistant (and at most one user) pointing at a real character of the right role
    for (const role of ['assistant', 'user'] as const) {
      const active = this.getActive(role)
      if (!active) repo.setActiveId(role, this.list(role)[0]?.id)
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
