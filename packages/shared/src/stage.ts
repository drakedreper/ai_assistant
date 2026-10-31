/**
 * STAGE PROTOCOL (draft v1, "mira-stage/1").
 *
 * The backend (daemon) owns the character: identity, appearance, wardrobe, scene, mood, memory and the live
 * performance. A "stage" is any renderer that can show it: Unreal Engine, Unity, the web three.js room, or a
 * headless simulator used by tests. Stages are replaceable; the backend never depends on one engine.
 *
 *   daemon (brain + character state)  <== WebSocket  ==>  Stage (renders, plays audio, reports what happened)
 *
 * Text frames carry JSON (StageCommand down, StageEvent up). Binary frames carry audio and face frames
 * (see BinaryFrameKind). All times are milliseconds on the stage clock agreed in `hello` (clockSync) so audio,
 * face and gesture stay lip-synced despite network jitter.
 */
import { z } from 'zod'
import { Emotion } from './schemas/common'

export const STAGE_PROTOCOL = 'mira-stage/1' as const

// ---------------------------------------------------------------------------------------------------------------
// Rigs and capabilities
// ---------------------------------------------------------------------------------------------------------------

/** What a character's skeleton/face rig is. Assets declare which rig families they fit. */
export const RigFamily = z.enum([
  'vrm1', // VRM 1.0 humanoid (VTuber class; UniVRM / three-vrm)
  'metahuman', // Unreal MetaHuman class (high-fidelity face + body)
  'cc5', // Reallusion Character Creator class (exports to Unreal and Unity)
  'custom', // bespoke rig described by its own manifest
])
export type RigFamily = z.infer<typeof RigFamily>

export const StageEngine = z.enum(['unreal', 'unity', 'web', 'sim'])
export type StageEngine = z.infer<typeof StageEngine>

/** Declared by a stage in `hello`, so the backend adapts instead of assuming (e.g. send ARKit frames or visemes). */
export const StageCapabilities = z.object({
  engine: StageEngine,
  engineVersion: z.string(),
  rigFamilies: z.array(RigFamily),
  face: z.object({
    arkit52: z.boolean(),
    visemes: z.boolean(),
    /** Engine runs its own audio-to-face (uLipSync, Runtime Lip Sync, Audio2Face plugin) from the audio frames. */
    audioToFaceOnStage: z.boolean(),
  }),
  render: z.object({
    strandHair: z.boolean(),
    clothSim: z.boolean(),
    runtimeAssetLoading: z.boolean(),
    /** Frames can be streamed into the dashboard's Room window (Pixel Streaming 2 or equivalent). */
    embeddedStream: z.boolean(),
  }),
  maxCharacters: z.number().int().positive(),
})
export type StageCapabilities = z.infer<typeof StageCapabilities>

// ---------------------------------------------------------------------------------------------------------------
// Assets: the catalog of things that can be equipped, placed or played
// ---------------------------------------------------------------------------------------------------------------

export const AssetKind = z.enum([
  'character_base',
  'hair',
  'outfit',
  'accessory',
  'prop',
  'environment',
  'animation',
  'pose',
  'material',
])
export type AssetKind = z.infer<typeof AssetKind>

/** Body slots an item can occupy. An outfit may occupy several (a dress takes top + bottom). */
export const WardrobeSlot = z.enum([
  'hair',
  'hairAccessory',
  'headwear',
  'glasses',
  'earrings',
  'neck',
  'top',
  'bottom',
  'fullBody',
  'outerwear',
  'legwear',
  'footwear',
  'gloves',
  'wristwear',
  'back',
  'tail',
])
export type WardrobeSlot = z.infer<typeof WardrobeSlot>

/** Body regions an item hides so the body mesh does not poke through (the engine applies the mask). */
export const BodyRegion = z.enum(['torso', 'arms', 'hands', 'legs', 'feet', 'neck', 'head'])
export type BodyRegion = z.infer<typeof BodyRegion>

/**
 * Licensing travels with every asset. VRM files carry explicit usage flags; store assets can forbid
 * redistribution or AI use. The backend refuses to publish or share an asset whose license forbids it.
 */
