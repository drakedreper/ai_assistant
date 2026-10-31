import { AUTHORITY_PRESENCE } from '@ai-assistant/shared'
import {
  SEED_ASSETS,
  seedBaseId,
  seedBaseParams,
  type AssetCatalog,
  type AssetManifestInput,
  type CharacterService,
  type SceneService,
} from '@ai-assistant/stage-core'
import { USER_PRESENCE } from '@ai-assistant/stage-core'
import type { StageStore } from '../store'

/**
 * The first-run seed of the stage backend: the seed catalog (METADATA ONLY, no binary), the default assistant with the
 * AUTHORITY presence, the user's ABSTRACT presence character and the empty "cerebral void" scene with its two scene
 * presets. It runs exactly once per database (a marker in kv): after that the database is the truth, so a user's
 * changes (a renamed character, a deleted preset, an added asset) are never overwritten by a later start.
 *
 * Content rules: every character is an adult. The seed bases declare slider ranges inside the adult envelope
 * (stage-core enforces it when they are added to the catalog), the wardrobe is tailored, structured or athletic, and a
 * fully clothed baseline is always kept. Nothing here is revealing or sexualised.
 */

export const STAGE_SEED_VERSION = 1

export const ASSISTANT_CHARACTER_ID = 'char.assistant'
export const USER_CHARACTER_ID = 'char.user'
/** The base of the user's representation: an abstract, faceless form (a silhouette with a soft light), adult proportions. */
export const ABSTRACT_BASE_ID = 'base.vrm1.presence-form'

/**
 * The user's representation, as catalog metadata. It is an abstract presence on purpose: no face is modelled and no
 * face capture is ever needed or used (the stage capability `tracking.face` stays a separate, off-by-default matter).
 * It is a `character_base` like any other, so it passes the same adult envelope and licence checks.
 */
export function abstractPresenceBase(): AssetManifestInput {
  return {
    id: ABSTRACT_BASE_ID,
    kind: 'character_base',
    name: 'Presence form (abstract, faceless)',
    description: 'A softly lit abstract figure with adult proportions. No face, no face capture. The stage may draw it as a silhouette.',
    tags: ['adult', 'abstract', 'presence', 'no-face-capture'],
    rigFamilies: ['vrm1'],
    locator: 'bases/vrm1/presence-form.vrm',
    slots: [],
    hides: [],
    params: seedBaseParams({ heightCm: 175, muscle: 0.45, shoulder: 0.3, jaw: 0.7, age: 36 }),
    license: {
      id: 'first-party-placeholder',
      source: 'project seed metadata',
      personalUse: true,
      commercialUse: true,
      redistribution: true,
      adultExpression: false,
      notes: 'Seed metadata only, no binary ships. A real asset must carry its own licence record.',
    },
    adult: true,
  }
}

/** Every entry the seed adds to an empty catalog. */
export function seedManifests(): AssetManifestInput[] {
  return [...(SEED_ASSETS as unknown as AssetManifestInput[]), abstractPresenceBase()]
}

export interface CatalogLoadReport {
  loaded: number
  rejected: Array<{ id: string; reason: string }>
}

/** Fill the in-memory catalog from the stored entries. A stored manifest is validated again, so a bad row is reported and skipped. */
export function loadCatalog(catalog: AssetCatalog, stageStore: StageStore): CatalogLoadReport {
  const report: CatalogLoadReport = { loaded: 0, rejected: [] }
  for (const row of stageStore.listAssets()) {
    const r = catalog.add(row.manifest, { replace: true })
    if (r.ok) report.loaded++
    else {
      const id = typeof row.manifest === 'object' && row.manifest !== null && typeof (row.manifest as { id?: unknown }).id === 'string' ? (row.manifest as { id: string }).id : '(unknown)'
      report.rejected.push({ id, reason: r.error })
    }
  }
  return report
}

export interface SeedDeps {
  stageStore: StageStore
  catalog: AssetCatalog
  characters: CharacterService
  scenes: SceneService
  assistantName: string
  nowIso: string
}

export interface SeedReport {
  assets: number
  characters: string[]
  scene: boolean
  problems: string[]
}

/** Run the seed. Idempotent on its own (existing ids are left alone), the caller records the "seeded" marker. */
export function runSeed(d: SeedDeps): SeedReport {
  const report: SeedReport = { assets: 0, characters: [], scene: false, problems: [] }

  for (const manifest of seedManifests()) {
    if (d.stageStore.hasAsset((manifest as { id: string }).id)) continue
    const r = d.catalog.add(manifest, { replace: true })
    if (!r.ok) {
      report.problems.push(`asset ${(manifest as { id: string }).id}: ${r.error}`)
      continue
    }
    d.stageStore.upsertAsset(r.value, 'seed', d.nowIso)
    report.assets++
  }

  if (!d.characters.get(ASSISTANT_CHARACTER_ID)) {
    const a = d.characters.create({ id: ASSISTANT_CHARACTER_ID, name: d.assistantName, role: 'assistant', baseAssetId: seedBaseId('vrm1', 'composed'), presence: AUTHORITY_PRESENCE })
    if (a.ok) report.characters.push(a.value.id)
    else report.problems.push(`assistant: ${a.error}`)
  }
  if (!d.characters.get(USER_CHARACTER_ID)) {
    const u = d.characters.create({ id: USER_CHARACTER_ID, name: 'You', role: 'user', baseAssetId: ABSTRACT_BASE_ID, presence: USER_PRESENCE })
    if (u.ok) report.characters.push(u.value.id)
    else report.problems.push(`user: ${u.error}`)
  }

  if (!d.scenes.getScene()) {
    d.scenes.ensureVoid()
    report.scene = true
  }
  return report
}
