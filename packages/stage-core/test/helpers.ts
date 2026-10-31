import { InMemoryCharacterRepo, createCharacterService, createSeedCatalog, createSequentialIds, createVirtualTime, seedBaseId } from '../src'
import type { AssetManifestInput, CharacterService } from '../src'

/** 08:15 local on a Monday, so time-of-day logic is stable. */
export const T0 = new Date(2026, 10, 2, 8, 15, 0).getTime()
export const at = (h: number, m = 0, dayOffset = 0): number => new Date(2026, 10, 2 + dayOffset, h, m, 0).getTime()

export function makeWorld(start = T0) {
  const vt = createVirtualTime(start)
  const catalog = createSeedCatalog()
  const repo = new InMemoryCharacterRepo()
  const newId = createSequentialIds()
  const characters: CharacterService = createCharacterService({ repo, catalog, clock: vt.clock, newId })
  return { vt, catalog, repo, newId, characters }
}

export function makeAssistant(w = makeWorld(), rig: 'vrm1' | 'metahuman' | 'cc5' = 'vrm1') {
  const r = w.characters.create({ name: 'Mira', role: 'assistant', baseAssetId: seedBaseId(rig) })
  if (!r.ok) throw new Error(`makeAssistant: ${r.error}`)
  return { ...w, assistant: r.value }
}

export const LIC = { id: 'MIT', personalUse: true, commercialUse: true, redistribution: true }

export const wideBase = (over: Record<string, unknown> = {}): AssetManifestInput =>
  ({
    id: 'base.wide',
    kind: 'character_base',
    name: 'Wide base',
    locator: 'bases/wide',
    rigFamilies: ['vrm1'],
    adult: true,
    license: LIC,
    params: [
      { id: 'face.apparent_age', group: 'face', label: 'age', min: 25, max: 65, default: 40 },
      { id: 'face.jaw_definition', group: 'face', label: 'jaw', min: 0.2, max: 1, default: 0.7 },
      { id: 'face.roundness', group: 'face', label: 'round', min: -0.6, max: 0.5, default: -0.1 },
      { id: 'eyes.size', group: 'eyes', label: 'eyes', min: -0.4, max: 0.4, default: 0 },
      { id: 'body.head_scale', group: 'body', label: 'head', min: 0.9, max: 1.04, default: 0.96 },
      { id: 'body.leg_length', group: 'body', label: 'legs', min: -0.2, max: 0.8, default: 0.3 },
      { id: 'body.height_cm', group: 'body', label: 'height', min: 158, max: 200, default: 175 },
    ],
    ...over,
  }) as AssetManifestInput

/** Deterministic pseudo-random for property loops (independent of the library under test). */
export function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}