export const AssetLicense = z.object({
  /** SPDX id, "vendor-eula", or "unknown". */
  id: z.string(),
  source: z.string().optional(),
  personalUse: z.boolean(),
  commercialUse: z.boolean(),
  redistribution: z.boolean(),
  /** Whether the author permits sexual/violent expression with this model (VRM flags this explicitly). */
  adultExpression: z.boolean().optional(),
  notes: z.string().optional(),
})
export type AssetLicense = z.infer<typeof AssetLicense>

/** A morph or parameter the user can adjust (face width, eye size, bust, height...). Like a character-creator slider. */
export const MorphParam = z.object({
  id: z.string(),
  group: z.enum(['face', 'eyes', 'nose', 'mouth', 'body', 'skin', 'hair', 'makeup', 'other']),
  label: z.string(),
  min: z.number(),
  max: z.number(),
  default: z.number(),
  /** 'scalar' sliders, or a color the stage tints with. */
  type: z.enum(['scalar', 'color']).default('scalar'),
})
export type MorphParam = z.infer<typeof MorphParam>

export const Asset = z.object({
  id: z.string(),
  kind: AssetKind,
  name: z.string(),
  tags: z.array(z.string()).default([]),
  /** Which rigs this asset fits. A prop or environment fits all of them (empty = any). */
  rigFamilies: z.array(RigFamily).default([]),
  /** Engine-specific locator the stage resolves: a path in its content pack, a glTF/VRM path or a URL. */
  locator: z.string(),
  /** Pre-rendered thumbnail path or data URI, for the picker UI. */
  thumbnail: z.string().optional(),
  slots: z.array(WardrobeSlot).default([]),
  hides: z.array(BodyRegion).default([]),
  /** Parameters this asset exposes (a base character exposes its face/body sliders; an outfit may expose fit/color). */
  params: z.array(MorphParam).default([]),
  /** Another asset id this one is a color/material variant of. */
  variantOf: z.string().optional(),
  license: AssetLicense,
})
export type Asset = z.infer<typeof Asset>

// ---------------------------------------------------------------------------------------------------------------
// Character: who she is, how she looks, what she wears
// ---------------------------------------------------------------------------------------------------------------

export const VoiceProfile = z.object({
  provider: z.enum(['kokoro', 'elevenlabs', 'xtts', 'custom']),
  voiceId: z.string(),
  speed: z.number().min(0.5).max(2).default(1),
  pitchSemitones: z.number().min(-12).max(12).default(0),
})
export type VoiceProfile = z.infer<typeof VoiceProfile>

/** The equipped state: slot -> asset id (null = nothing). Stored per character, restored on every start. */
export const Equipped = z.record(WardrobeSlot, z.string().nullable())
export type Equipped = z.infer<typeof Equipped>

/** A saved look, optionally with rules so she picks it herself ("cozy" at night, "smart" before a meeting). */
export const OutfitPreset = z.object({
  id: z.string(),
  name: z.string(),
  equipped: Equipped,
  /** Material/color overrides keyed by asset id then param id. */
  tweaks: z.record(z.string(), z.record(z.string(), z.union([z.number(), z.string()]))).default({}),
  /** Soft context hints for the OutfitDirector. The user can always override. */
  context: z
    .object({
      timeOfDay: z.array(z.enum(['morning', 'day', 'evening', 'night'])).optional(),
      weather: z.array(z.enum(['clear', 'cloudy', 'rain', 'snow', 'cold', 'hot'])).optional(),
      activity: z.array(z.enum(['work', 'meeting', 'relax', 'sleep', 'out'])).optional(),
    })
    .default({}),
})
export type OutfitPreset = z.infer<typeof OutfitPreset>

