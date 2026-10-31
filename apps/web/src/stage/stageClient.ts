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
  StageSnapshot,
  StageUnequipRequest,
  type StageOutfitSuggestRequest as OutfitSuggestInput,
  type StagePresenceRequest as PresenceInput,
  type StageSceneObjectAddRequest as ObjectAddInput,
  type StageSceneObjectUpdateRequest as ObjectUpdateInput,
  type WardrobeSlot,
} from '@ai-assistant/shared'

/**
 * Browser side of the stage backend (daemon mode only; see apps/daemon/README.md, "Stage"). Plain `fetch` against the
 * daemon's routes: same origin, JSON, the session cookie, exactly like terminalClient.ts. There is no mock and no
 * fixture here: without the daemon there is nothing to talk to, and the Stage tab says so.
 *
 * Every mutation is validated twice, here with the shared zod request schemas and again by the daemon. A refusal comes
 * back as a StageApiError with the daemon's own plain-language message (an out-of-range slider, an item whose licence
 * forbids it, an outfit that would not leave her fully dressed).
 */

export class StageApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'StageApiError'
  }
}

async function call(method: string, path: string, body?: unknown): Promise<unknown> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 20_000)
  let res: Response
  let text: string
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      signal: ctl.signal,
      headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    text = await res.text()
  } catch {
    throw new StageApiError(0, 'unreachable', 'The daemon is not reachable. Is it still running?')
  } finally {
    clearTimeout(timer)
  }
  let data: unknown
  try {
    data = text ? (JSON.parse(text) as unknown) : undefined
  } catch {
    data = undefined
  }
  if (res.status >= 200 && res.status < 300) return data
  const o = data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : {}
  throw new StageApiError(res.status, typeof o.error === 'string' ? o.error : 'error', typeof o.message === 'string' && o.message ? o.message : `The daemon answered HTTP ${res.status}.`, o.details)
}

interface Schema<O> {
  safeParse(v: unknown): { success: true; data: O } | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } }
}

/** Parse with a shared schema first, so a client bug fails loudly here instead of as a vague 400. */
function req<O>(schema: Schema<O>, value: unknown): O {
  const r = schema.safeParse(value)
  if (!r.success) {
    const i = r.error.issues[0]
    throw new StageApiError(0, 'invalid_request', i ? `${i.path.map(String).join('.') || 'request'}: ${i.message}` : 'That request is not valid.')
  }
  return r.data
}


export interface StageMutation<T = unknown> {
  ok: true
  result: T
  stage: { connected: boolean; sent: number }
}

export const stageClient = {
  async getStage(): Promise<StageSnapshot> {
    const data = await call('GET', DaemonRoutes.stage)
    const parsed = StageSnapshot.safeParse(data)
    if (!parsed.success) throw new StageApiError(0, 'protocol', 'The daemon returned a stage state this app does not understand. Rebuild the web app.')
    return parsed.data
  },
  setEnabled: (on: boolean) => call('PUT', DaemonRoutes.stageEnabled, req(OnOffRequest, { on })) as Promise<StageMutation>,
  disconnect: () => call('DELETE', DaemonRoutes.stageConnection) as Promise<StageMutation>,
  selectCharacter: (characterId: string) => call('PUT', DaemonRoutes.stageCharacterSelect, req(StageSelectRequest, { characterId })) as Promise<StageMutation>,
  setParams: (characterId: string, params: Record<string, number | string>) => call('PUT', DaemonRoutes.stageCharacterParams(characterId), req(StageParamsRequest, { params })) as Promise<StageMutation>,
  setPresence: (characterId: string, patch: PresenceInput) => call('PUT', DaemonRoutes.stageCharacterPresence(characterId), req(StagePresenceRequest, patch)) as Promise<StageMutation>,
  equip: (characterId: string, assetId: string, slot?: WardrobeSlot) => call('POST', DaemonRoutes.stageEquip(characterId), req(StageEquipRequest, { assetId, ...(slot ? { slot } : {}) })) as Promise<StageMutation>,
  unequip: (characterId: string, slot: WardrobeSlot) => call('POST', DaemonRoutes.stageUnequip(characterId), req(StageUnequipRequest, { slot })) as Promise<StageMutation>,
  applyOutfit: (characterId: string, presetId: string) => call('POST', DaemonRoutes.stageOutfitApply(characterId), req(StageOutfitApplyRequest, { presetId })) as Promise<StageMutation>,
  saveOutfit: (characterId: string, name: string) => call('POST', DaemonRoutes.stageOutfitSave(characterId), req(StageOutfitSaveRequest, { name })) as Promise<StageMutation>,
  deleteOutfit: (characterId: string, presetId: string) => call('POST', DaemonRoutes.stageOutfitDelete(characterId), req(StageOutfitApplyRequest, { presetId })) as Promise<StageMutation>,
  suggestOutfit: (characterId: string, ctx: OutfitSuggestInput = {}) =>
    call('POST', DaemonRoutes.stageOutfitSuggest(characterId), req(StageOutfitSuggestRequest, ctx)) as Promise<StageMutation<{ presetId: string; presetName: string; explanation: string; changed: boolean } | null>>,
  applyScenePreset: (presetId: string) => call('POST', DaemonRoutes.stageScenePreset, req(StageScenePresetRequest, { presetId })) as Promise<StageMutation>,
  addObject: (input: ObjectAddInput) => call('POST', DaemonRoutes.stageSceneObjects, req(StageSceneObjectAddRequest, input)) as Promise<StageMutation>,
  updateObject: (objectId: string, patch: ObjectUpdateInput) => call('PUT', DaemonRoutes.stageSceneObject(objectId), req(StageSceneObjectUpdateRequest, patch)) as Promise<StageMutation>,
  removeObject: (objectId: string) => call('DELETE', DaemonRoutes.stageSceneObject(objectId)) as Promise<StageMutation>,
  setCamera: (shot: string) => call('PUT', DaemonRoutes.stageCamera, req(StageCameraRequest, { shot })) as Promise<StageMutation>,
  registerAsset: (manifest: Record<string, unknown>) => call('POST', DaemonRoutes.stageAssets, req(StageAssetRegisterRequest, { manifest })) as Promise<StageMutation>,
}

/** A sentence a person can read for a failed stage call. */
export function describeStageError(err: unknown): string {
  if (err instanceof StageApiError) {
    if (err.status === 401) return 'This browser is signed out of the daemon. Open the sign-in link it printed when it started.'
    return err.message
  }
  return err instanceof Error ? err.message.slice(0, 200) : 'Something went wrong.'
}
