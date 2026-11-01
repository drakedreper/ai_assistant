import { describe, expect, it } from 'vitest'
import { AUTHORITY_PRESENCE } from '@ai-assistant/shared'
import {
  ADULT_BOUNDS,
  NEOTENY_MAX,
  USER_PRESENCE,
  defaultParams,
  evaluateAdultEnvelope,
  neotenyScore,
  normalizeColor,
  scalarsOf,
  seedBaseId,
  validateParamValue,
  validateParams,
  worstCaseNeoteny,
  isClothedBaseline,
} from '../src'
import { LIC, lcg, makeAssistant, makeWorld, wideBase } from './helpers'

describe('CharacterService.create', () => {
  it('creates the assistant with authority presence, a clothed baseline, seed presets and makes it active', () => {
    const { assistant, characters } = makeAssistant()
    expect(assistant.role).toBe('assistant')
    expect(assistant.rigFamily).toBe('vrm1')
    expect(assistant.presence).toEqual(AUTHORITY_PRESENCE)
    expect(isClothedBaseline(assistant.equipped)).toBe(true)
    expect(assistant.equipped.top).toBe('outfit.crisp-shirt')
    expect(assistant.equipped.bottom).toBe('outfit.tailored-trousers')
    expect(assistant.presets.length).toBeGreaterThanOrEqual(5)
    expect(Object.keys(assistant.equipped)).toHaveLength(16)
    expect(characters.getActive('assistant')?.id).toBe(assistant.id)
    expect(assistant.createdAt).toBe(assistant.updatedAt)
    expect(assistant.voice).toEqual({ provider: 'kokoro', voiceId: 'default', speed: 1, pitchSemitones: 0 })
  })
  it('the user role gets its own default presence and its own active pointer', () => {
    const w = makeAssistant()
    const u = w.characters.create({ name: 'Me', role: 'user', baseAssetId: seedBaseId('vrm1', 'poised') })
    expect(u.ok && u.value.presence).toEqual(USER_PRESENCE)
    expect(w.characters.getActive('user')?.name).toBe('Me')
    expect(w.characters.getActive('assistant')?.name).toBe('Mira')
  })
  it('works for every rig family', () => {
    for (const rig of ['vrm1', 'metahuman', 'cc5'] as const) {
      const w = makeWorld()
      const r = w.characters.create({ name: 'A', baseAssetId: seedBaseId(rig) })
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.value.rigFamily).toBe(rig)
    }
  })
  it.each([
    ['empty name', { name: '   ', baseAssetId: seedBaseId('vrm1') }, 'invalid_input'],
    ['control-only name', { name: '\u0001\u0002', baseAssetId: seedBaseId('vrm1') }, 'invalid_input'],
    ['unknown base', { name: 'A', baseAssetId: 'base.nope' }, 'base_unusable'],
    ['not a base', { name: 'A', baseAssetId: 'outfit.crisp-shirt' }, 'base_unusable'],
    ['wrong rig', { name: 'A', baseAssetId: seedBaseId('vrm1'), rigFamily: 'cc5' }, 'base_unusable'],
    ['unsafe id', { name: 'A', baseAssetId: seedBaseId('vrm1'), id: '../x' }, 'invalid_input'],
    ['bad voice', { name: 'A', baseAssetId: seedBaseId('vrm1'), voice: { provider: 'nope' } }, 'invalid_input'],
    ['bad presence', { name: 'A', baseAssetId: seedBaseId('vrm1'), presence: { uprightness: 3 } }, 'invalid_input'],
    ['unknown param', { name: 'A', baseAssetId: seedBaseId('vrm1'), params: { 'nope.x': 1 } }, 'invalid_params'],
    ['top only (not clothed)', { name: 'A', baseAssetId: seedBaseId('vrm1'), equipped: { top: 'outfit.crisp-shirt' } }, 'invalid_equipped'],
    ['nothing worn', { name: 'A', baseAssetId: seedBaseId('vrm1'), equipped: {} }, 'invalid_equipped'],
    ['unknown outfit', { name: 'A', baseAssetId: seedBaseId('vrm1'), equipped: { top: 'x', bottom: 'y' } }, 'invalid_equipped'],
  ] as const)('refuses %s', (_n, input, code) => {
    const w = makeWorld()
    const r = w.characters.create(input as never)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe(code)
    expect(w.characters.list()).toHaveLength(0)
  })
  it('refuses a base whose licence does not allow personal use', () => {
    const w = makeWorld()
    expect(w.catalog.add(wideBase({ license: { id: 'EULA', personalUse: false, commercialUse: false, redistribution: false } })).ok).toBe(true)
    const r = w.characters.create({ name: 'A', baseAssetId: 'base.wide' })
    expect(!r.ok && r.code).toBe('base_unusable')
  })
  it('refuses duplicate explicit ids and generates unique ones otherwise', () => {
    const w = makeWorld()
    expect(w.characters.create({ name: 'A', baseAssetId: seedBaseId('vrm1'), id: 'mira' }).ok).toBe(true)
    const dup = w.characters.create({ name: 'B', baseAssetId: seedBaseId('vrm1'), id: 'mira' })
    expect(!dup.ok && dup.code).toBe('duplicate')
    const a = w.characters.create({ name: 'C', baseAssetId: seedBaseId('vrm1') })
    const b = w.characters.create({ name: 'D', baseAssetId: seedBaseId('vrm1') })
    expect(a.ok && b.ok && a.value.id !== b.value.id).toBe(true)
  })
  it('fails with no_baseline when the catalog has nothing to wear for that rig', () => {
    const w = makeWorld()
    for (const a of w.catalog.list({ tags: ['baseline'] })) w.catalog.remove(a.id)
    const r = w.characters.create({ name: 'A', baseAssetId: seedBaseId('vrm1') })
    expect(!r.ok && r.code).toBe('no_baseline')
  })
  it('accepts a valid explicit equipped state and drops presets that do not fit', () => {
    const w = makeWorld()
    const r = w.characters.create({
      name: 'A',
      baseAssetId: seedBaseId('vrm1'),
      equipped: { fullBody: 'outfit.utility-jumpsuit', footwear: 'outfit.ankle-boots' },
    })
    expect(r.ok).toBe(true)
    w.catalog.remove('outfit.structured-coat')
    const r2 = w.characters.create({ name: 'B', baseAssetId: seedBaseId('vrm1') })
    expect(r2.ok && r2.value.presets.some((p) => p.id === 'preset.out')).toBe(false)
  })
})

