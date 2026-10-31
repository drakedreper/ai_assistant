import { Asset } from '@ai-assistant/shared'
import type { AuditEntry, CharacterProfile, Emotion, GazeTarget, Persona, Posture, ServerEvent, StageCapabilities, StageEngine, StageEvent, StageLive, StageSnapshot, ToolBinding } from '@ai-assistant/shared'
import {
  AssetCatalog,
  BehaviorDirector,
  CameraDirector,
  ConstructDataSync,
  FakeFaceProvider,
  FakeTtsProvider,
  MoodEngine,
  OutfitDirector,
  SpeechPipeline,
  StageMirror,
  createCharacterMemory,
  createCharacterService,
  createOutfitDirector,
  createRng,
  createSceneService,
  createStageSession,
  createStageToolBindings,
  createWardrobeService,
  decodeFrame,
  type CharacterMemory,
  type CharacterService,
  type CommandDraft,
  type CommandResult,
  type FaceProvider,
  type GraphNoteInput,
  type MoodEventType,
  type OutfitContext,
  type OutfitDirectorState,
  type Rng,
  type SceneService,
  type StageSession,
  type StageTransport,
  type Timers,
  type TtsProvider,
  type WardrobeChange,
  type WardrobeService,
} from '@ai-assistant/stage-core'
import type { EventBus } from '../bus'
import type { DaemonConfig } from '../config'
import type { IdGen } from '../ids'
import type { Logger } from '../log'
import { StageStore, type Store } from '../store'
import { redactText } from '../store/redact'
import { ConstructFeed } from './constructs'
import { STAGE_SEED_VERSION, loadCatalog, runSeed } from './seed'

/**
 * The StageHub owns everything the backend knows about the live character: the catalog, the characters and their
 * wardrobe, the scene, her memory and mood, the behaviour loop, the speech pipeline and the ONE stage connection.
 *
 *   daemon bus (chat, avatar, approvals, sessions) --> mood signals, speech, camera, constructs  --> stage connection
 *   REST / tools (actions.ts, stage-core tool bindings) --> services (validate, persist) --> commands --> stage connection
 *   stage events (speak.started, user.presence, clicks)  --> behaviour, mood
 *   everything that changes --> `stage.live` events for the dashboards (and the draft web room)
 *
 * The stage is replaceable (Unreal, Unity, the simulator): the hub only speaks `mira-stage/1` through a StageSession,
 * and keeps working, as a pure backend, when none is connected. A stage that disconnects loses nothing: its look is
 * rebuilt from the database (never from what the stage last acknowledged) when it comes back.
 *
 * PRIVACY: nothing here logs text, audio, camera data or terminal bytes. Keystrokes sent by a stage pane
 * (`construct.terminal.input`) are DROPPED: the stage is not wired to any terminal, on purpose (see README, Stage).
 */

export const STAGE_KV = {
  enabled: 'settings.stage',
  seeded: 'stage.seeded',
  outfit: 'stage.outfitDirector',
} as const

/** How long after the user's last message the camera and the behaviour treat the moment as "a conversation". */
const CONVERSATION_MS = 20_000
const LIVE_MIN_GAP_MS = 1500

