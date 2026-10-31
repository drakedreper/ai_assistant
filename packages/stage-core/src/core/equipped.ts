import { WardrobeSlot } from '@ai-assistant/shared'
import type { BodyRegion, Equipped, OutfitPreset, WardrobeSlot as Slot } from '@ai-assistant/shared'

/** Every slot, in canonical order. Note: shared `Equipped` is an EXHAUSTIVE record (zod 4): all 16 keys must exist. */
export const ALL_SLOTS: readonly Slot[] = WardrobeSlot.options

/** Slots that belong to who she is rather than what she wears; a preset that leaves them empty keeps the current one. */
export const IDENTITY_SLOTS: readonly Slot[] = ['hair']

/** The wardrobe (equipped) kinds of asset. */
export const WEARABLE_KINDS = ['hair', 'outfit', 'accessory'] as const

export function emptyEquipped(): Equipped {
  const e = {} as Record<string, string | null>
  for (const s of ALL_SLOTS) e[s] = null
  return e as Equipped
}

/** Fill missing slots with null and drop anything that is not a slot or not a string. Never throws. */
export function normalizeEquipped(partial: unknown): Equipped {
  const out = emptyEquipped()
  if (partial === null || typeof partial !== 'object') return out
  for (const s of ALL_SLOTS) {
    const v = (partial as Record<string, unknown>)[s]
    if (typeof v === 'string' && v.length > 0) out[s] = v
  }
  return out
}

/** Distinct asset ids that are worn (a multi-slot item appears once). */
export function equippedAssetIds(eq: Equipped): string[] {
  const seen = new Set<string>()
  for (const s of ALL_SLOTS) {
    const id = eq[s]
    if (id) seen.add(id)
  }
  return [...seen]
}

/** Slots occupied by a given asset id. */
export function slotsOf(eq: Equipped, assetId: string): Slot[] {
  return ALL_SLOTS.filter((s) => eq[s] === assetId)
}

/**
 * The fully-clothed baseline: a full-body item, or BOTH a top and a bottom. (Stricter than "not both empty":
 * a state with only one of them is also refused, so no operation can ever leave the figure half dressed.)
 */
export function isClothedBaseline(eq: Equipped): boolean {
  return !!eq.fullBody || (!!eq.top && !!eq.bottom)
}

export function equippedEqual(a: Equipped, b: Equipped): boolean {
  return ALL_SLOTS.every((s) => (a[s] ?? null) === (b[s] ?? null))
}

/** The resulting equipped state after applying a preset: a full replace, except identity slots left empty are kept. */
export function applyPresetToEquipped(current: Equipped, preset: Pick<OutfitPreset, 'equipped'>): Equipped {
  const next = normalizeEquipped(preset.equipped)
  for (const s of IDENTITY_SLOTS) if (!next[s]) next[s] = current[s] ?? null
  return next
}

export type { BodyRegion }
