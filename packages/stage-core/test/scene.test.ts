import { describe, expect, it } from 'vitest'
import {
  InMemorySceneRepo,
  SEED_IDS as S,
  SHOT_IDS,
  buildCameraShots,
  buildCerebralVoid,
  composeTransforms,
  createSceneService,
  lookAtQuat,
  quatFromYaw,
  quatLength,
  quatMul,
  rotateVec,
  validateTransform,
} from '../src'
import type { Transform } from '@ai-assistant/shared'
import { Scene } from '@ai-assistant/shared'
import { makeWorld } from './helpers'

function setup() {
  const w = makeWorld()
  const repo = new InMemorySceneRepo()
  const scenes = createSceneService({ repo, catalog: w.catalog, clock: w.vt.clock, newId: w.newId })
  scenes.ensureVoid()
  return { ...w, repo, scenes }
}
const T = (x = 0, y = 0, z = 0): Transform => ({ position: [x, y, z], rotation: [0, 0, 0, 1], scale: [1, 1, 1] })

describe('quaternion and transform maths', () => {
  it('rotates vectors correctly', () => {
    const q = quatFromYaw(Math.PI / 2) // +Z -> +X
    const v = rotateVec(q, [0, 0, 1])
    expect(v[0]).toBeCloseTo(1)
    expect(v[2]).toBeCloseTo(0)
    expect(rotateVec([0, 0, 0, 1], [1, 2, 3])).toEqual([1, 2, 3])
  })
  it('lookAt: a camera at +Z looking at the origin looks down -Z (180 degree yaw)', () => {
    const q = lookAtQuat([0, 0, 5], [0, 0, 0])
    const fwd = rotateVec(q, [0, 0, -1]) // camera forward in world
    expect(fwd[0]).toBeCloseTo(0)
    expect(fwd[1]).toBeCloseTo(0)
    expect(fwd[2]).toBeCloseTo(-1)
    expect(quatLength(q)).toBeCloseTo(1)
  })
  it('lookAt points the camera forward axis at the target for many positions (property)', () => {
    for (let i = 0; i < 200; i++) {
      const eye: [number, number, number] = [Math.sin(i) * 5, 1 + (i % 7) * 0.3, Math.cos(i * 1.7) * 5]
      const target: [number, number, number] = [0.3, 1.2, -0.2]
      const fwd = rotateVec(lookAtQuat(eye, target), [0, 0, -1])
      const d = [target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]]
      const l = Math.hypot(...d)
      expect(fwd[0]).toBeCloseTo(d[0]! / l, 5)
      expect(fwd[1]).toBeCloseTo(d[1]! / l, 5)
      expect(fwd[2]).toBeCloseTo(d[2]! / l, 5)
    }
  })
  it('degenerate lookAt (same point, or looking straight up) stays finite', () => {
    for (const q of [lookAtQuat([1, 1, 1], [1, 1, 1]), lookAtQuat([0, 0, 0], [0, 5, 0]), lookAtQuat([0, 0, 0], [0, -5, 0])]) {
      expect(q.every(Number.isFinite)).toBe(true)
      expect(quatLength(q)).toBeCloseTo(1)
    }
  })
  it('composes parent and child transforms', () => {
    const parent: Transform = { position: [1, 0, 0], rotation: quatFromYaw(Math.PI / 2), scale: [2, 2, 2] }
    const child = T(0, 0, 1)
    const w = composeTransforms(parent, child)
    expect(w.position[0]).toBeCloseTo(1 + 2) // child +Z becomes +X, scaled by 2
    expect(w.position[2]).toBeCloseTo(0)
    expect(w.scale).toEqual([2, 2, 2])
    expect(quatLength(w.rotation)).toBeCloseTo(1)
    const q = quatMul(quatFromYaw(0.3), quatFromYaw(0.4))
    expect(q[1]).toBeCloseTo(Math.sin(0.35))
  })
  it.each([
    [{ position: [NaN, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }],
    [{ position: [Infinity, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }],
    [{ position: [0, 0, 0], rotation: [0, 0, 0, 0], scale: [1, 1, 1] }],
    [{ position: [0, 0, 0], rotation: [0, 0, 0, NaN], scale: [1, 1, 1] }],
    [{ position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [0, 1, 1] }],
    [{ position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [-1, 1, 1] }],
    [{ position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1e6, 1, 1] }],
    [{ position: [5000, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }],
    [{ position: [0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }],
    [{ position: ['0', 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }],
    [null],
    [5],
    [{}],
  ])('rejects transform %j', (t) => {
    expect(validateTransform(t).ok).toBe(false)
  })
  it('normalises quaternions', () => {
    const r = validateTransform({ position: [0, 0, 0], rotation: [0, 0, 0, 5], scale: [1, 1, 1] })
    expect(r.ok && r.value.rotation).toEqual([0, 0, 0, 1])
  })
})

describe('cerebral void', () => {
  it('matches the shared Scene schema, with the void look', () => {
    const v = buildCerebralVoid(Date.UTC(2026, 10, 2))
    expect(Scene.safeParse(v).success).toBe(true)
    expect(v.environmentAssetId).toBe('env.cerebral-void')
    expect(v.objects).toEqual([])
    expect(v.lighting).toMatchObject({ mode: 'fixed', look: 'void' })
    expect(v.lighting.atmosphere).toMatchObject({ ground: 'void', fogColor: '#0a1a3a', volumetrics: true, vignette: 0.7 })
    expect(v.lighting.atmosphere!.floorPool.radius).toBe(2.2)
    expect(v.lighting.atmosphere!.dustMotes).toBeGreaterThan(0)
    expect(v.activeCameraId).toBe('wide')
  })
  it('fog is dark navy (low red and green, higher blue)', () => {
    const hex = buildCerebralVoid(0).lighting.atmosphere!.fogColor
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
    expect(b!).toBeGreaterThan(g!)
    expect(g!).toBeGreaterThan(r!)
    expect(b!).toBeLessThan(100)
  })
  it('has the six named camera shots with sane transforms and fov', () => {
    const cams = buildCameraShots()
    expect(cams.map((c) => c.id)).toEqual([...SHOT_IDS])
    for (const c of cams) {
      expect(validateTransform(c.transform).ok).toBe(true)
      expect(c.fovDeg).toBeGreaterThanOrEqual(10)
      expect(c.fovDeg).toBeLessThanOrEqual(120)
      // every shot looks at (or near) the character at the origin region, except over_shoulder which looks out at constructs
      const fwd = rotateVec(c.transform.rotation as [number, number, number, number], [0, 0, -1])
      const toChar = [-c.transform.position[0], 1.3 - c.transform.position[1], -c.transform.position[2]]
      const l = Math.hypot(...toChar)
      const dot = (fwd[0] * toChar[0]! + fwd[1] * toChar[1]! + fwd[2] * toChar[2]!) / l
      if (c.id === 'over_shoulder') expect(dot).toBeGreaterThan(0.2)
      else expect(dot).toBeGreaterThan(0.95)
    }
    const dist = (id: string) => Math.hypot(...(cams.find((c) => c.id === id)!.transform.position as [number, number, number]))
    expect(dist('wide')).toBeGreaterThan(dist('medium'))
    expect(dist('medium')).toBeGreaterThan(dist('closeup'))
    const fov = (id: string) => cams.find((c) => c.id === id)!.fovDeg
    expect(fov('wide')).toBeGreaterThan(fov('closeup'))
    const closeup = cams.find((c) => c.id === 'closeup')!
    expect(closeup.depthOfField).toBeGreaterThan(cams.find((c) => c.id === 'wide')!.depthOfField)
    // back is behind her, profile is to her side, over-shoulder is behind her
    expect(cams.find((c) => c.id === 'back')!.transform.position[2]).toBeLessThan(0)
    expect(Math.abs(cams.find((c) => c.id === 'profile')!.transform.position[0])).toBeGreaterThan(1)
    expect(cams.find((c) => c.id === 'over_shoulder')!.transform.position[2]).toBeLessThan(0)
  })
})

describe('SceneService lifecycle', () => {
  it('creates the void when none exists and is idempotent', () => {
    const w = makeWorld()
    const repo = new InMemorySceneRepo()
    const scenes = createSceneService({ repo, catalog: w.catalog, clock: w.vt.clock, newId: w.newId })
    expect(scenes.getScene()).toBeUndefined()
    expect(scenes.loadCommand()).toMatchObject({ ok: false, code: 'no_scene' })
    expect(scenes.addObject({ assetId: S.chair })).toMatchObject({ ok: false, code: 'no_scene' })
    const a = scenes.ensureVoid()
    const b = scenes.ensureVoid()
    expect(a).toEqual(b)
    expect(scenes.listPresets().map((p) => p.id)).toEqual(['preset.void', 'preset.void-seating'])
  })
  it('loadCommand carries the scene and its assets', () => {
    const { scenes } = setup()
    scenes.addObject({ assetId: S.chair })
    const r = scenes.loadCommand()
    expect(r.ok).toBe(true)
    if (!r.ok || r.value.type !== 'scene.load') throw new Error('bad')
    expect(r.value.assets.map((a) => a.id)).toEqual([S.void, S.chair].sort())
  })
  it('validates its own scenes', () => {
    const { scenes } = setup()
    expect(scenes.validateScene(scenes.getScene())).toEqual([])
    const bad = scenes.getScene()!
    bad.activeCameraId = 'zzz'
    bad.environmentAssetId = S.chair
    expect(scenes.validateScene(bad).join(' ')).toMatch(/active camera.*does not exist.*not an environment|not an environment.*active camera/s)
    expect(scenes.validateScene({ nope: 1 }).length).toBeGreaterThan(0)
  })
})

describe('objects', () => {
  it('adds with defaults, generating ids, and returns the scene.object command with the asset', () => {
    const { scenes } = setup()
    const r = scenes.addObject({ assetId: S.chair, transform: T(1, 0, 2) })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.value).toMatchObject({ assetId: S.chair, parentId: null, role: 'static', visible: true })
    expect(r.value.value.id).toMatch(/^obj_/)
    expect(r.value.commands[0]).toMatchObject({ type: 'scene.object', op: 'add' })
    expect((r.value.commands[0] as { asset: { id: string } }).asset.id).toBe(S.chair)
    expect(scenes.getScene()!.objects).toHaveLength(1)
  })
  it('keeps ids unique across objects AND constructs, and rejects unsafe ids', () => {
    const { scenes } = setup()
    expect(scenes.addObject({ id: 'a', assetId: S.chair }).ok).toBe(true)
    expect(scenes.addObject({ id: 'a', assetId: S.chair })).toMatchObject({ ok: false, code: 'duplicate_id' })
    expect(scenes.addConstruct({ id: 'a', kind: 'knowledge_graph', transform: T(), source: 'brain' })).toMatchObject({ ok: false, code: 'duplicate_id' })
    expect(scenes.addConstruct({ id: 'g', kind: 'knowledge_graph', transform: T(), source: 'brain' }).ok).toBe(true)
    expect(scenes.addObject({ id: 'g', assetId: S.chair })).toMatchObject({ ok: false, code: 'duplicate_id' })
    expect(scenes.addObject({ id: '../x', assetId: S.chair })).toMatchObject({ ok: false, code: 'invalid_input' })
    expect(scenes.addObject({ id: '__proto__', assetId: S.chair }).ok).toBe(false)
  })
  it.each([
    ['unknown asset', { assetId: 'nope' }, 'unknown_asset'],
    ['wearable', { assetId: S.blazer }, 'wrong_asset_kind'],
    ['environment', { assetId: S.void }, 'wrong_asset_kind'],
    ['NaN position', { assetId: S.chair, transform: T(NaN) }, 'invalid_transform'],
    ['Infinity scale', { assetId: S.chair, transform: { ...T(), scale: [Infinity, 1, 1] } }, 'invalid_transform'],
    ['missing parent', { assetId: S.chair, parentId: 'ghost' }, 'parent_missing'],
    ['bad anchor kind', { assetId: S.chair, anchors: [{ id: 'x', kind: 'fly', local: T() }] }, 'invalid_input'],
    ['duplicate anchors', { assetId: S.chair, anchors: [{ id: 'x', kind: 'sit', local: T() }, { id: 'x', kind: 'sit', local: T() }] }, 'duplicate_id'],
    ['anchor with a NaN transform', { assetId: S.chair, anchors: [{ id: 'x', kind: 'sit', local: T(NaN) }] }, 'invalid_transform'],
    ['bad binding', { assetId: S.chair, binding: { source: 'nope' } }, 'invalid_input'],
  ])('refuses %s', (_n, input, code) => {
    const { scenes } = setup()
    const r = scenes.addObject(input as never)
    expect(!r.ok && r.code).toBe(code)
    expect(scenes.getScene()!.objects).toHaveLength(0)
  })
  it('refuses a prop whose licence forbids personal use, and non-object input', () => {
    const { scenes, catalog } = setup()
    catalog.add({ id: 'prop.locked', kind: 'prop', name: 'Locked', locator: 'p/l', license: { id: 'EULA', personalUse: false, commercialUse: false, redistribution: false } })
    expect(scenes.addObject({ assetId: 'prop.locked' })).toMatchObject({ ok: false, code: 'licence' })
    expect(scenes.addObject(null as never).ok).toBe(false)
  })
  it('updates transform, role, visibility, binding, asset and anchors; stamps updatedAt', () => {
    const { scenes, vt } = setup()
    scenes.addObject({ id: 'a', assetId: S.chair })
    const t0 = scenes.getScene()!.updatedAt
    vt.advance(5000)
    const r = scenes.updateObject('a', { transform: T(3, 0, 3), role: 'furniture', visible: false, binding: { source: 'work' }, assetId: S.plinth })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.value).toMatchObject({ role: 'furniture', visible: false, binding: { source: 'work' }, assetId: S.plinth })
    expect((r.value.commands[0] as { asset?: { id: string } }).asset?.id).toBe(S.plinth)
    expect(scenes.getScene()!.updatedAt > t0).toBe(true)
    const cleared = scenes.updateObject('a', { binding: null })
    expect(cleared.ok && cleared.value.value.binding).toBeUndefined()
    expect(scenes.updateObject('ghost', {})).toMatchObject({ ok: false, code: 'not_found' })
    expect(scenes.updateObject('a', { transform: T(NaN) })).toMatchObject({ ok: false, code: 'invalid_transform' })
    expect(scenes.updateObject('a', { role: 'x' as never }).ok).toBe(false)
    expect(scenes.updateObject('a', { assetId: S.blazer })).toMatchObject({ ok: false, code: 'wrong_asset_kind' })
    expect(scenes.getObject('a')!.assetId).toBe(S.plinth) // failed updates changed nothing
  })
  it('parents objects, rejects missing parents and every kind of cycle', () => {
    const { scenes } = setup()
    scenes.addObject({ id: 'a', assetId: S.plinth })
    scenes.addObject({ id: 'b', assetId: S.chair, parentId: 'a' })
    scenes.addObject({ id: 'c', assetId: S.chair, parentId: 'b' })
    expect(scenes.updateObject('a', { parentId: 'c' })).toMatchObject({ ok: false, code: 'cycle' })
    expect(scenes.updateObject('a', { parentId: 'b' })).toMatchObject({ ok: false, code: 'cycle' })
    expect(scenes.updateObject('a', { parentId: 'a' })).toMatchObject({ ok: false, code: 'cycle' })
    expect(scenes.updateObject('c', { parentId: 'zzz' })).toMatchObject({ ok: false, code: 'parent_missing' })
    expect(scenes.updateObject('c', { parentId: 'a' }).ok).toBe(true)
    expect(scenes.updateObject('c', { parentId: null }).ok).toBe(true)
  })
  it('removing an object with children needs cascade, which removes deepest first', () => {
    const { scenes } = setup()
    scenes.addObject({ id: 'a', assetId: S.plinth })
    scenes.addObject({ id: 'b', assetId: S.chair, parentId: 'a' })
    scenes.addObject({ id: 'c', assetId: S.chair, parentId: 'b' })
    scenes.addObject({ id: 'd', assetId: S.chair })
    expect(scenes.removeObject('a')).toMatchObject({ ok: false, code: 'has_children' })
    const r = scenes.removeObject('a', { cascade: true })
    expect(r.ok && r.value.value).toEqual(['c', 'b', 'a'])
    expect(r.ok && r.value.commands.map((c) => (c as { object: { id: string } }).object.id)).toEqual(['c', 'b', 'a'])
    expect(scenes.getScene()!.objects.map((o) => o.id)).toEqual(['d'])
    expect(scenes.removeObject('zzz')).toMatchObject({ ok: false, code: 'not_found' })
  })
  it('is bounded', () => {
    const { scenes } = setup()
    for (let i = 0; i < 200; i++) expect(scenes.addObject({ assetId: S.chair }).ok).toBe(true)
    expect(scenes.addObject({ assetId: S.chair }).ok).toBe(false)
  })
  it('random valid and invalid operations never leave an invalid scene (property)', () => {
    const { scenes } = setup()
    let seed = 7
    const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296)
    for (let i = 0; i < 400; i++) {
      const ids = scenes.getScene()!.objects.map((o) => o.id)
      const pick = () => (rnd() < 0.1 ? 'ghost' : ids[Math.floor(rnd() * ids.length)] ?? 'ghost')
      const roll = rnd()
      if (roll < 0.35) scenes.addObject({ assetId: rnd() < 0.9 ? S.chair : S.blazer, parentId: rnd() < 0.4 ? pick() : null, transform: T((rnd() - 0.5) * (rnd() < 0.05 ? Infinity : 10)) })
      else if (roll < 0.7) scenes.updateObject(pick(), { parentId: rnd() < 0.8 ? pick() : null })
      else scenes.removeObject(pick(), { cascade: rnd() < 0.5 })
      expect(scenes.validateScene(scenes.getScene())).toEqual([])
    }
  })
})

