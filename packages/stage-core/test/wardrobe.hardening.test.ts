import { describe, expect, it } from 'vitest'
import {
  ALL_SLOTS,
  AssetCatalog,
  AssetManifest,
  SEED_IDS as S,
  SEED_OUTFIT_PRESETS,
  baselineEquipped,
  completeBaseline,
  coverageProblem,
  coverageProblems,
  createWardrobeService,
  emptyEquipped,
  isClothedBaseline,
  isFullyClothed,
  normalizeEquipped,
  pickBaseline,
  seedBaseId,
  validateEquipped,
} from '../src'
import type { AssetManifestInput, WardrobeChange } from '../src'
import { LIC, lcg, makeAssistant, makeWorld } from './helpers'

/**
 * Regression tests for the wardrobe findings: the clothed baseline is about BODY COVERAGE, not slot occupancy (an
 * accessory or a piece that hides nothing never counts), the default look comes only from vetted assets (a free
 * "baseline" tag means nothing), restore never saves an unclothed state, and preset tweaks are validated like any input.
 */

const wear = (id: string, slots: string[], hides: string[], over: Record<string, unknown> = {}): AssetManifestInput =>
  ({ id, kind: 'outfit', name: id, locator: `w/${id}`, slots, hides, tags: [], license: LIC, ...over }) as AssetManifestInput

function setup() {
  const w = makeAssistant()
  const changes: WardrobeChange[] = []
  const wardrobe = createWardrobeService({ characters: w.characters, catalog: w.catalog, newId: w.newId, onChange: (c) => changes.push(c) })
  return { ...w, wardrobe, changes, id: w.assistant.id, eq: () => w.characters.get(w.assistant.id)!.equipped }
}

