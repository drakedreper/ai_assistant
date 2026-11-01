import { STAGE_MEMORY_LIST_LIMIT, type CharacterProfile, type OutfitPreset, type PresenceStyle, type SceneObject, type StageMemoryItem, type StageMemoryList, type StageOutfitSuggestion, type WardrobeSlot } from '@ai-assistant/shared'
import type { StageOutfitSuggestRequest, StagePresenceRequest, StageSceneObjectAddRequest, StageSceneObjectUpdateRequest } from '@ai-assistant/shared'
import { quatFromYaw, roundQuat, type CommandDraft, type MemoryItem, type ObjectInput, type ObjectPatch } from '@ai-assistant/stage-core'
import { redactText } from '../store/redact'
import type { StageHub } from './hub'

/**
 * Every state-changing operation behind the stage REST routes, in one place, so the routes stay thin and the tests can
 * call the same code. Each one: checks the switch, validates (the stage-core services judge the adult envelope, the
 * licence, the slot rules and the clothed baseline; this layer adds the range check that REFUSES instead of clamping),
 * persists through the services, hands the resulting commands to the stage, audits (refusals too) and tells the
 * dashboards.
 *
 * Nothing here ever returns a partial success: a refused change changes nothing.
 */

export type ActionFail = { ok: false; status: 400 | 403 | 404 | 409 | 422; code: string; message: string; details?: unknown }
export type ActionOk<T> = { ok: true; value: T; /** Commands handed to the connected stage (0 when none is connected). */ sent: number }
export type ActionResult<T> = ActionOk<T> | ActionFail

/** The catalog is metadata for a handful of content packs; this stops a runaway client from filling the database. */
export const MAX_CATALOG_ENTRIES = 500

const NOT_FOUND = new Set(['not_found', 'unknown_asset', 'preset_not_found', 'no_scene'])
const CONFLICT = new Set(['duplicate', 'duplicate_id', 'has_children', 'camera_in_use', 'last_assistant', 'stage_busy', 'catalog_full'])

/** stage-core codes -> HTTP status. Policy refusals (adult envelope, licence, baseline, slot rules) are 422. */
export function statusOf(code: string): 404 | 409 | 422 {
  if (NOT_FOUND.has(code)) return 404
  if (CONFLICT.has(code)) return 409
  return 422
}

const fail = (status: ActionFail['status'], code: string, message: string, details?: unknown): ActionFail => ({ ok: false, status, code, message, ...(details !== undefined ? { details } : {}) })
const failFrom = (code: string, message: string): ActionFail => fail(statusOf(code), code, message)

export class StageActions {
  constructor(private readonly hub: StageHub) {}

  private guard(): ActionFail | undefined {
    return this.hub.enabled() ? undefined : fail(409, 'stage_disabled', 'The stage is switched off. Turn it on in Settings, Stage.')
  }

  private done<T>(value: T, cmds: readonly CommandDraft[] = []): ActionOk<T> {
    const sent = this.hub.isConnected() ? cmds.length : 0
    void this.hub.deliver(cmds, { ack: true })
    return { ok: true, value, sent }
  }

  /** A refused change is recorded too: the audit log shows what was asked and why it did not happen. */
  private refused(action: string, target: string, f: ActionFail): ActionFail {
    this.hub.audit({ action, target, outcome: 'blocked', detail: `${f.code}: ${f.message}`.slice(0, 180) })
    return f
  }

  private character(id: string): CharacterProfile | ActionFail {
    return this.hub.characters.get(id) ?? fail(404, 'not_found', `No character "${id}".`)
  }

  // ---------------------------------------------------------------------------------------------- switch

  setEnabled(on: boolean): ActionResult<{ enabled: boolean }> {
    this.hub.setEnabled(on)
    return { ok: true, value: { enabled: this.hub.enabled() }, sent: 0 }
  }

  /** Close the current stage connection (the stage may reconnect). */
  disconnect(): ActionResult<{ disconnected: true }> {
    if (!this.hub.closeConnection('user', 'disconnected from Settings')) return fail(404, 'no_stage', 'No stage is connected.')
    this.hub.audit({ action: 'Disconnected the stage', target: 'Settings', outcome: 'auto' })
    return { ok: true, value: { disconnected: true }, sent: 0 }
  }

