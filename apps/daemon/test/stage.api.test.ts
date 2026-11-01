import { afterEach, describe, expect, it } from 'vitest'
import { ServerEvent, StageMemoryList, StageSnapshot, Snapshot } from '@ai-assistant/shared'
import { json, makeDaemon, type TestDaemon } from './helpers'

const open: TestDaemon[] = []
afterEach(async () => {
  for (const d of open.splice(0)) await d.cleanup()
})
async function daemon(): Promise<TestDaemon> {
  const d = await makeDaemon()
  open.push(d)
  return d
}

const A = 'char.assistant'
const U = 'char.user'
const ch = (id: string, tail: string) => `/api/stage/characters/${id}/${tail}`

const outfit = (over: Record<string, unknown> = {}) => ({
  id: 'outfit.vendor-coat',
  kind: 'outfit',
  name: 'Vendor coat',
  tags: ['dark'],
  rigFamilies: ['vrm1', 'metahuman', 'cc5'],
  locator: 'wardrobe/vendor-coat',
  slots: ['outerwear'],
  hides: ['torso', 'arms'],
  params: [],
  license: { id: 'vendor-eula', personalUse: false, commercialUse: false, redistribution: false },
  ...over,
})
const prop = (over: Record<string, unknown> = {}) => ({
  id: 'prop.vendor-lamp',
  kind: 'prop',
  name: 'Vendor lamp',
  tags: ['furniture'],
  rigFamilies: [],
  locator: 'props/vendor-lamp',
  slots: [],
  hides: [],
  params: [],
  license: { id: 'vendor-eula', personalUse: false, commercialUse: false, redistribution: false },
  ...over,
})

async function snap(d: TestDaemon): Promise<StageSnapshot> {
  const r = await d.call('/api/stage')
  expect(r.status).toBe(200)
  return StageSnapshot.parse(await r.json())
}
const err = async (r: Response) => (await r.json()) as { error: string; message: string; details?: unknown }

describe('GET /api/stage and the snapshot', () => {
  it('returns a StageSnapshot that validates, filled with the seed', async () => {
    const d = await daemon()
    const s = await snap(d)
    expect(s.enabled).toBe(true)
    expect(s.characters.map((c) => c.id)).toEqual([A, U])
    expect(s.assets.length).toBeGreaterThan(25)
    expect(s.scene?.name).toBe('Cerebral void')
    expect(s.cameraShots).toEqual(['wide', 'medium', 'closeup', 'profile', 'back', 'over_shoulder'])
    expect(s.stage).toEqual({ connected: false })
    expect(s.mood?.label).toBeDefined()
    expect(s.outfitSuggestion?.explanation).toBeTruthy()
  })

  it('is part of GET /api/snapshot, which still validates against the shared schema', async () => {
    const d = await daemon()
    const r = await d.call('/api/snapshot')
    const body = Snapshot.parse(await r.json())
    expect(body.stage?.enabled).toBe(true)
    expect(body.stage?.characters).toHaveLength(2)
  })

  it('carries the licence of every asset', async () => {
    const d = await daemon()
    const s = await snap(d)
    for (const a of s.assets) {
      expect(a.license.id, a.id).toBeTruthy()
      expect(typeof a.license.personalUse).toBe('boolean')
    }
  })
})

describe('the request gate on every stage route', () => {
  const routes: Array<[string, string, unknown?]> = [
    ['GET', '/api/stage'],
    ['PUT', '/api/settings/stage', { on: true }],
    ['DELETE', '/api/stage/connection'],
    ['POST', '/api/stage/assets', { manifest: {} }],
    ['PUT', '/api/stage/characters/select', { characterId: A }],
    ['PUT', ch(A, 'params'), { params: { 'body.height_cm': 175 } }],
    ['PUT', ch(A, 'presence'), { pace: 0.5 }],
    ['POST', ch(A, 'equip'), { assetId: 'outfit.tailored-blazer' }],
    ['POST', ch(A, 'unequip'), { slot: 'outerwear' }],
    ['POST', ch(A, 'outfit/apply'), { presetId: 'preset.work' }],
    ['POST', ch(A, 'outfit/save'), { name: 'x' }],
    ['POST', ch(A, 'outfit/delete'), { presetId: 'preset.work' }],
    ['POST', ch(A, 'outfit/suggest'), {}],
    ['POST', '/api/stage/scene/preset', { presetId: 'preset.void' }],
    ['POST', '/api/stage/scene/objects', { assetId: 'prop.lounge-chair' }],
    ['PUT', '/api/stage/scene/objects/x', { visible: false }],
    ['DELETE', '/api/stage/scene/objects/x'],
    ['PUT', '/api/stage/scene/camera', { shot: 'wide' }],
    ['GET', '/api/stage/memory'],
    ['DELETE', '/api/stage/memory?confirm=all'],
    ['DELETE', '/api/stage/memory/x'],
  ]

  it('refuses without the session cookie (401), also with the stage token', async () => {
    const d = await daemon()
    const token = d.daemon.security.stageToken()
    for (const [method, path, body] of routes) {
      const r = await d.call(path, { method, ...(body !== undefined ? { json: body } : {}), cookie: false })
      expect(r.status, `${method} ${path}`).toBe(401)
      const r2 = await d.call(path, { method, ...(body !== undefined ? { json: body } : {}), cookie: false, headers: { Authorization: `Bearer ${token}` } })
      expect(r2.status, `${method} ${path} with the stage token`).toBe(401)
    }
  })

  it('the stage token is no browser credential at all, and the hook token is not either', async () => {
    const d = await daemon()
    for (const t of [d.daemon.security.stageToken(), d.daemon.security.hookToken()]) {
      for (const p of ['/api/stage', '/api/snapshot', '/api/health', '/api/tasks']) {
        const r = await d.call(p, { cookie: false, headers: { Authorization: `Bearer ${t}`, 'X-Api-Key': t } })
        expect(r.status, p).toBe(401)
      }
    }
  })

  it('refuses a foreign Host (403) and a missing or foreign Origin on mutations (403)', async () => {
    const d = await daemon()
    for (const [method, path, body] of routes) {
      const host = await d.call(path, { method, ...(body !== undefined ? { json: body } : {}), host: 'evil.example:80' })
      expect(host.status, `${method} ${path} host`).toBe(403)
      if (method === 'GET') continue
      const noOrigin = await d.call(path, { method, ...(body !== undefined ? { json: body } : {}), origin: false })
      expect(noOrigin.status, `${method} ${path} no origin`).toBe(403)
      const foreign = await d.call(path, { method, ...(body !== undefined ? { json: body } : {}), origin: 'https://evil.example' })
      expect(foreign.status, `${method} ${path} foreign origin`).toBe(403)
    }
  })

  it('refuses a mutation that is not JSON (415)', async () => {
    const d = await daemon()
    const r = await d.call('/api/stage/scene/camera', { method: 'PUT', body: 'shot=wide', contentType: 'text/plain' })
    expect(r.status).toBe(415)
  })

  it('sends no CORS headers and no-store', async () => {
    const d = await daemon()
    const r = await d.call('/api/stage')
    expect([...r.headers.keys()].filter((k) => k.startsWith('access-control'))).toEqual([])
    expect(r.headers.get('cache-control')).toBe('no-store')
  })
})

