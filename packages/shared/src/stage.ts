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
  /** The stage can track the user (webcam) to drive the user's avatar and report presence. Never sends images. */
  tracking: z.object({ face: z.boolean(), body: z.boolean() }).default({ face: false, body: false }),
  /** Data constructs the stage can draw in the space (see ConstructKind). */
  constructs: z.array(z.string()).default([]),
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

/**
 * How a character carries herself. The behaviour director reads it, so the same words and emotions look different
 * on different people. "Athletic and intelligent, meeting in authority" is: upright and balanced, economical in
 * gesture, long steady gaze, measured pace, high dominance with low arousal. Values are 0..1.
 */
export const PresenceStyle = z.object({
  /** 0 = relaxed/slouched, 1 = rigidly upright. Authority sits around 0.7-0.85. */
  uprightness: z.number().min(0).max(1),
  /** 0 = expressive and busy, 1 = very economical. Fewer, deliberate gestures read as authority. */
  gestureEconomy: z.number().min(0).max(1),
  /** How long gaze is held before a natural break. */
  gazeHold: z.number().min(0).max(1),
  /** 0 = quick and energetic, 1 = slow and measured. */
  pace: z.number().min(0).max(1),
  /** Athletic bearing: balanced weight, grounded stance, controlled movement. */
  athleticism: z.number().min(0).max(1),
  /** Baseline mood the MoodEngine decays toward (valence, arousal, dominance in -1..1). */
  baseline: z.object({ valence: z.number().min(-1).max(1), arousal: z.number().min(-1).max(1), dominance: z.number().min(-1).max(1) }),
})
export type PresenceStyle = z.infer<typeof PresenceStyle>

/** "authority": the user's brief for the long-term assistant. Used as the default for new assistant characters. */
export const AUTHORITY_PRESENCE: PresenceStyle = {
  uprightness: 0.8,
  gestureEconomy: 0.75,
  gazeHold: 0.8,
  pace: 0.65,
  athleticism: 0.8,
  baseline: { valence: 0.2, arousal: -0.1, dominance: 0.7 },
}