describe('anchors and world transforms', () => {
  it('adds, lists, removes and resolves anchors to world space', () => {
    const { scenes } = setup()
    scenes.addObject({ id: 'chair', assetId: S.chair, transform: { position: [2, 0, 0], rotation: quatFromYaw(Math.PI / 2), scale: [1, 1, 1] } })
    const a = scenes.addAnchor('chair', { id: 'seat', kind: 'sit', local: T(0, 0.45, 0.2) })
    expect(a.ok && a.value.value.id).toBe('seat')
    expect(scenes.addAnchor('chair', { id: 'seat', kind: 'sit', local: T() })).toMatchObject({ ok: false, code: 'duplicate_id' })
    expect(scenes.addAnchor('zzz', { id: 'x', kind: 'sit', local: T() })).toMatchObject({ ok: false, code: 'not_found' })
    expect(scenes.listAnchors({ kind: 'sit' })).toEqual([{ objectId: 'chair', anchor: expect.objectContaining({ id: 'seat' }) }])
    expect(scenes.listAnchors({ kind: 'lie' })).toEqual([])
    const w = scenes.anchorWorld('chair', 'seat')!
    expect(w.position[0]).toBeCloseTo(2.2) // local +Z rotated to +X
    expect(w.position[1]).toBeCloseTo(0.45)
    expect(scenes.anchorWorld('chair', 'nope')).toBeUndefined()
    expect(scenes.removeAnchor('chair', 'seat').ok).toBe(true)
    expect(scenes.removeAnchor('chair', 'seat')).toMatchObject({ ok: false, code: 'not_found' })
  })
  it('composes parent chains', () => {
    const { scenes } = setup()
    scenes.addObject({ id: 'p', assetId: S.plinth, transform: T(1, 0, 0) })
    scenes.addObject({ id: 'c', assetId: S.chair, parentId: 'p', transform: T(0, 1, 0) })
    expect(scenes.worldTransform('c')!.position).toEqual([1, 1, 0])
    expect(scenes.worldTransform('zzz')).toBeUndefined()
  })
})

