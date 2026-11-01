import { describe, expect, it } from 'vitest'
import {
  ADULT_BOUNDS,
  AssetCatalog,
  AssetManifest,
  GOVERNED_ROLE_IDS,
  NEOTENY_MAX,
  SEED_ASSETS,
  checkOpaqueParams,
  checkParamDeclarations,
  evaluateAdultEnvelope,
  exposesGovernedRole,
  governedAliasOf,
  neotenyScore,
  scalarsOf,
  seedBaseId,
} from '../src'
import type { AssetManifestInput } from '../src'
import { LIC, lcg, makeAssistant, makeWorld, wideBase } from './helpers'

/**
 * Regression tests for the adult-envelope findings: the envelope governs semantic ROLES (not self-asserted ids) for EVERY
 * asset kind, a base that exposes no governed role is refused unless vetted, only own properties are read, and a
 * character that cannot be judged fails closed (restore keeps nothing out-of-envelope that a stage could receive).
 */

const sc = (id: string, min: number, max: number, def: number, group = 'body') => ({ id, group, label: id, min, max, default: def, type: 'scalar' })
const base = (id: string, params: unknown[], over: Record<string, unknown> = {}): AssetManifestInput => wideBase({ id, params, ...over })

describe('aliases of governed roles are refused instead of trusted (MEDIUM: adult-alias-ids-bypass)', () => {
  const alias = (): AssetManifestInput =>
    base('base.alias', [sc('face.age_years', 5, 90, 40, 'face'), sc('body.stature', 0.3, 1.2, 1), sc('face.eye_scale', 0, 3, 1, 'eyes'), sc('body.proportion_kid', 0, 1, 0, 'body')], { adult: true })

  it('the reported base is refused by the catalog and by the manifest schema, each alias named with what to use instead', () => {
    const cat = new AssetCatalog()
    const r = cat.add(alias())
    expect(r.ok).toBe(false)
    const parsed = AssetManifest.safeParse(alias())
    expect(parsed.success).toBe(false)
    const messages = !parsed.success ? parsed.error.issues.map((i) => i.message).join(' | ') : ''
    for (const [id, use] of [['face.age_years', 'face.apparent_age'], ['body.stature', 'body.height_cm'], ['face.eye_scale', 'eyes.size']] as const) {
      expect(messages).toContain(id)
      expect(messages).toContain(use)
    }
    expect(messages).toMatch(/body\.proportion_kid/)
  })

  it.each(['face.age_years', 'body.stature', 'face.eye_scale', 'body.proportion_kid', 'age', 'body.age', 'face.age', 'body.height', 'height_cm', 'head.size', 'body.head_ratio', 'legs.scale', 'leg.length', 'jaw.width', 'face.baby_fat', 'face.round', 'shoulders.width', 'body.scale', 'body.size', 'face.child_like', 'skin.age_spots', 'chibi_factor', 'underage_mode', 'body.kid', 'teen_slider', 'eyes.big'])('"%s" is recognised as a governed role or as youth', (id) => {
    expect(governedAliasOf(id), id).toBeDefined()
  })

  it('the ids the seed bases and wardrobe use are NOT flagged (no false positives on the shipped content)', () => {
    const ids = new Set<string>()
    for (const a of SEED_ASSETS) for (const p of a.params) ids.add(p.id)
    for (const id of ids) expect(governedAliasOf(id), id).toBeUndefined()
    for (const id of ['face.cheekbone_height', 'nose.bridge_height', 'eyes.spacing', 'eyes.tilt', 'makeup.eye_definition', 'mouth.lip_fullness', 'body.neck_length', 'body.waist_width', 'hair.length', 'skin.tone']) expect(governedAliasOf(id), id).toBeUndefined()
    for (const id of Object.keys(ADULT_BOUNDS)) expect(governedAliasOf(id), id).toBeUndefined() // the canonical ids are not aliases of themselves
  })

  it('every canonical id has a role, and the roles map one to one', () => {
    expect(Object.values(GOVERNED_ROLE_IDS).sort()).toEqual(Object.keys(ADULT_BOUNDS).sort())
  })

  it('a parameter SET that carries an alias is not acceptable to the envelope (a value it cannot judge)', () => {
    const r = evaluateAdultEnvelope({ 'face.age_years': 5 })
    expect(r.ok).toBe(false)
    expect(r.violations.join(' ')).toMatch(/face\.age_years.*face\.apparent_age/)
    expect(evaluateAdultEnvelope({ 'face.width': 0.2, 'skin.freckles': 0.1 }).ok).toBe(true)
  })

  it('an opaque slider keeps to -1..1 unless the owner vetted the asset; a vetted asset may use its own units', () => {
    const wide = [sc('face.apparent_age', 25, 65, 40, 'face'), sc('face.width', -1, 1, 0, 'face')]
    const bigUnits = [...wide, sc('face.morph_a', 0, 100, 50, 'face')]
    const cat = new AssetCatalog()
    const r = cat.add(base('base.units', bigUnits))
    expect(!r.ok && r.error).toMatch(/face\.morph_a.*within -1\.\.1/)
    expect(cat.add(base('base.units', bigUnits), { vetted: true }).ok).toBe(true)
    expect(cat.isVetted('base.units')).toBe(true)
    expect(cat.add(base('base.fine', wide)).ok).toBe(true)
    expect(cat.isVetted('base.fine')).toBe(false)
    // colours are exempt, and so are the canonical ids (they have their own bounds)
    expect(checkOpaqueParams([{ id: 'hair.color', group: 'hair', label: 'c', min: 0, max: 16777215, default: 0, type: 'color' }, sc('face.apparent_age', 25, 65, 30)] as never)).toEqual([])
    expect(checkOpaqueParams([sc('x.wide', -1.5, 1, 0)] as never)).toHaveLength(1)
    expect(checkOpaqueParams([sc('x.default', -1, 1, 5)] as never).length).toBe(1) // (a default outside is refused too)
  })

  it('a base that exposes none of the governed ids is refused unless vetted (the old "adult: true is enough" gap)', () => {
    const none = base('base.noids', [sc('face.width', -1, 1, 0, 'face')])
    const cat = new AssetCatalog()
    const r = cat.add(none)
    expect(!r.ok && r.error).toMatch(/at least one governed parameter/)
    expect(cat.has('base.noids')).toBe(false)
    expect(cat.add(none, { vetted: true }).ok).toBe(true)
    expect(exposesGovernedRole([sc('face.width', -1, 1, 0)] as never)).toBe(false)
    expect(exposesGovernedRole([sc('face.apparent_age', 25, 65, 40)] as never)).toBe(true)
    // a colour parameter that merely carries a governed id does not count (and is refused anyway)
    expect(exposesGovernedRole([{ id: 'face.apparent_age', group: 'face', label: 'x', min: 0, max: 16777215, default: 5, type: 'color' }] as never)).toBe(false)
  })

  it('vetting is state of the catalog: no manifest field can ask for it, and replacing an entry drops it', () => {
    const cat = new AssetCatalog()
    expect(cat.add({ ...base('base.sneaky', [sc('face.width', -1, 1, 0)]), vetted: true, trusted: true, source: 'seed' }).ok).toBe(false)
    expect(cat.add(wideBase({ id: 'base.v' }), { vetted: true }).ok).toBe(true)
    expect(cat.isVetted('base.v')).toBe(true)
    expect(cat.add(wideBase({ id: 'base.v' }), { replace: true }).ok).toBe(true)
    expect(cat.isVetted('base.v')).toBe(false)
    expect(cat.add(wideBase({ id: 'base.v' }), { replace: true, vetted: true }).ok).toBe(true)
    cat.remove('base.v')
    expect(cat.isVetted('base.v')).toBe(false)
    expect(cat.isVetted('nope')).toBe(false)
  })
})