export const CharacterProfile = z.object({
  id: z.string(),
  name: z.string(),
  /** Base body/face asset (kind character_base). */
  baseAssetId: z.string(),
  rigFamily: RigFamily,
  /** All slider/color values set by the user or the character creator: paramId -> value. */
  params: z.record(z.string(), z.union([z.number(), z.string()])),
  equipped: Equipped,
  presets: z.array(OutfitPreset).default([]),
  voice: VoiceProfile,
  /** The persona (personality, boundaries) is stored in settings; the character is just her body and voice. */
  personaId: z.string().default('default'),
  /** Where this character prefers to be (an anchor in the current scene), e.g. "desk_chair". */
  homeAnchor: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type CharacterProfile = z.infer<typeof CharacterProfile>

// ---------------------------------------------------------------------------------------------------------------
// Scene: the environment and the objects in it (VTube Studio's "items", but in 3D)
// ---------------------------------------------------------------------------------------------------------------

export const Vec3 = z.tuple([z.number(), z.number(), z.number()])
export const Quat = z.tuple([z.number(), z.number(), z.number(), z.number()])
export const Transform = z.object({ position: Vec3, rotation: Quat, scale: Vec3 })
export type Transform = z.infer<typeof Transform>

/** A place a character can attach to: sit, lean, stand, lie, hold. */
export const Anchor = z.object({
  id: z.string(),
  kind: z.enum(['sit', 'stand', 'lean', 'lie', 'hold', 'look']),
  /** Transform relative to the object. */
  local: Transform,
})
export type Anchor = z.infer<typeof Anchor>

export const SceneObject = z.object({
  id: z.string(),
  assetId: z.string(),
  transform: Transform,
  parentId: z.string().nullable().default(null),
  /** furniture can be sat on, interactable reports clicks, static is decoration. */
  role: z.enum(['static', 'furniture', 'interactable']).default('static'),
  anchors: z.array(Anchor).default([]),
  /** Dashboard data this object shows or reacts to (e.g. a monitor bound to the running Claude sessions). */
  binding: z
    .object({ source: z.enum(['calendar', 'work', 'brain', 'money', 'weather', 'mail']), field: z.string().optional() })
    .optional(),
  visible: z.boolean().default(true),
})
export type SceneObject = z.infer<typeof SceneObject>

export const CameraShot = z.object({
  id: z.string(),
  name: z.string(),
  transform: Transform,
  fovDeg: z.number().min(10).max(120),
  /** Look-at the character's head/eyes instead of a fixed rotation. */
  follow: z.enum(['none', 'head', 'face', 'body']).default('none'),
  depthOfField: z.number().min(0).max(1).default(0),
})
export type CameraShot = z.infer<typeof CameraShot>

export const LightingPreset = z.object({
  id: z.string(),
  name: z.string(),
  /** 'clock' derives sun/moon from the real time and weather; 'fixed' uses the named look. */
  mode: z.enum(['clock', 'fixed']),
  look: z.enum(['day', 'golden', 'dusk', 'night', 'studio', 'neon']).optional(),
})
export type LightingPreset = z.infer<typeof LightingPreset>

export const Scene = z.object({
  id: z.string(),
  name: z.string(),
  environmentAssetId: z.string(),
  objects: z.array(SceneObject),
  cameras: z.array(CameraShot),
  activeCameraId: z.string(),
  lighting: LightingPreset,
  updatedAt: z.string(),
})
export type Scene = z.infer<typeof Scene>

// ---------------------------------------------------------------------------------------------------------------
// Affect and behaviour: what makes her feel alive
// ---------------------------------------------------------------------------------------------------------------

/**
 * Continuous mood in valence/arousal/dominance, each -1..1. The backend's MoodEngine evolves it from events
 * (good news, a long silence, late hours, being interrupted) and decays toward the persona's baseline. The stage
 * only ever receives the result, expressed as face/body parameters and the discrete `emotion` label.
 */
export const Affect = z.object({
  valence: z.number().min(-1).max(1),
  arousal: z.number().min(-1).max(1),
  dominance: z.number().min(-1).max(1),
  /** Closest discrete label from the closed emotion vocabulary, used for expression presets. */
  label: Emotion,
})
export type Affect = z.infer<typeof Affect>

export const GazeTarget = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user') }),
  z.object({ kind: z.literal('camera') }),
  z.object({ kind: z.literal('object'), objectId: z.string() }),
  z.object({ kind: z.literal('point'), position: Vec3 }),
  z.object({ kind: z.literal('away'), direction: z.enum(['left', 'right', 'up', 'down']) }),
])
export type GazeTarget = z.infer<typeof GazeTarget>