describe('request validation (400)', () => {
  it('rejects invalid JSON and bad shapes with a message that names the field', async () => {
    const d = await daemon()
    const bad = await d.call('/api/stage/scene/camera', { method: 'PUT', body: '{nope', contentType: 'application/json' })
    expect(bad.status).toBe(400)
    expect((await err(bad)).error).toBe('invalid_json')

    const cases: Array<[string, string, unknown, RegExp]> = [
      ['PUT', '/api/settings/stage', { on: 'yes' }, /on/],
      ['PUT', '/api/stage/characters/select', {}, /characterId/],
      ['PUT', ch(A, 'params'), { params: {} }, /parameters/],
      ['PUT', ch(A, 'params'), { params: { 'body.height_cm': [1] } }, /params/],
      ['PUT', ch(A, 'presence'), {}, /at least one/],
      ['PUT', ch(A, 'presence'), { uprightness: 1.5 }, /uprightness/],
      ['PUT', ch(A, 'presence'), { baseline: { valence: 4 } }, /valence/],
      ['POST', ch(A, 'equip'), {}, /assetId/],
      ['POST', ch(A, 'equip'), { assetId: 'x', slot: 'nope' }, /slot/],
      ['POST', ch(A, 'unequip'), { slot: 'nope' }, /slot/],
      ['POST', ch(A, 'outfit/apply'), {}, /presetId/],
      ['POST', ch(A, 'outfit/save'), { name: '' }, /name/],
      ['POST', ch(A, 'outfit/save'), { name: 'x'.repeat(41) }, /name/],
      ['POST', ch(A, 'outfit/suggest'), { activity: 'party' }, /activity/],
      ['POST', '/api/stage/scene/preset', {}, /presetId/],
      ['POST', '/api/stage/scene/objects', { assetId: 'prop.lounge-chair', position: [1, 2] }, /position/],
      ['POST', '/api/stage/scene/objects', { assetId: 'prop.lounge-chair', scale: 0 }, /scale/],
      ['POST', '/api/stage/scene/objects', { assetId: 'prop.lounge-chair', position: [999, 0, 0] }, /position/],
      ['PUT', '/api/stage/scene/objects/x', {}, /at least one/],
      ['PUT', '/api/stage/scene/camera', { shot: '' }, /shot/],
      ['POST', '/api/stage/assets', {}, /manifest/],
    ]
    for (const [method, path, body, msg] of cases) {
      const r = await d.call(path, { method, json: body })
      expect(r.status, `${method} ${path} ${JSON.stringify(body)}`).toBe(400)
      const e = await err(r)
      expect(e.error).toBe('invalid_request')
      expect(e.message, `${method} ${path}`).toMatch(msg)
    }
  })
})