describe('every asset kind is held to the same rules (MEDIUM: adult-nonbase-assets-skip-governed-ids)', () => {
  const lic = LIC
  const outfitWith = (params: unknown[], over: Record<string, unknown> = {}): AssetManifestInput =>
    ({ id: 'outfit.evil', kind: 'outfit', name: 'Evil jacket', locator: 'outfits/evil', rigFamilies: ['vrm1'], slots: ['outerwear'], hides: [], tags: ['jacket'], license: lic, params, ...over }) as AssetManifestInput

  it('an outfit, hair, accessory or prop that declares a governed id is refused (the reported outfit with age 1..5 and height 60..90)', () => {
    const cat = new AssetCatalog()
    const evil = outfitWith([sc('face.apparent_age', 1, 5, 3, 'face'), sc('body.height_cm', 60, 90, 70)])
    const r = cat.add(evil)
    expect(!r.ok && r.error).toMatch(/only a character base can declare it/)
    for (const [kind, slots] of [['hair', ['hair']], ['accessory', ['neck']], ['outfit', ['outerwear']], ['prop', []], ['environment', []]] as const) {
      const m = outfitWith([sc('eyes.size', -0.1, 0.1, 0, 'eyes')], { id: `x.${kind}`, kind, slots, hides: [] })
      expect(AssetManifest.safeParse(m).success, kind).toBe(false)
    }
    expect(checkParamDeclarations('outfit', [sc('face.apparent_age', 30, 40, 35)] as never)).toHaveLength(1)
    expect(checkParamDeclarations('character_base', [sc('face.apparent_age', 30, 40, 35)] as never)).toEqual([])
  })

  it('an alias is refused on any kind too, and ordinary outfit parameters are fine', () => {
    expect(AssetManifest.safeParse(outfitWith([sc('body.stature', 0.8, 1.2, 1)])).success).toBe(false)
    expect(AssetManifest.safeParse(outfitWith([sc('fit', -0.3, 0.3, 0), sc('polish', 0, 1, 0.5), { id: 'color', group: 'other', label: 'c', min: 0, max: 16777215, default: 255, type: 'color' }])).success).toBe(true)
    expect(new AssetCatalog().add(outfitWith([sc('sleeve_len', 0, 80, 40, 'other')])).ok).toBe(false) // opaque and not within -1..1
    expect(new AssetCatalog().add(outfitWith([sc('sleeve_len', 0, 80, 40, 'other')]), { vetted: true }).ok).toBe(true)
  })

})