describe('active selection', () => {
  it('has exactly one active assistant; select switches; delete promotes the oldest remaining', () => {
    const w = makeAssistant()
    const second = w.characters.create({ name: 'Second', baseAssetId: seedBaseId('vrm1', 'poised') })
    const third = w.characters.create({ name: 'Third', baseAssetId: seedBaseId('vrm1') })
    expect(w.characters.getActive()?.id).toBe(w.assistant.id)
    if (!second.ok || !third.ok) throw new Error('setup')
    expect(w.characters.select(third.value.id).ok).toBe(true)
    expect(w.characters.getActive()?.id).toBe(third.value.id)
    expect(w.characters.delete(third.value.id).ok).toBe(true)
    expect(w.characters.getActive()?.id).toBe(w.assistant.id)
    expect(w.characters.delete(w.assistant.id).ok).toBe(true)
    expect(w.characters.getActive()?.id).toBe(second.value.id)
    const last = w.characters.delete(second.value.id)
    expect(!last.ok && last.code).toBe('last_assistant')
  })
  it('select and delete of unknown ids report not_found; users can be deleted down to zero', () => {
    const w = makeAssistant()
    expect(w.characters.select('zzz')).toMatchObject({ ok: false, code: 'not_found' })
    expect(w.characters.delete('zzz')).toMatchObject({ ok: false, code: 'not_found' })
    const u = w.characters.create({ name: 'Me', role: 'user', baseAssetId: seedBaseId('vrm1') })
    if (!u.ok) throw new Error('setup')
    expect(w.characters.delete(u.value.id).ok).toBe(true)
    expect(w.characters.getActive('user')).toBeUndefined()
  })
  it('lists by role', () => {
    const w = makeAssistant()
    w.characters.create({ name: 'Me', role: 'user', baseAssetId: seedBaseId('vrm1') })
    expect(w.characters.list()).toHaveLength(2)
    expect(w.characters.list('user')).toHaveLength(1)
    expect(w.characters.list('assistant')).toHaveLength(1)
  })
})