describe('not found (404) and refusals (409, 422)', () => {
  it('unknown ids are 404', async () => {
    const d = await daemon()
    const cases: Array<[string, string, unknown]> = [
      ['PUT', '/api/stage/characters/select', { characterId: 'nope' }],
      ['PUT', ch('nope', 'params'), { params: { 'body.height_cm': 175 } }],
      ['PUT', ch('nope', 'presence'), { pace: 0.5 }],
      ['POST', ch('nope', 'equip'), { assetId: 'outfit.tailored-blazer' }],
      ['POST', ch('nope', 'unequip'), { slot: 'outerwear' }],
      ['POST', ch('nope', 'outfit/apply'), { presetId: 'preset.work' }],
      ['POST', ch(A, 'outfit/apply'), { presetId: 'preset.nope' }],
      ['POST', ch(A, 'outfit/delete'), { presetId: 'preset.nope' }],
      ['POST', ch('nope', 'outfit/save'), { name: 'x' }],
      ['POST', ch('nope', 'outfit/suggest'), {}],
      ['POST', ch(A, 'equip'), { assetId: 'outfit.does-not-exist' }],
      ['POST', '/api/stage/scene/preset', { presetId: 'preset.nope' }],
      ['POST', '/api/stage/scene/objects', { assetId: 'prop.does-not-exist' }],
      ['PUT', '/api/stage/scene/objects/ghost', { visible: false }],
      ['DELETE', '/api/stage/scene/objects/ghost', undefined],
    ]
    for (const [method, path, body] of cases) {
      const r = await d.call(path, { method, ...(body !== undefined ? { json: body } : {}) })
      expect(r.status, `${method} ${path}`).toBe(404)
      expect((await err(r)).message.length).toBeGreaterThan(5)
    }
    expect((await d.call('/api/stage/connection', { method: 'DELETE' })).status).toBe(404) // nothing connected
  })

  it('REFUSES an out-of-range slider with the range in the message, and changes nothing', async () => {
    const d = await daemon()
    const before = (await snap(d)).characters.find((c) => c.id === A)!
    const r = await d.call(ch(A, 'params'), { method: 'PUT', json: { params: { 'body.height_cm': 250 } } })
    expect(r.status).toBe(422)
    const e = await err(r)
    expect(e.error).toBe('param_out_of_range')
    expect(e.message).toMatch(/Height \(cm\) must be between 162 and 190 \(you sent 250\)/)
    expect(e.message).toMatch(/adult/i)
    expect(e.details).toEqual([{ param: 'body.height_cm', min: 162, max: 190, value: 250 }])
    const after = (await snap(d)).characters.find((c) => c.id === A)!
    expect(after.params).toEqual(before.params)
  })

  it('refuses a childlike apparent age however it is asked (below the base range and below the adult floor)', async () => {
    const d = await daemon()
    for (const age of [8, 15, 17, 24, 27.9, -3]) {
      const r = await d.call(ch(A, 'params'), { method: 'PUT', json: { params: { 'face.apparent_age': age } } })
      expect(r.status, `age ${age}`).toBe(422)
      expect((await err(r)).message).toMatch(/Apparent age/)
    }
    // and a legal value is accepted
    const ok = await d.call(ch(A, 'params'), { method: 'PUT', json: { params: { 'face.apparent_age': 40 } } })
    expect(ok.status).toBe(200)
    expect((await snap(d)).characters.find((c) => c.id === A)!.params['face.apparent_age']).toBe(40)
  })

  it('refuses the extremes of every governed slider on both characters', async () => {
    const d = await daemon()
    const s = await snap(d)
    for (const id of [A, U]) {
      const c = s.characters.find((x) => x.id === id)!
      const base = s.assets.find((a) => a.id === c.baseAssetId)!
      for (const p of base.params.filter((x) => x.type === 'scalar')) {
        for (const v of [p.min - 1e-3 * Math.max(1, Math.abs(p.min)), p.max + 1e-3 * Math.max(1, Math.abs(p.max))]) {
          const r = await d.call(ch(id, 'params'), { method: 'PUT', json: { params: { [p.id]: v } } })
          expect(r.status, `${id} ${p.id} ${v}`).toBe(422)
        }
      }
    }
  })

  it('judges the COMBINATION: a base with wide (but individually adult) ranges cannot be steered into a childlike figure', async () => {
    const d = await daemon()
    const sc = (id: string, group: string, label: string, min: number, max: number, def: number) => ({ id, group, label, min, max, default: def, type: 'scalar' })
    const wide = {
      id: 'base.vrm1.wide-adult',
      kind: 'character_base',
      name: 'Wide adult ranges',
      adult: true,
      tags: ['adult'],
      rigFamilies: ['vrm1'],
      locator: 'bases/wide-adult',
      slots: [],
      hides: [],
      params: [
        sc('face.apparent_age', 'face', 'Apparent age', 25, 65, 40),
        sc('face.jaw_definition', 'face', 'Jaw', 0.2, 1, 0.7),
        sc('face.roundness', 'face', 'Roundness', -0.6, 0.5, -0.1),
        sc('eyes.size', 'eyes', 'Eye size', -0.4, 0.4, 0),
        sc('body.head_scale', 'body', 'Head scale', 0.9, 1.04, 0.96),
        sc('body.leg_length', 'body', 'Leg length', -0.2, 0.8, 0.3),
      ],
      license: { id: 'CC0-1.0', personalUse: true, commercialUse: true, redistribution: true },
    }
    expect((await d.call('/api/stage/assets', { json: { manifest: wide } })).status).toBe(201)
    const c = d.daemon.stage.hub.characters.create({ id: 'char.wide', name: 'Wide', baseAssetId: wide.id })
    expect(c.ok).toBe(true)
    // every value is inside the base's own declared range, yet together they are the most youthful corner
    const corner = { 'face.apparent_age': 25, 'face.jaw_definition': 0.2, 'face.roundness': 0.5, 'eyes.size': 0.4, 'body.head_scale': 1.04, 'body.leg_length': -0.2 }
    const r = await d.call(ch('char.wide', 'params'), { method: 'PUT', json: { params: corner } })
    expect(r.status).toBe(422)
    const e = await err(r)
    expect(e.error).toBe('adult_envelope')
    expect(e.message).toMatch(/youthful/i)
    // a mature combination of the same base is fine
    const ok = await d.call(ch('char.wide', 'params'), { method: 'PUT', json: { params: { 'face.apparent_age': 45, 'face.jaw_definition': 0.9 } } })
    expect(ok.status).toBe(200)
    expect(d.daemon.store.listAudit(50).some((a) => a.action === 'Refused a body change' && /adult_envelope/.test(a.detail ?? ''))).toBe(true)
  })

  it('refuses unknown parameters, bad colours and prototype-pollution keys', async () => {
    const d = await daemon()
    for (const params of [{ 'body.bust_size': 1 }, { 'skin.tone': 'not-a-colour' }, { 'skin.tone': '#12345' }, { constructor: 1 }, { 'body.height_cm': 'tall' }]) {
      const r = await d.call(ch(A, 'params'), { method: 'PUT', json: { params } })
      expect([400, 422], JSON.stringify(params)).toContain(r.status)
    }
    const ok = await d.call(ch(A, 'params'), { method: 'PUT', json: { params: { 'skin.tone': '#C0A090' } } })
    expect(ok.status).toBe(200)
    expect((await snap(d)).characters.find((c) => c.id === A)!.params['skin.tone']).toBe('#c0a090')
  })

  it('an unchanged value is accepted and sends nothing', async () => {
    const d = await daemon()
    const h = (await snap(d)).characters.find((c) => c.id === A)!.params['body.height_cm']
    const r = await d.call(ch(A, 'params'), { method: 'PUT', json: { params: { 'body.height_cm': h } } })
    expect(r.status).toBe(200)
    expect(((await json(r)) as { stage: { sent: number } }).stage.sent).toBe(0)
  })

  it('refuses to take off the last full outfit (baseline), by any slot', async () => {
    const d = await daemon()
    const worn = (await snap(d)).characters.find((c) => c.id === A)!.equipped
    for (const slot of ['top', 'bottom'] as const) {
      expect(worn[slot]).toBeTruthy()
      const r = await d.call(ch(A, 'unequip'), { json: { slot } })
      expect(r.status).toBe(422)
      expect((await err(r)).message).toMatch(/full outfit|baseline/i)
    }
    expect((await snap(d)).characters.find((c) => c.id === A)!.equipped.top).toBe(worn.top)
  })

  it('taking off something optional works, and unequipping an empty slot is a no-op', async () => {
    const d = await daemon()
    expect((await d.call(ch(A, 'equip'), { json: { assetId: 'accessory.metal-bracers' } })).status).toBe(200)
    expect((await snap(d)).characters.find((c) => c.id === A)!.equipped.wristwear).toBe('accessory.metal-bracers')
    expect((await d.call(ch(A, 'unequip'), { json: { slot: 'wristwear' } })).status).toBe(200)
    expect((await snap(d)).characters.find((c) => c.id === A)!.equipped.wristwear).toBeNull()
    const again = await d.call(ch(A, 'unequip'), { json: { slot: 'wristwear' } })
    expect(again.status).toBe(200)
  })

  it('refuses things that are not wardrobe, slot mismatches and a full-body swap keeps her dressed', async () => {
    const d = await daemon()
    const prop = await d.call(ch(A, 'equip'), { json: { assetId: 'prop.lounge-chair' } })
    expect(prop.status).toBe(422)
    const base = await d.call(ch(A, 'equip'), { json: { assetId: 'base.vrm1.poised' } })
    expect([404, 422]).toContain(base.status)
    const slot = await d.call(ch(A, 'equip'), { json: { assetId: 'accessory.metal-bracers', slot: 'neck' } })
    expect(slot.status).toBe(422)
    expect((await err(slot)).message).toMatch(/cannot be worn in the neck slot/)
    // a jumpsuit replaces top and bottom and she stays fully dressed
    const j = await d.call(ch(A, 'equip'), { json: { assetId: 'outfit.utility-jumpsuit' } })
    expect(j.status).toBe(200)
    const eq = (await snap(d)).characters.find((c) => c.id === A)!.equipped
    expect(eq.fullBody).toBe('outfit.utility-jumpsuit')
    expect(eq.top).toBeNull()
  })

  it('REFUSES an asset whose licence forbids personal use, with the reason, for wardrobe and scene alike', async () => {
    const d = await daemon()
    const reg = await d.call('/api/stage/assets', { json: { manifest: outfit() } })
    expect(reg.status).toBe(201)
    const lamp = await d.call('/api/stage/assets', { json: { manifest: prop() } })
    expect(lamp.status).toBe(201)
    // it is in the catalog (metadata), licence visible, and unusable
    const s = await snap(d)
    expect(s.assets.find((a) => a.id === 'outfit.vendor-coat')?.license).toMatchObject({ id: 'vendor-eula', personalUse: false })
    const worn = await d.call(ch(A, 'equip'), { json: { assetId: 'outfit.vendor-coat' } })
    expect(worn.status).toBe(422)
    expect((await err(worn)).message).toMatch(/licen[cs]e/i)
    expect((await snap(d)).characters.find((c) => c.id === A)!.equipped.outerwear).toBeNull()
    const placed = await d.call('/api/stage/scene/objects', { json: { assetId: 'prop.vendor-lamp' } })
    expect(placed.status).toBe(422)
    expect((await err(placed)).error).toBe('licence')
    expect((await snap(d)).scene!.objects).toEqual([])
  })

  it('an unknown licence is refused for every use', async () => {
    const d = await daemon()
    await d.call('/api/stage/assets', { json: { manifest: outfit({ id: 'outfit.mystery', license: { id: 'unknown', personalUse: true, commercialUse: false, redistribution: false } }) } })
    const r = await d.call(ch(A, 'equip'), { json: { assetId: 'outfit.mystery' } })
    expect(r.status).toBe(422)
    expect((await err(r)).message).toMatch(/unknown licen/i)
  })

  it('applies outfit presets, refuses one that cannot be worn, saves and deletes presets', async () => {
    const d = await daemon()
    const apply = await d.call(ch(A, 'outfit/apply'), { json: { presetId: 'preset.meeting' } })
    expect(apply.status).toBe(200)
    expect((await snap(d)).characters.find((c) => c.id === A)!.equipped.outerwear).toBe('outfit.tailored-blazer')

    const save = await d.call(ch(A, 'outfit/save'), { json: { name: 'Board day' } })
    expect(save.status).toBe(201)
    const saved = ((await json(save)) as { result: { id: string } }).result
    expect(saved.id).toBe('preset.board-day')
    expect((await snap(d)).characters.find((c) => c.id === A)!.presets.map((p) => p.id)).toContain('preset.board-day')
    expect((await d.call(ch(A, 'outfit/delete'), { json: { presetId: saved.id } })).status).toBe(200)
    expect((await snap(d)).characters.find((c) => c.id === A)!.presets.map((p) => p.id)).not.toContain('preset.board-day')

    // a preset whose licence has been withdrawn since is refused, and nothing changes
    await d.call('/api/stage/assets', { json: { manifest: outfit({ id: 'outfit.vendor-top', slots: ['top'], license: { id: 'vendor-eula', personalUse: false, commercialUse: false, redistribution: false } }) } })
    const store = d.daemon.stage.hub.characters
    const cur = store.get(A)!
    store.setPresets(A, [...cur.presets, { id: 'preset.bad', name: 'Bad', equipped: { ...cur.equipped, top: 'outfit.vendor-top' }, tweaks: {}, context: {} }])
    const bad = await d.call(ch(A, 'outfit/apply'), { json: { presetId: 'preset.bad' } })
    expect(bad.status).toBe(422)
    expect((await err(bad)).message).toMatch(/cannot be worn/)
  })

  it('suggests an outfit for her only and applies nothing', async () => {
    const d = await daemon()
    const before = (await snap(d)).characters.find((c) => c.id === A)!.equipped
    const r = await d.call(ch(A, 'outfit/suggest'), { json: { activity: 'meeting' } })
    expect(r.status).toBe(200)
    const s = ((await json(r)) as { result: { presetId: string; explanation: string } }).result
    expect(s.presetId).toBe('preset.meeting')
    expect(s.explanation).toMatch(/Meeting/)
    expect((await snap(d)).characters.find((c) => c.id === A)!.equipped).toEqual(before)
    const user = await d.call(ch(U, 'outfit/suggest'), { json: {} })
    expect(user.status).toBe(422)
    expect((await err(user)).error).toBe('not_assistant')
    // an empty body is fine
    expect((await d.call(ch(A, 'outfit/suggest'), { method: 'POST' })).status).toBe(200)
  })

  it('presence: merges a partial patch and keeps the baseline fields it did not send', async () => {
    const d = await daemon()
    const r = await d.call(ch(A, 'presence'), { method: 'PUT', json: { pace: 0.3, baseline: { arousal: 0.2 } } })
    expect(r.status).toBe(200)
    const c = (await snap(d)).characters.find((x) => x.id === A)!
    expect(c.presence.pace).toBe(0.3)
    expect(c.presence.baseline).toEqual({ valence: 0.2, arousal: 0.2, dominance: 0.7 })
    expect(c.presence.uprightness).toBe(0.8)
    // the live director follows
    expect(d.daemon.stage.hub.mood?.baseline().arousal).toBe(0.2)
  })

  it('selecting a character makes it the active one of its role', async () => {
    const d = await daemon()
    const hub = d.daemon.stage.hub
    const second = hub.characters.create({ id: 'char.second', name: 'Second', baseAssetId: 'base.vrm1.poised' })
    expect(second.ok).toBe(true)
    const r = await d.call('/api/stage/characters/select', { method: 'PUT', json: { characterId: 'char.second' } })
    expect(r.status).toBe(200)
    const s = await snap(d)
    expect(s.assistantCharacterId).toBe('char.second')
    expect(s.userCharacterId).toBe(U)
    expect(hub.assistant()?.id).toBe('char.second')
  })

  it('scene: add, update, remove objects, presets and cameras', async () => {
    const d = await daemon()
    const add = await d.call('/api/stage/scene/objects', { json: { assetId: 'prop.lounge-chair', id: 'my_chair', position: [1, 0, 2], yawDeg: 90 } })
    expect(add.status).toBe(201)
    let obj = (await snap(d)).scene!.objects.find((o) => o.id === 'my_chair')!
    expect(obj.transform.position).toEqual([1, 0, 2])
    expect(obj.transform.rotation[1]).toBeGreaterThan(0.6)
    expect((await d.call('/api/stage/scene/objects', { json: { assetId: 'prop.lounge-chair', id: 'my_chair' } })).status).toBe(409)
    expect((await d.call('/api/stage/scene/objects', { json: { assetId: 'outfit.crisp-shirt' } })).status).toBe(422)
    expect((await d.call('/api/stage/scene/objects', { json: { assetId: 'env.cerebral-void' } })).status).toBe(422)

    const up = await d.call('/api/stage/scene/objects/my_chair', { method: 'PUT', json: { position: [-2, 0, 1], scale: 1.5, visible: false } })
    expect(up.status).toBe(200)
    obj = (await snap(d)).scene!.objects.find((o) => o.id === 'my_chair')!
    expect(obj.transform.position).toEqual([-2, 0, 1])
    expect(obj.transform.scale).toEqual([1.5, 1.5, 1.5])
    expect(obj.visible).toBe(false)

    expect((await d.call('/api/stage/scene/objects/my_chair', { method: 'DELETE' })).status).toBe(200)
    expect((await snap(d)).scene!.objects).toEqual([])

    expect((await d.call('/api/stage/scene/preset', { json: { presetId: 'preset.void-seating' } })).status).toBe(200)
    expect((await snap(d)).scene!.objects.map((o) => o.id)).toEqual(['lounge_chair', 'data_plinth'])

    expect((await d.call('/api/stage/scene/camera', { method: 'PUT', json: { shot: 'closeup' } })).status).toBe(200)
    expect((await snap(d)).scene!.activeCameraId).toBe('closeup')
    const bad = await d.call('/api/stage/scene/camera', { method: 'PUT', json: { shot: 'drone' } })
    expect(bad.status).toBe(422)
    expect((await err(bad)).message).toMatch(/unknown shot/)
  })

  it('catalog registration: accepts metadata, never replaces, refuses unsafe or non-adult entries', async () => {
    const d = await daemon()
    const ok = await d.call('/api/stage/assets', { json: { manifest: outfit({ id: 'outfit.ok-coat', license: { id: 'CC-BY-4.0', personalUse: true, commercialUse: true, redistribution: true } }) } })
    expect(ok.status).toBe(201)
    expect((await snap(d)).assets.find((a) => a.id === 'outfit.ok-coat')?.license.id).toBe('CC-BY-4.0')
    // stored with its licence columns
    expect(d.daemon.stage.hub.stageStore.assetLicense('outfit.ok-coat')?.source).toBe('user')

    const dup = await d.call('/api/stage/assets', { json: { manifest: outfit({ id: 'outfit.ok-coat' }) } })
    expect(dup.status).toBe(409)
    const seed = await d.call('/api/stage/assets', { json: { manifest: outfit({ id: 'outfit.crisp-shirt' }) } })
    expect(seed.status).toBe(409)

    const refusals: Array<[string, Record<string, unknown>]> = [
      ['an invalid manifest', { id: 'x' }],
      ['a path-escaping locator', outfit({ id: 'outfit.escape', locator: '../../etc/passwd' })],
      ['a locator with credentials', outfit({ id: 'outfit.creds', locator: 'https://user:pw@example.com/a.vrm' })],
      ['a non-adult base (no attestation)', { id: 'base.vrm1.kid', kind: 'character_base', name: 'Base', tags: [], rigFamilies: ['vrm1'], locator: 'bases/kid', slots: [], hides: [], params: [], license: { id: 'x', personalUse: true, commercialUse: false, redistribution: false } }],
      [
        'a base whose slider ranges leave the adult envelope',
        {
          id: 'base.vrm1.wide',
          kind: 'character_base',
          name: 'Wide',
          adult: true,
          tags: [],
          rigFamilies: ['vrm1'],
          locator: 'bases/wide',
          slots: [],
          hides: [],
          params: [{ id: 'face.apparent_age', group: 'face', label: 'Age', min: 8, max: 60, default: 30, type: 'scalar' }],
          license: { id: 'x', personalUse: true, commercialUse: false, redistribution: false },
        },
      ],
      ['a wearable without a slot', outfit({ id: 'outfit.noslot', slots: [] })],
      ['a licence that is incoherent', outfit({ id: 'outfit.incoherent', license: { id: 'x', personalUse: false, commercialUse: true, redistribution: false } })],
    ]
    for (const [what, manifest] of refusals) {
      const r = await d.call('/api/stage/assets', { json: { manifest } })
      expect(r.status, what).toBe(422)
      expect((await err(r)).message.length, what).toBeGreaterThan(5)
    }
    // none of the refused ones got in
    const ids = new Set((await snap(d)).assets.map((a) => a.id))
    for (const id of ['x', 'outfit.escape', 'outfit.creds', 'base.vrm1.kid', 'base.vrm1.wide', 'outfit.noslot', 'outfit.incoherent']) expect(ids.has(id), id).toBe(false)
  })
})

