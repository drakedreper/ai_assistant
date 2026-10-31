/**
 * The "cerebral void": an empty dark navy space with fog, volumetrics, dust motes, one lit pool on the floor and a heavy
 * vignette (docs/CEREBRAL-SPACE.md), plus six camera shots. The character stands at the origin facing +Z; the camera
 * looks down its -Z. The data constructs hang in front of her (+Z side, further out is deeper).
 */
import { Atmosphere, CameraShot, Scene } from '@ai-assistant/shared'
import type { LightingPreset, Scene as SceneT } from '@ai-assistant/shared'
import { SEED_IDS } from '../assets/seed'
import { lookAtQuat, quatFromYaw, roundQuat, roundVec } from './math'
import type { V3 } from './math'
import { isoFromMs } from '../util/clock'

export const SHOT_IDS = ['wide', 'medium', 'closeup', 'profile', 'back', 'over_shoulder'] as const
export type ShotId = (typeof SHOT_IDS)[number]
export const isShotId = (s: string): s is ShotId => (SHOT_IDS as readonly string[]).includes(s)

interface ShotSpec {
  id: ShotId
  name: string
  eye: V3
  target: V3
  fovDeg: number
  follow: 'none' | 'head' | 'face' | 'body'
  depthOfField: number
}

const SHOT_SPECS: readonly ShotSpec[] = [
  // wide: full body, small in the void
  { id: 'wide', name: 'Wide', eye: [0, 1.5, 6.2], target: [0, 1.0, 0], fovDeg: 38, follow: 'none', depthOfField: 0.05 },
  // medium: waist up
  { id: 'medium', name: 'Medium', eye: [0, 1.45, 2.7], target: [0, 1.32, 0], fovDeg: 34, follow: 'body', depthOfField: 0.25 },
  // closeup: face and shoulders
  { id: 'closeup', name: 'Close-up', eye: [0, 1.62, 1.15], target: [0, 1.58, 0], fovDeg: 28, follow: 'face', depthOfField: 0.55 },
  // profile: from her right, side-on
  { id: 'profile', name: 'Profile', eye: [2.6, 1.45, 0.1], target: [0, 1.35, 0], fovDeg: 32, follow: 'head', depthOfField: 0.3 },
  // back: turntable back view
  { id: 'back', name: 'Back', eye: [0, 1.5, -3.8], target: [0, 1.2, 0], fovDeg: 36, follow: 'none', depthOfField: 0.15 },
  // over_shoulder: behind her right shoulder, looking out at the constructs
  { id: 'over_shoulder', name: 'Over the shoulder', eye: [0.55, 1.75, -1.1], target: [0, 1.45, 2.4], fovDeg: 40, follow: 'none', depthOfField: 0.4 },
]

export function buildCameraShots(): SceneT['cameras'] {
  return SHOT_SPECS.map((s) =>
    CameraShot.parse({
      id: s.id,
      name: s.name,
      transform: { position: roundVec(s.eye), rotation: roundQuat(lookAtQuat(s.eye, s.target)), scale: [1, 1, 1] },
      fovDeg: s.fovDeg,
      follow: s.follow,
      depthOfField: s.depthOfField,
    }),
  )
}

export function voidAtmosphere(): Atmosphere {
  return Atmosphere.parse({
    ground: 'void',
    fogColor: '#0a1a3a',
    fogDensity: 0.55,
    volumetrics: true,
    dustMotes: 0.35,
    floorPool: { radius: 2.2, intensity: 1, color: '#cfe3ff' },
    vignette: 0.7,
    bloom: 0.35,
  })
}

export function voidLighting(): LightingPreset {
  return { id: 'void', name: 'Cerebral void', mode: 'fixed', look: 'void', atmosphere: voidAtmosphere() }
}

export const MAIN_SCENE_ID = 'scene.main'

/** The empty cerebral void as a Scene (validated against the shared schema). */
export function buildCerebralVoid(nowMs: number, id: string = MAIN_SCENE_ID): SceneT {
  return Scene.parse({
    id,
    name: 'Cerebral void',
    environmentAssetId: SEED_IDS.void,
    objects: [],
    constructs: [],
    cameras: buildCameraShots(),
    activeCameraId: 'wide',
    lighting: voidLighting(),
    updatedAt: isoFromMs(nowMs),
  })
}

/** The void with a lounge chair (a sit anchor) and a data plinth (a lean anchor and a look anchor). */
export function buildVoidWithFurniture(nowMs: number): SceneT {
  const base = buildCerebralVoid(nowMs)
  base.name = 'Void with seating'
  base.objects = [
    {
      id: 'lounge_chair',
      assetId: SEED_IDS.chair,
      // faces +X, towards where she stands
      transform: { position: [-1.6, 0, 0.4], rotation: roundQuat(quatFromYaw(Math.PI / 2)), scale: [1, 1, 1] },
      parentId: null,
      role: 'furniture',
      anchors: [{ id: 'seat', kind: 'sit', local: { position: [0, 0.45, 0.05], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } }],
      visible: true,
    },
    {
      id: 'data_plinth',
      assetId: SEED_IDS.plinth,
      transform: { position: [1.5, 0, 1.2], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      parentId: null,
      role: 'furniture',
      anchors: [
        { id: 'lean', kind: 'lean', local: { position: [-0.45, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } },
        { id: 'look', kind: 'look', local: { position: [0, 1.1, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } },
      ],
      visible: true,
    },
  ]
  return Scene.parse(base)
}
