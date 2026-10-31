/**
 * WardrobeService: equip / unequip with slot conflicts, hidden-region masks, rig and licence checks, outfit presets and
 * the guaranteed clothed baseline. Cosmetic changes only.
 *
 * The baseline is stricter than "top and bottom not both empty": every committed state has a full-body item or BOTH a
 * top and a bottom. Equipping may auto-complete a displaced slot from the rig's baseline pick (`autoFill`, default
 * on); unequipping never does, it is refused instead.
 */
import type { Asset, BodyRegion, CharacterProfile, Equipped, OutfitPreset, WardrobeSlot as Slot } from '@ai-assistant/shared'
import { OutfitPreset as OutfitPresetSchema } from '@ai-assistant/shared'
import type { AssetManifest } from '../assets/manifest'
import type { AssetCatalog } from '../assets/catalog'
import type { CharacterService } from '../characters/service'
import { validateParamValue } from '../characters/params'
import { ALL_SLOTS, applyPresetToEquipped, equippedAssetIds, equippedEqual, normalizeEquipped, slotsOf } from '../core/equipped'
import { SLOT_CONFLICTS, checkWearable, completeBaseline, computeHiddenRegions, removeAsset, validateEquipped } from './slots'
import { cleanText, hasForbiddenKeys, isSafeId } from '../util/safe'
import { fail, ok } from '../util/result'
import type { Result } from '../util/result'
import type { CommandDraft } from '../util/commands'
import type { IdGenerator } from '../util/ids'

export type WardrobeCode =
  | 'not_found'
  | 'unknown_asset'
  | 'unwearable'
  | 'slot_mismatch'
  | 'baseline'
  | 'invalid_state'
  | 'invalid_input'
  | 'preset_not_found'
  | 'invalid_preset'
  | 'too_many_presets'

/** Who asked: the user's own choice always wins over the assistant's and the director's. */
export type ChangeSource = 'user' | 'assistant' | 'director'

export interface WardrobeChange {
  characterId: string
  source: ChangeSource
  presetId?: string
  equipped: Equipped
}

export interface WardrobeDeps {
  characters: CharacterService
  catalog: AssetCatalog
  newId: IdGenerator
  /** Called after every committed change (the OutfitDirector listens here). */
  onChange?: (change: WardrobeChange) => void
}

export interface SlotChange {
  slot: Slot
  assetId: string | null
  previous: string | null
}

export interface EquipOutcome {
  profile: CharacterProfile
  changes: SlotChange[]
  /** Items that were taken off because of slot conflicts (ids). */
  displaced: string[]
  /** Slots refilled from the baseline to stay clothed. */
  filled: Slot[]
  hidden: BodyRegion[]
  commands: CommandDraft[]
  unchanged: boolean
}

export interface EquipOptions {
  autoFill?: boolean
  source?: ChangeSource
}

const MAX_PRESETS = 24
/** More slot changes than this are sent as one atomic `character.outfit` instead of several `character.equip`. */
const EQUIP_COMMAND_LIMIT = 3

export class WardrobeService {
  constructor(private readonly deps: WardrobeDeps) {}

  private character(id: string): Result<CharacterProfile, WardrobeCode> {
    const c = this.deps.characters.get(id)
    return c ? ok(c) : fail('not_found', `character "${id}" does not exist`)
  }

  /** Slots one asset needs, resolving an explicit slot request for assets that list several. */
  private slotsFor(asset: AssetManifest, wanted?: Slot): Result<Slot[], WardrobeCode> {
    if (wanted !== undefined && !asset.slots.includes(wanted)) return fail('slot_mismatch', `"${asset.name}" cannot be worn in the ${wanted} slot (it uses: ${asset.slots.join(', ')})`)
    return ok(asset.slots)
  }

  /** Place assets into an equipped state, clearing conflicts. Pure on its inputs. */
  private place(current: Equipped, assets: AssetManifest[]): { equipped: Equipped; displaced: Set<string> } {
    let eq: Equipped = { ...current }
    const displaced = new Set<string>()
    for (const asset of assets) {
      const clear = new Set<Slot>()
      for (const s of asset.slots) {
        clear.add(s)
        for (const c of SLOT_CONFLICTS[s] ?? []) clear.add(c)
      }
      for (const s of clear) {
        const occupant = eq[s]
        if (occupant && occupant !== asset.id) {
          displaced.add(occupant)
          eq = removeAsset(eq, occupant)
        }
      }
      for (const s of asset.slots) eq[s] = asset.id
    }
    return { equipped: eq, displaced }
  }