describe('clothed means covered, not "a slot is occupied" (MEDIUM: wardrobe-baseline-by-slot-not-coverage)', () => {
  it('an accessory can never occupy top, bottom or fullBody (the reported REST case is refused at registration)', () => {
    const cat = new AssetCatalog()
    for (const slot of ['top', 'bottom', 'fullBody']) {
      const r = AssetManifest.safeParse({ id: `acc.${slot}`, kind: 'accessory', name: 'x', locator: 'a/x', slots: [slot], hides: [], license: LIC })
      expect(r.success, slot).toBe(false)
      expect(!r.success && r.error.issues.map((i) => i.message).join(' ')).toMatch(/only an outfit can occupy the top, bottom or fullBody slot/)
      expect(cat.add({ id: `acc.${slot}`, kind: 'accessory', name: 'x', locator: 'a/x', slots: [slot], hides: [], license: LIC }).ok).toBe(false)
    }
    // hair is restricted to its own slot as before, accessories keep their own slots
    expect(AssetManifest.safeParse({ id: 'acc.ok', kind: 'accessory', name: 'x', locator: 'a/x', slots: ['neck', 'wristwear'], hides: [], license: LIC }).success).toBe(true)
  })

  it('an OUTFIT that hides nothing may be registered, but it never counts as clothing: equipping it is refused and nothing changes', () => {
    const s = setup()
    s.catalog.add(wear('outfit.sheer-top', ['top'], []))
    s.catalog.add(wear('outfit.sheer-all', ['fullBody'], []))
    s.catalog.add(wear('outfit.half-all', ['fullBody'], ['torso'])) // covers the torso only
    s.catalog.add(wear('outfit.arms-top', ['top'], ['arms', 'neck'])) // not the torso
    s.catalog.add(wear('outfit.legs-top', ['top'], ['legs'])) // covers the wrong region
    const before = s.eq()
    for (const id of ['outfit.sheer-top', 'outfit.sheer-all', 'outfit.half-all', 'outfit.arms-top', 'outfit.legs-top']) {
      for (const autoFill of [true, false]) {
        const r = s.wardrobe.equip(s.id, id, { autoFill })
        expect(r.ok, `${id} autoFill=${autoFill}`).toBe(false)
        expect(!r.ok && r.code).toBe('baseline')
        expect(!r.ok && r.error).toMatch(/clothed baseline/)
        expect(s.eq()).toEqual(before)
      }
    }
  })

  it('a covering piece in the right slot is fine (and so is a full-body item that covers both)', () => {
    const s = setup()
    s.catalog.add(wear('outfit.good-top', ['top'], ['torso', 'arms']))
    s.catalog.add(wear('outfit.good-all', ['fullBody'], ['torso', 'legs']))
    expect(s.wardrobe.equip(s.id, 'outfit.good-top').ok).toBe(true)
    expect(s.wardrobe.equip(s.id, 'outfit.good-all').ok).toBe(true)
    expect(isFullyClothed(s.eq(), s.catalog)).toBe(true)
  })

  it('a non-covering top cannot replace the covering one even through equipMany, a preset or a character create', () => {
    const s = setup()
    s.catalog.add(wear('outfit.sheer-top', ['top'], []))
    expect(s.wardrobe.equipMany(s.id, ['outfit.sheer-top', S.trousers]).ok).toBe(false)
    const eq = { ...emptyEquipped(), top: 'outfit.sheer-top', bottom: S.trousers }
    const made = s.characters.create({ name: 'X', baseAssetId: seedBaseId('vrm1'), equipped: eq })
    expect(!made.ok && made.code).toBe('invalid_equipped')
    s.characters.setPresets(s.id, [...s.characters.get(s.id)!.presets, { id: 'preset.sheer', name: 'Sheer', equipped: eq, tweaks: {}, context: {} }])
    const r = s.wardrobe.applyPreset(s.id, 'preset.sheer')
    expect(!r.ok && r.code).toBe('invalid_preset')
    expect(s.wardrobe.applicablePresets(s.id).some((p) => p.id === 'preset.sheer')).toBe(false)
  })

  it('coverageProblem / coverageProblems / isFullyClothed on examples', () => {
    const s = setup()
    const shirt = s.catalog.get(S.shirt)!
    expect(coverageProblem(shirt, 'top')).toBeUndefined()
    expect(coverageProblem(shirt, 'bottom')).toMatch(/does not cover the legs/)
    expect(coverageProblem(shirt, 'fullBody')).toMatch(/legs/)
    expect(coverageProblem(shirt, 'outerwear')).toBeUndefined() // other slots have no coverage duty
    expect(coverageProblem({ ...shirt, kind: 'accessory' }, 'top')).toMatch(/only an outfit/)
    expect(coverageProblems(s.eq(), s.catalog)).toEqual([])
    expect(isFullyClothed(s.eq(), s.catalog)).toBe(true)
    // slot-wise "clothed" but a slot holds something that is not in the catalog: the slot rule alone is satisfied
    const ghost = normalizeEquipped({ top: 'ghost', bottom: S.trousers })
    expect(isClothedBaseline(ghost)).toBe(true)
    expect(validateEquipped(ghost, s.catalog, 'vrm1').map((i) => i.message).join(' ')).toMatch(/not in the catalog/)
  })

  it('every seed preset and the default look are fully clothed by coverage on every rig', () => {
    for (const rig of ['vrm1', 'metahuman', 'cc5'] as const) {
      const w = makeWorld()
      for (const p of SEED_OUTFIT_PRESETS) expect(isFullyClothed(normalizeEquipped(p.equipped), w.catalog), `${rig} ${p.id}`).toBe(true)
      const eq = baselineEquipped(w.catalog, rig)
      expect(eq && isFullyClothed(eq, w.catalog)).toBe(true)
    }
  })

  it('property: whatever hostile pieces are registered, no sequence of operations leaves her uncovered (coverage, not slot occupancy)', () => {
    const s = setup()
    // pieces a hostile manifest author could register: outfits that hide nothing, hide the wrong thing, tag themselves "baseline"
    s.catalog.add(wear('a-hijack.top', ['top'], [], { tags: ['baseline'] }))
    s.catalog.add(wear('a-hijack.bottom', ['bottom'], [], { tags: ['baseline'] }))
    s.catalog.add(wear('a-hijack.full', ['fullBody'], [], { tags: ['baseline'] }))
    s.catalog.add(wear('z.torso-only', ['fullBody'], ['torso']))
    s.catalog.add(wear('z.legs-top', ['top'], ['legs']))
    s.catalog.add(wear('z.dress', ['top', 'bottom'], ['torso', 'legs']))
    s.catalog.add({ id: 'z.ring', kind: 'accessory', name: 'ring', locator: 'a/r', slots: ['wristwear'], hides: [], license: LIC } as AssetManifestInput)
    const rnd = lcg(404)
    const wearables = s.catalog.list({ kind: ['outfit', 'accessory', 'hair'], rig: 'vrm1' }).map((a) => a.id)
    let accepted = 0
    for (let i = 0; i < 1500; i++) {
      const roll = rnd()
      if (roll < 0.4) s.wardrobe.equip(s.id, wearables[Math.floor(rnd() * wearables.length)]!, { autoFill: rnd() < 0.6 })
      else if (roll < 0.6) s.wardrobe.unequip(s.id, ALL_SLOTS[Math.floor(rnd() * ALL_SLOTS.length)]!)
      else if (roll < 0.8) {
        const ids = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => wearables[Math.floor(rnd() * wearables.length)]!)
        s.wardrobe.equipMany(s.id, ids, { autoFill: rnd() < 0.5 })
      } else s.wardrobe.applyPreset(s.id, SEED_OUTFIT_PRESETS[Math.floor(rnd() * SEED_OUTFIT_PRESETS.length)]!.id)
      const e = s.eq()
      expect(isFullyClothed(e, s.catalog), JSON.stringify(e)).toBe(true)
      expect(validateEquipped(e, s.catalog, 'vrm1')).toEqual([])
      if (e.top === 'z.dress' || e.fullBody === 'z.torso-only') accepted++
    }
    expect(accepted).toBeGreaterThanOrEqual(0)
    // none of the hijackers ever ended up on her
    expect(Object.values(s.eq()).some((v) => typeof v === 'string' && v.startsWith('a-hijack'))).toBe(false)
  })
})