describe('the catalog is bounded', () => {
  it('refuses new entries beyond the cap (409 catalog_full) and keeps what it has', async () => {
    const d = await daemon()
    const hub = d.daemon.stage.hub
    const { MAX_CATALOG_ENTRIES } = await import('../src/stage/actions')
    for (let i = hub.catalog.size; i < MAX_CATALOG_ENTRIES; i++) {
      hub.catalog.add(outfit({ id: `outfit.filler-${i}`, license: { id: 'CC0-1.0', personalUse: true, commercialUse: true, redistribution: true } }))
    }
    expect(hub.catalog.size).toBe(MAX_CATALOG_ENTRIES)
    const r = await d.call('/api/stage/assets', { json: { manifest: outfit({ id: 'outfit.one-too-many' }) } })
    expect(r.status).toBe(409)
    expect((await err(r)).error).toBe('catalog_full')
    expect(hub.catalog.has('outfit.one-too-many')).toBe(false)
  })
})

describe('the stage switch', () => {
  it('off: mutations answer 409 stage_disabled, the snapshot says so, reads still work; on again restores everything', async () => {
    const d = await daemon()
    expect((await d.call('/api/settings/stage', { method: 'PUT', json: { on: false } })).status).toBe(200)
    const off = await snap(d)
    expect(off.enabled).toBe(false)
    expect(off.characters).toEqual([])
    expect(off.scene).toBeNull()
    for (const [path, body] of [
      [ch(A, 'equip'), { assetId: 'outfit.tailored-blazer' }],
      ['/api/stage/scene/camera', { shot: 'wide' }],
      ['/api/stage/assets', { manifest: outfit() }],
      [ch(A, 'params'), { params: { 'body.height_cm': 175 } }],
    ] as const) {
      const r = await d.call(path, { method: path.endsWith('camera') || path.endsWith('params') ? 'PUT' : 'POST', json: body })
      expect(r.status, path).toBe(409)
      expect((await err(r)).error).toBe('stage_disabled')
    }
    // the stage tools refuse politely
    const tool = d.daemon.stage.toolBindings().find((b) => b.spec.name === 'stage_camera')!
    expect(await tool.handler({ shot: 'wide' })).toMatchObject({ isError: true })
    expect((await d.call('/api/settings/stage', { method: 'POST', json: { on: true } })).status).toBe(200)
    const on = await snap(d)
    expect(on.enabled).toBe(true)
    expect(on.characters).toHaveLength(2)
  })

  it('a fresh database defaults to ON and the choice persists', async () => {
    const d = await daemon()
    expect(d.daemon.stage.hub.enabled()).toBe(true)
    await d.call('/api/settings/stage', { method: 'PUT', json: { on: false } })
    expect(d.daemon.store.kvGet('settings.stage')).toBe(false)
  })
})

