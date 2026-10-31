import { describe, expect, it } from 'vitest'
import {
  ALL_SLOTS,
  OutfitDirector,
  SEED_IDS as S,
  SEED_OUTFIT_PRESETS,
  WardrobeService,
  applyPresetToEquipped,
  computeHiddenRegions,
  createWardrobeService,
  emptyEquipped,
  isClothedBaseline,
  normalizeEquipped,
  seedBaseId,
  validateEquipped,
} from '../src'
import type { ChangeSource, WardrobeChange } from '../src'
import { LIC, lcg, makeAssistant, makeWorld } from './helpers'

function setup(rig: 'vrm1' | 'metahuman' | 'cc5' = 'vrm1') {
  const w = makeAssistant(makeWorld(), rig)
  const changes: WardrobeChange[] = []
  const wardrobe = createWardrobeService({ characters: w.characters, catalog: w.catalog, newId: w.newId, onChange: (c) => changes.push(c) })
  return { ...w, wardrobe, changes, id: w.assistant.id, eq: () => w.characters.get(w.assistant.id)!.equipped }
}

describe('equip', () => {
  it('wears a blazer over the baseline, hides the right regions and sends a character.equip with the asset', () => {
    const s = setup()
    const r = s.wardrobe.equip(s.id, S.blazer)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(s.eq().outerwear).toBe(S.blazer)
    expect(r.value.changes).toEqual([{ slot: 'outerwear', assetId: S.blazer, previous: null }])
    expect(r.value.hidden).toEqual(['torso', 'arms', 'legs', 'feet', 'neck'])
    expect(r.value.commands).toHaveLength(1)
    expect(r.value.commands[0]).toMatchObject({ type: 'character.equip', characterId: s.id, slot: 'outerwear', assetId: S.blazer })
    expect((r.value.commands[0] as { asset?: { id: string } }).asset?.id).toBe(S.blazer)
    expect(s.changes.at(-1)).toMatchObject({ characterId: s.id, source: 'user' })
  })

  it('a coat replaces a blazer (same slot) and reports the displaced item', () => {
    const s = setup()
    s.wardrobe.equip(s.id, S.blazer)
    const r = s.wardrobe.equip(s.id, S.coat)
    expect(r.ok && r.value.displaced).toEqual([S.blazer])
    expect(s.eq().outerwear).toBe(S.coat)
  })

  it('equipping what is already worn changes nothing and fires nothing', () => {
    const s = setup()
    const n = s.changes.length
    const r = s.wardrobe.equip(s.id, S.shirt)
    expect(r.ok && r.value.unchanged).toBe(true)
    expect(r.ok && r.value.commands).toEqual([])
    expect(s.changes).toHaveLength(n)
  })

  it('a full-body item clears top and bottom but keeps outerwear, footwear and accessories', () => {
    const s = setup()
    s.wardrobe.equip(s.id, S.blazer)
    s.wardrobe.equip(s.id, S.earrings)
    const r = s.wardrobe.equip(s.id, S.jumpsuit)
    expect(r.ok).toBe(true)
    const e = s.eq()
    expect(e.fullBody).toBe(S.jumpsuit)
    expect(e.top).toBeNull()
    expect(e.bottom).toBeNull()
    expect(e.outerwear).toBe(S.blazer)
    expect(e.footwear).toBe(S.boots)
    expect(e.earrings).toBe(S.earrings)
    expect(r.ok && r.value.displaced).toEqual([S.shirt, S.trousers].sort())
    expect(isClothedBaseline(e)).toBe(true)
  })

  it('equipping a top while in a jumpsuit clears the jumpsuit and refills the bottom from the baseline', () => {
    const s = setup()
    s.wardrobe.equip(s.id, S.jumpsuit)
    const r = s.wardrobe.equip(s.id, S.trainingTop)
    expect(r.ok).toBe(true)
    expect(s.eq().fullBody).toBeNull()
    expect(s.eq().top).toBe(S.trainingTop)
    expect(s.eq().bottom).toBe(S.trousers)
    expect(r.ok && r.value.filled).toEqual(['bottom'])
  })

  it('with autoFill off that same swap is refused and nothing changes', () => {
    const s = setup()
    s.wardrobe.equip(s.id, S.jumpsuit)
    const before = s.eq()
    const r = s.wardrobe.equip(s.id, S.trainingTop, { autoFill: false })
    expect(!r.ok && r.code).toBe('baseline')
    expect(s.eq()).toEqual(before)
  })

  it('equipMany swaps from a jumpsuit to separates atomically without any fill', () => {
    const s = setup()
    s.wardrobe.equip(s.id, S.jumpsuit)
    const r = s.wardrobe.equipMany(s.id, [S.trainingTop, S.leggings], { autoFill: false })
    expect(r.ok && r.value.filled).toEqual([])
    expect(s.eq()).toMatchObject({ top: S.trainingTop, bottom: S.leggings, fullBody: null })
  })

  it('a multi-slot item (a dress taking top and bottom) is removed from both slots when one is replaced', () => {
    const s = setup()
    s.catalog.add({ id: 'outfit.dress', kind: 'outfit', name: 'Tailored dress', locator: 'w/dress', slots: ['top', 'bottom'], hides: ['torso', 'legs'], license: LIC })
    expect(s.wardrobe.equip(s.id, 'outfit.dress').ok).toBe(true)
    expect(s.eq()).toMatchObject({ top: 'outfit.dress', bottom: 'outfit.dress' })
    const r = s.wardrobe.equip(s.id, S.trainingTop)
    expect(r.ok).toBe(true)
    expect(s.eq().top).toBe(S.trainingTop)
    expect(s.eq().bottom).toBe(S.trousers) // refilled
    expect(Object.values(s.eq()).includes('outfit.dress')).toBe(false)
    // unequipping one half takes the whole dress off, which would break the baseline
    s.wardrobe.equip(s.id, 'outfit.dress')
    const u = s.wardrobe.unequip(s.id, 'bottom')
    expect(!u.ok && u.code).toBe('baseline')
    expect(s.eq().bottom).toBe('outfit.dress')
  })

  it.each([
    ['unknown asset', 'nope', 'unknown_asset'],
    ['a prop', S.chair, 'unwearable'],
    ['a base character', 'base.vrm1.poised', 'unwearable'],
    ['an environment', S.void, 'unwearable'],
  ])('refuses %s', (_n, id, code) => {
    const s = setup()
    const before = s.eq()
    const r = s.wardrobe.equip(s.id, id)
    expect(!r.ok && r.code).toBe(code)
    expect(s.eq()).toEqual(before)
  })

  it('refuses an item for another rig and one whose licence forbids personal use', () => {
    const s = setup()
    s.catalog.add({ id: 'outfit.mh-only', kind: 'outfit', name: 'MH only', locator: 'w/mh', slots: ['outerwear'], hides: ['torso'], rigFamilies: ['metahuman'], license: LIC })
    const r = s.wardrobe.equip(s.id, 'outfit.mh-only')
    expect(!r.ok && r.error).toMatch(/does not fit a vrm1 rig/)
    s.catalog.add({ id: 'outfit.locked', kind: 'outfit', name: 'Locked', locator: 'w/l', slots: ['outerwear'], hides: ['torso'], license: { id: 'EULA', personalUse: false, commercialUse: false, redistribution: false } })
    const r2 = s.wardrobe.equip(s.id, 'outfit.locked')
    expect(!r2.ok && r2.error).toMatch(/does not permit personal use/)
    s.catalog.add({ id: 'outfit.unk', kind: 'outfit', name: 'Unk', locator: 'w/u', slots: ['outerwear'], hides: ['torso'], license: { id: 'unknown', personalUse: true, commercialUse: true, redistribution: true } })
    expect(s.wardrobe.equip(s.id, 'outfit.unk').ok).toBe(false)
  })

  it('refuses a slot the item cannot use, and an unknown character', () => {
    const s = setup()
    const r = s.wardrobe.equip(s.id, S.blazer, { slot: 'top' })
    expect(!r.ok && r.code).toBe('slot_mismatch')
    expect(s.wardrobe.equip(s.id, S.blazer, { slot: 'outerwear' }).ok).toBe(true)
    expect(s.wardrobe.equip('nobody', S.blazer)).toMatchObject({ ok: false, code: 'not_found' })
  })

  it('equipMany is all or nothing and bounded', () => {
    const s = setup()
    const before = s.eq()
    const r = s.wardrobe.equipMany(s.id, [S.blazer, 'nope'])
    expect(r.ok).toBe(false)
    expect(s.eq()).toEqual(before)
    expect(s.wardrobe.equipMany(s.id, []).ok).toBe(false)
    expect(s.wardrobe.equipMany(s.id, Array(20).fill(S.blazer)).ok).toBe(false)
    expect(s.wardrobe.equipMany(s.id, [5 as unknown as string]).ok).toBe(false)
  })

  it('works on every rig family', () => {
    for (const rig of ['vrm1', 'metahuman', 'cc5'] as const) {
      const s = setup(rig)
      expect(s.wardrobe.equip(s.id, S.coat).ok).toBe(true)
      expect(s.wardrobe.equip(s.id, S.gloves).ok).toBe(true)
    }
  })

  it('sends one atomic character.outfit when many slots change, in removal-first order otherwise', () => {
    const s = setup()
    const r = s.wardrobe.equipMany(s.id, [S.jumpsuit, S.bracers, S.earrings, S.blazer])
    expect(r.ok && r.value.commands).toHaveLength(1)
    expect(r.ok && r.value.commands[0]!.type).toBe('character.outfit')
    const s2 = setup()
    const r2 = s2.wardrobe.equip(s2.id, S.jumpsuit)
    const types = r2.ok ? r2.value.commands.map((c) => (c as { assetId: string | null }).assetId) : []
    expect(types.slice(0, 2)).toEqual([null, null]) // shirt and trousers come off first
    expect(types[2]).toBe(S.jumpsuit)
  })
})

