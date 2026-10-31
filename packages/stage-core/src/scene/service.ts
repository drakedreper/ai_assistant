/**
 * SceneService: the working scene (the cerebral void by default), its objects, constructs, anchors, cameras, lighting
 * and saved scene presets. Every mutation is validated first and returns the stage command(s) that mirror it.
 * Invariants: object and construct ids are unique across both; parents exist; no cycles; transforms are finite and
 * bounded; assets exist, are licensed for personal use and are props (the environment is an environment asset).
 */
import { Anchor, CameraShot, DataConstruct, LightingPreset, Scene, SceneObject } from '@ai-assistant/shared'
import type { Asset, Anchor as AnchorT, CameraShot as CameraShotT, DataConstruct as DataConstructT, LightingPreset as LightingT, Scene as SceneT, SceneObject as SceneObjectT, Transform } from '@ai-assistant/shared'
import type { AssetCatalog } from '../assets/catalog'
import type { SceneRepo } from './repo'
import { MAIN_SCENE_ID, buildCerebralVoid, buildVoidWithFurniture } from './void'
import { IDENTITY, composeTransforms, identityTransform, validateTransform } from './math'
import { isSafeId } from '../util/safe'
import { fail, ok } from '../util/result'
import type { Result } from '../util/result'
import type { Clock } from '../util/clock'
import { isoFromMs } from '../util/clock'
import type { IdGenerator } from '../util/ids'
import type { CommandDraft } from '../util/commands'

export type SceneCode =
  | 'no_scene'
  | 'invalid_input'
  | 'invalid_transform'
  | 'unknown_asset'
  | 'wrong_asset_kind'
  | 'licence'
  | 'duplicate_id'
  | 'not_found'
  | 'parent_missing'
  | 'cycle'
  | 'has_children'
  | 'invalid_scene'
  | 'preset_not_found'
  | 'camera_in_use'

export interface SceneDeps {
  repo: SceneRepo
  catalog: AssetCatalog
  clock: Clock
  newId: IdGenerator
}

export interface ObjectInput {
  id?: string
  assetId: string
  transform?: Transform
  parentId?: string | null
  role?: SceneObjectT['role']
  anchors?: AnchorT[]
  binding?: SceneObjectT['binding']
  visible?: boolean
}

export interface ObjectPatch {
  assetId?: string
  transform?: Transform
  parentId?: string | null
  role?: SceneObjectT['role']
  anchors?: AnchorT[]
  binding?: SceneObjectT['binding'] | null
  visible?: boolean
}

export interface SceneChange<T = undefined> {
  scene: SceneT
  value: T
  commands: CommandDraft[]
}

/** Shared-schema failures that concern a transform report as invalid_transform (zod rejects NaN/Infinity itself). */
function codeFor(issues: ReadonlyArray<{ path: PropertyKey[] }>): SceneCode {
  const geometric = new Set(['transform', 'local', 'position', 'rotation', 'scale'])
  return issues.some((i) => i.path.some((p) => typeof p === 'string' && geometric.has(p))) ? 'invalid_transform' : 'invalid_input'
}

const MAX_OBJECTS = 200
const MAX_CONSTRUCTS = 24

export class SceneService {
  constructor(private readonly deps: SceneDeps) {}

  private nowIso(): string {
    return isoFromMs(this.deps.clock.now())
  }

  // ------------------------------------------------------------------------------------------- scene lifecycle

  /** The working scene, if one exists. */
  getScene(): SceneT | undefined {
    return this.deps.repo.getActive()
  }

  /** The working scene; the cerebral void is created (and the seed scene presets installed) when none exists yet. */
  ensureVoid(): SceneT {
    const cur = this.deps.repo.getActive()
    if (cur) return cur
    return this.resetToVoid().scene
  }

  /** Replace the working scene by a fresh, empty cerebral void. */
  resetToVoid(): SceneChange {
    const scene = buildCerebralVoid(this.deps.clock.now())
    this.deps.repo.saveActive(scene)
    this.installSeedPresets()
    return { scene, value: undefined, commands: [this.sceneLoadCommand(scene)] }
  }