describe('the default look comes only from vetted assets (MEDIUM: wardrobe-baseline-tag-hijack)', () => {
  const hijackers = (): AssetManifestInput[] => [
    wear('a-hijack.top', ['top'], ['torso', 'arms'], { tags: ['baseline'] }),
    wear('a-hijack.bottom', ['bottom'], ['legs'], { tags: ['baseline'] }),
    wear('a-hijack.shoes', ['footwear'], ['feet'], { tags: ['baseline'] }),
  ]
  it('registered assets named so that they sort first, tagged "baseline", are never picked for a new character or an auto-fill', () => {
    const w = makeWorld()
    for (const h of hijackers()) expect(w.catalog.add(h).ok).toBe(true)
    expect(pickBaseline(w.catalog, 'vrm1')).toEqual({ top: S.shirt, bottom: S.trousers, footwear: S.boots })
    const made = w.characters.create({ name: 'N', baseAssetId: seedBaseId('vrm1') })
    expect(made.ok && made.value.equipped).toMatchObject({ top: S.shirt, bottom: S.trousers, footwear: S.boots })
    const comp = completeBaseline({ ...emptyEquipped(), outerwear: S.coat }, w.catalog, 'vrm1')
    expect(comp?.equipped).toMatchObject({ top: S.shirt, bottom: S.trousers })
  })
  it('with the seed baseline gone there is no default look at all (the tag is not a fallback)', () => {
    const w = makeWorld()
    for (const h of hijackers()) w.catalog.add(h)
    for (const a of w.catalog.list({ tags: ['baseline'] })) if (w.catalog.isVetted(a.id)) w.catalog.remove(a.id)
    expect(pickBaseline(w.catalog, 'vrm1')).toBeUndefined()
    expect(w.characters.create({ name: 'N', baseAssetId: seedBaseId('vrm1') })).toMatchObject({ ok: false, code: 'no_baseline' })
  })
  it('the owner can vet an asset (that is how a content pack would supply a baseline), and it must still cover its slot', () => {
    const w = makeWorld()
    for (const a of w.catalog.list({ tags: ['baseline'] })) w.catalog.remove(a.id)
    w.catalog.add(wear('pack.shirt', ['top'], ['torso'], { tags: ['baseline'] }), { vetted: true })
    w.catalog.add(wear('pack.trousers', ['bottom'], ['legs'], { tags: ['baseline'] }), { vetted: true })
    expect(pickBaseline(w.catalog, 'vrm1')).toEqual({ top: 'pack.shirt', bottom: 'pack.trousers' })
    // vetted but not covering: skipped
    w.catalog.add(wear('aaa.vetted-sheer', ['top'], [], { tags: ['baseline'] }), { vetted: true })
    expect(pickBaseline(w.catalog, 'vrm1')?.top).toBe('pack.shirt')
    // vetted, covering, but tagged for another rig only: not picked for vrm1
    w.catalog.add(wear('aaa.mh-top', ['top'], ['torso'], { tags: ['baseline'], rigFamilies: ['metahuman'] }), { vetted: true })
    expect(pickBaseline(w.catalog, 'vrm1')?.top).toBe('pack.shirt')
    expect(pickBaseline(w.catalog, 'metahuman')?.top).toBe('aaa.mh-top')
  })
  it('a vetted baseline asset whose licence forbids personal use is not picked either', () => {
    const w = makeWorld()
    const shirt = w.catalog.get(S.shirt)!
    w.catalog.add({ ...shirt, license: { id: 'EULA', personalUse: false, commercialUse: false, redistribution: false } }, { replace: true, vetted: true })
    expect(pickBaseline(w.catalog, 'vrm1')).toBeUndefined() // no other vetted baseline top exists
  })
})