describe('constructs', () => {
  it('adds, updates (kind is fixed) and removes, with commands', () => {
    const { scenes } = setup()
    const a = scenes.addConstruct({ id: 'g', kind: 'knowledge_graph', transform: T(0, 1.5, 3), source: 'brain' })
    expect(a.ok && a.value.commands[0]).toMatchObject({ type: 'scene.construct', op: 'add' })
    expect(a.ok && a.value.value.style).toEqual({ palette: 'cool', density: 0.5, scale: 1 })
    const u = scenes.updateConstruct('g', { style: { palette: 'warm', density: 0.9, scale: 2 }, transform: T(1, 1, 1) })
    expect(u.ok && u.value.value).toMatchObject({ kind: 'knowledge_graph', style: { palette: 'warm' } })
    expect(scenes.updateConstruct('zzz', {})).toMatchObject({ ok: false, code: 'not_found' })
    expect(scenes.updateConstruct('g', { transform: T(NaN) })).toMatchObject({ ok: false, code: 'invalid_transform' })
    expect(scenes.addConstruct({ kind: 'nope' }).ok).toBe(false)
    expect(scenes.addConstruct({ id: 'x', kind: 'terminal_pane', transform: T(NaN), source: 'terminal' })).toMatchObject({ ok: false, code: 'invalid_transform' })
    expect(scenes.getConstruct('g')!.id).toBe('g')
    const r = scenes.removeConstruct('g')
    expect(r.ok && r.value.commands[0]).toMatchObject({ type: 'scene.construct', op: 'remove' })
    expect(scenes.removeConstruct('g')).toMatchObject({ ok: false, code: 'not_found' })
  })
  it('is bounded', () => {
    const { scenes } = setup()
    for (let i = 0; i < 24; i++) expect(scenes.addConstruct({ kind: 'mail_stream', transform: T(), source: 'life' }).ok).toBe(true)
    expect(scenes.addConstruct({ kind: 'mail_stream', transform: T(), source: 'life' }).ok).toBe(false)
  })
})