describe('the envelope reads own data properties only (LOW: adult-inherited-keys-skip-hard-bounds)', () => {
  const proto = { 'face.apparent_age': 5, 'body.height_cm': 90, 'body.head_scale': 1.5 }
  it('governed keys on a PROTOTYPE are refused, never skipped', () => {
    const sneaky = Object.create(proto) as Record<string, unknown>
    expect(evaluateAdultEnvelope(sneaky).ok).toBe(false)
    expect(evaluateAdultEnvelope(sneaky).violations.join(' ')).toMatch(/plain object/)
    expect(evaluateAdultEnvelope({ ...proto }).violations.length).toBeGreaterThanOrEqual(3)
    expect(neotenyScore(sneaky)).toBe(1)
  })
  it.each([
    ['null', null],
    ['an array', [1, 2]],
    ['a Map', new Map()],
    ['a class instance', new (class P { 'face.apparent_age' = 40 })()],
    ['a number', 5],
    ['a string', 'x'],
    ['undefined', undefined],
    ['a Proxy that throws', new Proxy({}, { ownKeys: () => { throw new Error('boom') }, getPrototypeOf: () => { throw new Error('boom') } })],
  ])('non-plain input (%s) is refused without throwing', (_n, input) => {
    expect(() => evaluateAdultEnvelope(input as never)).not.toThrow()
    expect(evaluateAdultEnvelope(input as never).ok).toBe(false)
  })
  it('an accessor property is refused (its value could change between the check and the send)', () => {
    const o = Object.defineProperty({}, 'face.apparent_age', { enumerable: true, get: () => 40 })
    const r = evaluateAdultEnvelope(o)
    expect(r.ok).toBe(false)
    expect(r.violations.join(' ')).toMatch(/not an accessor/)
  })
  it('null-prototype objects and plain objects behave the same (the services build plain ones)', () => {
    const vals = { 'face.apparent_age': 40, 'face.jaw_definition': 0.7, 'body.height_cm': 175 }
    expect(evaluateAdultEnvelope(Object.assign(Object.create(null) as object, vals))).toEqual(evaluateAdultEnvelope(vals))
    expect(evaluateAdultEnvelope(vals).ok).toBe(true)
  })
  it('the youthfulness score and its limit are unchanged for plain input (so the 600k-case oracle still holds)', () => {
    const youthful = { 'eyes.size': 0.4, 'face.roundness': 0.5, 'face.jaw_definition': 0.2, 'body.head_scale': 1.04, 'body.leg_length': -0.2, 'face.apparent_age': 25 }
    expect(neotenyScore(youthful)).toBeCloseTo(1, 10)
    expect(evaluateAdultEnvelope(youthful).ok).toBe(false)
    expect(neotenyScore({})).toBeCloseTo(0.5, 10)
    expect(NEOTENY_MAX).toBe(0.8)
  })
  it('property: random parameter sets agree between plain, null-prototype and copied forms', () => {
    const r = lcg(12)
    const ids = [...Object.keys(ADULT_BOUNDS), 'face.width', 'skin.freckles']
    for (let i = 0; i < 2000; i++) {
      const set: Record<string, unknown> = {}
      for (const id of ids) if (r() < 0.6) set[id] = (ADULT_BOUNDS[id] ? ADULT_BOUNDS[id]!.min - 5 + r() * ((ADULT_BOUNDS[id]!.max - ADULT_BOUNDS[id]!.min) + 10) : r() * 2 - 1)
      expect(evaluateAdultEnvelope(Object.assign(Object.create(null) as object, set))).toEqual(evaluateAdultEnvelope({ ...set }))
    }
  })
})