describe('restore re-establishes a clothed state or refuses (MEDIUM: wardrobe-restore-leaves-unclothed)', () => {
  it('a stored piece that no longer covers (its manifest changed) is cleared and the vetted default refills the slot', () => {
    const w = makeAssistant()
    w.catalog.add(wear('outfit.mine', ['top'], ['torso']), { vetted: false })
    const cur = w.characters.get(w.assistant.id)!
    w.repo.save({ ...cur, equipped: { ...cur.equipped, top: 'outfit.mine' } })
    w.catalog.add(wear('outfit.mine', ['top'], []), { replace: true }) // the manifest is replaced by one that hides nothing
    const rep = w.characters.restore()
    expect(rep.repaired.map((r) => `${r.slot}:${r.reason}`)).toEqual([expect.stringMatching(/^top:.*does not cover the torso/)])
    const after = w.characters.get(w.assistant.id)!
    expect(after.equipped.top).toBe(S.shirt)
    expect(isFullyClothed(after.equipped, w.catalog)).toBe(true)
    expect(rep.problems).toEqual([])
  })

  it('property: many runs of random catalog damage then restore: the stored look is always either fully clothed or exactly as it was', () => {
    const rnd = lcg(31)
    let failedClosed = 0
    let repairedAndSaved = 0
    for (let run = 0; run < 400; run++) {
      const w = makeAssistant()
      const wardrobe = createWardrobeService({ characters: w.characters, catalog: w.catalog, newId: w.newId })
      // dress her in some seed pieces
      for (const id of [S.blazer, S.gloves, S.bracers, S.earrings, S.jumpsuit, S.trainingTop, S.leggings, S.coat]) if (rnd() < 0.5) wardrobe.equip(w.assistant.id, id)
      const before = w.characters.get(w.assistant.id)!
      // damage the catalog: remove or un-licence random pieces, including the baseline ones
      for (const a of w.catalog.list({ kind: ['outfit', 'accessory'] })) {
        const roll = rnd()
        if (roll < 0.15) w.catalog.remove(a.id)
        else if (roll < 0.3) w.catalog.add({ ...a, license: { id: 'EULA', personalUse: false, commercialUse: false, redistribution: false } }, { replace: true, vetted: true })
        else if (roll < 0.4) w.catalog.add({ ...a, hides: [] }, { replace: true, vetted: true })
      }
      const rep = w.characters.restore()
      const after = w.characters.get(w.assistant.id)!
      // valid = every piece exists, fits, is licensed and the body is covered; anything else must have been left alone and reported
      const valid = validateEquipped(after.equipped, w.catalog, 'vrm1').length === 0
      if (!valid) {
        failedClosed++
        // fail closed: nothing was saved, the problem is reported and a stage is never told
        expect(after.equipped, `run ${run}`).toEqual(before.equipped)
        expect(rep.problems.some((p) => /clothed baseline/.test(p.message)), `run ${run}`).toBe(true)
        expect(w.characters.loadCommand(w.assistant.id).ok, `run ${run}`).toBe(false)
      } else {
        if (rep.repaired.length > 0) repairedAndSaved++
        expect(isFullyClothed(after.equipped, w.catalog), `run ${run}`).toBe(true)
        expect(w.characters.loadCommand(w.assistant.id).ok, `run ${run}`).toBe(true)
      }
      // and never a slot-wise unclothed state
      expect(isClothedBaseline(after.equipped), `run ${run}`).toBe(true)
    }
    // both outcomes really happen in this run, so the property is not vacuous
    expect(failedClosed).toBeGreaterThan(20)
    expect(repairedAndSaved).toBeGreaterThan(20)
  })
})

