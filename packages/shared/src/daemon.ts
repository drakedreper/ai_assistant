import { z } from 'zod'
import { IsoDateTime } from './schemas/common'
import { Persona } from './schemas/settings'
import { TaskColumn } from './schemas/work'
import { Affect, GazeTarget, Posture, PresenceStyle, StageEngine, WardrobeSlot } from './stage'

/**
 * The daemon's wire contract. The web DaemonClient and the daemon both import this, so they cannot drift.
 * Everything binds to 127.0.0.1. Browser calls authenticate with an HttpOnly cookie (exchanged once from the
 * URL the daemon prints at startup); Claude Code hooks authenticate with a separate bearer token.
 */
export const DEFAULT_DAEMON_PORT = 7421

export const DaemonRoutes = {
  health: '/api/health',
  snapshot: '/api/snapshot',
  authExchange: '/api/auth/exchange',
  chat: '/api/chat',
  chatInterrupt: '/api/chat/interrupt',
  approvalDecision: (id: string) => `/api/approvals/${encodeURIComponent(id)}/decision`,
  proposalDecision: (id: string) => `/api/proposals/${encodeURIComponent(id)}/decision`,
  tasks: '/api/tasks',
  task: (id: string) => `/api/tasks/${encodeURIComponent(id)}`,
  trustMode: (ruleId: string) => `/api/settings/trust/${encodeURIComponent(ruleId)}`,
  claudeMode: '/api/settings/claude-mode',
  guestMode: '/api/settings/guest',
  webcam: '/api/settings/webcam',
  persona: '/api/settings/persona',
  learned: (id: string) => `/api/learned/${encodeURIComponent(id)}`,
  /** Embedded terminals (highest-risk surface: see apps/daemon/README.md). All need terminals enabled in Settings. */
  terminals: '/api/terminals',
  terminal: (id: string) => `/api/terminals/${encodeURIComponent(id)}`,
  /** POST: mint a single-use, short-lived ticket bound to this terminal. */
  terminalTicket: (id: string) => `/api/terminals/${encodeURIComponent(id)}/ticket`,
  terminalsEnabled: '/api/settings/terminals',
  /** WebSocket for one terminal. No secrets in the URL: the first text frame must be {type:'auth', ticket}. */
  terminalWs: (id: string) => `/ws/terminal/${encodeURIComponent(id)}`,
  /** WebSocket for a stage (Unreal/Unity/simulator). Authenticates with `Authorization: Bearer <stage token>`; loopback only. */
  stageWs: '/ws/stage',
  /** GET: the StageSnapshot (also part of GET /api/snapshot). */
  stage: '/api/stage',
  /** PUT or POST {on}: the persisted stage switch (default on in daemon mode). */
  stageEnabled: '/api/settings/stage',
  /** DELETE: close the current stage connection (the stage may reconnect). */
  stageConnection: '/api/stage/connection',
  /** POST {manifest}: register a catalog entry (metadata only; the licence is judged on every use). */
  stageAssets: '/api/stage/assets',
  /** PUT {characterId}: make a character the active one of its role. */
  stageCharacterSelect: '/api/stage/characters/select',
  /** PUT {params}: morph sliders (refused when out of range or outside the adult envelope). */
  stageCharacterParams: (id: string) => `/api/stage/characters/${encodeURIComponent(id)}/params`,
  /** PUT: the presence style (five sliders and the baseline mood). */
  stageCharacterPresence: (id: string) => `/api/stage/characters/${encodeURIComponent(id)}/presence`,
  /** POST {assetId, slot?}: wear an item. */
  stageEquip: (id: string) => `/api/stage/characters/${encodeURIComponent(id)}/equip`,
  /** POST {slot}: take a slot off (refused when it would leave the character without a full outfit). */
  stageUnequip: (id: string) => `/api/stage/characters/${encodeURIComponent(id)}/unequip`,
  /** POST {presetId}: put on a saved outfit preset. */
  stageOutfitApply: (id: string) => `/api/stage/characters/${encodeURIComponent(id)}/outfit/apply`,
  /** POST {name}: save the current look as a preset. */
  stageOutfitSave: (id: string) => `/api/stage/characters/${encodeURIComponent(id)}/outfit/save`,
  /** POST {presetId}: delete a saved preset. */
  stageOutfitDelete: (id: string) => `/api/stage/characters/${encodeURIComponent(id)}/outfit/delete`,
  /** POST {activity?, weather?}: ask the OutfitDirector what she would wear (nothing is applied). */
  stageOutfitSuggest: (id: string) => `/api/stage/characters/${encodeURIComponent(id)}/outfit/suggest`,
  /** POST {presetId}: switch to a saved scene preset. */
  stageScenePreset: '/api/stage/scene/preset',
  /** POST {assetId,...}: place an object. */
  stageSceneObjects: '/api/stage/scene/objects',
  /** PUT or PATCH {...}: move or swap an object. DELETE: remove it. */
  stageSceneObject: (id: string) => `/api/stage/scene/objects/${encodeURIComponent(id)}`,
  /** PUT {shot}: the active camera shot. */
  stageCamera: '/api/stage/scene/camera',
  /**
   * GET: what she remembers (StageMemoryList, newest first). DELETE ?confirm=all: forget everything she remembers.
   * Both work while the stage is switched off: "her data stays" is only true if you can always see and delete it.
   */
  stageMemory: '/api/stage/memory',
  /** DELETE: forget one remembered item. */
  stageMemoryItem: (id: string) => `/api/stage/memory/${encodeURIComponent(id)}`,
  /** WebSocket. Query: ?since=<seq>&epoch=<epoch> to resume. */
  ws: '/ws',
  /** Claude Code http hooks POST here. Bearer = hook token. Always answers 200 fast (fail-open). */
  hook: (event: string) => `/hooks/${encodeURIComponent(event)}`,
} as const