describe('setParams holds the blend time to 0..5000 ms (LOW: adult-setparams-blendms-unvalidated)', () => {
  it.each([[Number.NaN, 0], [Number.POSITIVE_INFINITY, 5000], [-5, 0], [1e308, 5000], [-1e308, 0], [250, 250], [5000, 5000], [5001, 5000]] as const)('blendMs %s reaches the stage as %s', (given, sent) => {
    const w = makeAssistant()
    const r = w.characters.setParams(w.assistant.id, { 'body.shoulder_width': 0.5 }, given)
    expect(r.ok && r.value.command).toMatchObject({ type: 'character.params', blendMs: sent })
  })
  it('a blend that is not a number at all means "now"', () => {
    const w = makeAssistant()
    const r = w.characters.setParams(w.assistant.id, { 'body.shoulder_width': 0.45 }, 'fast' as never)
    expect(r.ok && r.value.command).toMatchObject({ blendMs: 0 })
  })
})

describe('a character that cannot be judged fails closed (MEDIUM: adult-restore-base-missing-fails-open)', () => {
  const poison = (w: ReturnType<typeof makeAssistant>, extra: Record<string, unknown> = { 'face.apparent_age': 12, 'body.height_cm': 100, 'body.head_scale': 1.4 }) => {
    const cur = w.characters.get(w.assistant.id)!
    w.repo.save({ ...cur, params: { ...cur.params, ...extra } as never })
  }

  it('the reported case: base gone, stored age 12 / height 100 / head 1.4 -> reported, never described to a stage', () => {
    const w = makeAssistant()
    poison(w)
    w.catalog.remove(w.assistant.baseAssetId)
    const rep = w.characters.restore()
    expect(rep.problems.some((p) => /not in the catalog, so she cannot be shown/.test(p.message))).toBe(true)
    const load = w.characters.loadCommand(w.assistant.id)
    expect(load.ok).toBe(false)
    expect(!load.ok && load.code).toBe('base_unusable')
    // nothing about her can be sent: no params command either (it needs the base)
    expect(w.characters.setParams(w.assistant.id, { 'body.shoulder_width': 0.4 }).ok).toBe(false)
    expect(w.characters.check(w.assistant.id)).toMatchObject({ ok: false, code: 'base_unusable' })
    // and nothing out of the envelope is left in her record: the governed values were cleared (the base sets them again)
    const stored = w.characters.get(w.assistant.id)!
    expect(evaluateAdultEnvelope(scalarsOf(stored.params)).ok).toBe(true)
    for (const id of Object.keys(ADULT_BOUNDS)) expect(stored.params[id], id).toBeUndefined()
    expect(rep.problems.some((p) => /governed values were cleared/.test(p.message))).toBe(true)
  })

  it('without a base, a governed value that is not even a number is cleared as well, and a clean record is left alone', () => {
    const w = makeAssistant()
    poison(w, { 'face.apparent_age': '5' })
    w.catalog.remove(w.assistant.baseAssetId)
    w.characters.restore()
    expect(w.characters.get(w.assistant.id)!.params['face.apparent_age']).toBeUndefined()
    const w2 = makeAssistant()
    const before = w2.characters.get(w2.assistant.id)!.params
    w2.catalog.remove(w2.assistant.baseAssetId)
    w2.characters.restore()
    expect(w2.characters.get(w2.assistant.id)!.params).toEqual(before) // in-envelope values are kept: nothing to repair
  })

  it('when the base returns, the cleared governed values come from its defaults and she is shown again', () => {
    const w = makeAssistant()
    const baseManifest = w.catalog.get(w.assistant.baseAssetId)!
    poison(w)
    w.catalog.remove(w.assistant.baseAssetId)
    w.characters.restore()
    w.catalog.add(baseManifest, { vetted: true })
    w.characters.restore()
    const load = w.characters.loadCommand(w.assistant.id)
    expect(load.ok).toBe(true)
    const params = load.ok ? (load.value as { character: { params: Record<string, number> } }).character.params : {}
    expect(params['face.apparent_age']).toBe(34) // the seed default of base.vrm1.composed
    expect(evaluateAdultEnvelope(scalarsOf(params as never)).ok).toBe(true)
  })

  it('with the base present, the poisoned parameters are repaired and she is described again', () => {
    const w = makeAssistant()
    poison(w)
    const rep = w.characters.restore()
    expect(rep.paramsAdjusted.length + rep.problems.length).toBeGreaterThan(0)
    const load = w.characters.loadCommand(w.assistant.id)
    expect(load.ok).toBe(true)
    const params = load.ok ? (load.value as { character: { params: Record<string, number> } }).character.params : {}
    expect(evaluateAdultEnvelope(scalarsOf(params as never)).ok).toBe(true)
    expect(params['face.apparent_age']).toBeGreaterThanOrEqual(28)
  })

  it('a stored combination inside every single range but over the youthfulness limit is reset, not sent', () => {
    const w = makeWorld()
    w.catalog.add(wideBase({ id: 'base.wide2' }), { vetted: true })
    const c = w.characters.create({ name: 'A', baseAssetId: 'base.wide2' })
    if (!c.ok) throw new Error(c.error)
    const cur = w.characters.get(c.value.id)!
    w.repo.save({ ...cur, params: { ...cur.params, 'face.apparent_age': 25, 'face.jaw_definition': 0.2, 'face.roundness': 0.5, 'eyes.size': 0.4, 'body.head_scale': 1.04, 'body.leg_length': -0.2 } as never })
    expect(w.characters.loadCommand(c.value.id).ok).toBe(false) // refused as stored
    const rep = w.characters.restore()
    expect(rep.problems.some((p) => /reset to the base defaults/.test(p.message))).toBe(true)
    expect(w.characters.loadCommand(c.value.id).ok).toBe(true)
  })

  it('when even the base defaults are not acceptable the character is reported, left as it is, and refused', () => {
    const w = makeWorld()
    const params = (def: Record<string, number>) => [
      sc('face.apparent_age', 25, 65, def['face.apparent_age']!, 'face'),
      sc('face.jaw_definition', 0.2, 1, def['face.jaw_definition']!, 'face'),
      sc('face.roundness', -0.6, 0.5, def['face.roundness']!, 'face'),
      sc('eyes.size', -0.4, 0.4, def['eyes.size']!, 'eyes'),
      sc('body.head_scale', 0.9, 1.04, def['body.head_scale']!),
      sc('body.leg_length', -0.2, 0.8, def['body.leg_length']!),
    ]
    const calm = { 'face.apparent_age': 40, 'face.jaw_definition': 0.7, 'face.roundness': -0.1, 'eyes.size': 0, 'body.head_scale': 0.96, 'body.leg_length': 0.3 }
    const corner = { 'face.apparent_age': 25, 'face.jaw_definition': 0.2, 'face.roundness': 0.5, 'eyes.size': 0.4, 'body.head_scale': 1.04, 'body.leg_length': -0.2 }
    w.catalog.add(base('base.shift', params(calm)), { vetted: true })
    const c = w.characters.create({ name: 'C', baseAssetId: 'base.shift' })
    if (!c.ok) throw new Error(c.error)
    // the base manifest is replaced later by one whose DEFAULTS combine to a youthful figure (every one inside its own range)
    w.catalog.add(base('base.shift', params(corner)), { replace: true, vetted: true })
    const cur = w.characters.get(c.value.id)!
    w.repo.save({ ...cur, params: { ...cur.params, ...corner } as never })
    const stored = w.characters.get(c.value.id)
    const rep = w.characters.restore()
    expect(rep.problems.some((p) => /do not satisfy it either/.test(p.message))).toBe(true)
    expect(w.characters.get(c.value.id)!.params).toEqual(stored!.params) // not "repaired" into something else that is also wrong
    expect(w.characters.loadCommand(c.value.id)).toMatchObject({ ok: false, code: 'adult_envelope' })
  })

  it('a base whose licence flipped, or that is no longer an adult base, makes her unusable and restore says so', () => {
    const w = makeAssistant()
    const baseId = w.assistant.baseAssetId
    const b = w.catalog.get(baseId)!
    w.catalog.add({ ...b, license: { id: 'vendor-eula', personalUse: false, commercialUse: false, redistribution: false } }, { replace: true, vetted: true })
    const rep = w.characters.restore()
    expect(rep.problems.some((p) => /can no longer be used/.test(p.message))).toBe(true)
    expect(w.characters.loadCommand(w.assistant.id)).toMatchObject({ ok: false, code: 'base_unusable' })
    // and when it is fixed she is whole again
    w.catalog.add({ ...b }, { replace: true, vetted: true })
    expect(w.characters.loadCommand(w.assistant.id).ok).toBe(true)
  })

  it('the active assistant that cannot be shown is replaced by one that can (and it is reported)', () => {
    const w = makeAssistant()
    const other = w.characters.create({ name: 'Second', baseAssetId: seedBaseId('vrm1', 'poised') })
    if (!other.ok) throw new Error(other.error)
    expect(w.characters.getActive('assistant')?.id).toBe(w.assistant.id)
    w.catalog.remove(w.assistant.baseAssetId) // 'base.vrm1.composed'
    const rep = w.characters.restore()
    expect(w.characters.getActive('assistant')?.id).toBe(other.value.id)
    expect(rep.assistant?.id).toBe(other.value.id)
    expect(rep.problems.some((p) => /is now the active assistant/.test(p.message))).toBe(true)
  })

  it('the stage never receives unknown or stale parameter ids, and the resolved set carries every parameter of the base', () => {
    const w = makeAssistant()
    poison(w, { 'old.slider': 3, 'face.width': 0.2 })
    const load = w.characters.loadCommand(w.assistant.id)
    expect(load.ok).toBe(true)
    const params = load.ok ? (load.value as { character: { params: Record<string, unknown> } }).character.params : {}
    expect(params['old.slider']).toBeUndefined()
    expect(params['face.width']).toBe(0.2)
    expect(Object.keys(params).length).toBe(w.catalog.get(w.assistant.baseAssetId)!.params.length)
  })

  it('a hand-edited stored character with garbage in its parameters is refused as stored', () => {
    const w = makeAssistant()
    for (const bad of [{ 'face.apparent_age': 'young' }, { 'face.apparent_age': null }, { 'body.height_cm': Number.NaN }]) {
      const cur = w.characters.get(w.assistant.id)!
      // a profile row can only hold what the repo accepts; the in-memory repo does not re-validate, like a damaged row would not
      w.repo.save({ ...cur, params: { ...cur.params, ...bad } as never })
      const res = w.characters.loadCommand(w.assistant.id)
      // either refused outright, or the resolved set no longer contains the garbage (it is replaced by the default)
      if (res.ok) {
        const v = (res.value as { character: { params: Record<string, unknown> } }).character.params
        expect(Number.isFinite(v['face.apparent_age'] as number) && Number.isFinite(v['body.height_cm'] as number)).toBe(true)
        expect(evaluateAdultEnvelope(scalarsOf(v as never)).ok).toBe(true)
      }
      w.characters.restore()
    }
  })

  it('unchanged for a healthy character: restore reports nothing and loadCommand describes her as before', () => {
    const w = makeAssistant()
    const before = w.characters.get(w.assistant.id)
    const rep = w.characters.restore()
    expect(rep).toMatchObject({ repaired: [], paramsAdjusted: [], problems: [] })
    expect(w.characters.get(w.assistant.id)).toEqual(before)
    const load = w.characters.loadCommand(w.assistant.id)
    expect(load.ok && (load.value as { character: unknown }).character).toEqual(before)
  })
})