describe('audit, events and secrets', () => {
  it('audits every mutation and every refusal, never the token', async () => {
    const d = await daemon()
    await d.call(ch(A, 'outfit/apply'), { json: { presetId: 'preset.meeting' } })
    await d.call(ch(A, 'params'), { method: 'PUT', json: { params: { 'body.height_cm': 250 } } })
    await d.call('/api/stage/scene/camera', { method: 'PUT', json: { shot: 'profile' } })
    await d.call('/api/stage/scene/objects', { json: { assetId: 'prop.lounge-chair', id: 'c1' } })
    await d.call(ch(A, 'unequip'), { json: { slot: 'top' } })
    const audit = d.daemon.store.listAudit(100)
    const text = (a: { action: string }) => a.action
    expect(audit.some((a) => /Changed outfit to Meeting/.test(a.action) && a.outcome === 'auto')).toBe(true)
    expect(audit.some((a) => text(a) === 'Refused a body change' && a.outcome === 'blocked' && /param_out_of_range/.test(a.detail ?? ''))).toBe(true)
    expect(audit.some((a) => /Moved the camera to profile/.test(a.action))).toBe(true)
    expect(audit.some((a) => /Placed an object/.test(a.action))).toBe(true)
    expect(audit.some((a) => /Refused to take something off/.test(a.action) && a.outcome === 'blocked')).toBe(true)
    const blob = JSON.stringify([audit, d.events])
    expect(blob).not.toContain(d.daemon.security.stageToken())
    expect(blob).not.toContain(d.daemon.security.hookToken())
  })

  it('publishes stage.live with a higher revision after every structural change, and the events validate', async () => {
    const d = await daemon()
    const before = d.events.length
    const rev0 = d.daemon.stage.hub.revision()
    await d.call('/api/stage/scene/camera', { method: 'PUT', json: { shot: 'back' } })
    await d.call(ch(A, 'outfit/apply'), { json: { presetId: 'preset.training' } })
    const lives = d.events.slice(before).filter((e) => e.type === 'stage.live')
    expect(lives.length).toBeGreaterThanOrEqual(2)
    const revs = lives.map((e) => (e as { live: { rev: number } }).live.rev)
    expect(revs).toEqual([...revs].sort((a, b) => a - b))
    expect(revs[revs.length - 1]).toBeGreaterThan(rev0)
    for (const e of lives) expect(ServerEvent.safeParse(e).success).toBe(true)
    expect((lives[lives.length - 1] as { live: { camera?: string } }).live.camera).toBe('back')
  })

  it('a refused change publishes nothing and does not bump the revision', async () => {
    const d = await daemon()
    const rev = d.daemon.stage.hub.revision()
    await d.call(ch(A, 'equip'), { json: { assetId: 'prop.lounge-chair' } })
    await d.call('/api/stage/scene/camera', { method: 'PUT', json: { shot: 'nope' } })
    expect(d.daemon.stage.hub.revision()).toBe(rev)
  })
})