export const AuthExchangeRequest = z.object({ code: z.string().min(16) })

export const ChatRequest = z.object({
  text: z.string().min(1).max(8000),
  modality: z.enum(['text', 'voice']).default('text'),
})
export type ChatRequest = z.infer<typeof ChatRequest>

export const DecisionRequest = z.object({ decision: z.enum(['approved', 'denied', 'rejected']) })
export const TaskCreateRequest = z.object({
  title: z.string().min(1).max(200),
  projectId: z.string().optional(),
  column: TaskColumn.optional(),
})
export const TaskMoveRequest = z.object({ column: TaskColumn })
export const TaskPatchRequest = z.object({
  column: TaskColumn.optional(),
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  priority: z.enum(['low', 'medium', 'high']).optional(),
})
export type TaskPatchRequest = z.infer<typeof TaskPatchRequest>

/** Error body returned by every non-2xx API response. */
export const ApiError = z.object({ error: z.string(), message: z.string(), details: z.unknown().optional() })
export type ApiError = z.infer<typeof ApiError>

export const AuthExchangeResponse = z.object({ ok: z.literal(true) })
export const TrustModeRequest = z.object({ mode: z.enum(['ask', 'auto']) })
export const ClaudeModeRequest = z.object({ mode: z.enum(['api-key', 'local-login']) })
export const OnOffRequest = z.object({ on: z.boolean() })
export const PersonaPatchRequest = Persona.partial()

/** First message on every WebSocket. If `epoch` differs from the client's, the client must refetch the snapshot. */
export const WsHello = z.object({
  type: z.literal('hello'),
  /** Latest sequence number at connect time. */
  seq: z.number().int().nonnegative(),
  /** Random per daemon process. A restart changes it, so sequence numbers are never compared across runs. */
  epoch: z.string(),
  backend: z.enum(['fake', 'sdk']),
  version: z.string(),
  /** True when the requested resume point cannot be served (older than the replay buffer, or a different epoch). Refetch the snapshot. */
  resync: z.boolean().optional(),
  reason: z.string().optional(),
})
export type WsHello = z.infer<typeof WsHello>

export const DaemonHealth = z.object({
  ok: z.literal(true),
  version: z.string(),
  epoch: z.string(),
  uptimeSec: z.number(),
  backend: z.enum(['fake', 'sdk']),
  lane: z.enum(['starting', 'ready', 'busy', 'error', 'stopped']),
  hooksReceived: z.number().int(),
  lastHookAt: z.string().nullable(),
  sessions: z.number().int(),
  dataDir: z.string(),
})
export type DaemonHealth = z.infer<typeof DaemonHealth>

/**
 * A Claude Code hook payload as it arrives. Only the common fields are modelled; everything else is kept
 * verbatim (the format moves fast: 12 events in 2025, 33 now), so projections are tolerant by design.
 */
export const HookPayload = z
  .object({
    session_id: z.string(),
    hook_event_name: z.string().optional(),
    cwd: z.string().optional(),
    transcript_path: z.string().optional(),
    permission_mode: z.string().optional(),
    agent_id: z.string().optional(),
    agent_type: z.string().optional(),
    tool_name: z.string().optional(),
    tool_use_id: z.string().optional(),
    tool_input: z.unknown().optional(),
    tool_response: z.unknown().optional(),
    prompt: z.string().optional(),
    message: z.string().optional(),
    notification_type: z.string().optional(),
    model: z.string().optional(),
    source: z.string().optional(),
    reason: z.string().optional(),
    last_assistant_message: z.string().optional(),
    error: z.unknown().optional(),
    parent_agent_id: z.string().optional(),
  })
  .passthrough()
export type HookPayload = z.infer<typeof HookPayload>