describe('cameras and lighting', () => {
  it('switches the active camera with a blend and rejects unknown shots', () => {
    const { scenes } = setup()
    const r = scenes.setActiveCamera('closeup', 900)
    expect(r.ok && r.value.commands).toEqual([{ type: 'scene.camera', cameraId: 'closeup', blendMs: 900 }])
    expect(scenes.getScene()!.activeCameraId).toBe('closeup')
    const bad = scenes.setActiveCamera('nope')
    expect(!bad.ok && bad.error).toMatch(/wide, medium, closeup/)
    expect(scenes.setActiveCamera('wide', NaN).ok).toBe(false)
    expect(scenes.setActiveCamera('wide', -1).ok).toBe(false)
    expect(scenes.setActiveCamera('wide', 1e9).ok).toBe(false)
    expect(scenes.hasCamera('profile')).toBe(true)
    expect(scenes.hasCamera('nope')).toBe(false)
    expect(scenes.getCamera('back')!.id).toBe('back')
  })
  it('adds and removes custom shots but never the active one', () => {
    const { scenes } = setup()
    const shot = { id: 'low', name: 'Low', transform: T(0, 0.3, 3), fovDeg: 40 }
    expect(scenes.addCamera(shot).ok).toBe(true)
    expect(scenes.addCamera(shot)).toMatchObject({ ok: false, code: 'duplicate_id' })
    expect(scenes.addCamera({ ...shot, id: 'x', fovDeg: 500 }).ok).toBe(false)
    expect(scenes.addCamera({ ...shot, id: 'y', transform: T(NaN) })).toMatchObject({ ok: false, code: 'invalid_transform' })
    scenes.setActiveCamera('low')
    expect(scenes.removeCamera('low')).toMatchObject({ ok: false, code: 'camera_in_use' })
    scenes.setActiveCamera('wide')
    expect(scenes.removeCamera('low').ok).toBe(true)
    expect(scenes.removeCamera('low')).toMatchObject({ ok: false, code: 'not_found' })
  })
  it('sets lighting', () => {
    const { scenes } = setup()
    const r = scenes.setLighting({ id: 'night', name: 'Night', mode: 'fixed', look: 'night' })
    expect(r.ok && r.value.commands[0]).toMatchObject({ type: 'scene.lighting' })
    expect(scenes.setLighting({ id: 'x', mode: 'weird' }).ok).toBe(false)
    expect(scenes.getScene()!.lighting.look).toBe('night')
  })
})