describe('update and morph parameters', () => {
  it('updates name, voice, presence, persona and anchor; stamps updatedAt', () => {
    const w = makeAssistant()
    w.vt.advance(60_000)
    const r = w.characters.update(w.assistant.id, {
      name: '  Vera  ',
      voice: { provider: 'xtts', voiceId: 'v2', speed: 1.1 },
      presence: { ...AUTHORITY_PRESENCE, pace: 0.4 },
      personaId: 'work',
      homeAnchor: 'chair_1',
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.name).toBe('Vera')
    expect(r.value.voice.provider).toBe('xtts')
    expect(r.value.presence.pace).toBe(0.4)
    expect(r.value.homeAnchor).toBe('chair_1')
    expect(r.value.updatedAt > r.value.createdAt).toBe(true)
    const cleared = w.characters.update(w.assistant.id, { homeAnchor: null })
    expect(cleared.ok && cleared.value.homeAnchor).toBeUndefined()
    expect(w.characters.update(w.assistant.id, { voice: { provider: 'x' } }).ok).toBe(false)
    expect(w.characters.update(w.assistant.id, { name: '' }).ok).toBe(false)
    expect(w.characters.update(w.assistant.id, { personaId: '../x' }).ok).toBe(false)
    expect(w.characters.update('nope', {}).ok).toBe(false)
  })

  it('fills defaults, clamps scalars, normalises colours and merges patches', () => {
    const w = makeAssistant()
    const base = w.catalog.get(seedBaseId('vrm1'))!
    expect(w.assistant.params['body.height_cm']).toBe(177)
    expect(w.assistant.params['hair.color']).toBe('#2a1e18')
    const r = w.characters.setParams(w.assistant.id, { 'body.height_cm': 500, 'hair.color': '#ABC', 'face.width': 0.2 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.profile.params['body.height_cm']).toBe(base.params.find((p) => p.id === 'body.height_cm')!.max)
    expect(r.value.profile.params['hair.color']).toBe('#aabbcc')
    expect(r.value.profile.params['face.width']).toBe(0.2)
    expect(r.value.changed.sort()).toEqual(['body.height_cm', 'face.width', 'hair.color'])
    expect(r.value.command).toMatchObject({ type: 'character.params', characterId: w.assistant.id, params: { 'hair.color': '#aabbcc' } })
    const again = w.characters.setParams(w.assistant.id, { 'face.width': 0.2 })
    expect(again.ok && again.value.changed).toEqual([])
    expect(again.ok && again.value.command).toBeUndefined()
    const merged = w.characters.setParams(w.assistant.id, { 'nose.width': 0.1 })
    expect(merged.ok && merged.value.profile.params['face.width']).toBe(0.2)
  })

  it('rejects the whole patch when any entry is invalid and leaves state untouched', () => {
    const w = makeAssistant()
    const before = w.characters.get(w.assistant.id)!
    const r = w.characters.setParams(w.assistant.id, { 'face.width': 0.3, 'nope.x': 1 })
    expect(!r.ok && r.code).toBe('invalid_params')
    expect(w.characters.get(w.assistant.id)).toEqual(before)
  })
})

describe('validateParams (property style)', () => {
  const base = makeWorld().catalog.get(seedBaseId('vrm1'))!
  const defs = new Map(base.params.map((p) => [p.id, p]))

  it.each([
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
    ['string', '0.5'],
    ['null', null],
    ['undefined', undefined],
    ['boolean', true],
    ['object', {}],
    ['array', [1]],
    ['bigint', 1n],
  ])('rejects a %s for a scalar', (_n, v) => {
    expect(validateParams(base, { 'face.width': v }).ok).toBe(false)
  })

  it.each([
    ['named hex', 'red'],
    ['short', '#12'],
    ['no hash', 'aabbcc'],
    ['negative', -1],
    ['too big', 0x1000000],
    ['float', 1.5],
    ['NaN', NaN],
    ['object', {}],
  ])('rejects %s for a colour', (_n, v) => {
    expect(validateParams(base, { 'hair.color': v }).ok).toBe(false)
  })

  it('accepts integer colours', () => {
    const r = validateParams(base, { 'hair.color': 0x336699 })
    expect(r.ok && r.params['hair.color']).toBe('#336699')
    expect(normalizeColor('#FFF')).toBe('#ffffff')
    expect(normalizeColor('#FFFFFF')).toBe('#ffffff')
  })

  it('rejects prototype-pollution keys, including one made by JSON.parse', () => {
    for (const json of ['{"__proto__":1}', '{"constructor":1}', '{"prototype":1}', '{"face.width":0.1,"__proto__":{"x":1}}']) {
      const r = validateParams(base, JSON.parse(json))
      expect(r.ok).toBe(false)
    }
    expect(({} as Record<string, unknown>).x).toBeUndefined()
  })

  it('rejects non-objects and too many keys', () => {
    for (const bad of [null, undefined, 5, 'x', [], [1, 2], new Date(), new Map()]) expect(validateParams(base, bad).ok).toBe(false)
    const many: Record<string, number> = {}
    for (let i = 0; i < 300; i++) many[`p${i}`] = 1
    expect(validateParams(base, many).ok).toBe(false)
  })

  it('never throws and always yields in-range values for random input (fuzz)', () => {
    const rnd = lcg(42)
    const ids = [...defs.keys()]
    const values: unknown[] = [NaN, Infinity, -Infinity, 0, -0, 1e308, -1e308, 'x', '#fff', null, undefined, {}, [], true, 0.5, -2, 999]
    for (let i = 0; i < 2000; i++) {
      const input: Record<string, unknown> = {}
      const n = 1 + Math.floor(rnd() * 5)
      for (let j = 0; j < n; j++) {
        const id = rnd() < 0.1 ? ['__proto__', 'constructor', 'zzz'][Math.floor(rnd() * 3)]! : ids[Math.floor(rnd() * ids.length)]!
        input[id] = rnd() < 0.5 ? (rnd() - 0.5) * 1000 : values[Math.floor(rnd() * values.length)]
      }
      const r = validateParams(base, input)
      if (r.ok) {
        for (const [k, v] of Object.entries(r.params)) {
          const d = defs.get(k)!
          if (d.type === 'color') expect(v).toMatch(/^#[0-9a-f]{6}$/)
          else {
            expect(Number.isFinite(v as number)).toBe(true)
            expect(v as number).toBeGreaterThanOrEqual(d.min)
            expect(v as number).toBeLessThanOrEqual(d.max)
          }
        }
        expect(Object.keys(r.params).sort()).toEqual([...ids].sort())
      }
    }
  })

  it('validateParamValue reports clamping', () => {
    const d = defs.get('face.width')!
    expect(validateParamValue(d, 9)).toEqual({ ok: true, value: d.max, clamped: true })
    expect(validateParamValue(d, 0.1)).toEqual({ ok: true, value: 0.1, clamped: false })
    expect(validateParamValue(d, -0)).toEqual({ ok: true, value: 0, clamped: false })
  })

  it('stale ids in the current set are dropped, not carried', () => {
    const r = validateParams(base, {}, { 'old.slider': 1, 'face.width': 0.2, 'face.roundness': 99 })
    expect(r.ok && 'old.slider' in r.params).toBe(false)
    expect(r.ok && r.params['face.width']).toBe(0.2)
    expect(r.ok && r.params['face.roundness']).toBe(defs.get('face.roundness')!.max) // out-of-range stored values are clamped
  })
})

describe('adult envelope', () => {
  it('seed bases: no slider position can leave the envelope or reach the combined limit (corners + random)', () => {
    const w = makeWorld()
    for (const b of w.catalog.list({ kind: 'character_base' })) {
      expect(worstCaseNeoteny(b.params)).toBeLessThan(NEOTENY_MAX)
      const rnd = lcg(7)
      for (let i = 0; i < 300; i++) {
        const set: Record<string, number> = {}
        for (const p of b.params) if (p.type === 'scalar') set[p.id] = p.min + rnd() * (p.max - p.min)
        const ev = evaluateAdultEnvelope(set)
        expect(ev.violations).toEqual([])
        expect(ev.ok).toBe(true)
      }
      // all extremes of the youthful end
      const youthful: Record<string, number> = {}
      for (const p of b.params) {
        if (p.type !== 'scalar') continue
        const bound = ADULT_BOUNDS[p.id]
        if (!bound) continue
        youthful[p.id] = ['eyes.size', 'face.roundness', 'body.head_scale'].includes(p.id) ? p.max : p.min
      }
      expect(evaluateAdultEnvelope(youthful).ok).toBe(true)
      expect(youthful['face.apparent_age']).toBeGreaterThanOrEqual(25)
      expect(youthful['body.height_cm']).toBeGreaterThanOrEqual(158)
    }
  })

  it('refuses single values outside the hard bounds', () => {
    expect(evaluateAdultEnvelope({ 'face.apparent_age': 19 }).ok).toBe(false)
    expect(evaluateAdultEnvelope({ 'body.height_cm': 140 }).ok).toBe(false)
    expect(evaluateAdultEnvelope({ 'body.head_scale': 1.2 }).violations[0]).toMatch(/outside the adult range/)
    expect(evaluateAdultEnvelope({ 'face.jaw_definition': 0.05 }).ok).toBe(false)
    expect(evaluateAdultEnvelope({ 'eyes.size': 0.9 }).ok).toBe(false)
    expect(evaluateAdultEnvelope({ 'face.apparent_age': NaN }).ok).toBe(false)
    expect(evaluateAdultEnvelope({ 'face.apparent_age': '30' }).ok).toBe(false)
  })

  it('refuses a COMBINATION that is individually in range but together reads childlike', () => {
    const youthfulCombo = {
      'face.apparent_age': 25,
      'face.jaw_definition': 0.2,
      'face.roundness': 0.5,
      'eyes.size': 0.4,
      'body.head_scale': 1.04,
      'body.leg_length': -0.2,
      'body.height_cm': 160,
    }
    for (const [id, v] of Object.entries(youthfulCombo)) {
      expect(evaluateAdultEnvelope({ [id]: v }).ok).toBe(true) // each is fine alone
    }
    const r = evaluateAdultEnvelope(youthfulCombo)
    expect(r.ok).toBe(false)
    expect(r.violations.join(' ')).toMatch(/combined youthfulness/)
    expect(r.neoteny).toBeGreaterThan(NEOTENY_MAX)
  })

  it('the service refuses that combination on a wide third-party base, and accepts a mature one', () => {
    const w = makeWorld()
    expect(w.catalog.add(wideBase()).ok).toBe(true)
    const ok1 = w.characters.create({ name: 'A', baseAssetId: 'base.wide' })
    expect(ok1.ok).toBe(true)
    const bad = w.characters.create({
      name: 'B',
      baseAssetId: 'base.wide',
      params: { 'face.apparent_age': 25, 'face.jaw_definition': 0.2, 'face.roundness': 0.5, 'eyes.size': 0.4, 'body.head_scale': 1.04, 'body.leg_length': -0.2 },
    })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.code).toBe('adult_envelope')
    if (!ok1.ok) return
    const upd = w.characters.setParams(ok1.value.id, { 'face.apparent_age': 25, 'face.jaw_definition': 0.2, 'face.roundness': 0.5, 'eyes.size': 0.4, 'body.head_scale': 1.04, 'body.leg_length': -0.2 })
    expect(!upd.ok && upd.code).toBe('adult_envelope')
    expect(w.characters.get(ok1.value.id)!.params['face.apparent_age']).toBe(40)
    // values below the declared floor are clamped to 25 by the base, never lower
    const clamped = w.characters.setParams(ok1.value.id, { 'face.apparent_age': 5 })
    expect(clamped.ok && clamped.value.profile.params['face.apparent_age']).toBe(25)
  })

  it('neotenyScore is monotone in each youthful direction and bounded 0..1', () => {
    const rnd = lcg(99)
    for (let i = 0; i < 200; i++) {
      const s: Record<string, number> = {
        'eyes.size': -0.4 + rnd() * 0.8,
        'face.roundness': -0.6 + rnd() * 1.1,
        'face.jaw_definition': 0.2 + rnd() * 0.8,
        'body.head_scale': 0.9 + rnd() * 0.14,
        'body.leg_length': -0.2 + rnd(),
        'face.apparent_age': 25 + rnd() * 40,
      }
      const score = neotenyScore(s)
      expect(score).toBeGreaterThanOrEqual(0)
      expect(score).toBeLessThanOrEqual(1)
      expect(neotenyScore({ ...s, 'eyes.size': 0.4 })).toBeGreaterThanOrEqual(score)
      expect(neotenyScore({ ...s, 'face.apparent_age': 65 })).toBeLessThanOrEqual(score)
    }
  })

  it('scalarsOf keeps only numbers; defaultParams renders colours as hex', () => {
    expect(scalarsOf({ a: 1, b: '#fff', c: 2 })).toEqual({ a: 1, c: 2 })
    const base = makeWorld().catalog.get(seedBaseId('vrm1'))!
    expect(defaultParams(base)['skin.tone']).toBe('#c89f87')
  })

  it('manifest licence helper sanity', () => {
    expect(LIC.personalUse).toBe(true)
  })
})

describe('restore', () => {
  it('when no baseline can be refilled it saves NOTHING (never an unclothed state), says so, refuses to show her, and heals when the item returns', () => {
    const w = makeAssistant()
    const before = w.characters.get(w.assistant.id)!
    const shirt = w.catalog.get('outfit.crisp-shirt')!
    w.catalog.remove('outfit.crisp-shirt')
    const rep = w.characters.restore()
    expect(rep.problems).toHaveLength(1) // no vetted baseline top remains in this catalog
    expect(rep.problems[0]!.message).toMatch(/clothed baseline could not be restored/)
    expect(rep.repaired).toEqual([]) // nothing was changed...
    expect(w.characters.get(w.assistant.id)).toEqual(before) // ...so her stored look is exactly as it was (still slot-wise clothed)
    expect(isClothedBaseline(w.characters.get(w.assistant.id)!.equipped)).toBe(true)
    expect(rep.assistant?.id).toBe(w.assistant.id) // nothing else to switch to
    // a stage is never told about a figure that cannot be shown clothed
    const load = w.characters.loadCommand(w.assistant.id)
    expect(!load.ok && load.code).toBe('invalid_equipped')
    expect(!load.ok && load.error).toMatch(/not in the catalog/)
    // the shirt comes back (a damaged catalog row was fixed): she is whole again, nothing was lost
    w.catalog.add(shirt, { vetted: true })
    expect(w.characters.loadCommand(w.assistant.id).ok).toBe(true)
    expect(w.characters.restore().problems).toEqual([])
  })
  it('refills the baseline from another VETTED baseline-tagged item when one is available', () => {
    const w = makeAssistant()
    w.catalog.add({ id: 'outfit.alt-shirt', kind: 'outfit', name: 'Alt shirt', locator: 'w/alt', slots: ['top'], hides: ['torso', 'arms'], tags: ['baseline'], license: LIC }, { vetted: true })
    w.catalog.remove('outfit.crisp-shirt')
    const rep = w.characters.restore()
    expect(rep.problems).toEqual([])
    expect(rep.repaired.map((r) => r.slot)).toEqual(['top'])
    expect(w.characters.get(w.assistant.id)!.equipped.top).toBe('outfit.alt-shirt')
  })
  it('never refills from an asset that only carries the "baseline" tag (a registered asset cannot make itself the default look)', () => {
    const w = makeAssistant()
    w.catalog.add({ id: 'a-hijack.top', kind: 'outfit', name: 'Hijack top', locator: 'w/h', slots: ['top'], hides: ['torso', 'arms'], tags: ['baseline'], license: LIC })
    w.catalog.remove('outfit.crisp-shirt')
    const rep = w.characters.restore()
    expect(rep.problems).toHaveLength(1)
    expect(w.characters.get(w.assistant.id)!.equipped.top).toBe('outfit.crisp-shirt') // untouched, not replaced by the hijacker
  })
  it('clears items whose licence now forbids use and fixes mixed fullBody states', () => {
    const w = makeAssistant()
    const c = w.characters.get(w.assistant.id)!
    c.equipped.earrings = 'accessory.simple-earrings'
    c.equipped.fullBody = 'outfit.utility-jumpsuit'
    w.repo.save(c)
    w.catalog.add({ ...w.catalog.get('accessory.simple-earrings')!, license: { id: 'EULA', personalUse: false, commercialUse: false, redistribution: false } }, { replace: true })
    const rep = w.characters.restore()
    expect(rep.repaired.find((r) => r.slot === 'earrings')?.reason).toMatch(/does not permit personal use/)
    const after = w.characters.get(w.assistant.id)!
    expect(after.equipped.earrings).toBeNull()
    expect(after.equipped.fullBody).toBe('outfit.utility-jumpsuit')
    expect(after.equipped.top).toBeNull()
    expect(after.equipped.bottom).toBeNull()
    expect(isClothedBaseline(after.equipped)).toBe(true)
  })
  it('re-clamps parameters against the current base and guarantees one active assistant', () => {
    const w = makeAssistant()
    const c = w.characters.get(w.assistant.id)!
    c.params['body.height_cm'] = 400
    c.params['old.slider'] = 3
    w.repo.save(c)
    w.repo.setActiveId('assistant', undefined)
    const rep = w.characters.restore()
    expect(rep.paramsAdjusted[0]!.ids.sort()).toEqual(['body.height_cm', 'old.slider'])
    expect(w.characters.get(w.assistant.id)!.params['body.height_cm']).toBe(190)
    expect(rep.assistant?.id).toBe(w.assistant.id)
    expect(w.characters.getActive()?.id).toBe(w.assistant.id)
  })
  it('restores a clean state unchanged', () => {
    const w = makeAssistant()
    const before = w.characters.get(w.assistant.id)
    const rep = w.characters.restore()
    expect(rep.repaired).toEqual([])
    expect(rep.paramsAdjusted).toEqual([])
    expect(rep.problems).toEqual([])
    expect(w.characters.get(w.assistant.id)).toEqual(before)
  })
})

describe('stage load command', () => {
  it('builds character.load with the base and everything worn', () => {
    const w = makeAssistant()
    const r = w.characters.loadCommand(w.assistant.id)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.type).toBe('character.load')
    const ids = (r.value as { assets: Array<{ id: string }> }).assets.map((a) => a.id)
    expect(ids).toEqual(['base.vrm1.composed', 'outfit.ankle-boots', 'outfit.crisp-shirt', 'outfit.tailored-trousers'].sort())
    expect(w.characters.loadCommand('nope').ok).toBe(false)
  })
})
