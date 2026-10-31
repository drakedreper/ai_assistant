/**
 * Pure wardrobe rules shared by the character and wardrobe services: slot conflicts, hidden-region masks,
 * rig/licence/slot validation of an equipped state and the guaranteed clothed baseline.
 */
import { BodyRegion } from '@ai-assistant/shared'
import type { BodyRegion as Region, Equipped, RigFamily, WardrobeSlot as Slot } from '@ai-assistant/shared'
import type { AssetCatalog } from '../assets/catalog'
import { ALL_SLOTS, WEARABLE_KINDS, emptyEquipped, isClothedBaseline, slotsOf } from '../core/equipped'

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

/** The default clothed look for a rig: the first (by id) licence-ok assets tagged "baseline" for top, bottom and footwear. */
export function pickBaseline(catalog: AssetCatalog, rig: RigFamily): BaselinePick | undefined {
  const pick = (slot: Slot): string | undefined => catalog.list({ slot, rig, tags: ['baseline'], usableFor: 'personal' }).find((a) => a.slots.length === 1)?.id
  const top = pick('top')
  const bottom = pick('bottom')
  if (!top || !bottom) return undefined
  const footwear = pick('footwear')
  return footwear ? { top, bottom, footwear } : { top, bottom }
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
  if (isClothedBaseline(equipped)) return { equipped: { ...equipped }, filled: [] }
  const b = pickBaseline(catalog, rig)
  if (!b) return undefined
  const next = { ...equipped }
  const filled: Slot[] = []
  if (!next.top) {
    next.top = b.top
    filled.push('top')
  }
  if (!next.bottom) {
    next.bottom = b.bottom
    filled.push('bottom')
  }
  return { equipped: next, filled }
}

/** Remove an asset from every slot it occupies. */
export function removeAsset(equipped: Equipped, assetId: string): Equipped {
  const next = { ...equipped }
  for (const s of slotsOf(equipped, assetId)) next[s] = null
  return next
}