  // ------------------------------------------------------------------------------------------ characters

  selectCharacter(characterId: string): ActionResult<CharacterProfile> {
    const g = this.guard()
    if (g) return g
    const r = this.hub.characters.select(characterId)
    if (!r.ok) return failFrom(r.code, r.error)
    if (r.value.role === 'assistant') this.hub.bindAssistant()
    const load = this.hub.characters.loadCommand(characterId)
    this.hub.audit({ action: `Selected ${r.value.role === 'assistant' ? 'her' : 'your'} character`, target: r.value.name, outcome: 'auto' })
    this.hub.changed('character')
    return this.done(r.value, load.ok ? [load.value] : [])
  }

  /**
   * Morph sliders. Out-of-range values are REFUSED with the range in the message (stage-core would clamp silently, which
   * would hide a bug in a client), and the combination is judged against the adult envelope by the character service.
   */
  setParams(characterId: string, params: Record<string, number | string>, blendMs = 0): ActionResult<{ profile: CharacterProfile; changed: string[] }> {
    const g = this.guard()
    if (g) return g
    const c = this.character(characterId)
    if ('ok' in c) return c
    const base = this.hub.catalog.get(c.baseAssetId)
    const defs = new Map((base?.params ?? []).map((p) => [p.id, p]))
    const problems: Array<{ param: string; min: number; max: number; value: unknown }> = []
    for (const [k, v] of Object.entries(params)) {
      const def = defs.get(k)
      if (!def || def.type === 'color') continue
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        return this.refused('Refused a body change', c.name, fail(422, 'invalid_params', `${def.label} must be a number.`))
      }
      if (v < def.min || v > def.max) problems.push({ param: k, min: def.min, max: def.max, value: v })
    }
    if (problems.length > 0) {
      const first = problems[0]!
      const label = defs.get(first.param)?.label ?? first.param
      const more = problems.length > 1 ? ` (and ${problems.length - 1} more)` : ''
      return this.refused(
        'Refused a body change',
        c.name,
        fail(422, 'param_out_of_range', `${label} must be between ${first.min} and ${first.max} (you sent ${first.value})${more}. The sliders are bounded to adult proportions.`, problems),
      )
    }
    const r = this.hub.characters.setParams(characterId, params, blendMs)
    if (!r.ok) return this.refused('Refused a body change', c.name, failFrom(r.code, r.error))
    if (r.value.changed.length > 0) {
      this.hub.audit({ action: 'Changed her appearance', target: c.name, outcome: 'auto', detail: r.value.changed.slice(0, 12).join(', ') })
      this.hub.changed('params')
    }
    return this.done({ profile: r.value.profile, changed: r.value.changed }, r.value.command ? [r.value.command] : [])
  }

  setPresence(characterId: string, patch: StagePresenceRequest): ActionResult<CharacterProfile> {
    const g = this.guard()
    if (g) return g
    const c = this.character(characterId)
    if ('ok' in c) return c
    const { baseline, ...scalars } = patch
    const merged: PresenceStyle = { ...c.presence, ...scalars, baseline: { ...c.presence.baseline, ...(baseline ?? {}) } }
    const r = this.hub.characters.update(characterId, { presence: merged })
    if (!r.ok) return this.refused('Refused a presence change', c.name, failFrom(r.code, r.error))
    if (this.hub.assistant()?.id === characterId) this.hub.bindAssistant()
    this.hub.audit({ action: 'Changed how she carries herself', target: c.name, outcome: 'auto', detail: Object.keys(patch).join(', ') })
    this.hub.changed('presence')
    return this.done(r.value)
  }

  // ------------------------------------------------------------------------------------------- wardrobe

  equip(characterId: string, assetId: string, slot?: WardrobeSlot): ActionResult<{ profile: CharacterProfile; changes: number; displaced: string[]; filled: string[] }> {
    const g = this.guard()
    if (g) return g
    const c = this.character(characterId)
    if ('ok' in c) return c
    const r = this.hub.wardrobe.equip(characterId, assetId, { source: 'user', ...(slot ? { slot } : {}) })
    if (!r.ok) return this.refused('Refused to put something on', c.name, failFrom(r.code, r.error))
    return this.done({ profile: r.value.profile, changes: r.value.changes.length, displaced: r.value.displaced, filled: r.value.filled }, r.value.commands)
  }

  unequip(characterId: string, slot: WardrobeSlot): ActionResult<{ profile: CharacterProfile; changes: number }> {
    const g = this.guard()
    if (g) return g
    const c = this.character(characterId)
    if ('ok' in c) return c
    const r = this.hub.wardrobe.unequip(characterId, slot, { source: 'user' })
    if (!r.ok) return this.refused('Refused to take something off', c.name, failFrom(r.code, r.error))
    return this.done({ profile: r.value.profile, changes: r.value.changes.length }, r.value.commands)
  }

  applyPreset(characterId: string, presetId: string): ActionResult<{ profile: CharacterProfile; changes: number }> {
    const g = this.guard()
    if (g) return g
    const c = this.character(characterId)
    if ('ok' in c) return c
    const r = this.hub.wardrobe.applyPreset(characterId, presetId, { source: 'user' })
    if (!r.ok) return this.refused('Refused an outfit', c.name, failFrom(r.code, r.error))
    return this.done({ profile: r.value.profile, changes: r.value.changes.length }, r.value.commands)
  }

  savePreset(characterId: string, name: string, id?: string): ActionResult<OutfitPreset> {
    const g = this.guard()
    if (g) return g
    const c = this.character(characterId)
    if ('ok' in c) return c
    const r = this.hub.wardrobe.savePreset(characterId, name, id ? { id } : {})
    if (!r.ok) return this.refused('Refused to save an outfit', c.name, failFrom(r.code, r.error))
    this.hub.audit({ action: `Saved the outfit ${r.value.name}`, target: c.name, outcome: 'auto' })
    this.hub.changed('wardrobe')
    return { ok: true, value: r.value, sent: 0 }
  }

  deletePreset(characterId: string, presetId: string): ActionResult<{ deleted: true }> {
    const g = this.guard()
    if (g) return g
    const c = this.character(characterId)
    if ('ok' in c) return c
    const r = this.hub.wardrobe.deletePreset(characterId, presetId)
    if (!r.ok) return this.refused('Refused to delete an outfit', c.name, failFrom(r.code, r.error))
    this.hub.audit({ action: 'Deleted an outfit preset', target: c.name, outcome: 'auto', detail: presetId })
    this.hub.changed('wardrobe')
    return { ok: true, value: { deleted: true }, sent: 0 }
  }

  /** What would she wear now? Nothing is applied by asking. */
  suggestOutfit(characterId: string, ctx: StageOutfitSuggestRequest = {}): ActionResult<StageOutfitSuggestion | null> {
    const g = this.guard()
    if (g) return g
    const c = this.character(characterId)
    if ('ok' in c) return c
    if (this.hub.assistant()?.id !== characterId) return fail(422, 'not_assistant', 'Outfit suggestions are made for the active assistant only.')
    return { ok: true, value: this.hub.suggestOutfit(ctx) ?? null, sent: 0 }
  }

  // ---------------------------------------------------------------------------------------------- scene

  applyScenePreset(presetId: string): ActionResult<{ id: string; name: string }> {
    const g = this.guard()
    if (g) return g
    const r = this.hub.scenes.applyPreset(presetId)
    if (!r.ok) return this.refused('Refused a scene', presetId, failFrom(r.code, r.error))
    this.hub.constructs.reset()
    this.hub.camera.setCurrent(r.value.scene.activeCameraId)
    this.hub.audit({ action: `Switched the scene to ${r.value.value.name}`, target: 'Stage', outcome: 'auto' })
    this.hub.changed('scene')
    return this.done(r.value.value, r.value.commands)
  }

  private transformOf(req: { position?: [number, number, number] | undefined; yawDeg?: number | undefined; scale?: number | undefined }, base?: SceneObject['transform']): SceneObject['transform'] {
    const position = req.position ?? base?.position ?? this.hub.scenes.suggestPlacement().position
    const rotation = req.yawDeg !== undefined ? roundQuat(quatFromYaw((req.yawDeg * Math.PI) / 180)) : (base?.rotation ?? [0, 0, 0, 1])
    const s = req.scale ?? base?.scale[0] ?? 1
    return { position: [...position], rotation: [...rotation], scale: [s, s, s] } as SceneObject['transform']
  }

  addObject(req: StageSceneObjectAddRequest): ActionResult<SceneObject> {
    const g = this.guard()
    if (g) return g
    const input: ObjectInput = {
      ...(req.id ? { id: req.id } : {}),
      assetId: req.assetId,
      transform: this.transformOf(req),
      role: req.role ?? 'furniture',
    }
    const r = this.hub.scenes.addObject(input)
    if (!r.ok) return this.refused('Refused to place an object', req.assetId, failFrom(r.code, r.error))
    this.hub.audit({ action: 'Placed an object in the space', target: this.hub.catalog.get(req.assetId)?.name ?? req.assetId, outcome: 'auto' })
    this.hub.changed('scene')
    return this.done(r.value.value, r.value.commands)
  }

  updateObject(objectId: string, req: StageSceneObjectUpdateRequest): ActionResult<SceneObject> {
    const g = this.guard()
    if (g) return g
    const cur = this.hub.scenes.getObject(objectId)
    if (!cur) return fail(404, 'not_found', `No object "${objectId}" in the scene.`)
    const patch: ObjectPatch = {
      ...(req.assetId !== undefined ? { assetId: req.assetId } : {}),
      ...(req.visible !== undefined ? { visible: req.visible } : {}),
      ...(req.position !== undefined || req.yawDeg !== undefined || req.scale !== undefined ? { transform: this.transformOf(req, cur.transform) } : {}),
    }
    const r = this.hub.scenes.updateObject(objectId, patch)
    if (!r.ok) return this.refused('Refused to change an object', objectId, failFrom(r.code, r.error))
    this.hub.audit({ action: 'Changed an object in the space', target: objectId, outcome: 'auto' })
    this.hub.changed('scene')
    return this.done(r.value.value, r.value.commands)
  }

  removeObject(objectId: string): ActionResult<{ removed: string[] }> {
    const g = this.guard()
    if (g) return g
    const r = this.hub.scenes.removeObject(objectId)
    if (!r.ok) return this.refused('Refused to remove an object', objectId, failFrom(r.code, r.error))
    this.hub.audit({ action: 'Removed an object from the space', target: objectId, outcome: 'auto' })
    this.hub.changed('scene')
    return this.done({ removed: r.value.value }, r.value.commands)
  }

  setCamera(shot: string): ActionResult<{ shot: string }> {
    const g = this.guard()
    if (g) return g
    const asked = this.hub.camera.request(shot)
    if (!asked.ok) return this.refused('Refused a camera shot', shot, fail(422, asked.code, asked.error))
    const blend = (asked.value as { blendMs?: number }).blendMs ?? 600
    const r = this.hub.scenes.setActiveCamera(shot, blend)
    if (!r.ok) return this.refused('Refused a camera shot', shot, failFrom(r.code, r.error))
    this.hub.audit({ action: `Moved the camera to ${shot}`, target: 'Stage', outcome: 'auto' })
    this.hub.changed('camera')
    return this.done({ shot }, r.value.commands)
  }

  // ---------------------------------------------------------------------------------------------- memory

  // Seeing and deleting what she remembers never checks the stage switch: "her data stays while the stage is off" is only
  // true if you can always inspect and erase it. Reading is not audited (it is your own screen); every deletion is, and the
  // audit line says what kind of thing went, never what it said.

  /** What she remembers, newest first. Stored text is masked against secrets again on the way out (an older store may hold what today's rules would refuse). */
  listMemory(): StageMemoryList {
    const all = this.hub.memory.list() // oldest first
    const bySensitivity = { normal: 0, private: 0, sensitive: 0 }
    // This list is also the way to find something in order to forget it, so one odd stored row must never break it: a
    // timestamp Date cannot represent would make toISOString() throw and hide every item.
    const iso = (ms: number): string => (Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : new Date(0).toISOString())
    const view = (i: MemoryItem): StageMemoryItem => {
      // a row with a label this code does not know is treated as the most protected one, like the digest does
      const sensitivity = i.sensitivity === 'normal' || i.sensitivity === 'private' ? i.sensitivity : 'sensitive'
      return {
        id: i.id,
        kind: i.kind === 'relationship' || i.kind === 'preference' ? i.kind : 'episode',
        text: redactText(i.text, 500).slice(0, 500),
        importance: Math.min(5, Math.max(1, Math.round(Number.isFinite(i.importance) ? i.importance : 1))),
        sensitivity,
        tags: i.tags.slice(0, 8).map((t) => t.slice(0, 40)),
        createdAt: iso(i.createdAt),
        updatedAt: iso(i.updatedAt),
      }
    }
    for (const i of all) bySensitivity[i.sensitivity === 'normal' || i.sensitivity === 'private' ? i.sensitivity : 'sensitive']++
    return { total: all.length, items: all.slice(-STAGE_MEMORY_LIST_LIMIT).reverse().map(view), bySensitivity }
  }

  forgetMemory(id: string): ActionResult<{ forgotten: number }> {
    const item = this.hub.memory.get(id)
    if (!item || !this.hub.memory.forget(id)) return fail(404, 'not_found', 'She does not remember that any more.')
    this.hub.audit({ action: 'Forgot something she remembered', target: 'Her memory', outcome: 'auto', detail: `${item.kind}, ${item.sensitivity}` })
    return { ok: true, value: { forgotten: 1 }, sent: 0 }
  }

  forgetAllMemory(): ActionResult<{ forgotten: number }> {
    const n = this.hub.memory.forgetWhere(() => true)
    this.hub.audit({ action: 'Forgot everything she remembered', target: 'Her memory', outcome: 'auto', detail: `${n} item${n === 1 ? '' : 's'}` })
    return { ok: true, value: { forgotten: n }, sent: 0 }
  }

  // ---------------------------------------------------------------------------------------------- catalog

  /**
   * Register a catalog entry (metadata only). The stage-core catalog validates it: adult attestation and slider ranges for
   * a character base, safe locators, a coherent licence record. An id that exists is never replaced. The licence is
   * judged again every time the asset is equipped or placed, so a "not for personal use" record is stored but unusable.
   */
  registerAsset(manifest: Record<string, unknown>): ActionResult<{ id: string; name: string; kind: string }> {
    const g = this.guard()
    if (g) return g
    const id = typeof manifest.id === 'string' ? manifest.id : ''
    if (this.hub.catalog.size >= MAX_CATALOG_ENTRIES) return this.refused('Refused a catalog entry', id || 'manifest', fail(409, 'catalog_full', `The catalog already has ${MAX_CATALOG_ENTRIES} entries.`))
    if (id && this.hub.catalog.has(id)) return this.refused('Refused a catalog entry', id, fail(409, 'duplicate', `The catalog already has "${redactText(id, 60)}". Existing entries are never replaced.`))
    const r = this.hub.catalog.add(manifest)
    if (!r.ok) return this.refused('Refused a catalog entry', id || 'manifest', fail(r.code === 'duplicate' ? 409 : 422, r.code, r.error))
    this.hub.stageStore.upsertAsset(r.value, 'user', this.hub.nowIso())
    this.hub.invalidateAssets()
    this.hub.audit({
      action: 'Added a catalog entry',
      target: r.value.name,
      outcome: 'auto',
      detail: `${r.value.kind}, licence ${r.value.license.id}, personal use ${r.value.license.personalUse ? 'yes' : 'no'} (metadata only)`,
    })
    this.hub.changed('assets')
    return { ok: true, value: { id: r.value.id, name: r.value.name, kind: r.value.kind }, sent: 0 }
  }
}