describe('her memory: inspect and forget', () => {
  type Kind = 'episode' | 'relationship' | 'preference'
  /** Write through the same service the character_remember tool uses; a minute passes between writes so "newest first" is exact. */
  const remember = (d: TestDaemon, input: { kind: Kind; text: string; importance?: number; sensitivity?: 'normal' | 'private' | 'sensitive' }): string => {
    const r = d.daemon.stage.hub.memory.remember(input)
    expect(r.ok, JSON.stringify(r)).toBe(true)
    d.clock.advance(60_000)
    return (r as { ok: true; value: { item: { id: string } } }).value.item.id
  }
  const list = async (d: TestDaemon) => {
    const r = await d.call('/api/stage/memory')
    expect(r.status).toBe(200)
    return StageMemoryList.parse(await r.json())
  }
  const digest = (d: TestDaemon) => d.daemon.stage.hub.memory.digest({ audience: 'cloud', maxChars: 900 }).text

  it('is empty at first, is never cached, and the empty list validates', async () => {
    const d = await daemon()
    const r = await d.call('/api/stage/memory')
    expect(r.status).toBe(200)
    expect(r.headers.get('cache-control')).toBe('no-store')
    expect(StageMemoryList.parse(await r.json())).toEqual({ total: 0, items: [], bySensitivity: { normal: 0, private: 0, sensitive: 0 } })
  })

  it('lists what she wrote down, newest first, with its labels', async () => {
    const d = await daemon()
    const a = remember(d, { kind: 'preference', text: 'Likes the camera wide while she works', importance: 3 })
    const b = remember(d, { kind: 'relationship', text: 'Calls the user by a shortened name', importance: 4 })
    const c = remember(d, { kind: 'episode', text: 'Had a hard conversation about a family matter', importance: 5, sensitivity: 'sensitive' })
    const l = await list(d)
    expect(l.total).toBe(3)
    expect(l.items.map((i) => i.id)).toEqual([c, b, a])
    expect(l.items[0]).toMatchObject({ kind: 'episode', sensitivity: 'sensitive', importance: 5 })
    expect(l.items[0]?.text).toContain('family matter') // it is your own data: you see all of it
    expect(l.bySensitivity.sensitive).toBe(1)
    expect(l.bySensitivity.normal + l.bySensitivity.private).toBe(2)
    expect(Date.parse(l.items[0]!.createdAt)).toBeGreaterThan(Date.parse(l.items[2]!.createdAt))
  })

  it('forgets one item: gone from the list and from her prompt, and the audit says what kind went, not what it said', async () => {
    const d = await daemon()
    const keep = remember(d, { kind: 'preference', text: 'Likes the camera wide while she works', importance: 3 })
    const drop = remember(d, { kind: 'preference', text: 'Prefers tea over coffee in the morning', importance: 3 })
    expect(digest(d)).toContain('tea over coffee')
    const r = await d.call(`/api/stage/memory/${drop}`, { method: 'DELETE' })
    expect(r.status).toBe(200)
    expect(((await r.json()) as { result: { forgotten: number } }).result.forgotten).toBe(1)
    expect((await list(d)).items.map((i) => i.id)).toEqual([keep])
    expect(digest(d)).not.toContain('tea over coffee')
    expect(d.daemon.stage.hub.memoryDigest() ?? '').not.toContain('tea over coffee')
    const audit = d.daemon.store.listAudit(50)
    expect(audit.some((a) => /Forgot something she remembered/.test(a.action) && a.outcome === 'auto' && /preference/.test(a.detail ?? ''))).toBe(true)
    expect(JSON.stringify(audit)).not.toContain('tea over coffee')
  })

  it('answers 404 for something she does not remember and touches nothing else', async () => {
    const d = await daemon()
    const keep = remember(d, { kind: 'preference', text: 'Likes the camera wide while she works' })
    const r = await d.call('/api/stage/memory/mem.ghost', { method: 'DELETE' })
    expect(r.status).toBe(404)
    expect((await err(r)).error).toBe('not_found')
    expect((await list(d)).items.map((i) => i.id)).toEqual([keep])
  })

  it('forgetting everything has to be asked for by name; then it removes all of it and says how many', async () => {
    const d = await daemon()
    remember(d, { kind: 'preference', text: 'Likes the camera wide while she works' })
    remember(d, { kind: 'relationship', text: 'Calls the user by a shortened name' })
    const bare = await d.call('/api/stage/memory', { method: 'DELETE' })
    expect(bare.status).toBe(400)
    expect((await err(bare)).error).toBe('confirm_required')
    expect((await list(d)).total).toBe(2)
    const wrong = await d.call('/api/stage/memory?confirm=yes', { method: 'DELETE' })
    expect(wrong.status).toBe(400)
    expect((await list(d)).total).toBe(2)
    const r = await d.call('/api/stage/memory?confirm=all', { method: 'DELETE' })
    expect(r.status).toBe(200)
    expect(((await r.json()) as { result: { forgotten: number } }).result.forgotten).toBe(2)
    expect((await list(d)).total).toBe(0)
    expect(d.daemon.stage.hub.memoryDigest()).toBeUndefined()
    expect(d.daemon.store.listAudit(50).some((a) => /Forgot everything she remembered/.test(a.action) && a.detail === '2 items')).toBe(true)
  })

  it('works while the stage is switched off, although other stage changes are refused then', async () => {
    const d = await daemon()
    const id = remember(d, { kind: 'preference', text: 'Likes the camera wide while she works' })
    remember(d, { kind: 'relationship', text: 'Calls the user by a shortened name' })
    expect((await d.call('/api/settings/stage', { method: 'PUT', json: { on: false } })).status).toBe(200)
    expect((await d.call('/api/stage/scene/camera', { method: 'PUT', json: { shot: 'wide' } })).status).toBe(409)
    expect((await list(d)).total).toBe(2)
    expect((await d.call(`/api/stage/memory/${id}`, { method: 'DELETE' })).status).toBe(200)
    expect((await d.call('/api/stage/memory?confirm=all', { method: 'DELETE' })).status).toBe(200)
    expect((await list(d)).total).toBe(0)
  })

  it('shows an older stored row safely: a secret is masked, an unknown label counts as sensitive, odd numbers are clamped', async () => {
    const d = await daemon()
    const repo = d.daemon.stage.hub.stageStore.memoryRepo()
    repo.insert({ id: 'mem.old', kind: 'odd' as Kind, text: 'the key is sk-ant-api03-abcdefghijklmnop1234 ok', importance: 9, sensitivity: 'odd' as 'normal', tags: ['a'], createdAt: T_OLD, updatedAt: T_OLD, recallCount: 0 })
    const l = await list(d)
    const old = l.items.find((i) => i.id === 'mem.old')!
    expect(old.text).not.toContain('abcdefghijklmnop1234')
    expect(old).toMatchObject({ kind: 'episode', sensitivity: 'sensitive', importance: 5 })
    expect(l.bySensitivity.sensitive).toBe(1)
    expect(JSON.stringify(l)).not.toContain('abcdefghijklmnop1234')
  })

  it('one odd stored row never breaks the list or the way to forget it: a timestamp Date cannot hold, a huge text, a bad importance', async () => {
    const d = await daemon()
    const repo = d.daemon.stage.hub.stageStore.memoryRepo()
    const fine = remember(d, { kind: 'preference', text: 'Likes the camera wide while she works' })
    repo.insert({ id: 'mem.weird', kind: 'episode', text: 'x'.repeat(5000), importance: 0, sensitivity: 'normal', tags: Array.from({ length: 30 }, (_, i) => `t${i}`.repeat(30)), createdAt: Number.MAX_SAFE_INTEGER, updatedAt: -Number.MAX_SAFE_INTEGER, recallCount: 0 })
    const r = await d.call('/api/stage/memory')
    expect(r.status).toBe(200)
    const l = StageMemoryList.parse(await r.json()) // still validates against the schema the web client uses
    expect(l.total).toBe(2)
    const weird = l.items.find((i) => i.id === 'mem.weird')!
    expect(weird.text.length).toBeLessThanOrEqual(500)
    expect(weird.importance).toBe(1)
    expect(weird.tags).toHaveLength(8)
    expect(Date.parse(weird.createdAt)).toBe(0)
    expect((await d.call('/api/stage/memory/mem.weird', { method: 'DELETE' })).status).toBe(200) // and it can be forgotten
    expect((await list(d)).items.map((i) => i.id)).toEqual([fine])
  })

  it('returns at most the newest 500 items and still reports the true total', async () => {
    const d = await daemon()
    const repo = d.daemon.stage.hub.stageStore.memoryRepo()
    for (let i = 0; i < 520; i++) repo.insert({ id: `mem.bulk-${String(i).padStart(4, '0')}`, kind: 'episode', text: `moment ${i}`, importance: 1, sensitivity: 'normal', tags: [], createdAt: T_OLD + i * 1000, updatedAt: T_OLD + i * 1000, recallCount: 0 })
    const l = await list(d)
    expect(l.total).toBe(520)
    expect(l.items).toHaveLength(500)
    expect(l.items[0]?.id).toBe('mem.bulk-0519')
    expect(l.items[499]?.id).toBe('mem.bulk-0020')
  })
})

const T_OLD = Date.parse('2026-10-01T09:00:00.000Z')