describe('unequip and the clothed baseline', () => {
  it('refuses to take off a top or a bottom or a full-body item (the figure stays clothed)', () => {
    const s = setup()
    for (const slot of ['top', 'bottom'] as const) {
      const r = s.wardrobe.unequip(s.id, slot)
      expect(!r.ok && r.code).toBe('baseline')
      expect(!r.ok && r.error).toMatch(/full outfit/)
    }
    s.wardrobe.equip(s.id, S.jumpsuit)
    expect(s.wardrobe.unequip(s.id, 'fullBody').ok).toBe(false)
    expect(isClothedBaseline(s.eq())).toBe(true)
  })
  it('allows taking off outerwear, accessories, footwear and hair', () => {
    const s = setup()
    s.wardrobe.equip(s.id, S.blazer)
    s.wardrobe.equip(s.id, 'hair.vrm1.low-braid')
    for (const slot of ['outerwear', 'footwear', 'hair'] as const) {
      const r = s.wardrobe.unequip(s.id, slot)
      expect(r.ok).toBe(true)
      expect(s.eq()[slot]).toBeNull()
    }
    expect(isClothedBaseline(s.eq())).toBe(true)
  })
  it('unequipping an empty slot is a no-op; an invalid slot is rejected', () => {
    const s = setup()
    const r = s.wardrobe.unequip(s.id, 'gloves')
    expect(r.ok && r.value.unchanged).toBe(true)
    expect(s.wardrobe.unequip(s.id, 'nonsense' as never).ok).toBe(false)
    expect(s.wardrobe.unequip('nobody', 'gloves').ok).toBe(false)
  })
  it('the service never persists an unclothed state, whatever sequence of operations runs (property test)', () => {
    const s = setup()
    const rnd = lcg(2026)
    const wearables = s.catalog.list({ kind: ['outfit', 'accessory', 'hair'], rig: 'vrm1' }).map((a) => a.id)
    for (let i = 0; i < 600; i++) {
      const roll = rnd()
      if (roll < 0.45) s.wardrobe.equip(s.id, wearables[Math.floor(rnd() * wearables.length)]!, { autoFill: rnd() < 0.6 })
      else if (roll < 0.7) s.wardrobe.unequip(s.id, ALL_SLOTS[Math.floor(rnd() * ALL_SLOTS.length)]!)
      else if (roll < 0.85) {
        const ids = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => wearables[Math.floor(rnd() * wearables.length)]!)
        s.wardrobe.equipMany(s.id, ids, { autoFill: rnd() < 0.5 })
      } else {
        const p = SEED_OUTFIT_PRESETS[Math.floor(rnd() * SEED_OUTFIT_PRESETS.length)]!
        s.wardrobe.applyPreset(s.id, p.id)
      }
      const e = s.eq()
      expect(isClothedBaseline(e)).toBe(true)
      expect(validateEquipped(e, s.catalog, 'vrm1')).toEqual([])
      expect(e.fullBody && (e.top || e.bottom)).toBeFalsy()
      expect(Object.keys(e)).toHaveLength(16)
    }
  })
})