/** Hook events the installer registers. PreToolUse is deliberately absent: a slow receiver there blocks the tool. */
export const NON_BLOCKING_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Notification',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'SessionEnd',
] as const

// ---------------------------------------------------------------------------------------------------------------
// Embedded terminals
// ---------------------------------------------------------------------------------------------------------------

export const TerminalKind = z.enum(['claude', 'shell'])
export type TerminalKind = z.infer<typeof TerminalKind>

export const TerminalInfo = z.object({
  id: z.string(),
  kind: TerminalKind,
  title: z.string(),
  cwd: z.string(),
  projectId: z.string().optional(),
  cols: z.number().int(),
  rows: z.number().int(),
  createdAt: z.string(),
  state: z.enum(['running', 'exited']),
  exitCode: z.number().int().nullable().optional(),
})
export type TerminalInfo = z.infer<typeof TerminalInfo>

export const TerminalCreateRequest = z.object({
  kind: TerminalKind,
  /** Start in a known project's root. Preferred over cwd. */
  projectId: z.string().optional(),
  /** Must resolve inside a known project root or the user's home; anything else is refused. */
  cwd: z.string().optional(),
  cols: z.number().int().min(10).max(500).default(100),
  rows: z.number().int().min(5).max(200).default(30),
})
export type TerminalCreateRequest = z.infer<typeof TerminalCreateRequest>

export const TerminalTicketResponse = z.object({ ticket: z.string(), expiresInSec: z.number() })
export type TerminalTicketResponse = z.infer<typeof TerminalTicketResponse>

/**
 * Terminal WebSocket framing. Terminal bytes (output and keystrokes) travel as BINARY frames; everything else is
 * one of these JSON text frames. The first client frame must be `auth`, within a few seconds, or the socket closes.
 */
export const TerminalClientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('auth'), ticket: z.string() }),
  z.object({ type: z.literal('resize'), cols: z.number().int().min(10).max(500), rows: z.number().int().min(5).max(200) }),
])
export type TerminalClientMessage = z.infer<typeof TerminalClientMessage>

export const TerminalServerMessage = z.discriminatedUnion('type', [
  /** Sent after auth. `replayBytes` of scrollback follow as binary frames. */
  z.object({ type: z.literal('ready'), replayBytes: z.number().int().nonnegative() }),
  z.object({ type: z.literal('exit'), exitCode: z.number().int().nullable() }),
  z.object({ type: z.literal('error'), message: z.string() }),
])
export type TerminalServerMessage = z.infer<typeof TerminalServerMessage>

// ---------------------------------------------------------------------------------------------------------------
// Stage REST (apps/daemon/src/stage). All of these are validated again by the stage-core services.
// ---------------------------------------------------------------------------------------------------------------

const StageId = z.string().min(1).max(96)

export const StageSelectRequest = z.object({ characterId: StageId })
export type StageSelectRequest = z.infer<typeof StageSelectRequest>

/** Morph sliders: paramId -> number, or "#rrggbb" for colours. Out-of-range values are REFUSED (never clamped silently). */
export const StageParamsRequest = z.object({
  params: z
    .record(z.string().min(1).max(64), z.union([z.number(), z.string().max(16)]))
    .refine((r) => Object.keys(r).length > 0 && Object.keys(r).length <= 64, { message: 'send between 1 and 64 parameters' }),
  blendMs: z.number().min(0).max(5000).optional(),
})
export type StageParamsRequest = z.infer<typeof StageParamsRequest>

/** Any subset of the presence style; `baseline` may carry any subset of valence, arousal, dominance. */
export const StagePresenceRequest = PresenceStyle.partial()
  .extend({ baseline: PresenceStyle.shape.baseline.partial().optional() })
  .refine((v) => Object.keys(v).length > 0, { message: 'send at least one field' })
export type StagePresenceRequest = z.infer<typeof StagePresenceRequest>

export const StageEquipRequest = z.object({ assetId: StageId, slot: WardrobeSlot.optional() })
export type StageEquipRequest = z.infer<typeof StageEquipRequest>

export const StageUnequipRequest = z.object({ slot: WardrobeSlot })
export type StageUnequipRequest = z.infer<typeof StageUnequipRequest>

export const StageOutfitApplyRequest = z.object({ presetId: StageId })
export type StageOutfitApplyRequest = z.infer<typeof StageOutfitApplyRequest>

export const StageOutfitSaveRequest = z.object({ name: z.string().min(1).max(40), id: StageId.optional() })
export type StageOutfitSaveRequest = z.infer<typeof StageOutfitSaveRequest>

export const StageOutfitSuggestRequest = z.object({
  activity: z.enum(['work', 'meeting', 'relax', 'sleep', 'out']).optional(),
  weather: z.enum(['clear', 'cloudy', 'rain', 'snow', 'cold', 'hot']).optional(),
})
export type StageOutfitSuggestRequest = z.infer<typeof StageOutfitSuggestRequest>