export const CharacterProfile = z.object({
  id: z.string(),
  /** 'assistant' is the second brain's embodiment; 'user' is the representation of the user in the space. */
  role: z.enum(['assistant', 'user']).default('assistant'),
  name: z.string(),
  /** Base body/face asset (kind character_base). */
  baseAssetId: z.string(),
  rigFamily: RigFamily,
  /** All slider/color values set by the user or the character creator: paramId -> value. */
  params: z.record(z.string(), z.union([z.number(), z.string()])),
  equipped: Equipped,
  presets: z.array(OutfitPreset).default([]),
  voice: VoiceProfile,
  presence: PresenceStyle.default(AUTHORITY_PRESENCE),
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

/**
 * The look of an empty "cerebral space": a dark void, volumetric fog, one soft pool of light on the floor,
 * drifting dust motes and a heavy vignette (see docs/CEREBRAL-SPACE.md).
 */
export const Atmosphere = z.object({
  ground: z.enum(['void', 'reflective', 'grid']).default('void'),
  fogColor: z.string().default('#0a1a3a'),
  fogDensity: z.number().min(0).max(1).default(0.55),
  /** Light shafts and soft volumetric glow. */
  volumetrics: z.boolean().default(true),
  dustMotes: z.number().min(0).max(1).default(0.35),
  /** The lit pool of floor under the character. */
  floorPool: z.object({ radius: z.number().default(2.2), intensity: z.number().default(1), color: z.string().default('#cfe3ff') }).default({ radius: 2.2, intensity: 1, color: '#cfe3ff' }),
  vignette: z.number().min(0).max(1).default(0.7),
  bloom: z.number().min(0).max(1).default(0.35),
})
export type Atmosphere = z.infer<typeof Atmosphere>

export const LightingPreset = z.object({
  id: z.string(),
  name: z.string(),
  /** 'clock' derives sun/moon from the real time and weather; 'fixed' uses the named look. */
  mode: z.enum(['clock', 'fixed']),
  look: z.enum(['day', 'golden', 'dusk', 'night', 'studio', 'neon', 'void']).optional(),
  atmosphere: Atmosphere.optional(),
})
export type LightingPreset = z.infer<typeof LightingPreset>

/**
 * A data construct is something the stage DRAWS from live data, not a mesh the user placed: the second brain as a
 * 3D knowledge constellation, Claude sessions as agents orbiting a project, a terminal as a pane in space.
 * The backend computes layout and pushes data; the stage renders it and reports clicks. This is how the
 * dashboards become places in the cerebral space.
 */
export const ConstructKind = z.enum([
  'knowledge_graph', // notes as nodes, wikilinks as edges, layers as depth
  'session_orbit', // Claude sessions and subagents as bodies orbiting their project
  'project_cluster', // projects as structures with their tasks
  'timeline_ribbon', // calendar and journal as a ribbon through time
  'terminal_pane', // an interactive terminal (claude or a shell) as a pane
  'mail_stream',
  'finance_pulse',
])
export type ConstructKind = z.infer<typeof ConstructKind>

export const DataConstruct = z.object({
  id: z.string(),
  kind: ConstructKind,
  transform: Transform,
  source: z.enum(['brain', 'work', 'life', 'money', 'world', 'terminal']),
  /** Source-specific filter, e.g. { layer: "strategy" } or { terminalId: "t1" }. */
  query: z.record(z.string(), z.unknown()).default({}),
  style: z
    .object({
      palette: z.enum(['cool', 'warm', 'mono']).default('cool'),
      density: z.number().min(0).max(1).default(0.5),
      scale: z.number().positive().default(1),
    })
    .default({ palette: 'cool', density: 0.5, scale: 1 }),
  interactive: z.boolean().default(true),
})
export type DataConstruct = z.infer<typeof DataConstruct>

export const GraphNode = z.object({
  id: z.string(),
  label: z.string(),
  layer: z.enum(['core', 'strategy', 'episodic', 'semantic', 'project', 'inbox']).optional(),
  importance: z.number().int().min(1).max(5).default(2),
  /** Layout computed by the backend so every engine draws the same constellation. */
  position: Vec3.optional(),
  color: z.string().optional(),
  /** Visual hints derived from importance by the backend (node radius in metres, glow 0..1). Additive, optional. */
  size: z.number().positive().optional(),
  brightness: z.number().min(0).max(1).optional(),
})
export const GraphEdge = z.object({ from: z.string(), to: z.string(), weight: z.number().default(1) })
export type GraphNode = z.infer<typeof GraphNode>
export type GraphEdge = z.infer<typeof GraphEdge>

export const Scene = z.object({
  id: z.string(),
  name: z.string(),
  environmentAssetId: z.string(),
  objects: z.array(SceneObject),
  constructs: z.array(DataConstruct).default([]),
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

const cmdBase = {
  id: z.string(),
  /** Stage-clock time the command should take effect; omitted = now. */
  atMs: z.number().optional(),
  /** Which character this applies to. Omitted = the assistant character. */
  characterId: z.string().optional(),
}

export const StageCommand = z.discriminatedUnion('type', [
  // --- loading and look ---
  z.object({ ...cmdBase, type: z.literal('character.load'), character: CharacterProfile, assets: z.array(Asset) }),
  z.object({ ...cmdBase, type: z.literal('character.params'), characterId: z.string(), params: z.record(z.string(), z.union([z.number(), z.string()])), blendMs: z.number().default(0) }),
  z.object({ ...cmdBase, type: z.literal('character.equip'), characterId: z.string(), slot: WardrobeSlot, assetId: z.string().nullable(), asset: Asset.optional() }),
  z.object({ ...cmdBase, type: z.literal('character.outfit'), characterId: z.string(), preset: OutfitPreset, assets: z.array(Asset) }),
  z.object({ ...cmdBase, type: z.literal('scene.load'), scene: Scene, assets: z.array(Asset) }),
  z.object({ ...cmdBase, type: z.literal('scene.object'), op: z.enum(['add', 'update', 'remove']), object: SceneObject, asset: Asset.optional() }),
  z.object({ ...cmdBase, type: z.literal('scene.construct'), op: z.enum(['add', 'update', 'remove']), construct: DataConstruct }),
  /** Push data into a construct. 'replace' swaps everything, 'merge' upserts by id. */
  z.object({
    ...cmdBase,
    type: z.literal('scene.data'),
    constructId: z.string(),
    mode: z.enum(['replace', 'merge']).default('merge'),
    nodes: z.array(GraphNode).optional(),
    edges: z.array(GraphEdge).optional(),
    items: z.array(z.record(z.string(), z.unknown())).optional(),
    /**
     * Removals for 'merge' mode (additive, optional): node ids (their edges go with them), edges by endpoints and item
     * ids. Lets the backend send minimal diffs instead of replacing the whole construct every tick.
     */
    remove: z
      .object({
        nodes: z.array(z.string()).optional(),
        edges: z.array(z.object({ from: z.string(), to: z.string() })).optional(),
        items: z.array(z.string()).optional(),
      })
      .optional(),
  }),
  /** Terminal bytes (ANSI) from the daemon's PTY for a terminal_pane construct. */
  z.object({ ...cmdBase, type: z.literal('construct.terminal.write'), constructId: z.string(), data: z.string() }),
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
  z.object({ type: z.literal('construct.clicked'), constructId: z.string(), itemId: z.string().optional() }),
  /** Keystrokes typed into a focused terminal_pane. The daemon forwards them to the PTY after its own checks. */
  z.object({ type: z.literal('construct.terminal.input'), constructId: z.string(), data: z.string() }),
  z.object({ type: z.literal('construct.terminal.resize'), constructId: z.string(), cols: z.number().int(), rows: z.number().int() }),
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
 *
 * Details fixed by packages/stage-core (src/protocol/frames.ts), which has the reference encoder/decoder:
 * - utteranceIdHash is FNV-1a 32-bit over the UTF-8 bytes of the utteranceId.
 * - A face message carries k >= 1 consecutive frames (payload = k * 208 bytes); frame i is at tStartMs + i * 1000/30.
 * - Decoders reject truncated frames, unknown kinds, non-finite times or weights and misaligned payloads.
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

// ---------------------------------------------------------------------------------------------------------------
// What the dashboard UI sees of the stage backend (Snapshot.stage)
// ---------------------------------------------------------------------------------------------------------------

export const StageSnapshot = z.object({
  /** False until the stage backend is switched on; the rest is then empty. */
  enabled: z.boolean(),
  characters: z.array(CharacterProfile),
  /** The assistant (second brain's embodiment) and the user's representation. */
  assistantCharacterId: z.string().nullable(),
  userCharacterId: z.string().nullable(),
  /** The catalog, metadata only (licence, slots, params). */
  assets: z.array(Asset),
  scene: Scene.nullable(),
  scenePresets: z.array(z.object({ id: z.string(), name: z.string() })),
  mood: Affect.nullable(),
  /** The renderer currently attached (an engine, the web room, or the simulator). */
  stage: z.object({
    connected: z.boolean(),
    engine: StageEngine.optional(),
    capabilities: StageCapabilities.optional(),
    /** Additive, optional: ISO time the current connection became ready. */
    since: z.string().optional(),
  }),
  /** Additive, optional: monotonic revision of this snapshot (see StageLive.rev in daemon.ts). */
  rev: z.number().int().nonnegative().optional(),
  /** Additive, optional: what the OutfitDirector would have the assistant wear now, with its reason. */
  outfitSuggestion: z.object({ presetId: z.string(), presetName: z.string(), explanation: z.string(), changed: z.boolean() }).nullable().optional(),
  /** Additive, optional: shot ids the working scene has (wide, medium, closeup, ...). */
  cameraShots: z.array(z.string()).optional(),
})
export type StageSnapshot = z.infer<typeof StageSnapshot>
