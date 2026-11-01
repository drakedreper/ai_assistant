/**
 * Pure wardrobe rules shared by the character and wardrobe services: slot conflicts, hidden-region masks,
 * rig/licence/slot validation of an equipped state and the guaranteed clothed baseline.
 *
 * THE BASELINE IS ABOUT COVERAGE, NOT SLOT OCCUPANCY. Being "clothed" means a full-body item, or both a top and a bottom
 * (the structural rule, `isClothedBaseline`), AND that what sits in those slots really covers the body: the top (or the
 * full-body item) must hide the torso, the bottom (or the full-body item) the legs, and all of them are outfits. A piece
 * that hides nothing does not count, so no registered item can "satisfy" the baseline while the figure is bare.
 *
 * WHERE THE DEFAULT LOOK COMES FROM. The default top, bottom and footwear (new characters, auto-fill, restore) are chosen
 * ONLY from assets the owner of the catalog has vetted (`AssetCatalog.isVetted`: the first-party seed) that carry the
 * "baseline" tag, and only if they cover what their slot must cover. The tag alone means nothing: a registered asset
 * cannot make itself the default look by tagging itself.
 */
import { BodyRegion } from '@ai-assistant/shared'
import type { BodyRegion as Region, Equipped, RigFamily, WardrobeSlot as Slot } from '@ai-assistant/shared'
import type { AssetCatalog } from '../assets/catalog'
import { ALL_SLOTS, WEARABLE_KINDS, emptyEquipped, isClothedBaseline, slotsOf } from '../core/equipped'
import type { AssetManifest } from '../assets/manifest'

/** Slots that cannot be occupied together. A full-body item replaces top and bottom (outerwear, shoes and accessories stay). */
export const SLOT_CONFLICTS: Readonly<Record<string, readonly Slot[]>> = {
  fullBody: ['top', 'bottom'],
  top: ['fullBody'],
  bottom: ['fullBody'],
}

export interface EquipIssue {
  slot?: Slot
  assetId?: string
  message: string
}

/** Union of the regions hidden by everything worn, in canonical BodyRegion order. */
export function computeHiddenRegions(equipped: Equipped, catalog: AssetCatalog): Region[] {
  const hidden = new Set<Region>()
  const seen = new Set<string>()
  for (const s of ALL_SLOTS) {
    const id = equipped[s]
    if (!id || seen.has(id)) continue
    seen.add(id)
    const a = catalog.get(id)
    if (a) for (const r of a.hides) hidden.add(r)
  }
  return BodyRegion.options.filter((r) => hidden.has(r))
}

/** Check one asset can be worn by a character of this rig (exists, wearable kind, rig, personal licence). */
export function checkWearable(catalog: AssetCatalog, assetId: string, rig: RigFamily): EquipIssue | undefined {
  const a = catalog.get(assetId)
  if (!a) return { assetId, message: `"${assetId}" is not in the catalog` }
  if (!(WEARABLE_KINDS as readonly string[]).includes(a.kind)) return { assetId, message: `"${a.name}" is a ${a.kind}, not something she can wear` }
  if (a.rigFamilies.length > 0 && !a.rigFamilies.includes(rig)) return { assetId, message: `"${a.name}" does not fit a ${rig} rig` }
  const lic = catalog.canUse(assetId, 'personal')
  if (!lic.ok) return { assetId, message: lic.reasons.join('; ') }
  return undefined
}

/** What a piece in a baseline slot must hide. */
const COVERS: Readonly<Record<string, readonly Region[]>> = { top: ['torso'], bottom: ['legs'], fullBody: ['torso', 'legs'] }

/** Why this asset cannot serve as the clothing in a baseline slot (top, bottom, fullBody), or undefined if it can (or the slot is not a baseline one). */
export function coverageProblem(asset: Pick<AssetManifest, 'kind' | 'name' | 'hides'>, slot: Slot): string | undefined {
  const need = COVERS[slot]
  if (!need) return undefined
  if (asset.kind !== 'outfit') return `"${asset.name}" is a ${asset.kind}; only an outfit can be worn in the ${slot} slot as clothing`
  const missing = need.filter((r) => !asset.hides.includes(r))
  return missing.length > 0 ? `"${asset.name}" in the ${slot} slot does not cover the ${missing.join(' and ')}` : undefined
}

/** Problems with what the baseline slots hold (their coverage); only meaningful once the structural rule holds. Unknown ids are reported elsewhere. */
export function coverageProblems(equipped: Equipped, catalog: AssetCatalog): string[] {
  const out: string[] = []
  const slots: Slot[] = equipped.fullBody ? ['fullBody'] : ['top', 'bottom']
  const seen = new Set<string>()
  for (const slot of slots) {
    const id = equipped[slot]
    if (!id) continue
    const a = catalog.get(id)
    if (!a) continue
    const p = coverageProblem(a, slot)
    if (p && !seen.has(p)) {
      seen.add(p)
      out.push(p)
    }
  }
  return out
}