export const StageScenePresetRequest = z.object({ presetId: StageId })
export type StageScenePresetRequest = z.infer<typeof StageScenePresetRequest>

const Metres = z.number().min(-50).max(50)
export const StageSceneObjectAddRequest = z.object({
  assetId: StageId,
  id: StageId.optional(),
  /** Metres, Y up. Omitted: a free spot is chosen. */
  position: z.tuple([Metres, Metres, Metres]).optional(),
  yawDeg: z.number().min(-360).max(360).optional(),
  scale: z.number().min(0.05).max(20).optional(),
  role: z.enum(['static', 'furniture', 'interactable']).optional(),
})
export type StageSceneObjectAddRequest = z.infer<typeof StageSceneObjectAddRequest>

export const StageSceneObjectUpdateRequest = z
  .object({
    assetId: StageId.optional(),
    position: z.tuple([Metres, Metres, Metres]).optional(),
    yawDeg: z.number().min(-360).max(360).optional(),
    scale: z.number().min(0.05).max(20).optional(),
    visible: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'send at least one field' })
export type StageSceneObjectUpdateRequest = z.infer<typeof StageSceneObjectUpdateRequest>

export const StageCameraRequest = z.object({ shot: z.string().min(1).max(32) })
export type StageCameraRequest = z.infer<typeof StageCameraRequest>

/** A catalog manifest (asset.json). Metadata only: no binary is ever accepted here. Judged by the stage-core catalog. */
export const StageAssetRegisterRequest = z.object({ manifest: z.record(z.string(), z.unknown()) })
export type StageAssetRegisterRequest = z.infer<typeof StageAssetRegisterRequest>

/**
 * The light, live part of the stage state, pushed to the dashboards (`stage.live` event) and included in the stage
 * snapshot. `rev` changes whenever the structural snapshot (characters, wardrobe, scene, connection) changed: refetch
 * GET /api/stage then. The rest is what the draft web stage draws without fetching anything.
 */
export const StageLive = z.object({
  rev: z.number().int().nonnegative(),
  enabled: z.boolean(),
  connected: z.boolean(),
  engine: StageEngine.optional(),
  mood: Affect.nullable(),
  idle: z.enum(['attentive', 'relaxed', 'busy', 'sleepy', 'asleep']).optional(),
  posture: Posture.optional(),
  gaze: GazeTarget.optional(),
  speaking: z.boolean(),
  camera: z.string().optional(),
  /** Last stage performance report (fps), if the connected stage sends one. */
  perf: z.object({ fps: z.number().min(0).max(10_000), gpuMs: z.number().min(0).max(1_000_000), vramMb: z.number().min(0).max(10_000_000) }).optional(),
})
export type StageLive = z.infer<typeof StageLive>

/** What the OutfitDirector would do now, with its one-line reason. Nothing is applied by asking. */
export const StageOutfitSuggestion = z.object({
  presetId: z.string(),
  presetName: z.string(),
  explanation: z.string(),
  /** False when the suggestion is "keep what she wears". */
  changed: z.boolean(),
})
export type StageOutfitSuggestion = z.infer<typeof StageOutfitSuggestion>

/** The most items GET /api/stage/memory returns (the newest): her memory holds 2000 notes at most, so this lists every one. */
export const STAGE_MEMORY_LIST_LIMIT = 2000

/**
 * One thing she wrote down with her memory tool. The text is your own data on your own PC, so you see all of it; the UI
 * blurs everything that is not `normal` in Guest mode. Only `normal` items can ever be summarised into her prompt.
 */
export const StageMemoryItem = z.object({
  id: z.string().min(1).max(96),
  kind: z.enum(['episode', 'relationship', 'preference']),
  text: z.string().max(520),
  importance: z.number().int().min(1).max(5),
  sensitivity: z.enum(['normal', 'private', 'sensitive']),
  tags: z.array(z.string().max(40)).max(8),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
})
export type StageMemoryItem = z.infer<typeof StageMemoryItem>

export const StageMemoryList = z.object({
  /** Everything stored, not only the items returned. */
  total: z.number().int().nonnegative(),
  /** Stored rows the list cannot show because their id cannot be addressed (an empty or oversized id). Forgetting everything removes them. */
  unlisted: z.number().int().nonnegative(),
  /** Newest first, at most STAGE_MEMORY_LIST_LIMIT. */
  items: z.array(StageMemoryItem).max(STAGE_MEMORY_LIST_LIMIT),
  /** Counts over everything stored. */
  bySensitivity: z.object({ normal: z.number().int().nonnegative(), private: z.number().int().nonnegative(), sensitive: z.number().int().nonnegative() }),
})
export type StageMemoryList = z.infer<typeof StageMemoryList>