describe('hidden-region masks', () => {
  it('is the union of what everything worn hides, in canonical order', () => {
    const s = setup()
    const c = s.catalog
    expect(computeHiddenRegions(emptyEquipped(), c)).toEqual([])
    expect(computeHiddenRegions(normalizeEquipped({ footwear: S.boots }), c)).toEqual(['feet'])
    expect(computeHiddenRegions(normalizeEquipped({ top: S.trainingTop, bottom: S.leggings, gloves: S.gloves }), c)).toEqual(['torso', 'arms', 'hands', 'legs'])
    expect(s.wardrobe.hiddenRegions(s.id)).toEqual(['torso', 'arms', 'legs', 'feet', 'neck'])
    expect(s.wardrobe.hiddenRegions('nobody')).toEqual([])
  })
  it('a multi-slot item counts once and unknown ids are ignored', () => {
    const s = setup()
    const eq = normalizeEquipped({ top: 'ghost', outerwear: S.coat })
    expect(computeHiddenRegions(eq, s.catalog)).toEqual(['torso', 'arms', 'legs'])
  })
})

describe('presets', () => {
  it('every seed preset applies on every rig and always ends fully clothed', () => {
    for (const rig of ['vrm1', 'metahuman', 'cc5'] as const) {
      const s = setup(rig)
      for (const p of SEED_OUTFIT_PRESETS) {
        const r = s.wardrobe.applyPreset(s.id, p.id)
        expect(r.ok, `${rig} ${p.id}: ${!r.ok ? r.error : ''}`).toBe(true)
        expect(isClothedBaseline(s.eq())).toBe(true)
        expect(s.wardrobe.currentPresetId(s.id)).toBe(p.id)
      }
    }
  })
  it('seed presets only use tasteful wardrobe items and never an unclothed combination', () => {
    for (const p of SEED_OUTFIT_PRESETS) {
      expect(isClothedBaseline(normalizeEquipped(p.equipped))).toBe(true)
      expect(Object.keys(p.equipped)).toHaveLength(16)
    }
  })
  it('apply sends one character.outfit with the full target and the assets', () => {
    const s = setup()
    const r = s.wardrobe.applyPreset(s.id, 'preset.meeting', { source: 'director' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.commands).toHaveLength(1)
    const cmd = r.value.commands[0] as { type: string; preset: { id: string; equipped: Record<string, string | null> }; assets: Array<{ id: string }> }
    expect(cmd.type).toBe('character.outfit')
    expect(cmd.preset.id).toBe('preset.meeting')
    expect(cmd.preset.equipped.outerwear).toBe(S.blazer)
    expect(cmd.assets.map((a) => a.id)).toContain(S.blazer)
    expect(s.changes.at(-1)).toMatchObject({ source: 'director', presetId: 'preset.meeting' })
  })
  it('re-applying the current preset still reports a change event for the director', () => {
    const s = setup()
    s.wardrobe.applyPreset(s.id, 'preset.work')
    const r = s.wardrobe.applyPreset(s.id, 'preset.work')
    expect(r.ok && r.value.changes).toEqual([])
    expect(r.ok && r.value.commands).toHaveLength(1)
  })
  it('keeps her hair when the preset does not specify one, and takes the preset hair when it does', () => {
    const s = setup()
    s.wardrobe.equip(s.id, 'hair.vrm1.sleek-tail')
    s.wardrobe.applyPreset(s.id, 'preset.training')
    expect(s.eq().hair).toBe('hair.vrm1.sleek-tail')
    s.wardrobe.equip(s.id, 'hair.vrm1.short-crop')
    const saved = s.wardrobe.savePreset(s.id, 'Crop day')
    s.wardrobe.equip(s.id, 'hair.vrm1.low-braid')
    s.wardrobe.applyPreset(s.id, saved.ok ? saved.value.id : '')
    expect(s.eq().hair).toBe('hair.vrm1.short-crop')
    expect(applyPresetToEquipped(normalizeEquipped({ hair: 'a' }), { equipped: emptyEquipped() }).hair).toBe('a')
  })
  it('saves the current look with unique ids, context and validated tweaks; overwrites by id', () => {
    const s = setup()
    s.wardrobe.equip(s.id, S.blazer)
    const a = s.wardrobe.savePreset(s.id, 'Board day', { context: { activity: ['meeting'] }, tweaks: { [S.blazer]: { color: '#223344', fit: 0.1 } } })
    expect(a.ok).toBe(true)
    if (!a.ok) return
    expect(a.value.id).toBe('preset.board-day')
    expect(a.value.tweaks[S.blazer]).toEqual({ color: '#223344', fit: 0.1 })
    expect(a.value.equipped.outerwear).toBe(S.blazer)
    const b = s.wardrobe.savePreset(s.id, 'Board day')
    expect(b.ok && b.value.id).toBe('preset.board-day-2')
    const c = s.wardrobe.savePreset(s.id, 'Board day v3', { id: 'preset.board-day' })
    expect(c.ok && c.value.id).toBe('preset.board-day')
    expect(s.wardrobe.listPresets(s.id).filter((p) => p.id === 'preset.board-day')).toHaveLength(1)
    expect(s.wardrobe.listPresets(s.id).find((p) => p.id === 'preset.board-day')!.name).toBe('Board day v3')
  })
  it.each([
    ['empty name', '  ', {}],
    ['unsafe id', 'X', { id: '../x' }],
    ['tweak for an item not worn', 'X', { tweaks: { [S.coat]: { color: '#fff' } } }],
    ['tweak for a missing param', 'X', { tweaks: { [S.shirt]: { nope: 1 } } }],
    ['tweak with a bad colour', 'X', { tweaks: { [S.shirt]: { color: 'blue' } } }],
    ['tweak with a prototype key', 'X', { tweaks: JSON.parse('{"__proto__":{"a":1}}') }],
    ['bad context', 'X', { context: { activity: ['party'] } }],
  ])('rejects a preset with %s', (_n, name, opts) => {
    const s = setup()
    const before = s.wardrobe.listPresets(s.id).length
    expect(s.wardrobe.savePreset(s.id, name, opts as never).ok).toBe(false)
    expect(s.wardrobe.listPresets(s.id)).toHaveLength(before)
  })
  it('clamps tweak values into the asset parameter range', () => {
    const s = setup()
    const r = s.wardrobe.savePreset(s.id, 'Loose', { tweaks: { [S.shirt]: { fit: 5 } } })
    expect(r.ok && r.value.tweaks[S.shirt]).toEqual({ fit: 0.3 })
  })
  it('caps the number of presets', () => {
    const s = setup()
    let last
    for (let i = 0; i < 30; i++) last = s.wardrobe.savePreset(s.id, `Look ${i}`)
    expect(last && !last.ok && last.code).toBe('too_many_presets')
    expect(s.wardrobe.listPresets(s.id).length).toBe(24)
  })
  it('refuses to apply a preset whose items are gone, without changing anything', () => {
    const s = setup()
    s.catalog.remove(S.blazer)
    const before = s.eq()
    const r = s.wardrobe.applyPreset(s.id, 'preset.meeting')
    expect(!r.ok && r.code).toBe('invalid_preset')
    expect(s.eq()).toEqual(before)
    expect(s.wardrobe.applicablePresets(s.id).some((p) => p.id === 'preset.meeting')).toBe(false)
    expect(s.wardrobe.checkPreset(s.id, SEED_OUTFIT_PRESETS.find((p) => p.id === 'preset.meeting')!)[0]).toMatch(/not in the catalog/)
    expect(s.wardrobe.applyPreset(s.id, 'preset.nope')).toMatchObject({ ok: false, code: 'preset_not_found' })
  })
  it('deletes presets', () => {
    const s = setup()
    expect(s.wardrobe.deletePreset(s.id, 'preset.work').ok).toBe(true)
    expect(s.wardrobe.deletePreset(s.id, 'preset.work')).toMatchObject({ ok: false, code: 'preset_not_found' })
    expect(s.wardrobe.listPresets(s.id).some((p) => p.id === 'preset.work')).toBe(false)
  })
  it('describes the look in words', () => {
    const s = setup()
    s.wardrobe.equip(s.id, S.blazer)
    expect(s.wardrobe.describeLook(s.id)).toBe('Crisp shirt, Tailored trousers, Tailored blazer, Ankle boots')
    expect(s.wardrobe.describeLook('nobody')).toBe('unknown character')
  })
  it('classes exist and the factory builds them', () => {
    const s = setup()
    expect(s.wardrobe).toBeInstanceOf(WardrobeService)
    expect(new OutfitDirector({ clock: s.vt.clock })).toBeInstanceOf(OutfitDirector)
    expect(seedBaseId('vrm1')).toBe('base.vrm1.composed')
  })
})

describe('change sources', () => {
  it('reports the source of every committed change', () => {
    const s = setup()
    const sources: ChangeSource[] = ['user', 'assistant', 'director']
    for (const src of sources) {
      s.wardrobe.equip(s.id, src === 'user' ? S.blazer : src === 'assistant' ? S.coat : S.blazer, { source: src })
    }
    expect(s.changes.map((c) => c.source)).toEqual(sources)
  })
})