export const Posture = z.enum(['stand', 'sit', 'lean', 'lie', 'sleep', 'walk'])
export type Posture = z.infer<typeof Posture>

// ---------------------------------------------------------------------------------------------------------------
// Commands: backend -> stage
// ---------------------------------------------------------------------------------------------------------------

const cmdBase = { id: z.string(), /** Stage-clock time the command should take effect; omitted = now. */ atMs: z.number().optional() }

export const StageCommand = z.discriminatedUnion('type', [
  // --- loading and look ---
  z.object({ ...cmdBase, type: z.literal('character.load'), character: CharacterProfile, assets: z.array(Asset) }),
  z.object({ ...cmdBase, type: z.literal('character.params'), characterId: z.string(), params: z.record(z.string(), z.union([z.number(), z.string()])), blendMs: z.number().default(0) }),
  z.object({ ...cmdBase, type: z.literal('character.equip'), characterId: z.string(), slot: WardrobeSlot, assetId: z.string().nullable(), asset: Asset.optional() }),
  z.object({ ...cmdBase, type: z.literal('character.outfit'), characterId: z.string(), preset: OutfitPreset, assets: z.array(Asset) }),
  z.object({ ...cmdBase, type: z.literal('scene.load'), scene: Scene, assets: z.array(Asset) }),
  z.object({ ...cmdBase, type: z.literal('scene.object'), op: z.enum(['add', 'update', 'remove']), object: SceneObject, asset: Asset.optional() }),
  z.object({ ...cmdBase, type: z.literal('scene.camera'), cameraId: z.string(), blendMs: z.number().default(600) }),
  z.object({ ...cmdBase, type: z.literal('scene.lighting'), lighting: LightingPreset }),

  // --- live performance ---
  /** Start an utterance. Audio and face frames for it arrive as binary frames tagged with utteranceId. */
  z.object({
    ...cmdBase,
    type: z.literal('perform.speak'),
    utteranceId: z.string(),
    text: z.string(),
    emotion: Emotion,
    /** Emotion changes inside the utterance, as offsets from its start (the tag parser's output). */
    emotionTimeline: z.array(z.object({ tMs: z.number(), emotion: Emotion, intensity: z.number().min(0).max(1) })).default([]),
    audio: z.object({ format: z.literal('pcm_s16le'), sampleRate: z.number(), channels: z.literal(1), totalMs: z.number().optional() }),
    /** 'stage' = the stage computes the face from audio; 'backend' = FaceFrames arrive from the backend. */
    faceSource: z.enum(['stage', 'backend']),
  }),
  z.object({ ...cmdBase, type: z.literal('perform.cancel'), utteranceId: z.string(), fadeMs: z.number().default(120) }),
  z.object({ ...cmdBase, type: z.literal('perform.affect'), affect: Affect, blendMs: z.number().default(400) }),
  z.object({ ...cmdBase, type: z.literal('perform.gesture'), clip: z.string(), intensity: z.number().min(0).max(1).default(0.7), targetObjectId: z.string().optional() }),
  z.object({ ...cmdBase, type: z.literal('perform.gaze'), target: GazeTarget, speed: z.number().min(0).max(1).default(0.6), saccades: z.boolean().default(true) }),
  z.object({ ...cmdBase, type: z.literal('perform.posture'), posture: Posture, anchorObjectId: z.string().optional(), anchorId: z.string().optional() }),
  z.object({ ...cmdBase, type: z.literal('perform.idle'), profile: z.enum(['attentive', 'relaxed', 'busy', 'sleepy', 'asleep']) }),
  z.object({ ...cmdBase, type: z.literal('perform.interact'), objectId: z.string(), action: z.string() }),
])
export type StageCommand = z.infer<typeof StageCommand>

// ---------------------------------------------------------------------------------------------------------------
// Events: stage -> backend
// ---------------------------------------------------------------------------------------------------------------

