import type { Context, Hono } from 'hono'
import type { ZodType } from 'zod'
import {
  DaemonRoutes,
  OnOffRequest,
  StageAssetRegisterRequest,
  StageCameraRequest,
  StageEquipRequest,
  StageOutfitApplyRequest,
  StageOutfitSaveRequest,
  StageOutfitSuggestRequest,
  StageParamsRequest,
  StagePresenceRequest,
  StageSceneObjectAddRequest,
  StageSceneObjectUpdateRequest,
  StageScenePresetRequest,
  StageSelectRequest,
  StageUnequipRequest,
  type StageSnapshot,
} from '@ai-assistant/shared'
import type { Security } from '../security'
import { StageActions, type ActionResult } from './actions'
import type { StageHub } from './hub'

/**
 * REST routes of the stage backend. They are registered AFTER the global request gate (src/http/guards.ts), so each of
 * them has already passed Host, Origin (required on every mutation), the JSON content-type rule and the browser session
 * cookie. The stage token does nothing here, and the cookie does nothing on the stage socket.
 *
 * Every mutation goes through StageActions: validated (zod here, then the stage-core services), audited, delivered to
 * the connected stage and announced to the dashboards. Errors are `{ error, message, details? }` with a stable code.
 */

export interface StageRouteDeps {
  hub: StageHub
  security: Security
}

type Parsed<T> = { ok: true; data: T } | { ok: false; res: Response }

function fail(c: Context, status: number, code: string, message: string, details?: unknown): Response {
  return c.json({ error: code, message, ...(details !== undefined ? { details } : {}) }, status as 400)
}

async function readBody<T>(c: Context, schema: ZodType<T>, optional = false): Promise<Parsed<T>> {
  let raw: unknown
  try {
    const text = await c.req.text()
    raw = text.trim() === '' && optional ? {} : JSON.parse(text)
  } catch {
    return { ok: false, res: fail(c, 400, 'invalid_json', 'The request body is not valid JSON.') }
  }
  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 8).map((i) => ({ path: i.path.join('.'), message: i.message }))
    const first = issues[0]
    return { ok: false, res: fail(c, 400, 'invalid_request', first ? `${first.path ? `${first.path}: ` : ''}${first.message}` : 'The request body does not match the expected shape.', issues) }
  }
  return { ok: true, data: parsed.data }
}

export function registerStageRoutes(app: Hono, deps: StageRouteDeps): StageActions {
  const { hub, security } = deps
  const actions = new StageActions(hub)

  const reply = <T>(c: Context, r: ActionResult<T>, status: 200 | 201 = 200): Response =>
    r.ok ? c.json({ ok: true, result: r.value, stage: { connected: hub.isConnected(), sent: r.sent } }, status) : fail(c, r.status, r.code, r.message, r.details)

  // ---- reads
  app.get(DaemonRoutes.stage, (c) => {
    const snap: StageSnapshot = hub.snapshot()
    return c.json(snap)
  })

  // A plain HTTP GET to the stage socket path: the bearer token decides what the caller learns (the cookie is never read).
  app.get(DaemonRoutes.stageWs, (c) => {
    c.header('Cache-Control', 'no-store')
    if (!security.verifyStageToken(c.req.header('authorization'))) return fail(c, 401, 'unauthorized', 'A valid stage token is required (Authorization: Bearer <stage token>).')
    return fail(c, 426, 'upgrade_required', 'Use a WebSocket connection.')
  })

  // ---- the switch and the connection
  app.on(['PUT', 'POST'], DaemonRoutes.stageEnabled, async (c) => {
    const b = await readBody(c, OnOffRequest)
    return b.ok ? reply(c, actions.setEnabled(b.data.on)) : b.res
  })
  app.delete(DaemonRoutes.stageConnection, (c) => reply(c, actions.disconnect()))

  // ---- the catalog
  app.post(DaemonRoutes.stageAssets, async (c) => {
    const b = await readBody(c, StageAssetRegisterRequest)
    return b.ok ? reply(c, actions.registerAsset(b.data.manifest), 201) : b.res
  })

  // ---- characters
  app.on(['PUT', 'POST'], DaemonRoutes.stageCharacterSelect, async (c) => {
    const b = await readBody(c, StageSelectRequest)
    return b.ok ? reply(c, actions.selectCharacter(b.data.characterId)) : b.res
  })
  app.on(['PUT', 'POST'], '/api/stage/characters/:id/params', async (c) => {
    const b = await readBody(c, StageParamsRequest)
    return b.ok ? reply(c, actions.setParams(c.req.param('id'), b.data.params, b.data.blendMs ?? 0)) : b.res
  })
  app.on(['PUT', 'POST'], '/api/stage/characters/:id/presence', async (c) => {
    const b = await readBody(c, StagePresenceRequest)
    return b.ok ? reply(c, actions.setPresence(c.req.param('id'), b.data)) : b.res
  })

  // ---- wardrobe
  app.post('/api/stage/characters/:id/equip', async (c) => {
    const b = await readBody(c, StageEquipRequest)
    return b.ok ? reply(c, actions.equip(c.req.param('id'), b.data.assetId, b.data.slot)) : b.res
  })
  app.post('/api/stage/characters/:id/unequip', async (c) => {
    const b = await readBody(c, StageUnequipRequest)
    return b.ok ? reply(c, actions.unequip(c.req.param('id'), b.data.slot)) : b.res
  })
  app.post('/api/stage/characters/:id/outfit/apply', async (c) => {
    const b = await readBody(c, StageOutfitApplyRequest)
    return b.ok ? reply(c, actions.applyPreset(c.req.param('id'), b.data.presetId)) : b.res
  })
  app.post('/api/stage/characters/:id/outfit/save', async (c) => {
    const b = await readBody(c, StageOutfitSaveRequest)
    return b.ok ? reply(c, actions.savePreset(c.req.param('id'), b.data.name, b.data.id), 201) : b.res
  })
  app.post('/api/stage/characters/:id/outfit/delete', async (c) => {
    const b = await readBody(c, StageOutfitApplyRequest)
    return b.ok ? reply(c, actions.deletePreset(c.req.param('id'), b.data.presetId)) : b.res
  })
  app.post('/api/stage/characters/:id/outfit/suggest', async (c) => {
    const b = await readBody(c, StageOutfitSuggestRequest, true)
    return b.ok ? reply(c, actions.suggestOutfit(c.req.param('id'), b.data)) : b.res
  })

  // ---- the scene
  app.post(DaemonRoutes.stageScenePreset, async (c) => {
    const b = await readBody(c, StageScenePresetRequest)
    return b.ok ? reply(c, actions.applyScenePreset(b.data.presetId)) : b.res
  })
  app.post(DaemonRoutes.stageSceneObjects, async (c) => {
    const b = await readBody(c, StageSceneObjectAddRequest)
    return b.ok ? reply(c, actions.addObject(b.data), 201) : b.res
  })
  app.on(['PUT', 'PATCH'], '/api/stage/scene/objects/:id', async (c) => {
    const b = await readBody(c, StageSceneObjectUpdateRequest)
    return b.ok ? reply(c, actions.updateObject(c.req.param('id'), b.data)) : b.res
  })
  app.delete('/api/stage/scene/objects/:id', (c) => reply(c, actions.removeObject(c.req.param('id'))))
  app.on(['PUT', 'POST'], DaemonRoutes.stageCamera, async (c) => {
    const b = await readBody(c, StageCameraRequest)
    return b.ok ? reply(c, actions.setCamera(b.data.shot)) : b.res
  })

  return actions
}