  private commit(
    profile: CharacterProfile,
    target: Equipped,
    opts: { source: ChangeSource; displaced?: Set<string>; filled?: Slot[]; presetId?: string; presetTweaks?: OutfitPreset['tweaks']; asOutfit?: boolean },
  ): Result<EquipOutcome, WardrobeCode> {
    const issues = validateEquipped(target, this.deps.catalog, profile.rigFamily)
    if (issues.length > 0) {
      const baselineIssue = issues.some((i) => /baseline/.test(i.message))
      return fail(baselineIssue ? 'baseline' : 'invalid_state', issues.map((i) => i.message).join('; '))
    }
    const changes: SlotChange[] = []
    for (const s of ALL_SLOTS) {
      const prev = profile.equipped[s] ?? null
      const next = target[s] ?? null
      if (prev !== next) changes.push({ slot: s, assetId: next, previous: prev })
    }
    const unchanged = changes.length === 0 && opts.presetId === undefined
    if (changes.length > 0) {
      const saved = this.deps.characters.setEquipped(profile.id, target)
      if (!saved.ok) return fail(saved.code === 'not_found' ? 'not_found' : 'invalid_state', saved.error)
      profile = saved.value
    }
    const hidden = computeHiddenRegions(target, this.deps.catalog)
    const commands = this.commandsFor(profile, changes, opts)
    const outcome: EquipOutcome = { profile, changes, displaced: [...(opts.displaced ?? [])].sort(), filled: opts.filled ?? [], hidden, commands, unchanged }
    if (!unchanged) this.deps.onChange?.({ characterId: profile.id, source: opts.source, ...(opts.presetId ? { presetId: opts.presetId } : {}), equipped: target })
    return ok(outcome)
  }

  private assetsOf(eq: Equipped): Asset[] {
    return equippedAssetIds(eq).sort().map((id) => this.deps.catalog.get(id)).filter((a): a is AssetManifest => !!a)
  }

  private commandsFor(profile: CharacterProfile, changes: SlotChange[], opts: { presetId?: string; presetTweaks?: OutfitPreset['tweaks']; asOutfit?: boolean }): CommandDraft[] {
    if (changes.length === 0 && opts.presetId === undefined) return []
    if (opts.asOutfit || changes.length > EQUIP_COMMAND_LIMIT) {
      const preset: OutfitPreset = {
        id: opts.presetId ?? 'adhoc',
        name: profile.presets.find((p) => p.id === opts.presetId)?.name ?? 'Current look',
        equipped: profile.equipped,
        tweaks: opts.presetTweaks ?? {},
        context: {},
      }
      return [{ type: 'character.outfit', characterId: profile.id, preset, assets: this.assetsOf(profile.equipped) }]
    }
    // removals first so slots are free before items arrive
    const ordered = [...changes].sort((a, b) => Number(a.assetId !== null) - Number(b.assetId !== null))
    return ordered.map((c): CommandDraft => {
      const asset = c.assetId ? this.deps.catalog.get(c.assetId) : undefined
      return { type: 'character.equip', characterId: profile.id, slot: c.slot, assetId: c.assetId, ...(asset ? { asset } : {}) }
    })
  }

  /** Wear one asset (in all the slots it occupies). Replaced items come off; a clothed baseline is kept. */
  equip(characterId: string, assetId: string, opts: EquipOptions & { slot?: Slot } = {}): Result<EquipOutcome, WardrobeCode> {
    return this.equipMany(characterId, [assetId], opts)
  }