  /** Register the built-in scene presets ("void" and "void with seating") unless they already exist. */
  installSeedPresets(): void {
    const have = new Set(this.deps.repo.listPresets().map((p) => p.id))
    const now = this.deps.clock.now()
    if (!have.has('preset.void')) this.deps.repo.savePreset('preset.void', 'Cerebral void', buildCerebralVoid(now))
    if (!have.has('preset.void-seating')) this.deps.repo.savePreset('preset.void-seating', 'Void with seating', buildVoidWithFurniture(now))
  }

  /** Assets a stage needs to draw the scene: the environment and every placed object. */
  assetsFor(scene: SceneT): Asset[] {
    const ids = new Set<string>([scene.environmentAssetId, ...scene.objects.map((o) => o.assetId)])
    return [...ids].sort().map((id) => this.deps.catalog.get(id)).filter((a): a is NonNullable<typeof a> => !!a)
  }

  private sceneLoadCommand(scene: SceneT): CommandDraft {
    return { type: 'scene.load', scene, assets: this.assetsFor(scene) }
  }

  /** The `scene.load` command for the working scene (also used to resume after a reconnect). */
  loadCommand(): Result<CommandDraft, SceneCode> {
    const s = this.deps.repo.getActive()
    return s ? ok(this.sceneLoadCommand(s)) : fail('no_scene', 'there is no scene yet')
  }

  /** Every problem with a scene value (empty = valid). */
  validateScene(scene: unknown): string[] {
    const parsed = Scene.safeParse(scene)
    if (!parsed.success) return parsed.error.issues.map((i) => `${i.path.join('.') || 'scene'}: ${i.message}`)
    const s = parsed.data
    const issues: string[] = []
    const env = this.deps.catalog.get(s.environmentAssetId)
    if (!env) issues.push(`environment "${s.environmentAssetId}" is not in the catalog`)
    else if (env.kind !== 'environment') issues.push(`"${s.environmentAssetId}" is a ${env.kind}, not an environment`)
    const ids = new Set<string>()
    for (const o of s.objects) {
      if (!isSafeId(o.id)) issues.push(`object id "${o.id}" is not path-safe`)
      if (ids.has(o.id)) issues.push(`duplicate id "${o.id}"`)
      ids.add(o.id)
    }
    for (const c of s.constructs) {
      if (!isSafeId(c.id)) issues.push(`construct id "${c.id}" is not path-safe`)
      if (ids.has(c.id)) issues.push(`duplicate id "${c.id}"`)
      ids.add(c.id)
    }
    const byId = new Map(s.objects.map((o) => [o.id, o]))
    for (const o of s.objects) {
      const a = this.deps.catalog.get(o.assetId)
      if (!a) issues.push(`object "${o.id}": asset "${o.assetId}" is not in the catalog`)
      else if (a.kind !== 'prop') issues.push(`object "${o.id}": "${a.name}" is a ${a.kind}, not a prop`)
      if (o.parentId !== null && !byId.has(o.parentId)) issues.push(`object "${o.id}": parent "${o.parentId}" does not exist`)
      const t = validateTransform(o.transform, `object "${o.id}" transform`)
      if (!t.ok) issues.push(t.error)
      const aids = new Set<string>()
      for (const an of o.anchors) {
        if (aids.has(an.id)) issues.push(`object "${o.id}": duplicate anchor "${an.id}"`)
        aids.add(an.id)
      }
      // cycle check
      const seen = new Set<string>([o.id])
      let cur = o.parentId
      while (cur !== null && byId.has(cur)) {
        if (seen.has(cur)) {
          issues.push(`object "${o.id}" is part of a parent cycle`)
          break
        }
        seen.add(cur)
        cur = byId.get(cur)!.parentId
      }
    }
    const camIds = new Set<string>()
    for (const c of s.cameras) {
      if (camIds.has(c.id)) issues.push(`duplicate camera "${c.id}"`)
      camIds.add(c.id)
      const t = validateTransform(c.transform, `camera "${c.id}" transform`)
      if (!t.ok) issues.push(t.error)
    }
    if (!camIds.has(s.activeCameraId)) issues.push(`active camera "${s.activeCameraId}" does not exist`)
    for (const c of s.constructs) {
      const t = validateTransform(c.transform, `construct "${c.id}" transform`)
      if (!t.ok) issues.push(t.error)
    }
    return issues
  }