const THANKS = /\b(thanks|thank you|thx|great job|well done|nice work|perfect, thanks|brilliant)\b/i
const CRITICISM = /\b(that'?s wrong|you got (it|that) wrong|not what i asked|useless|that was bad|terrible)\b/i

export const unrefTimers: Timers = {
  setTimeout(fn, ms) {
    const h = setTimeout(fn, ms)
    h.unref?.()
    return h
  },
  clearTimeout(h) {
    clearTimeout(h as ReturnType<typeof setTimeout>)
  },
}

export interface StageHubDeps {
  config: DaemonConfig
  store: Store
  bus: EventBus
  log: Logger
  now: () => Date
  clock: () => number
  newId: IdGen
  persona: () => Persona
  /** Providers: the fakes by default (zero cost, no audio hardware). Real TTS and audio-to-face plug in here. */
  tts?: TtsProvider
  face?: FaceProvider
  timers?: Timers
  rng?: Rng
  /** The notes the knowledge graph draws. Default: the fixture notes. */
  notes?: () => GraphNoteInput[]
}

export type DisconnectCause = 'stage' | 'daemon' | 'disabled' | 'refused' | 'replaced' | 'user' | 'slow' | 'stale'

interface Observed {
  idle?: StageLive['idle']
  posture?: Posture
  gaze?: GazeTarget
  perf?: StageLive['perf']
}

export interface ConnectionInfo {
  id: string
  ready: boolean
  engine?: StageEngine
  capabilities?: StageCapabilities
  since?: string
}

/** One accepted stage socket: its session, the speech pipeline bound to it and what it declared. */
export class StageConnection {
  ready = false
  engine: StageEngine | undefined
  capabilities: StageCapabilities | undefined
  since: string | undefined
  pipeline: SpeechPipeline | undefined
  cause: DisconnectCause = 'stage'
  constructor(
    readonly id: string,
    readonly session: StageSession,
    readonly transport: StageTransport & { terminate?(): void },
  ) {}
  info(): ConnectionInfo {
    return { id: this.id, ready: this.ready, ...(this.engine ? { engine: this.engine } : {}), ...(this.capabilities ? { capabilities: this.capabilities } : {}), ...(this.since ? { since: this.since } : {}) }
  }
}

export class StageHub {
  readonly stageStore: StageStore
  readonly catalog = new AssetCatalog()
  readonly characters: CharacterService
  readonly wardrobe: WardrobeService
  readonly scenes: SceneService
  readonly memory: CharacterMemory
  readonly mirror = new StageMirror()
  readonly sync = new ConstructDataSync()
  readonly constructs: ConstructFeed
  readonly camera: CameraDirector
  outfit: OutfitDirector
  mood: MoodEngine | undefined
  behavior: BehaviorDirector | undefined

  readonly clock = { now: () => this.d.clock() }
  readonly timers: Timers
  private readonly ids: (prefix: string) => string
  private readonly rng: Rng
  private readonly tts: TtsProvider
  private readonly face: FaceProvider

  private conn: StageConnection | undefined
  private connSeq = 0
  private rev = 0
  private readonly obs: Observed = {}
  private lastLiveKey = ''
  private lastLiveAt = Number.NEGATIVE_INFINITY
  private tickTimer: ReturnType<typeof setInterval> | undefined
  private ticking = false
  private unsubscribeBus: (() => void) | undefined
  private lastMoodPersistAt = 0
  private readonly pendingSends = new Set<Promise<unknown>>()
  private stopped = false

  // context the behaviour reads
  private lastInteractionAt: number
  private lastChatAt = Number.NEGATIVE_INFINITY
  private chatActive = false
  private pendingApprovals = 0
  private sessionLoad = { running: 0, blocked: 0 }
  private anchorsRev = -1
  private assetsCache: Asset[] | undefined
  /** Counters for the README's honesty and the tests: what the hub refused to do. */
  readonly dropped = { terminalInput: 0, stageBinary: 0, invalidEvents: 0 }

  constructor(private readonly d: StageHubDeps) {
    this.timers = d.timers ?? unrefTimers
    this.ids = (p) => d.newId(p)
    this.rng = d.rng ?? createRng(d.config.stage.seed)
    this.tts = d.tts ?? new FakeTtsProvider({ mode: 'sine' })
    this.face = d.face ?? new FakeFaceProvider()
    this.lastInteractionAt = d.clock()

    this.stageStore = new StageStore(d.store)
    const report = loadCatalog(this.catalog, this.stageStore)
    for (const r of report.rejected) d.log.warn('a stored asset was rejected by the catalog', { id: r.id })

    this.characters = createCharacterService({ repo: this.stageStore.characterRepo(), catalog: this.catalog, clock: this.clock, newId: this.ids })
    this.scenes = createSceneService({ repo: this.stageStore.sceneRepo(), catalog: this.catalog, clock: this.clock, newId: this.ids })
    this.wardrobe = createWardrobeService({ characters: this.characters, catalog: this.catalog, newId: this.ids, onChange: (c) => this.onWardrobeChange(c) })
    this.memory = createCharacterMemory({ repo: this.stageStore.memoryRepo(), clock: this.clock, newId: this.ids })

    // First run only: the seed catalog, the two characters and the void. Afterwards the database is the truth.
    const seeded = d.store.kvGet<number>(STAGE_KV.seeded)
    if (typeof seeded !== 'number' || seeded < STAGE_SEED_VERSION) {
      const r = runSeed({ stageStore: this.stageStore, catalog: this.catalog, characters: this.characters, scenes: this.scenes, assistantName: d.persona().name, nowIso: d.now().toISOString() })
      for (const p of r.problems) d.log.warn('stage seed problem', { problem: p.slice(0, 160) })
      d.store.kvSet(STAGE_KV.seeded, STAGE_SEED_VERSION, d.now().toISOString())
    }
    // Every start: repair what the catalog no longer allows (a vanished asset, a changed licence), keep one active
    // assistant, and make sure there is a scene.
    const restored = this.characters.restore()
    for (const r of restored.repaired) d.log.warn('stage: an equipped item was taken off on restore', { character: r.characterId, slot: r.slot })
    for (const p of restored.problems) d.log.warn('stage restore problem', { problem: p.message.slice(0, 160) })
    this.scenes.ensureVoid()

    this.outfit = createOutfitDirector({
      clock: this.clock,
      presets: () => {
        const a = this.assistant()
        return a ? this.wardrobe.applicablePresets(a.id) : []
      },
      currentPresetId: () => {
        const a = this.assistant()
        return a ? this.wardrobe.currentPresetId(a.id) : undefined
      },
    })
    const savedOutfit = d.store.kvGet<OutfitDirectorState>(STAGE_KV.outfit)
    if (savedOutfit && Array.isArray(savedOutfit.history)) this.outfit.importState(savedOutfit)

    this.camera = new CameraDirector({
      clock: this.clock,
      available: () => (this.scenes.getScene()?.cameras ?? []).map((c) => c.id),
      initial: this.scenes.getScene()?.activeCameraId ?? 'wide',
    })
    this.constructs = new ConstructFeed({
      scenes: this.scenes,
      sync: this.sync,
      store: d.store,
      ...(d.notes ? { notes: d.notes } : {}),
      send: (cmds) => void this.deliver(cmds, { ack: false }),
      clock: d.clock,
    })

    this.bindAssistant()
    this.recountApprovals()
    this.recountSessions()
    this.unsubscribeBus = d.bus.subscribe((e) => this.onBus(e))
  }

  // ----------------------------------------------------------------------------------------------- switch

  /** The persisted stage switch: ON until the user turns it off. */
  enabled(): boolean {
    const v = this.d.store.kvGet<boolean>(STAGE_KV.enabled)
    return typeof v === 'boolean' ? v : this.d.config.stage.defaultOn
  }

  setEnabled(on: boolean): void {
    const was = this.enabled()
    this.d.store.kvSet(STAGE_KV.enabled, on, this.d.now().toISOString())
    if (was !== on) this.audit({ action: on ? 'Turned the stage on' : 'Turned the stage off', target: 'Settings', outcome: 'auto' })
    if (!on) this.closeConnection('disabled', 'the stage was switched off')
    this.changed('enabled')
  }

  // ---------------------------------------------------------------------------------------------- helpers

  assistant(): CharacterProfile | undefined {
    return this.characters.getActive('assistant')
  }

  user(): CharacterProfile | undefined {
    return this.characters.getActive('user')
  }

  nowIso(): string {
    return this.d.now().toISOString()
  }

  audit(e: { actor?: AuditEntry['actor']; action: string; target: string; outcome: AuditEntry['outcome']; detail?: string }): void {
    try {
      this.d.store.insertAudit({
        id: this.d.newId('au'),
        at: this.nowIso(),
        actor: e.actor ?? 'you',
        action: e.action,
        target: redactText(e.target, 160),
        outcome: e.outcome,
        ...(e.detail ? { detail: redactText(e.detail, 200) } : {}),
      })
    } catch (err) {
      this.d.log.warn('could not write a stage audit entry', { error: err instanceof Error ? err.message : 'unknown' })
    }
  }

  /** The catalog as the dashboards see it: metadata only, with the licence of every asset. */
  assets(): Asset[] {
    this.assetsCache ??= this.catalog.list().map((a) => Asset.parse(a))
    return this.assetsCache
  }

  invalidateAssets(): void {
    this.assetsCache = undefined
  }

  // -------------------------------------------------------------------------------------------- snapshot

  connection(): ConnectionInfo | undefined {
    return this.conn?.info()
  }

  isConnected(): boolean {
    return this.conn?.ready === true
  }

  /** The StageSession of the ready connection (tests, the simulator conformance). */
  session(): StageSession | undefined {
    return this.conn?.ready ? this.conn.session : undefined
  }

  pipeline(): SpeechPipeline | undefined {
    return this.conn?.pipeline
  }

  revision(): number {
    return this.rev
  }

  snapshot(): StageSnapshot {
    const on = this.enabled()
    const conn = this.conn?.ready ? this.conn : undefined
    if (!on) {
      return { enabled: false, characters: [], assistantCharacterId: null, userCharacterId: null, assets: [], scene: null, scenePresets: [], mood: null, stage: { connected: false }, rev: this.rev }
    }
    const a = this.assistant()
    const scene = this.scenes.getScene() ?? null
    return {
      enabled: true,
      characters: this.characters.list(),
      assistantCharacterId: a?.id ?? null,
      userCharacterId: this.user()?.id ?? null,
      assets: this.assets(),
      scene,
      scenePresets: this.scenes.listPresets(),
      mood: this.mood?.get() ?? null,
      stage: conn ? { connected: true, ...(conn.engine ? { engine: conn.engine } : {}), ...(conn.capabilities ? { capabilities: conn.capabilities } : {}), ...(conn.since ? { since: conn.since } : {}) } : { connected: false },
      rev: this.rev,
      outfitSuggestion: this.suggestOutfit(),
      cameraShots: (scene?.cameras ?? []).map((c) => c.id),
    }
  }

  /** What the OutfitDirector would do now (asking changes nothing). */
  suggestOutfit(ctx: Pick<OutfitContext, 'activity' | 'weather'> = {}): StageSnapshot['outfitSuggestion'] {
    const a = this.assistant()
    if (!a) return null
    const activity = ctx.activity ?? this.contextActivity()
    const s = this.outfit.suggest({ ...(activity ? { activity } : {}), ...(ctx.weather ? { weather: ctx.weather } : {}) })
    if (!s) return null
    const name = a.presets.find((p) => p.id === s.presetId)?.name ?? s.presetId
    return { presetId: s.presetId, presetName: name, explanation: s.explanation, changed: s.changed }
  }

  private contextActivity(): OutfitContext['activity'] | undefined {
    if (this.behavior?.currentProfile() === 'asleep') return 'sleep'
    if (this.pendingApprovals > 0 || this.sessionLoad.running > 0) return 'work'
    return undefined
  }

  live(): StageLive {
    const conn = this.conn?.ready ? this.conn : undefined
    return {
      rev: this.rev,
      enabled: this.enabled(),
      connected: !!conn,
      ...(conn?.engine ? { engine: conn.engine } : {}),
      mood: this.mood?.get() ?? null,
      ...(this.obs.idle ? { idle: this.obs.idle } : {}),
      ...(this.obs.posture ? { posture: this.obs.posture } : {}),
      ...(this.obs.gaze ? { gaze: this.obs.gaze } : {}),
      speaking: this.conn?.pipeline?.isSpeaking() ?? false,
      ...(this.scenes.getScene() ? { camera: this.scenes.getScene()!.activeCameraId } : {}),
      ...(this.obs.perf ? { perf: this.obs.perf } : {}),
    }
  }

  // ---------------------------------------------------------------------------------------------- changes

  /** Something structural changed (wardrobe, scene, selection, connection): bump the revision and tell the dashboards at once. */
  changed(_reason: string): void {
    this.rev++
    this.publishLive(true)
  }

  private liveKey(l: StageLive): string {
    const g = l.gaze
    const gk = g ? (g.kind === 'away' ? `away:${g.direction}` : g.kind === 'object' ? `object:${g.objectId}` : g.kind) : ''
    return JSON.stringify([l.rev, l.enabled, l.connected, l.engine, l.mood?.label, l.idle, l.posture, gk, l.speaking, l.camera])
  }

  /** Publish `stage.live` when something the dashboards show changed. Fine changes are throttled, structural ones are not. */
  publishLive(force = false): void {
    if (this.stopped) return
    const now = this.d.clock()
    const live = this.live()
    const key = this.liveKey(live)
    if (key === this.lastLiveKey) return
    if (!force && now - this.lastLiveAt < LIVE_MIN_GAP_MS) return
    this.lastLiveKey = key
    this.lastLiveAt = now
    this.d.bus.publish({ type: 'stage.live', live })
  }

  /** Track what the stage was told, so the dashboards can draw it with or without a stage. */
  private observe(cmd: CommandDraft): void {
    switch (cmd.type) {
      case 'perform.idle':
        this.obs.idle = cmd.profile
        break
      case 'perform.posture':
        this.obs.posture = cmd.posture
        break
      case 'perform.gaze':
        this.obs.gaze = cmd.target
        break
      default:
        break
    }
  }

  // ------------------------------------------------------------------------------------------------ send

  /**
   * Hand commands to the stage. Without a ready stage nothing is sent (the database is the truth; a stage that connects
   * later is rebuilt from it). Resolves with the stage's answers (empty when nothing was sent).
   */
  deliver(cmds: readonly CommandDraft[], opts: { ack?: boolean } = {}): Promise<CommandResult[]> {
    for (const c of cmds) this.observe(c)
    const conn = this.conn
    if (!conn?.ready || cmds.length === 0 || conn.session.state !== 'ready') return Promise.resolve([])
    const p = conn.session.sendMany(cmds, { ack: opts.ack ?? true }).then((results) => {
      results.forEach((r, i) => {
        if (!r.ok) this.d.log.warn('the stage refused a command', { type: String((cmds[i] as { type?: unknown } | undefined)?.type ?? 'unknown'), reason: (r.reason ?? 'unknown').slice(0, 120) })
      })
      return results
    })
    this.pendingSends.add(p)
    void p.finally(() => this.pendingSends.delete(p))
    return p
  }

  /** Resolves when every command handed to the stage so far has been answered (tests and graceful shutdown). */
  async flush(): Promise<void> {
    while (this.pendingSends.size > 0) await Promise.allSettled([...this.pendingSends])
  }

  // ------------------------------------------------------------------------------------- the assistant

  /**
   * (Re)build the mood engine and behaviour director for the active assistant: after a presence edit, a selection or at
   * start. The mood is carried over (or restored from SQLite), so editing her presence never resets how she feels.
   */
  bindAssistant(): void {
    const a = this.assistant()
    if (!a) {
      this.mood = undefined
      this.behavior = undefined
      return
    }
    const carried = this.mood?.snapshot()
    const mood = MoodEngine.fromPresence(a.presence, this.clock)
    const row = carried ?? this.stageStore.loadMood()
    if (row) mood.restore(row)
    this.mood = mood
    const p = this.d.persona()
    this.behavior = new BehaviorDirector({
      clock: this.clock,
      rng: this.rng.fork(`behavior:${a.id}`),
      presence: a.presence,
      mood,
      quietHours: p.quietHours,
      proactivity: p.vibe.proactivity,
      characterId: a.id,
    })
    this.camera.setCurrent(this.scenes.getScene()?.activeCameraId ?? 'wide')
  }

  /** The persona changed (quiet hours, proactivity): the director follows. */
  refreshPersona(): void {
    const p = this.d.persona()
    this.behavior?.setQuietHours(p.quietHours)
    this.behavior?.budget.setProactivity(p.vibe.proactivity)
  }

  // ----------------------------------------------------------------------------------------- wardrobe

  private onWardrobeChange(c: WardrobeChange): void {
    try {
      const ch = this.characters.get(c.characterId)
      const isAssistant = ch?.id === this.assistant()?.id
      if (isAssistant) {
        this.outfit.handleChange(c, { ...(this.contextActivity() ? { activity: this.contextActivity()! } : {}) })
        this.d.store.kvSet(STAGE_KV.outfit, this.outfit.exportState(), this.nowIso())
      }
      const presetName = c.presetId ? ch?.presets.find((p) => p.id === c.presetId)?.name : undefined
      this.audit({
        actor: c.source === 'user' ? 'you' : 'mira',
        action: presetName ? `Changed outfit to ${presetName}` : 'Changed what she wears',
        target: ch?.name ?? c.characterId,
        outcome: 'auto',
        detail: this.wardrobe.describeLook(c.characterId),
      })
      this.changed('wardrobe')
    } catch (err) {
      this.d.log.warn('stage wardrobe hook failed', { error: err instanceof Error ? err.message : 'unknown' })
    }
  }

  /** A short text for the persona prompt: relationship facts, preferences and recent moments. Cloud audience: nothing private or sensitive. */
  memoryDigest(): string | undefined {
    if (!this.enabled()) return undefined
    const text = this.memory.digest({ audience: 'cloud', maxChars: 900 }).text
    return text.length > 0 ? text : undefined
  }

  // --------------------------------------------------------------------------------------------- tools

  /** The stage tools (STAGE_TOOL_SURFACE) for the Secretary lane. They act through the services; none of them can touch a terminal. */
  toolBindings(): ToolBinding[] {
    const bindings = createStageToolBindings({
      characters: this.characters,
      wardrobe: this.wardrobe,
      scenes: this.scenes,
      memory: this.memory,
      perform: (cmds) => void this.deliver(cmds, { ack: true }),
      requestGesture: (clip, intensity) => {
        if (!this.behavior) return { ok: false, code: 'no_assistant', error: 'there is no assistant character' }
        return this.behavior.requestGesture(clip, intensity)
      },
      requestShot: (shot) => this.camera.request(shot),
      mood: () => this.mood?.get() ?? null,
      posture: () => this.behavior?.currentPosture(),
      stage: () => ({ connected: this.isConnected(), ...(this.conn?.engine ? { engine: this.conn.engine } : {}) }),
    })
    return bindings.map((b) => ({
      spec: b.spec,
      handler: async (input: unknown) => {
        if (!this.enabled()) return { text: 'The stage is switched off in Settings, so I cannot change my look or the space right now.', isError: true }
        const r = await b.handler(input)
        if (!b.spec.readOnly) {
          this.audit({
            actor: 'mira',
            action: `Used ${b.spec.name}`,
            target: 'Stage',
            outcome: r.isError ? 'blocked' : 'auto',
            // the outcome line only: the memory tool's text is never copied into the audit log
            ...(b.spec.name === 'character_remember' ? {} : { detail: r.text.split('\n')[0] ?? '' }),
          })
          if (!r.isError && b.spec.name !== 'stage_gesture' && b.spec.name !== 'character_remember') {
            if (b.spec.name === 'stage_set_scene') this.constructs.markDirty()
            this.changed(b.spec.name)
          }
        }
        return r
      },
    }))
  }

  // ------------------------------------------------------------------------------------- connection

  /** Is a new stage connection acceptable right now? One at a time: a second one is refused until the first closes. */
  canAccept(): { ok: true } | { ok: false; status: 403 | 409; code: string; message: string } {
    if (!this.enabled()) return { ok: false, status: 403, code: 'stage_disabled', message: 'The stage is switched off. Turn it on in Settings, Stage.' }
    if (this.conn && this.conn.session.state !== 'closed') {
      return { ok: false, status: 409, code: 'stage_busy', message: 'Another stage is already connected. Only one stage connection is accepted at a time; close the other one first (Settings, Stage, Disconnect).' }
    }
    return { ok: true }
  }

  /** Wrap an accepted socket in a StageSession (the stage speaks first: `hello`). */
  accept(transport: StageTransport & { terminate?(): void }): StageConnection {
    // The upgrade handler has already refused a second stage (canAccept). Anything that gets here anyway replaces the old
    // one rather than leaving two sessions talking over each other.
    if (this.conn && this.conn.session.state !== 'closed') this.closeConnection('replaced', 'replaced by a newer connection')
    const session = createStageSession({
      transport,
      clock: this.clock,
      timers: this.timers,
      newId: this.ids,
      mirror: this.mirror,
      autoResume: false,
      helloTimeoutMs: this.d.config.stage.helloTimeoutMs,
      maxTextBytes: this.d.config.stage.maxMessageBytes,
    })
    const conn = new StageConnection(this.d.newId('stg'), session, transport)
    this.conn = conn
    session.onClose((reason) => this.onDisconnected(conn, reason))
    session.onEvent((ev) => this.onStageEvent(conn, ev))
    session.onProtocolError(() => void this.dropped.invalidEvents++)
    // Binary frames only ever flow daemon -> stage. A stage that sends some is ignored (counted), never decoded further.
    transport.onBinary(() => void this.dropped.stageBinary++)
    session.ready().then(
      (caps) => void this.onReady(conn, caps),
      () => undefined, // refused (protocol mismatch, no hello): the session already closed the transport
    )
    return conn
  }

  /** Close the current connection (a REST disconnect, the switch turned off, a shutdown). */
  closeConnection(cause: DisconnectCause, reason: string): boolean {
    const c = this.conn
    if (!c) return false
    c.cause = cause
    c.session.close(reason)
    return true
  }

  private async onReady(conn: StageConnection, caps: StageCapabilities): Promise<void> {
    if (this.conn !== conn || conn.session.state !== 'ready') return
    conn.ready = true
    conn.capabilities = caps
    conn.engine = caps.engine
    conn.since = this.nowIso()
    this.d.log.info('stage connected', { engine: caps.engine, maxCharacters: caps.maxCharacters })
    this.audit({ actor: 'job', action: 'A stage connected', target: `${caps.engine} ${caps.engineVersion}`.slice(0, 60), outcome: 'auto' })
    this.changed('connected')
    // Rebuild the look from the database: characters, scene, then what she is doing right now.
    await this.deliver(this.resumeCommands(), { ack: true })
    if (this.conn !== conn || conn.session.state !== 'ready') return
    this.constructs.reset()
    this.constructs.refresh()
    // She speaks only once the stage has finished loading her: `perform.speak` is acknowledged in order, so a stage that is
    // still streaming assets would answer late and the lip-sync frames would arrive behind their time. (A sentence that
    // arrives in the first moments after a connect is shown as text only.)
    conn.pipeline = new SpeechPipeline({
      sink: conn.session,
      tts: this.tts,
      face: this.face,
      voice: () => this.assistant()?.voice ?? { provider: 'kokoro', voiceId: 'default', speed: 1, pitchSemitones: 0 },
      clock: this.clock,
      timers: this.timers,
      newId: this.ids,
      onEvent: (e) => {
        if (e.type === 'failed') this.d.log.warn('speech failed', { reason: e.reason.slice(0, 120) })
      },
    })
    this.publishLive(true)
  }

  /** Everything a fresh stage needs, from the authoritative services (not from the mirror). */
  resumeCommands(): CommandDraft[] {
    const out: CommandDraft[] = []
    for (const role of ['assistant', 'user'] as const) {
      const c = this.characters.getActive(role)
      if (!c) continue
      const r = this.characters.loadCommand(c.id)
      if (r.ok) out.push(r.value)
    }
    const sc = this.scenes.loadCommand()
    if (sc.ok) out.push(sc.value)
    const a = this.assistant()
    if (a && this.mood) out.push({ type: 'perform.affect', characterId: a.id, affect: this.mood.get(), blendMs: 0 })
    // what she was doing (idle profile, posture, gaze), as far as this process knows it
    for (const c of this.mirror.replayLook()) if (c.type !== 'perform.affect') out.push(c)
    return out
  }

  private onDisconnected(conn: StageConnection, reason: string): void {
    const wasReady = conn.ready
    conn.pipeline?.cancel().catch(() => undefined)
    if (this.conn === conn) this.conn = undefined
    this.sync.reset()
    delete this.obs.perf
    if (wasReady) {
      this.d.log.info('stage disconnected', { cause: conn.cause })
      this.audit({ actor: 'job', action: 'A stage disconnected', target: conn.engine ?? 'stage', outcome: 'auto', detail: conn.cause === 'stage' ? 'the stage closed the connection' : conn.cause })
    } else if (conn.cause === 'stage') {
      this.d.log.warn('a stage connection ended before it was ready', { reason: reason.slice(0, 100) })
    }
    this.changed('disconnected')
  }

  // ------------------------------------------------------------------------------- stage -> backend

  private onStageEvent(conn: StageConnection, ev: StageEvent): void {
    if (this.conn !== conn) return
    try {
      conn.pipeline?.handleStageEvent(ev)
      switch (ev.type) {
        case 'speak.started':
          this.behavior?.onSpeechStarted()
          this.publishLive()
          break
        case 'speak.ended':
          this.behavior?.onSpeechEnded(ev.interrupted)
          this.publishLive()
          break
        case 'user.presence':
          this.behavior?.onUserPresence(ev)
          break
        case 'character.interact':
          // Region-level only, and never escalating: she turns to the user; a drag or a grab on the body is mildly surprising.
          this.behavior?.lookAt({ kind: 'user' }, 2500)
          if (ev.kind === 'drag' || ev.region === 'body') this.mood?.apply({ type: 'surprise', magnitude: 0.2 })
          break
        case 'perf':
          this.obs.perf = { fps: ev.fps, gpuMs: ev.gpuMs, vramMb: ev.vramMb }
          break
        case 'construct.terminal.input':
        case 'construct.terminal.resize':
          // The stage is NOT wired to any terminal. Keystrokes from a pane are dropped, whatever they contain.
          this.dropped.terminalInput++
          break
        case 'error':
          this.d.log.warn('the stage reported an error', { fatal: ev.fatal, message: redactText(ev.message, 120) })
          if (ev.fatal) this.closeConnection('stage', 'the stage reported a fatal error')
          break
        default:
          break
      }
    } catch (err) {
      this.d.log.warn('stage event handler failed', { error: err instanceof Error ? err.message : 'unknown' })
    }
  }

  // ------------------------------------------------------------------------------------- bus signals

  private recountApprovals(): void {
    this.pendingApprovals = this.d.store.listApprovals(200).filter((a) => a.status === 'pending').length
  }

  private recountSessions(): void {
    let running = 0
    let blocked = 0
    for (const s of this.d.store.listSessions()) {
      if (s.status === 'running') running++
      else if (s.status === 'waiting_input' || s.status === 'blocked_permission') blocked++
    }
    this.sessionLoad = { running, blocked }
  }

  private mood$(type: MoodEventType, magnitude?: number): void {
    this.mood?.apply({ type, ...(magnitude !== undefined ? { magnitude } : {}) })
  }

  private onBus(e: ServerEvent): void {
    if (this.stopped || e.type === 'stage.live') return
    try {
      switch (e.type) {
        case 'chat.message': {
          if (e.message.role === 'user') this.onUserMessage(e.message.parts.map((p) => (p.type === 'text' ? p.text : '')).join(' '))
          else {
            this.chatActive = true
            this.lastChatAt = this.d.clock()
          }
          break
        }
        case 'chat.delta':
          this.lastChatAt = this.d.clock()
          break
        case 'chat.done':
          this.chatActive = false
          this.lastChatAt = this.d.clock()
          this.mood$('task_completed', 0.25)
          break
        case 'avatar':
          this.onAvatar(e.event)
          break
        case 'approval.new':
          if (e.approval.status === 'pending') this.pendingApprovals++
          this.camera.noteBeat('important')
          break
        case 'approval.resolved':
          this.pendingApprovals = Math.max(0, this.pendingApprovals - 1)
          if (e.status === 'approved') this.mood$('task_completed', 0.6)
          else this.mood$('task_failed', 0.3)
          break
        case 'session.update':
        case 'snapshot.reset':
          this.recountSessions()
          if (e.type === 'snapshot.reset') this.recountApprovals()
          this.constructs.markDirty()
          break
        case 'settings.update':
          this.refreshPersona()
          break
        default:
          break
      }
    } catch (err) {
      this.d.log.warn('stage bus handler failed', { error: err instanceof Error ? err.message : 'unknown' })
    }
  }

  private onUserMessage(text: string): void {
    const now = this.d.clock()
    const away = now - this.lastInteractionAt
    this.lastInteractionAt = now
    this.lastChatAt = now
    this.chatActive = true
    this.behavior?.onUserMessage()
    // She stops talking when you start: a new message is a barge-in.
    void this.bargeIn()
    if (away > 10 * 60_000) this.mood$('user_returned', 0.6)
    // Local, never logged, and only ever nudges her mood a little.
    if (THANKS.test(text)) this.mood$('thanks', 0.8)
    else if (CRITICISM.test(text)) this.mood$('criticism', 0.6)
  }

  private onAvatar(ev: Extract<ServerEvent, { type: 'avatar' }>['event']): void {
    switch (ev.type) {
      case 'speak': {
        if (ev.emotion === 'sad' || ev.emotion === 'angry' || ev.emotion === 'surprised' || ev.emotion === 'shy') this.camera.noteBeat('emotional')
        this.speak(ev.text, ev.emotion)
        break
      }
      case 'expression':
        // her own expression tags: a strong emotional one is a beat for the camera (the mood itself is not moved by them)
        if ((ev.emotion === 'sad' || ev.emotion === 'angry' || ev.emotion === 'surprised' || ev.emotion === 'shy') && ev.intensity >= 0.5) this.camera.noteBeat('emotional')
        break
      case 'pose':
        if (ev.state === 'thinking') this.mood?.holdLabel('thinking', 8000)
        else this.mood?.releaseLabel()
        break
      case 'lookAt': {
        const t = ev.target
        if (t === 'user') this.behavior?.lookAt({ kind: 'user' }, 3000)
        else if (t === 'screen') this.behavior?.lookAt({ kind: 'camera' }, 3000)
        else if (t === 'window') this.behavior?.lookAt({ kind: 'away', direction: 'right' }, 2500)
        break
      }
      default:
        break
    }
  }

  /** Queue a sentence for the stage (TTS, audio frames and face frames). Nothing happens without a ready stage. */
  speak(text: string, emotion: Emotion): boolean {
    const conn = this.conn
    if (!this.enabled() || !conn?.ready || !conn.pipeline) return false
    if (this.behavior && !this.behavior.requestUtterance({ kind: 'reply' }, { commit: false }).allowed) return false
    return conn.pipeline.enqueue({ text, emotion }).ok
  }

  /** Stop talking now (a new message, the interrupt button). */
  async bargeIn(): Promise<void> {
    const p = this.conn?.pipeline
    if (!p || p.pendingCount() === 0) return
    await p.cancel().catch(() => undefined)
  }

  // ----------------------------------------------------------------------------------------- the loop

  start(): void {
    if (this.tickTimer || this.stopped) return
    const every = Math.max(50, this.d.config.stage.tickMs)
    this.tickTimer = setInterval(() => this.tick(), every)
    this.tickTimer.unref?.()
  }

  private activity(): 'idle' | 'conversation' | 'reviewing' | 'working' {
    const now = this.d.clock()
    if (this.chatActive || this.conn?.pipeline?.isSpeaking() || now - this.lastChatAt < CONVERSATION_MS) return 'conversation'
    if (this.pendingApprovals > 0) return 'reviewing'
    if (this.sessionLoad.running > 0 && this.scenes.getConstruct('construct.sessions')) return 'working'
    return 'idle'
  }

  /** One pass of the behaviour loop. Public so tests can drive it with a fake clock. */
  tick(): void {
    if (this.stopped || this.ticking || !this.enabled()) return
    this.ticking = true
    try {
      const now = this.d.clock()
      const b = this.behavior
      if (b) {
        const act = this.activity()
        b.setActivity(act === 'idle' ? 'idle' : act)
        b.setWorkLoad(this.sessionLoad)
        if (this.anchorsRev !== this.rev) {
          this.anchorsRev = this.rev
          b.setAnchors(this.scenes.listAnchors().map((x) => ({ objectId: x.objectId, anchor: { id: x.anchor.id, kind: x.anchor.kind } })))
        }
        this.deliver(b.tick(now), { ack: false })

        const asleep = b.currentProfile() === 'asleep'
        const cam = this.camera.update({ activity: asleep ? 'asleep' : act }, now)
        if (cam && cam.type === 'scene.camera') {
          const r = this.scenes.setActiveCamera(cam.cameraId, cam.blendMs ?? 600)
          if (r.ok) {
            void this.deliver(r.value.commands, { ack: false })
            this.rev++
          }
        }
      }
      this.constructs.maybeRefresh(this.d.config.stage.constructsEveryMs)
      if (this.mood && now - this.lastMoodPersistAt >= this.d.config.stage.moodPersistEveryMs) this.persistMood()
      this.publishLive()
    } catch (err) {
      this.d.log.warn('stage tick failed', { error: err instanceof Error ? err.message : 'unknown' })
    } finally {
      this.ticking = false
    }
  }

  persistMood(): void {
    if (!this.mood) return
    this.lastMoodPersistAt = this.d.clock()
    this.stageStore.saveMood(this.mood.snapshot())
  }

  // --------------------------------------------------------------------------------------- shutdown

  async shutdown(): Promise<void> {
    if (this.stopped) return
    if (this.tickTimer) clearInterval(this.tickTimer)
    this.tickTimer = undefined
    this.unsubscribeBus?.()
    this.unsubscribeBus = undefined
    try {
      this.persistMood()
    } catch {
      /* the database may already be closing */
    }
    this.closeConnection('daemon', 'the daemon is stopping')
    this.stopped = true
    await Promise.race([this.flush(), new Promise((r) => setTimeout(r, 500).unref?.())])
  }
}

/** Decode helper for tests: is this binary message a well-formed frame? */
export const isValidFrame = (bytes: Uint8Array): boolean => decodeFrame(bytes).ok