describe('preset tweaks are validated like any other input (LOW: wardrobe-savepreset-hostile-tweaks)', () => {
  const HOSTILE: Array<[string, unknown]> = [
    ['an inner null', { [S.shirt]: null }],
    ['an inner array', { [S.shirt]: [1, 2] }],
    ['an inner string', { [S.shirt]: 'fit' }],
    ['an inner number', { [S.shirt]: 5 }],
    ['an inner boolean', { [S.shirt]: true }],
    ['a null value', { [S.shirt]: { fit: null } }],
    ['a nested object value', { [S.shirt]: { fit: { a: 1 } } }],
    ['a NaN value', { [S.shirt]: { fit: Number.NaN } }],
    ['an Infinity value', { [S.shirt]: { fit: Number.POSITIVE_INFINITY } }],
    ['a BigInt value', { [S.shirt]: { fit: 5n } }],
    ['a huge string value', { [S.shirt]: { color: '#' + 'a'.repeat(100) } }],
    ['an unknown parameter', { [S.shirt]: { nope: 1 } }],
    ['an unworn asset', { [S.coat]: { color: '#fff' } }],
    ['an unknown asset', { ghost: { fit: 1 } }],
    ['the top-level value null', null],
    ['an array at the top', [1, 2]],
    ['a string at the top', 'tweaks'],
    ['a number at the top', 5],
    ['__proto__', JSON.parse('{"__proto__":{"fit":1}}')],
    ['constructor', JSON.parse(`{"${S.shirt}":{"constructor":1}}`)],
  ]
  it.each(HOSTILE)('savePreset refuses %s with a result, never a throw, and saves nothing', (_n, tweaks) => {
    const s = setup()
    const before = s.wardrobe.listPresets(s.id).length
    let r: ReturnType<typeof s.wardrobe.savePreset> | undefined
    expect(() => {
      r = s.wardrobe.savePreset(s.id, 'Hostile', { tweaks: tweaks as never })
    }).not.toThrow()
    expect(r!.ok).toBe(false)
    expect(s.wardrobe.listPresets(s.id)).toHaveLength(before)
  })

  it('a good tweak still saves, is clamped and cleaned, and survives to the stage command', () => {
    const s = setup()
    const r = s.wardrobe.savePreset(s.id, 'Fitted', { tweaks: { [S.shirt]: { fit: 7, color: '#ABC' } } })
    expect(r.ok && r.value.tweaks[S.shirt]).toEqual({ fit: 0.3, color: '#aabbcc' })
    const applied = s.wardrobe.applyPreset(s.id, r.ok ? r.value.id : '')
    expect(applied.ok && (applied.value.commands[0] as { preset: { tweaks: unknown } }).preset.tweaks).toEqual({ [S.shirt]: { fit: 0.3, color: '#aabbcc' } })
  })

  it('a stored preset whose tweaks were edited by hand is refused when applied (and is not offered as applicable)', () => {
    const s = setup()
    const saved = s.wardrobe.savePreset(s.id, 'Fitted', { tweaks: { [S.shirt]: { fit: 0.1 } } })
    if (!saved.ok) throw new Error(saved.error)
    const edits: Array<[string, unknown]> = [
      ['null inner', { [S.shirt]: null }],
      ['unknown param', { [S.shirt]: { evil: 1 } }],
      ['bad colour', { [S.shirt]: { color: 'javascript:alert(1)' } }],
      ['governed parameter', { [S.shirt]: { 'face.apparent_age': 5 } }],
      ['an asset that is not part of the look', { [S.coat]: { color: '#fff' } }],
    ]
    for (const [label, tweaks] of edits) {
      const cur = s.characters.get(s.id)!
      s.repo.save({ ...cur, presets: cur.presets.map((p) => (p.id === saved.value.id ? { ...p, tweaks: tweaks as never } : p)) })
      const r = s.wardrobe.applyPreset(s.id, saved.value.id)
      expect(r.ok, label).toBe(false)
      expect(!r.ok && r.code, label).toBe('invalid_preset')
      expect(s.wardrobe.applicablePresets(s.id).some((p) => p.id === saved.value.id), label).toBe(false)
      expect(s.wardrobe.checkPreset(s.id, s.characters.get(s.id)!.presets.find((p) => p.id === saved.value.id)!).length, label).toBeGreaterThan(0)
    }
  })
})