export const StageEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), protocol: z.literal(STAGE_PROTOCOL), capabilities: StageCapabilities, stageClockMs: z.number() }),
  z.object({ type: z.literal('asset.loaded'), assetId: z.string(), ms: z.number() }),
  z.object({ type: z.literal('asset.failed'), assetId: z.string(), reason: z.string() }),
  z.object({ type: z.literal('speak.started'), utteranceId: z.string(), stageMs: z.number() }),
  z.object({ type: z.literal('speak.ended'), utteranceId: z.string(), stageMs: z.number(), interrupted: z.boolean() }),
  z.object({ type: z.literal('command.done'), id: z.string() }),
  z.object({ type: z.literal('command.failed'), id: z.string(), reason: z.string() }),
  /** Presence from the camera, computed on the stage or the web UI. Never carries image data. */
  z.object({ type: z.literal('user.presence'), present: z.boolean(), lookingAtScreen: z.boolean().optional(), distance: z.enum(['near', 'mid', 'far']).optional() }),
  z.object({ type: z.literal('object.clicked'), objectId: z.string(), button: z.enum(['primary', 'secondary']).default('primary') }),
  /** The user interacted with the character directly. Region-level only; the backend applies her boundaries. */
  z.object({ type: z.literal('character.interact'), characterId: z.string(), region: z.enum(['head', 'hand', 'shoulder', 'body']), kind: z.enum(['click', 'drag', 'wave']) }),
  z.object({ type: z.literal('perf'), fps: z.number(), gpuMs: z.number(), vramMb: z.number() }),
  z.object({ type: z.literal('error'), message: z.string(), fatal: z.boolean().default(false) }),
])
export type StageEvent = z.infer<typeof StageEvent>

/**
 * Binary frames (little-endian): [kind:u8][utteranceIdHash:u32][tStartMs:f64][payload...].
 * - Audio:  pcm_s16le mono chunks (24 kHz), ~20 ms each, sent slightly ahead of playback.
 * - Face:   ARKit weights, one f32 per entry of ARKIT_52 in canonical order, 30 fps. Audio2Face-3D also emits extra
 *           tongue shapes; their order must be confirmed against the SDK before they are added (see ADR 0008).
 * - Body:   reserved for future retargeted joint streams.
 */
export const BinaryFrameKind = { audio: 1, face: 2, body: 3 } as const
export type BinaryFrameKind = (typeof BinaryFrameKind)[keyof typeof BinaryFrameKind]

/** The 52 ARKit blendshapes in Apple's alphabetical-by-region order (tongueOut is the 52nd). */
export const ARKIT_52 = [
  'browDownLeft', 'browDownRight', 'browInnerUp', 'browOuterUpLeft', 'browOuterUpRight',
  'cheekPuff', 'cheekSquintLeft', 'cheekSquintRight',
  'eyeBlinkLeft', 'eyeBlinkRight', 'eyeLookDownLeft', 'eyeLookDownRight', 'eyeLookInLeft', 'eyeLookInRight',
  'eyeLookOutLeft', 'eyeLookOutRight', 'eyeLookUpLeft', 'eyeLookUpRight', 'eyeSquintLeft', 'eyeSquintRight',
  'eyeWideLeft', 'eyeWideRight',
  'jawForward', 'jawLeft', 'jawOpen', 'jawRight',
  'mouthClose', 'mouthDimpleLeft', 'mouthDimpleRight', 'mouthFrownLeft', 'mouthFrownRight', 'mouthFunnel',
  'mouthLeft', 'mouthLowerDownLeft', 'mouthLowerDownRight', 'mouthPressLeft', 'mouthPressRight', 'mouthPucker',
  'mouthRight', 'mouthRollLower', 'mouthRollUpper', 'mouthShrugLower', 'mouthShrugUpper',
  'mouthSmileLeft', 'mouthSmileRight', 'mouthStretchLeft', 'mouthStretchRight', 'mouthUpperUpLeft', 'mouthUpperUpRight',
  'noseSneerLeft', 'noseSneerRight', 'tongueOut',
] as const
export type ARKitBlendshape = (typeof ARKIT_52)[number]