describe('scene presets', () => {
  it('saves the working scene and applies it later, returning scene.load', () => {
    const { scenes } = setup()
    scenes.addObject({ id: 'a', assetId: S.chair })
    scenes.setActiveCamera('profile')
    expect(scenes.savePreset('preset.mine', '  My room  ')).toEqual({ ok: true, value: { id: 'preset.mine', name: 'My room' } })
    scenes.resetToVoid()
    expect(scenes.getScene()!.objects).toHaveLength(0)
    const r = scenes.applyPreset('preset.mine')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.scene.objects.map((o) => o.id)).toEqual(['a'])
    expect(r.value.scene.activeCameraId).toBe('profile')
    expect(r.value.scene.name).toBe('My room')
    expect(r.value.commands[0]!.type).toBe('scene.load')
    expect(scenes.getScene()!.id).toBe('scene.main')
  })
  it('applies the seed presets (the seating one has sit, lean and look anchors)', () => {
    const { scenes } = setup()
    expect(scenes.applyPreset('preset.void-seating').ok).toBe(true)
    expect(scenes.listAnchors({ kind: 'sit' })).toHaveLength(1)
    expect(scenes.listAnchors({ kind: 'lean' })).toHaveLength(1)
    expect(scenes.listAnchors({ kind: 'look' })).toHaveLength(1)
    expect(scenes.validateScene(scenes.getScene())).toEqual([])
    expect(scenes.applyPreset('preset.void').ok).toBe(true)
    expect(scenes.getScene()!.objects).toEqual([])
  })
  it('refuses a preset whose assets disappeared, leaving the scene untouched', () => {
    const { scenes, catalog } = setup()
    catalog.remove(S.chair)
    const before = scenes.getScene()
    const r = scenes.applyPreset('preset.void-seating')
    expect(r).toMatchObject({ ok: false, code: 'invalid_scene' })
    expect(scenes.getScene()).toEqual(before)
  })
  it('validates ids and names, lists, and deletes', () => {
    const { scenes } = setup()
    expect(scenes.savePreset('../x', 'X')).toMatchObject({ ok: false })
    expect(scenes.savePreset('p1', '  ')).toMatchObject({ ok: false })
    expect(scenes.applyPreset('zzz')).toMatchObject({ ok: false, code: 'preset_not_found' })
    scenes.savePreset('p1', 'One')
    expect(scenes.listPresets().map((p) => p.id)).toContain('p1')
    expect(scenes.deletePreset('p1').ok).toBe(true)
    expect(scenes.deletePreset('p1')).toMatchObject({ ok: false, code: 'preset_not_found' })
  })
})

describe('placement', () => {
  it('suggests distinct, finite, deterministic spots', () => {
    const { scenes } = setup()
    const seen = new Set<string>()
    for (let i = 0; i < 20; i++) {
      const t = scenes.suggestPlacement()
      expect(t.position.every(Number.isFinite)).toBe(true)
      expect(Math.hypot(t.position[0], t.position[2])).toBeGreaterThan(2)
      seen.add(t.position.join(','))
      scenes.addObject({ assetId: S.chair, transform: t })
    }
    expect(seen.size).toBe(20)
  })
})