  // ----------------------------------------------------------------------------------------------- helpers

  private withScene<T>(fn: (scene: SceneT) => Result<{ value: T; commands: CommandDraft[] }, SceneCode>): Result<SceneChange<T>, SceneCode> {
    const scene = this.deps.repo.getActive()
    if (!scene) return fail('no_scene', 'there is no scene yet')
    const draft = structuredClone(scene)
    const r = fn(draft)
    if (!r.ok) return r
    draft.updatedAt = this.nowIso()
    this.deps.repo.saveActive(draft)
    return ok({ scene: draft, value: r.value.value, commands: r.value.commands })
  }

  private uniqueId(scene: SceneT, prefix: string, wanted?: string): Result<string, SceneCode> {
    const taken = new Set<string>([...scene.objects.map((o) => o.id), ...scene.constructs.map((c) => c.id)])
    if (wanted !== undefined) {
      if (!isSafeId(wanted)) return fail('invalid_input', `id "${wanted}" must be path-safe`)
      if (taken.has(wanted)) return fail('duplicate_id', `id "${wanted}" is already used in this scene`)
      return ok(wanted)
    }
    let id: string
    do id = this.deps.newId(prefix)
    while (taken.has(id))
    return ok(id)
  }

  private propAsset(assetId: string): Result<Asset, SceneCode> {
    const a = this.deps.catalog.get(assetId)
    if (!a) return fail('unknown_asset', `asset "${assetId}" is not in the catalog`)
    if (a.kind !== 'prop') return fail('wrong_asset_kind', `"${a.name}" is a ${a.kind}; only props can be placed as scene objects`)
    const lic = this.deps.catalog.canUse(assetId, 'personal')
    if (!lic.ok) return fail('licence', lic.reasons.join('; '))
    return ok(a)
  }

  private checkAnchors(anchors: unknown): Result<AnchorT[], SceneCode> {
    if (!Array.isArray(anchors)) return fail('invalid_input', 'anchors must be a list')
    if (anchors.length > 16) return fail('invalid_input', 'at most 16 anchors per object')
    const out: AnchorT[] = []
    const seen = new Set<string>()
    for (const raw of anchors) {
      const p = Anchor.safeParse(raw)
      if (!p.success) return fail(codeFor(p.error.issues), `anchor: ${p.error.issues[0]?.message ?? 'invalid'}`)
      if (!isSafeId(p.data.id)) return fail('invalid_input', `anchor id "${p.data.id}" must be path-safe`)
      if (seen.has(p.data.id)) return fail('duplicate_id', `anchor "${p.data.id}" is listed twice`)
      seen.add(p.data.id)
      const t = validateTransform(p.data.local, `anchor "${p.data.id}"`)
      if (!t.ok) return fail('invalid_transform', t.error)
      out.push({ ...p.data, local: t.value })
    }
    return ok(out)
  }

  private wouldCycle(scene: SceneT, id: string, newParent: string | null): boolean {
    let cur = newParent
    const byId = new Map(scene.objects.map((o) => [o.id, o]))
    const seen = new Set<string>()
    while (cur !== null) {
      if (cur === id) return true
      if (seen.has(cur)) return true
      seen.add(cur)
      cur = byId.get(cur)?.parentId ?? null
    }
    return false
  }

  // ------------------------------------------------------------------------------------------------ objects