/** Clothed by the structural rule AND by coverage. */
export function isFullyClothed(equipped: Equipped, catalog: AssetCatalog): boolean {
  return isClothedBaseline(equipped) && coverageProblems(equipped, catalog).length === 0
}

/** Every problem with an equipped state (empty list = valid). */
export function validateEquipped(equipped: Equipped, catalog: AssetCatalog, rig: RigFamily): EquipIssue[] {
  const issues: EquipIssue[] = []
  const checked = new Set<string>()
  for (const s of ALL_SLOTS) {
    const id = equipped[s]
    if (!id) continue
    const a = catalog.get(id)
    if (!checked.has(id)) {
      checked.add(id)
      const w = checkWearable(catalog, id, rig)
      if (w) issues.push({ ...w, slot: s })
    }
    if (a) {
      if (!a.slots.includes(s)) issues.push({ slot: s, assetId: id, message: `"${a.name}" cannot occupy the ${s} slot` })
      for (const other of a.slots) {
        if (equipped[other] !== id) issues.push({ slot: other, assetId: id, message: `"${a.name}" must occupy all of its slots (${a.slots.join(', ')})` })
      }
    }
  }
  if (equipped.fullBody && (equipped.top || equipped.bottom)) issues.push({ slot: 'fullBody', message: 'a full-body item cannot be combined with a top or bottom' })
  if (!isClothedBaseline(equipped)) issues.push({ message: 'the outfit must keep the clothed baseline: a full-body item, or both a top and a bottom' })
  else for (const p of coverageProblems(equipped, catalog)) issues.push({ message: `the outfit must keep the clothed baseline: ${p}` })
  // de-duplicate identical messages (multi-slot items repeat)
  const uniq = new Map<string, EquipIssue>()
  for (const i of issues) uniq.set(`${i.slot ?? ''}|${i.assetId ?? ''}|${i.message}`, i)
  return [...uniq.values()]
}

export interface BaselinePick {
  top: string
  bottom: string
  footwear?: string
}

/**
 * The default clothed look for a rig: the first (by id) licence-ok, VETTED outfits tagged "baseline" for top, bottom and
 * footwear, each covering what its slot must cover. An asset that merely carries the tag is never picked.
 */
export function pickBaseline(catalog: AssetCatalog, rig: RigFamily): BaselinePick | undefined {
  const top = pickBaselineFor(catalog, rig, 'top')
  const bottom = pickBaselineFor(catalog, rig, 'bottom')
  if (!top || !bottom) return undefined
  const footwear = pickBaselineFor(catalog, rig, 'footwear')
  return footwear ? { top, bottom, footwear } : { top, bottom }
}

/** The default piece for ONE slot (see `pickBaseline`): vetted, tagged "baseline", an outfit, licence-ok, fitting the rig, covering what the slot must cover. */
export function pickBaselineFor(catalog: AssetCatalog, rig: RigFamily, slot: Slot): string | undefined {
  return catalog
    .list({ slot, rig, tags: ['baseline'], usableFor: 'personal' })
    .find((a) => a.kind === 'outfit' && a.slots.length === 1 && catalog.isVetted(a.id) && coverageProblem(a, slot) === undefined)?.id
}

export function baselineEquipped(catalog: AssetCatalog, rig: RigFamily): Equipped | undefined {
  const b = pickBaseline(catalog, rig)
  if (!b) return undefined
  const eq = emptyEquipped()
  eq.top = b.top
  eq.bottom = b.bottom
  if (b.footwear) eq.footwear = b.footwear
  return eq
}

/**
 * Fill whatever the clothed baseline is missing (top and/or bottom, when there is no full-body item) from the rig's
 * baseline picks. Returns undefined when the baseline cannot be completed from this catalog.
 */
export function completeBaseline(equipped: Equipped, catalog: AssetCatalog, rig: RigFamily): { equipped: Equipped; filled: Slot[] } | undefined {
  if (isFullyClothed(equipped, catalog)) return { equipped: { ...equipped }, filled: [] }
  const next = { ...equipped }
  const filled: Slot[] = []
  if (!next.fullBody) {
    // only what is MISSING is picked, so a shirt that is fine does not need a vetted bottom to exist, and the other way round
    for (const slot of ['top', 'bottom'] as const) {
      if (next[slot]) continue
      const id = pickBaselineFor(catalog, rig, slot)
      if (!id) return undefined
      next[slot] = id
      filled.push(slot)
    }
  }
  // a slot filled by something that does not cover (an outfit that hides nothing) is not repaired by filling the other one
  return isFullyClothed(next, catalog) ? { equipped: next, filled } : undefined
}

/** Remove an asset from every slot it occupies. */
export function removeAsset(equipped: Equipped, assetId: string): Equipped {
  const next = { ...equipped }
  for (const s of slotsOf(equipped, assetId)) next[s] = null
  return next
}