  /** Wear several assets atomically (all or nothing). */
  equipMany(characterId: string, assetIds: readonly string[], opts: EquipOptions & { slot?: Slot } = {}): Result<EquipOutcome, WardrobeCode> {
    const c = this.character(characterId)
    if (!c.ok) return c
    if (!Array.isArray(assetIds) || assetIds.length === 0 || assetIds.length > 16) return fail('invalid_input', 'equip needs between 1 and 16 assets')
    const assets: AssetManifest[] = []
    for (const id of assetIds) {
      if (typeof id !== 'string') return fail('invalid_input', 'asset ids must be strings')
      const a = this.deps.catalog.get(id)
      if (!a) return fail('unknown_asset', `"${id}" is not in the catalog`)
      const w = checkWearable(this.deps.catalog, id, c.value.rigFamily)
      if (w) return fail(/not something she can wear/.test(w.message) ? 'unwearable' : 'invalid_state', w.message)
      const slots = this.slotsFor(a, opts.slot)
      if (!slots.ok) return slots
      assets.push(a)
    }
    const placed = this.place(c.value.equipped, assets)
    let target = placed.equipped
    let filled: Slot[] = []
    if (opts.autoFill !== false) {
      const comp = completeBaseline(target, this.deps.catalog, c.value.rigFamily)
      if (comp) {
        target = comp.equipped
        filled = comp.filled
      }
    }
    return this.commit(c.value, target, { source: opts.source ?? 'user', displaced: placed.displaced, filled })
  }

  /** Take off whatever occupies a slot (and the rest of a multi-slot item). Refused if it would break the baseline. */
  unequip(characterId: string, slot: Slot, opts: { source?: ChangeSource } = {}): Result<EquipOutcome, WardrobeCode> {
    const c = this.character(characterId)
    if (!c.ok) return c
    if (!ALL_SLOTS.includes(slot)) return fail('invalid_input', `unknown slot "${String(slot)}"`)
    const id = c.value.equipped[slot]
    if (!id) return ok({ profile: c.value, changes: [], displaced: [], filled: [], hidden: computeHiddenRegions(c.value.equipped, this.deps.catalog), commands: [], unchanged: true })
    const target = removeAsset(c.value.equipped, id)
    const r = this.commit(c.value, target, { source: opts.source ?? 'user', displaced: new Set([id]) })
    if (!r.ok && r.code === 'baseline') return fail('baseline', `Taking off ${this.deps.catalog.get(id)?.name ?? id} would leave her without a full outfit. Swap it for another piece instead.`)
    return r
  }

  hiddenRegions(characterId: string): BodyRegion[] {
    const c = this.deps.characters.get(characterId)
    return c ? computeHiddenRegions(c.equipped, this.deps.catalog) : []
  }

  // ---------------------------------------------------------------------------------------------------- presets

  listPresets(characterId: string): OutfitPreset[] {
    return this.deps.characters.get(characterId)?.presets ?? []
  }

  /** Problems that stop a preset from being applied to this character (empty = applicable). */
  checkPreset(characterId: string, preset: OutfitPreset): string[] {
    const c = this.deps.characters.get(characterId)
    if (!c) return [`character "${characterId}" does not exist`]
    const target = applyPresetToEquipped(c.equipped, preset)
    return validateEquipped(target, this.deps.catalog, c.rigFamily).map((i) => i.message)
  }

  /** Presets that can be worn right now by this character. */
  applicablePresets(characterId: string): OutfitPreset[] {
    return this.listPresets(characterId).filter((p) => this.checkPreset(characterId, p).length === 0)
  }

  /** The preset the character is currently dressed as, if any. */
  currentPresetId(characterId: string): string | undefined {
    const c = this.deps.characters.get(characterId)
    if (!c) return undefined
    return c.presets.find((p) => equippedEqual(applyPresetToEquipped(c.equipped, p), c.equipped))?.id
  }