  addObject(input: ObjectInput): Result<SceneChange<SceneObjectT>, SceneCode> {
    if (typeof input !== 'object' || input === null) return fail('invalid_input', 'object input must be an object')
    return this.withScene((scene) => {
      if (scene.objects.length >= MAX_OBJECTS) return fail('invalid_input', `at most ${MAX_OBJECTS} objects`)
      const asset = this.propAsset(input.assetId)
      if (!asset.ok) return asset
      const id = this.uniqueId(scene, 'obj', input.id)
      if (!id.ok) return id
      const t = validateTransform(input.transform ?? identityTransform(), 'transform')
      if (!t.ok) return fail('invalid_transform', t.error)
      const parentId = input.parentId ?? null
      if (parentId !== null && !scene.objects.some((o) => o.id === parentId)) return fail('parent_missing', `parent "${parentId}" does not exist`)
      const anchors = this.checkAnchors(input.anchors ?? [])
      if (!anchors.ok) return anchors
      const parsed = SceneObject.safeParse({
        id: id.value,
        assetId: input.assetId,
        transform: t.value,
        parentId,
        role: input.role ?? 'static',
        anchors: anchors.value,
        ...(input.binding ? { binding: input.binding } : {}),
        visible: input.visible ?? true,
      })
      if (!parsed.success) return fail(codeFor(parsed.error.issues), parsed.error.issues[0]?.message ?? 'invalid object')
      scene.objects.push(parsed.data)
      return ok({ value: parsed.data, commands: [{ type: 'scene.object', op: 'add', object: parsed.data, asset: asset.value }] })
    })
  }

  updateObject(id: string, patch: ObjectPatch): Result<SceneChange<SceneObjectT>, SceneCode> {
    if (typeof patch !== 'object' || patch === null) return fail('invalid_input', 'patch must be an object')
    return this.withScene((scene) => {
      const obj = scene.objects.find((o) => o.id === id)
      if (!obj) return fail('not_found', `object "${id}" does not exist`)
      let asset: Asset | undefined
      if (patch.assetId !== undefined) {
        const a = this.propAsset(patch.assetId)
        if (!a.ok) return a
        asset = a.value
        obj.assetId = patch.assetId
      }
      if (patch.transform !== undefined) {
        const t = validateTransform(patch.transform, 'transform')
        if (!t.ok) return fail('invalid_transform', t.error)
        obj.transform = t.value
      }
      if (patch.parentId !== undefined) {
        if (patch.parentId !== null) {
          if (!scene.objects.some((o) => o.id === patch.parentId)) return fail('parent_missing', `parent "${patch.parentId}" does not exist`)
          if (this.wouldCycle(scene, id, patch.parentId)) return fail('cycle', `making "${patch.parentId}" the parent of "${id}" would create a cycle`)
        }
        obj.parentId = patch.parentId
      }
      if (patch.role !== undefined) {
        if (!['static', 'furniture', 'interactable'].includes(patch.role)) return fail('invalid_input', 'unknown role')
        obj.role = patch.role
      }
      if (patch.anchors !== undefined) {
        const a = this.checkAnchors(patch.anchors)
        if (!a.ok) return a
        obj.anchors = a.value
      }
      if (patch.binding !== undefined) {
        if (patch.binding === null) delete obj.binding
        else {
          const p = SceneObject.shape.binding.safeParse(patch.binding)
          if (!p.success) return fail('invalid_input', 'binding is invalid')
          obj.binding = p.data
        }
      }
      if (patch.visible !== undefined) obj.visible = !!patch.visible
      const parsed = SceneObject.safeParse(obj)
      if (!parsed.success) return fail('invalid_input', parsed.error.issues[0]?.message ?? 'invalid object')
      scene.objects = scene.objects.map((o) => (o.id === id ? parsed.data : o))
      return ok({ value: parsed.data, commands: [{ type: 'scene.object', op: 'update', object: parsed.data, ...(asset ? { asset } : {}) }] })
    })
  }

  /** Remove an object. Children block the removal unless `cascade` is set (then they go too, deepest first). */
  removeObject(id: string, opts: { cascade?: boolean } = {}): Result<SceneChange<string[]>, SceneCode> {
    return this.withScene((scene) => {
      const obj = scene.objects.find((o) => o.id === id)
      if (!obj) return fail('not_found', `object "${id}" does not exist`)
      const order: string[] = []
      const collect = (pid: string): void => {
        for (const c of scene.objects.filter((o) => o.parentId === pid)) collect(c.id)
        order.push(pid)
      }
      collect(id)
      if (order.length > 1 && !opts.cascade) return fail('has_children', `"${id}" has ${order.length - 1} child object(s); remove them too with cascade`)
      const gone = new Set(order)
      const removed = order.map((oid) => scene.objects.find((o) => o.id === oid)!)
      scene.objects = scene.objects.filter((o) => !gone.has(o.id))
      return ok({ value: order, commands: removed.map((o): CommandDraft => ({ type: 'scene.object', op: 'remove', object: o })) })
    })
  }

  getObject(id: string): SceneObjectT | undefined {
    return this.deps.repo.getActive()?.objects.find((o) => o.id === id)
  }

  /** World transform of an object (parents composed). Undefined for unknown ids. */
  worldTransform(objectId: string): Transform | undefined {
    const scene = this.deps.repo.getActive()
    if (!scene) return undefined
    const byId = new Map(scene.objects.map((o) => [o.id, o]))
    const chain: SceneObjectT[] = []
    let cur = byId.get(objectId)
    const seen = new Set<string>()
    while (cur && !seen.has(cur.id)) {
      chain.unshift(cur)
      seen.add(cur.id)
      cur = cur.parentId ? byId.get(cur.parentId) : undefined
    }
    if (chain.length === 0) return undefined
    return chain.reduce<Transform>((acc, o) => composeTransforms(acc, o.transform), structuredClone(IDENTITY))
  }

  // ------------------------------------------------------------------------------------------------ anchors

  addAnchor(objectId: string, anchor: AnchorT): Result<SceneChange<AnchorT>, SceneCode> {
    const obj = this.getObject(objectId)
    if (!obj) return fail('not_found', `object "${objectId}" does not exist`)
    if (obj.anchors.some((a) => a.id === anchor?.id)) return fail('duplicate_id', `anchor "${String(anchor?.id)}" already exists on "${objectId}"`)
    const r = this.updateObject(objectId, { anchors: [...obj.anchors, anchor] })
    if (!r.ok) return r
    return ok({ ...r.value, value: r.value.value.anchors.find((a) => a.id === anchor.id)! })
  }

  removeAnchor(objectId: string, anchorId: string): Result<SceneChange<undefined>, SceneCode> {
    const obj = this.getObject(objectId)
    if (!obj) return fail('not_found', `object "${objectId}" does not exist`)
    if (!obj.anchors.some((a) => a.id === anchorId)) return fail('not_found', `anchor "${anchorId}" does not exist on "${objectId}"`)
    const r = this.updateObject(objectId, { anchors: obj.anchors.filter((a) => a.id !== anchorId) })
    if (!r.ok) return r
    return ok({ ...r.value, value: undefined })
  }

  listAnchors(filter: { kind?: AnchorT['kind'] } = {}): Array<{ objectId: string; anchor: AnchorT }> {
    const scene = this.deps.repo.getActive()
    if (!scene) return []
    const out: Array<{ objectId: string; anchor: AnchorT }> = []
    for (const o of scene.objects) for (const a of o.anchors) if (!filter.kind || a.kind === filter.kind) out.push({ objectId: o.id, anchor: a })
    return out
  }

  /** World transform of an anchor. */
  anchorWorld(objectId: string, anchorId: string): Transform | undefined {
    const w = this.worldTransform(objectId)
    const a = this.getObject(objectId)?.anchors.find((x) => x.id === anchorId)
    return w && a ? composeTransforms(w, a.local) : undefined
  }

  // ---------------------------------------------------------------------------------------------- constructs