  /** Save what she is wearing as a preset (overwrites a preset with the same id). */
  savePreset(
    characterId: string,
    name: string,
    opts: { id?: string; context?: OutfitPreset['context']; tweaks?: OutfitPreset['tweaks'] } = {},
  ): Result<OutfitPreset, WardrobeCode> {
    const c = this.character(characterId)
    if (!c.ok) return c
    const clean = typeof name === 'string' ? cleanText(name, 40) : ''
    if (clean.length === 0) return fail('invalid_input', 'a preset needs a name')
    let id = opts.id
    if (id !== undefined && !isSafeId(id)) return fail('invalid_input', 'preset id must be path-safe')
    const existing = id ? c.value.presets.find((p) => p.id === id) : undefined
    if (!existing && c.value.presets.length >= MAX_PRESETS) return fail('too_many_presets', `at most ${MAX_PRESETS} presets`)
    if (id === undefined) {
      const slug = clean.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'look'
      id = `preset.${slug}`
      let n = 2
      while (c.value.presets.some((p) => p.id === id)) id = `preset.${slug}-${n++}`
    }
    const tweaks = opts.tweaks ?? {}
    if (hasForbiddenKeys(tweaks)) return fail('invalid_input', 'tweaks contain a forbidden key')
    const worn = new Set(equippedAssetIds(c.value.equipped))
    const cleanTweaks: OutfitPreset['tweaks'] = {}
    for (const [assetId, values] of Object.entries(tweaks)) {
      if (!worn.has(assetId)) return fail('invalid_input', `tweaks refer to "${assetId}", which is not part of the look`)
      const asset = this.deps.catalog.get(assetId)!
      const defs = new Map(asset.params.map((p) => [p.id, p]))
      const out: Record<string, number | string> = {}
      for (const [pid, v] of Object.entries(values)) {
        const d = defs.get(pid)
        if (!d) return fail('invalid_input', `"${asset.name}" has no parameter "${pid}"`)
        const r = validateParamValue(d, v)
        if (!r.ok) return fail('invalid_input', r.error)
        out[pid] = r.value
      }
      cleanTweaks[assetId] = out
    }
    const parsed = OutfitPresetSchema.safeParse({ id, name: clean, equipped: normalizeEquipped(c.value.equipped), tweaks: cleanTweaks, context: opts.context ?? {} })
    if (!parsed.success) return fail('invalid_input', parsed.error.issues[0]?.message ?? 'invalid preset')
    const presets = existing ? c.value.presets.map((p) => (p.id === id ? parsed.data : p)) : [...c.value.presets, parsed.data]
    const saved = this.deps.characters.setPresets(characterId, presets)
    if (!saved.ok) return fail('not_found', saved.error)
    return ok(structuredClone(parsed.data))
  }

  /** Put on a saved preset (a full replace; identity slots such as hair stay when the preset leaves them empty). */
  applyPreset(characterId: string, presetId: string, opts: { source?: ChangeSource } = {}): Result<EquipOutcome, WardrobeCode> {
    const c = this.character(characterId)
    if (!c.ok) return c
    const preset = c.value.presets.find((p) => p.id === presetId)
    if (!preset) return fail('preset_not_found', `no outfit preset "${presetId}"`)
    const target = applyPresetToEquipped(c.value.equipped, preset)
    const issues = validateEquipped(target, this.deps.catalog, c.value.rigFamily)
    if (issues.length > 0) return fail('invalid_preset', `preset "${preset.name}" cannot be worn: ${issues.map((i) => i.message).join('; ')}`)
    return this.commit(c.value, target, { source: opts.source ?? 'user', presetId: preset.id, presetTweaks: preset.tweaks, asOutfit: true })
  }

  deletePreset(characterId: string, presetId: string): Result<true, WardrobeCode> {
    const c = this.character(characterId)
    if (!c.ok) return c
    if (!c.value.presets.some((p) => p.id === presetId)) return fail('preset_not_found', `no outfit preset "${presetId}"`)
    const saved = this.deps.characters.setPresets(characterId, c.value.presets.filter((p) => p.id !== presetId))
    return saved.ok ? ok(true) : fail('not_found', saved.error)
  }

  /** A short, readable description of what she wears (for stage_state and logs). */
  describeLook(characterId: string): string {
    const c = this.deps.characters.get(characterId)
    if (!c) return 'unknown character'
    const parts: string[] = []
    for (const s of ALL_SLOTS) {
      const id = c.equipped[s]
      if (!id) continue
      if (slotsOf(c.equipped, id)[0] !== s) continue
      parts.push(this.deps.catalog.get(id)?.name ?? id)
    }
    return parts.join(', ')
  }
}

export function createWardrobeService(deps: WardrobeDeps): WardrobeService {
  return new WardrobeService(deps)
}