  addConstruct(input: unknown): Result<SceneChange<DataConstructT>, SceneCode> {
    return this.withScene((scene) => {
      if (scene.constructs.length >= MAX_CONSTRUCTS) return fail('invalid_input', `at most ${MAX_CONSTRUCTS} constructs`)
      const wanted = typeof input === 'object' && input !== null ? (input as { id?: unknown }).id : undefined
      const generated = wanted === undefined ? this.uniqueId(scene, 'con') : undefined
      if (generated && !generated.ok) return generated
      const raw = typeof input === 'object' && input !== null && generated?.ok ? { ...input, id: generated.value } : input
      const parsed = DataConstruct.safeParse(raw)
      if (!parsed.success) return fail(codeFor(parsed.error.issues), `construct: ${parsed.error.issues[0]?.message ?? 'invalid'}`)
      const id = this.uniqueId(scene, 'con', parsed.data.id)
      if (!id.ok) return id
      const t = validateTransform(parsed.data.transform, 'construct transform')
      if (!t.ok) return fail('invalid_transform', t.error)
      const c: DataConstructT = { ...parsed.data, transform: t.value }
      scene.constructs.push(c)
      return ok({ value: c, commands: [{ type: 'scene.construct', op: 'add', construct: c }] })
    })
  }

  updateConstruct(id: string, patch: Partial<Pick<DataConstructT, 'transform' | 'query' | 'style' | 'interactive' | 'source'>>): Result<SceneChange<DataConstructT>, SceneCode> {
    return this.withScene((scene) => {
      const cur = scene.constructs.find((c) => c.id === id)
      if (!cur) return fail('not_found', `construct "${id}" does not exist`)
      const merged = { ...cur, ...patch }
      const parsed = DataConstruct.safeParse(merged)
      if (!parsed.success) return fail(codeFor(parsed.error.issues), `construct: ${parsed.error.issues[0]?.message ?? 'invalid'}`)
      const t = validateTransform(parsed.data.transform, 'construct transform')
      if (!t.ok) return fail('invalid_transform', t.error)
      const c: DataConstructT = { ...parsed.data, id, kind: cur.kind, transform: t.value }
      scene.constructs = scene.constructs.map((x) => (x.id === id ? c : x))
      return ok({ value: c, commands: [{ type: 'scene.construct', op: 'update', construct: c }] })
    })
  }

  removeConstruct(id: string): Result<SceneChange<undefined>, SceneCode> {
    return this.withScene((scene) => {
      const cur = scene.constructs.find((c) => c.id === id)
      if (!cur) return fail('not_found', `construct "${id}" does not exist`)
      scene.constructs = scene.constructs.filter((c) => c.id !== id)
      return ok({ value: undefined, commands: [{ type: 'scene.construct', op: 'remove', construct: cur }] })
    })
  }

  getConstruct(id: string): DataConstructT | undefined {
    return this.deps.repo.getActive()?.constructs.find((c) => c.id === id)
  }

  // -------------------------------------------------------------------------------------- cameras and lighting

  getCamera(id: string): CameraShotT | undefined {
    return this.deps.repo.getActive()?.cameras.find((c) => c.id === id)
  }

  /** Does the scene have a shot with this id? (named shots: wide, medium, closeup, profile, back, over_shoulder) */
  hasCamera(id: string): boolean {
    return !!this.getCamera(id)
  }

  setActiveCamera(cameraId: string, blendMs = 600): Result<SceneChange<CameraShotT>, SceneCode> {
    if (typeof blendMs !== 'number' || !Number.isFinite(blendMs) || blendMs < 0 || blendMs > 10_000) return fail('invalid_input', 'blendMs must be between 0 and 10000')
    return this.withScene((scene) => {
      const cam = scene.cameras.find((c) => c.id === cameraId)
      if (!cam) return fail('not_found', `no camera shot "${cameraId}" (shots: ${scene.cameras.map((c) => c.id).join(', ')})`)
      scene.activeCameraId = cameraId
      return ok({ value: cam, commands: [{ type: 'scene.camera', cameraId, blendMs }] })
    })
  }

  addCamera(shot: unknown): Result<SceneChange<CameraShotT>, SceneCode> {
    return this.withScene((scene) => {
      const parsed = CameraShot.safeParse(shot)
      if (!parsed.success) return fail(codeFor(parsed.error.issues), `camera: ${parsed.error.issues[0]?.message ?? 'invalid'}`)
      if (!isSafeId(parsed.data.id)) return fail('invalid_input', 'camera id must be path-safe')
      if (scene.cameras.some((c) => c.id === parsed.data.id)) return fail('duplicate_id', `camera "${parsed.data.id}" already exists`)
      const t = validateTransform(parsed.data.transform, 'camera transform')
      if (!t.ok) return fail('invalid_transform', t.error)
      if (scene.cameras.length >= 24) return fail('invalid_input', 'at most 24 camera shots')
      const cam = { ...parsed.data, transform: t.value }
      scene.cameras.push(cam)
      return ok({ value: cam, commands: [] })
    })
  }

  removeCamera(cameraId: string): Result<SceneChange<undefined>, SceneCode> {
    return this.withScene((scene) => {
      if (!scene.cameras.some((c) => c.id === cameraId)) return fail('not_found', `no camera shot "${cameraId}"`)
      if (scene.activeCameraId === cameraId) return fail('camera_in_use', 'the active camera cannot be removed')
      scene.cameras = scene.cameras.filter((c) => c.id !== cameraId)
      return ok({ value: undefined, commands: [] })
    })
  }

  setLighting(lighting: unknown): Result<SceneChange<LightingT>, SceneCode> {
    return this.withScene((scene) => {
      const parsed = LightingPreset.safeParse(lighting)
      if (!parsed.success) return fail('invalid_input', `lighting: ${parsed.error.issues[0]?.message ?? 'invalid'}`)
      scene.lighting = parsed.data
      return ok({ value: parsed.data, commands: [{ type: 'scene.lighting', lighting: parsed.data }] })
    })
  }

  // ---------------------------------------------------------------------------------------------- presets

  listPresets(): Array<{ id: string; name: string }> {
    return this.deps.repo.listPresets()
  }

  /** Save the working scene as a preset (overwrites the same id). */
  savePreset(id: string, name: string): Result<{ id: string; name: string }, SceneCode> {
    const scene = this.deps.repo.getActive()
    if (!scene) return fail('no_scene', 'there is no scene yet')
    if (!isSafeId(id)) return fail('invalid_input', 'preset id must be path-safe')
    const clean = typeof name === 'string' ? name.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 60) : ''
    if (clean.length === 0) return fail('invalid_input', 'a scene preset needs a name')
    this.deps.repo.savePreset(id, clean, { ...structuredClone(scene), name: clean })
    return ok({ id, name: clean })
  }

  /** Replace the working scene by a saved preset (validated first). Returns the `scene.load` command. */
  applyPreset(id: string): Result<SceneChange<{ id: string; name: string }>, SceneCode> {
    const preset = this.deps.repo.getPreset(id)
    if (!preset) return fail('preset_not_found', `no scene preset "${id}"`)
    const next: SceneT = { ...preset, id: MAIN_SCENE_ID, updatedAt: this.nowIso() }
    const issues = this.validateScene(next)
    if (issues.length > 0) return fail('invalid_scene', `scene preset "${id}" cannot be loaded: ${issues.join('; ')}`)
    this.deps.repo.saveActive(next)
    return ok({ scene: next, value: { id, name: preset.name }, commands: [this.sceneLoadCommand(next)] })
  }

  deletePreset(id: string): Result<true, SceneCode> {
    return this.deps.repo.deletePreset(id) ? ok(true) : fail('preset_not_found', `no scene preset "${id}"`)
  }

  /** A free spot for a new object: golden-angle ring around the origin (deterministic, never on top of another object). */
  suggestPlacement(): Transform {
    const scene = this.deps.repo.getActive()
    const n = scene ? scene.objects.filter((o) => o.parentId === null).length : 0
    const angle = n * 2.399963229728653 + Math.PI / 6
    const radius = 2.2 + 0.35 * Math.floor(n / 6)
    const t = identityTransform()
    t.position = [Math.round(Math.cos(angle) * radius * 1000) / 1000, 0, Math.round(Math.sin(angle) * radius * 1000) / 1000]
    return t
  }
}

export function createSceneService(deps: SceneDeps): SceneService {
  return new SceneService(deps)
}

