/**
 * SimulatorStage: a HEADLESS stage implementing the stage side of mira-stage/1 over the same abstract transport the
 * daemon uses for a real engine. It exists so the backend can be developed and tested without an engine, and so an engine
 * stage has an executable reference (see conformance.ts).
 *
 * What it does:
 *  - sends `hello` with its capabilities and a stage clock (optionally offset from the backend's, to test clock sync);
 *  - validates EVERY incoming command with the shared zod schema, then against its own state (unknown character, camera,
 *    construct, missing asset, wrong slot, unsupported construct kind ...) and answers command.done / command.failed;
 *  - models asset-load latency (asset.loaded / asset.failed) and processes commands strictly in order;
 *  - tracks the state a real stage would show: characters (equipped, params), scene, objects, constructs and their data,
 *    camera blends, affect, posture, gaze, idle profile;
 *  - plays audio frames virtually and reports speak.started / speak.ended (interrupted when cancelled), handling late and
 *    missing audio (underruns);
 *  - emits perf and presence events on demand;
 *  - records a TIMELINE of everything for assertions.
 *
 * It never renders anything and never logs. Terminal bytes are only counted (an opt-in tail exists for tests).
 */
import { ConstructKind, StageCommand, StageEvent, STAGE_PROTOCOL } from '@ai-assistant/shared'
import type { Asset, CharacterProfile, DataConstruct, Scene, SceneObject, StageCapabilities, StageCommand as StageCommandT, StageEvent as StageEventT, WardrobeSlot, Affect, GazeTarget, Posture } from '@ai-assistant/shared'
import type { Clock, Timers } from '../util/clock'
import type { StageTransport, Unsubscribe } from '../protocol/transport'
import { decodeFrame, audioDurationMs } from '../protocol/frames'
import { utteranceIdHash } from '../protocol/frames'
import { applyPresetToEquipped } from '../core/equipped'
import { applySceneData, emptyConstructData } from '../constructs/data-state'
import type { ConstructData } from '../constructs/data-state'
import { BinaryFrameKind } from '@ai-assistant/shared'

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends readonly unknown[] ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K] }

export interface SimulatorOptions {
  transport: StageTransport
  clock: Clock
  timers: Timers
  capabilities?: DeepPartial<StageCapabilities>
  /** Stage clock minus backend clock. Default 0. */
  clockOffsetMs?: number
  /** Asset load time. Default depends on the kind. */
  assetLatencyMs?: (asset: Asset) => number
  /** Asset ids that fail to load. */
  failAssets?: Iterable<string>
  /** If given, perform.gesture with another clip fails. */
  knownClips?: Iterable<string>
  /** Latency added before every command.done / failed. Default 0. */
  ackLatencyMs?: number
  /** Send hello on start() (default true). */
  autoHello?: boolean
  /** Protocol string in hello (for refusal tests). Default mira-stage/1. */
  protocol?: string
  /** Record every audio/face frame in the timeline (default false: only per-utterance totals). */
  recordFrames?: boolean
  /** Timeline cap (oldest dropped). Default 20000. */
  maxTimeline?: number
  /**
   * Keep the last 2 KiB of each terminal pane's output in `state()` (for tests that assert on it). Off by default: terminal
   * bytes can hold secrets, so by default only their count is kept.
   */
  keepTerminalTail?: boolean
}

export type TimelineKind = 'command' | 'event' | 'state' | 'frame'

export interface TimelineEntry {
  seq: number
  /** Stage clock, ms. */
  tMs: number
  kind: TimelineKind
  /** Command or event type, or a state name such as "camera.blend.end". */
  name: string
  data?: unknown
}

interface Utterance {
  id: string
  hash: number
  text: string
  sampleRate: number
  totalMs: number | undefined
  faceSource: 'stage' | 'backend'
  atMs: number | undefined
  receivedMs: number
  lastChunkEndStage: number
  frames: number
  faceFrames: number
  underruns: number
  startStage: number | undefined
  started: boolean
  ended: boolean
  cancelled: boolean
  startTimer: unknown
  endTimer: unknown
  emotionTimeline: Array<{ tMs: number; emotion: string; intensity: number }>
}

export interface UtteranceReport {
  id: string
  text: string
  totalMs: number | undefined
  receivedMs: number
  audioFrames: number
  faceFrames: number
  underruns: number
  faceSource: 'stage' | 'backend'
  startedAtStageMs: number | undefined
  endedInterrupted: boolean | undefined
}

export interface SimState {
  characters: Record<string, { id: string; role: string; rigFamily: string; equipped: Record<string, string | null>; params: Record<string, number | string> }>
  assistantId: string | undefined
  scene: { id: string; environmentAssetId: string; objects: SceneObject[]; constructs: DataConstruct[]; cameraIds: string[]; activeCameraId: string; lightingLook?: string } | null
  camera: { activeId: string | undefined; blend: { from: string; to: string; startMs: number; durationMs: number } | undefined }
  constructs: Record<string, { kind: string; data: ConstructData; terminalBytes: number; terminalTail: string }>
  affect: Affect | undefined
  posture: { posture: Posture; anchorObjectId?: string; anchorId?: string } | undefined
  gaze: { target: GazeTarget; speed: number; saccades: boolean } | undefined
  idle: string | undefined
  speaking: string | null
  gestures: string[]
  loadedAssets: string[]
}

const DEFAULT_CAPS: StageCapabilities = {
  engine: 'sim',
  engineVersion: '1.0.0',
  rigFamilies: ['vrm1', 'metahuman', 'cc5', 'custom'],
  face: { arkit52: true, visemes: true, audioToFaceOnStage: false },
  render: { strandHair: false, clothSim: false, runtimeAssetLoading: true, embeddedStream: false },
  tracking: { face: false, body: false },
  constructs: [...ConstructKind.options],
  maxCharacters: 4,
}

const DEFAULT_LATENCY: Record<string, number> = { character_base: 220, hair: 80, outfit: 60, accessory: 30, prop: 90, environment: 300 }

type Done = (r: { ok: true } | { ok: false; reason: string }) => void
const OK = { ok: true } as const
const NO = (reason: string): { ok: false; reason: string } => ({ ok: false, reason })

export class SimulatorStage {
  readonly timeline: TimelineEntry[] = []
  timelineDropped = 0
  /** Binary frames that could not be decoded or matched an unknown utterance. */
  rejectedFrames = 0
  orphanFrames = 0
  rejectedCommands = 0

  private readonly caps: StageCapabilities
  private readonly offset: number
  private seq = 0
  private readonly queue: StageCommandT[] = []
  private busy = false
  private readonly unsubs: Unsubscribe[] = []
  private started = false
  private stopped = false

  private readonly characters = new Map<string, CharacterProfile>()
  private assistantId: string | undefined
  private scene: Scene | null = null
  private constructsData = new Map<string, { kind: string; data: ConstructData; terminalBytes: number; terminalTail: string }>()
  private readonly loaded = new Map<string, Asset>()
  private affect: Affect | undefined
  private posture: SimState['posture']
  private gaze: SimState['gaze']
  private idle: string | undefined
  private cameraBlend: SimState['camera']['blend']
  private blendTimer: unknown
  private activeCameraId: string | undefined
  private readonly utterances = new Map<string, Utterance>()
  private readonly gestures: string[] = []
  private readonly failAssets: Set<string>
  private readonly knownClips: Set<string> | undefined

  constructor(private readonly o: SimulatorOptions) {
    const c = o.capabilities ?? {}
    this.caps = {
      ...DEFAULT_CAPS,
      ...(c as object),
      face: { ...DEFAULT_CAPS.face, ...(c.face ?? {}) },
      render: { ...DEFAULT_CAPS.render, ...(c.render ?? {}) },
      tracking: { ...DEFAULT_CAPS.tracking, ...(c.tracking ?? {}) },
      rigFamilies: (c.rigFamilies as StageCapabilities['rigFamilies'] | undefined) ?? DEFAULT_CAPS.rigFamilies,
      constructs: (c.constructs as string[] | undefined) ?? DEFAULT_CAPS.constructs,
    }
    this.offset = o.clockOffsetMs ?? 0
    this.failAssets = new Set(o.failAssets ?? [])
    this.knownClips = o.knownClips ? new Set(o.knownClips) : undefined
  }

  // ------------------------------------------------------------------------------------------ lifecycle

  /** Stage clock, ms. */
  stageNow(): number {
    return this.o.clock.now() + this.offset
  }

  capabilities(): StageCapabilities {
    return structuredClone(this.caps)
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.unsubs.push(this.o.transport.onText((d) => this.handleText(d)))
    this.unsubs.push(this.o.transport.onBinary((d) => this.handleBinary(d)))
    if (this.o.autoHello !== false) this.sendHello()
  }

  sendHello(): void {
    if (this.o.protocol !== undefined && this.o.protocol !== STAGE_PROTOCOL) {
      // a deliberately wrong protocol string (refusal tests): it cannot pass our own schema, so it is written raw
      const raw = { type: 'hello', protocol: this.o.protocol, capabilities: this.caps, stageClockMs: this.stageNow() }
      this.rec('event', 'hello', raw)
      this.o.transport.sendText(JSON.stringify(raw))
      return
    }
    this.emit({ type: 'hello', protocol: STAGE_PROTOCOL, capabilities: this.caps, stageClockMs: this.stageNow() })
  }

  stop(): void {
    this.stopped = true
    for (const u of this.unsubs.splice(0)) u()
    const t = this.o.timers
    if (this.blendTimer) t.clearTimeout(this.blendTimer)
    for (const u of this.utterances.values()) {
      if (u.startTimer) t.clearTimeout(u.startTimer)
      if (u.endTimer) t.clearTimeout(u.endTimer)
    }
  }

  // -------------------------------------------------------------------------------------------- timeline

  private rec(kind: TimelineKind, name: string, data?: unknown): void {
    this.timeline.push({ seq: ++this.seq, tMs: this.stageNow(), kind, name, ...(data !== undefined ? { data } : {}) })
    const cap = this.o.maxTimeline ?? 20_000
    if (this.timeline.length > cap) {
      this.timeline.shift()
      this.timelineDropped++
    }
  }

  /** Entries of a kind/name, for assertions. */
  entries(filter: { kind?: TimelineKind; name?: string } = {}): TimelineEntry[] {
    return this.timeline.filter((e) => (!filter.kind || e.kind === filter.kind) && (!filter.name || e.name === filter.name))
  }

  /** Names of timeline entries in order (compact assertions). */
  names(kind?: TimelineKind): string[] {
    return this.timeline.filter((e) => !kind || e.kind === kind).map((e) => e.name)
  }

  // ------------------------------------------------------------------------------------------------ out

  private emit(ev: StageEventT): void {
    if (this.stopped) return
    const parsed = StageEvent.parse(ev) // the stage must itself speak valid protocol
    this.rec('event', parsed.type, parsed)
    this.o.transport.sendText(JSON.stringify(parsed))
  }

  emitPerf(fps: number, gpuMs: number, vramMb: number): void {
    this.emit({ type: 'perf', fps, gpuMs, vramMb })
  }
  emitPresence(p: { present: boolean; lookingAtScreen?: boolean; distance?: 'near' | 'mid' | 'far' }): void {
    this.emit({ type: 'user.presence', ...p })
  }
  emitObjectClicked(objectId: string, button: 'primary' | 'secondary' = 'primary'): void {
    this.emit({ type: 'object.clicked', objectId, button })
  }
  emitCharacterInteract(characterId: string, region: 'head' | 'hand' | 'shoulder' | 'body', kind: 'click' | 'drag' | 'wave'): void {
    this.emit({ type: 'character.interact', characterId, region, kind })
  }
  emitConstructClicked(constructId: string, itemId?: string): void {
    this.emit({ type: 'construct.clicked', constructId, ...(itemId ? { itemId } : {}) })
  }
  emitTerminalInput(constructId: string, data: string): void {
    this.emit({ type: 'construct.terminal.input', constructId, data })
  }
  emitTerminalResize(constructId: string, cols: number, rows: number): void {
    this.emit({ type: 'construct.terminal.resize', constructId, cols, rows })
  }
  emitError(message: string, fatal = false): void {
    this.emit({ type: 'error', message, fatal })
  }

  // ------------------------------------------------------------------------------------------------- in

  private handleText(raw: string): void {
    if (this.stopped) return
    let obj: unknown
    try {
      obj = JSON.parse(raw)
    } catch {
      this.rejectedCommands++
      this.emit({ type: 'error', message: 'invalid JSON', fatal: false })
      return
    }
    const id = obj !== null && typeof obj === 'object' && typeof (obj as { id?: unknown }).id === 'string' ? (obj as { id: string }).id : undefined
    const parsed = StageCommand.safeParse(obj)
    if (!parsed.success) {
      this.rejectedCommands++
      const i = parsed.error.issues[0]
      const reason = `invalid command: ${i ? `${i.path.join('.')} ${i.message}`.slice(0, 160) : 'invalid'}`
      if (id) {
        this.rec('command', 'invalid', { id })
        this.emit({ type: 'command.failed', id, reason })
      } else this.emit({ type: 'error', message: reason, fatal: false })
      return
    }
    this.queue.push(parsed.data)
    this.drain()
  }

  private drain(): void {
    if (this.busy) return
    const cmd = this.queue.shift()
    if (!cmd) return
    this.busy = true
    this.rec('command', cmd.type, this.summarize(cmd))
    let finished = false
    const finish: Done = (r) => {
      if (finished) return
      finished = true
      const send = (): void => {
        if (r.ok) this.emit({ type: 'command.done', id: cmd.id })
        else {
          this.rejectedCommands++
          this.emit({ type: 'command.failed', id: cmd.id, reason: r.reason })
        }
        this.busy = false
        this.drain()
      }
      const lat = this.o.ackLatencyMs ?? 0
      if (lat > 0) this.o.timers.setTimeout(send, lat)
      else send()
    }
    try {
      this.execute(cmd, finish)
    } catch (e) {
      finish(NO(`internal error: ${(e as Error).message}`.slice(0, 160)))
    }
  }

  /** A timeline-safe view of a command (no terminal bytes, no full profiles). */
  private summarize(cmd: StageCommandT): unknown {
    switch (cmd.type) {
      case 'construct.terminal.write':
        return { id: cmd.id, constructId: cmd.constructId, bytes: cmd.data.length }
      case 'perform.speak':
        return { id: cmd.id, utteranceId: cmd.utteranceId, emotion: cmd.emotion, chars: cmd.text.length, faceSource: cmd.faceSource }
      default:
        return cmd
    }
  }

  // ---------------------------------------------------------------------------------------------- helpers

  private charOf(cmd: { characterId?: string }): CharacterProfile | undefined {
    return this.characters.get(cmd.characterId ?? this.assistantId ?? '')
  }

  private latency(a: Asset): number {
    const v = this.o.assetLatencyMs ? this.o.assetLatencyMs(a) : (DEFAULT_LATENCY[a.kind] ?? 20)
    return Number.isFinite(v) && v > 0 ? v : 0
  }

  /**
   * Make assets available (provided in the command or already loaded), modelling load latency. Calls `then` when all
   * are loaded; fails with asset.failed for assets in failAssets. Assets the command does not provide must be loaded.
   */
  private loadAssets(provided: readonly Asset[], needed: readonly string[], done: Done, then: () => void): void {
    const byId = new Map<string, Asset>(provided.map((a) => [a.id, a]))
    const toLoad: Asset[] = []
    for (const id of new Set(needed)) {
      if (this.loaded.has(id)) continue
      const a = byId.get(id)
      if (!a) return done(NO(`asset "${id}" was not provided and is not loaded`))
      toLoad.push(a)
    }
    if (toLoad.length === 0) return then()
    if (!this.caps.render.runtimeAssetLoading && provided.length > 0) return done(NO('this stage cannot load assets at runtime'))
    let remaining = toLoad.length
    let failed = false
    for (const a of toLoad) {
      const ms = this.latency(a)
      const finish = (): void => {
        if (failed) return
        if (this.failAssets.has(a.id)) {
          failed = true
          this.emit({ type: 'asset.failed', assetId: a.id, reason: 'simulated load failure' })
          return done(NO(`asset "${a.id}" failed to load`))
        }
        this.loaded.set(a.id, structuredClone(a))
        this.emit({ type: 'asset.loaded', assetId: a.id, ms })
        if (--remaining === 0) then()
      }
      if (ms > 0) this.o.timers.setTimeout(finish, ms)
      else finish()
    }
  }

  private assetOf(id: string, provided?: readonly Asset[]): Asset | undefined {
    return this.loaded.get(id) ?? provided?.find((a) => a.id === id)
  }

  private slotsOk(equipped: Record<string, string | null>, provided: readonly Asset[]): string | undefined {
    for (const [slot, id] of Object.entries(equipped)) {
      if (!id) continue
      const a = this.assetOf(id, provided)
      if (!a) return `equipped asset "${id}" is not provided`
      if (!a.slots.includes(slot as WardrobeSlot)) return `asset "${id}" cannot occupy the ${slot} slot`
    }
    return undefined
  }

  // ------------------------------------------------------------------------------------------------ execute

  private execute(cmd: StageCommandT, done: Done): void {
    switch (cmd.type) {
      case 'character.load': {
        const c = cmd.character
        if (!this.caps.rigFamilies.includes(c.rigFamily)) return done(NO(`rig family ${c.rigFamily} is not supported`))
        if (!this.characters.has(c.id) && this.characters.size >= this.caps.maxCharacters) return done(NO('too many characters'))
        const slotErr = this.slotsOk(c.equipped, cmd.assets)
        if (slotErr) return done(NO(slotErr))
        const needed = [c.baseAssetId, ...Object.values(c.equipped).filter((v): v is string => !!v)]
        return this.loadAssets(cmd.assets, needed, done, () => {
          this.characters.set(c.id, structuredClone(c))
          if (c.role === 'assistant' || !this.assistantId) this.assistantId = c.id
          this.rec('state', 'character.loaded', { id: c.id })
          done(OK)
        })
      }
      case 'character.params': {
        const c = this.characters.get(cmd.characterId)
        if (!c) return done(NO(`unknown character "${cmd.characterId}"`))
        c.params = { ...c.params, ...cmd.params }
        return done(OK)
      }
      case 'character.equip': {
        const c = this.characters.get(cmd.characterId)
        if (!c) return done(NO(`unknown character "${cmd.characterId}"`))
        if (cmd.assetId === null) {
          c.equipped = { ...c.equipped, [cmd.slot]: null }
          return done(OK)
        }
        const a = this.assetOf(cmd.assetId, cmd.asset ? [cmd.asset] : [])
        if (!a) return done(NO(`asset "${cmd.assetId}" is not provided and is not loaded`))
        if (!a.slots.includes(cmd.slot)) return done(NO(`asset "${cmd.assetId}" cannot occupy the ${cmd.slot} slot`))
        if (a.rigFamilies.length > 0 && !a.rigFamilies.includes(c.rigFamily)) return done(NO(`asset "${cmd.assetId}" does not fit a ${c.rigFamily} rig`))
        return this.loadAssets(cmd.asset ? [cmd.asset] : [], [cmd.assetId], done, () => {
          c.equipped = { ...c.equipped, [cmd.slot]: cmd.assetId }
          done(OK)
        })
      }
      case 'character.outfit': {
        const c = this.characters.get(cmd.characterId)
        if (!c) return done(NO(`unknown character "${cmd.characterId}"`))
        const slotErr = this.slotsOk(cmd.preset.equipped, cmd.assets)
        if (slotErr) return done(NO(slotErr))
        const needed = Object.values(cmd.preset.equipped).filter((v): v is string => !!v)
        return this.loadAssets(cmd.assets, needed, done, () => {
          c.equipped = applyPresetToEquipped(c.equipped, cmd.preset)
          done(OK)
        })
      }
      case 'scene.load': {
        const s = cmd.scene
        const ids = new Set<string>()
        for (const x of [...s.objects.map((o) => o.id), ...s.constructs.map((k) => k.id)]) {
          if (ids.has(x)) return done(NO(`duplicate id "${x}" in the scene`))
          ids.add(x)
        }
        for (const o of s.objects) if (o.parentId !== null && !s.objects.some((p) => p.id === o.parentId)) return done(NO(`object "${o.id}" has a missing parent`))
        if (!s.cameras.some((c) => c.id === s.activeCameraId)) return done(NO(`active camera "${s.activeCameraId}" is not in the scene`))
        for (const k of s.constructs) if (!this.caps.constructs.includes(k.kind)) return done(NO(`construct kind ${k.kind} is not supported`))
        return this.loadAssets(cmd.assets, [s.environmentAssetId, ...s.objects.map((o) => o.assetId)], done, () => {
          this.scene = structuredClone(s)
          this.constructsData = new Map(s.constructs.map((k) => [k.id, { kind: k.kind, data: emptyConstructData(), terminalBytes: 0, terminalTail: '' }]))
          this.activeCameraId = s.activeCameraId
          this.cameraBlend = undefined
          this.rec('state', 'scene.loaded', { id: s.id })
          done(OK)
        })
      }
      case 'scene.object': {
        const sc = this.scene
        if (!sc) return done(NO('no scene is loaded'))
        const o = cmd.object
        if (cmd.op === 'remove') {
          if (!sc.objects.some((x) => x.id === o.id)) return done(NO(`unknown object "${o.id}"`))
          sc.objects = sc.objects.filter((x) => x.id !== o.id)
          return done(OK)
        }
        if (cmd.op === 'add' && (sc.objects.some((x) => x.id === o.id) || sc.constructs.some((x) => x.id === o.id))) return done(NO(`id "${o.id}" already exists`))
        if (cmd.op === 'update' && !sc.objects.some((x) => x.id === o.id)) return done(NO(`unknown object "${o.id}"`))
        if (o.parentId !== null && !sc.objects.some((x) => x.id === o.parentId)) return done(NO(`parent "${o.parentId}" does not exist`))
        return this.loadAssets(cmd.asset ? [cmd.asset] : [], [o.assetId], done, () => {
          if (cmd.op === 'add') sc.objects.push(structuredClone(o))
          else sc.objects = sc.objects.map((x) => (x.id === o.id ? structuredClone(o) : x))
          done(OK)
        })
      }
      case 'scene.construct': {
        const sc = this.scene
        if (!sc) return done(NO('no scene is loaded'))
        const k = cmd.construct
        if (cmd.op === 'remove') {
          if (!sc.constructs.some((x) => x.id === k.id)) return done(NO(`unknown construct "${k.id}"`))
          sc.constructs = sc.constructs.filter((x) => x.id !== k.id)
          this.constructsData.delete(k.id)
          return done(OK)
        }
        if (!this.caps.constructs.includes(k.kind)) return done(NO(`construct kind ${k.kind} is not supported`))
        if (cmd.op === 'add') {
          if (sc.constructs.some((x) => x.id === k.id) || sc.objects.some((x) => x.id === k.id)) return done(NO(`id "${k.id}" already exists`))
          sc.constructs.push(structuredClone(k))
          this.constructsData.set(k.id, { kind: k.kind, data: emptyConstructData(), terminalBytes: 0, terminalTail: '' })
        } else {
          if (!sc.constructs.some((x) => x.id === k.id)) return done(NO(`unknown construct "${k.id}"`))
          sc.constructs = sc.constructs.map((x) => (x.id === k.id ? structuredClone(k) : x))
        }
        return done(OK)
      }
      case 'scene.data': {
        const con = this.constructsData.get(cmd.constructId)
        if (!con) return done(NO(`unknown construct "${cmd.constructId}"`))
        const r = applySceneData(con.data, cmd)
        if (!r.ok) return done(NO(r.error))
        con.data = r.state
        return done(OK)
      }
      case 'construct.terminal.write': {
        const con = this.constructsData.get(cmd.constructId)
        if (!con) return done(NO(`unknown construct "${cmd.constructId}"`))
        if (con.kind !== 'terminal_pane') return done(NO(`construct "${cmd.constructId}" is not a terminal pane`))
        con.terminalBytes += cmd.data.length
        if (this.o.keepTerminalTail) con.terminalTail = (con.terminalTail + cmd.data).slice(-2048)
        return done(OK)
      }
      case 'scene.camera': {
        const sc = this.scene
        if (!sc) return done(NO('no scene is loaded'))
        if (!sc.cameras.some((c) => c.id === cmd.cameraId)) return done(NO(`unknown camera "${cmd.cameraId}"`))
        const from = this.activeCameraId ?? cmd.cameraId
        if (this.blendTimer) this.o.timers.clearTimeout(this.blendTimer)
        this.activeCameraId = cmd.cameraId
        sc.activeCameraId = cmd.cameraId
        if (cmd.blendMs > 0 && from !== cmd.cameraId) {
          this.cameraBlend = { from, to: cmd.cameraId, startMs: this.stageNow(), durationMs: cmd.blendMs }
          this.rec('state', 'camera.blend.start', { from, to: cmd.cameraId, ms: cmd.blendMs })
          this.blendTimer = this.o.timers.setTimeout(() => {
            this.cameraBlend = undefined
            this.rec('state', 'camera.blend.end', { to: cmd.cameraId })
          }, cmd.blendMs)
        } else {
          this.cameraBlend = undefined
          this.rec('state', 'camera.cut', { to: cmd.cameraId })
        }
        return done(OK)
      }
      case 'scene.lighting': {
        if (!this.scene) return done(NO('no scene is loaded'))
        this.scene.lighting = structuredClone(cmd.lighting)
        return done(OK)
      }
      case 'perform.speak':
        return this.speak(cmd, done)
      case 'perform.cancel': {
        const u = this.utterances.get(cmd.utteranceId)
        if (u && !u.ended) this.cancelUtterance(u, cmd.fadeMs)
        return done(OK)
      }
      case 'perform.affect': {
        if (!this.charOf(cmd)) return done(NO('no character is loaded'))
        this.affect = structuredClone(cmd.affect)
        return done(OK)
      }
      case 'perform.gesture': {
        if (!this.charOf(cmd)) return done(NO('no character is loaded'))
        if (this.knownClips && !this.knownClips.has(cmd.clip)) return done(NO(`unknown clip "${cmd.clip}"`))
        if (cmd.targetObjectId && !this.scene?.objects.some((o) => o.id === cmd.targetObjectId)) return done(NO(`unknown object "${cmd.targetObjectId}"`))
        this.gestures.push(cmd.clip)
        return done(OK)
      }
      case 'perform.gaze': {
        if (!this.charOf(cmd)) return done(NO('no character is loaded'))
        if (cmd.target.kind === 'object' && !this.scene?.objects.some((o) => o.id === (cmd.target as { objectId: string }).objectId)) return done(NO(`unknown object "${cmd.target.objectId}"`))
        this.gaze = { target: structuredClone(cmd.target), speed: cmd.speed, saccades: cmd.saccades }
        return done(OK)
      }
      case 'perform.posture': {
        if (!this.charOf(cmd)) return done(NO('no character is loaded'))
        if (cmd.anchorObjectId) {
          const obj = this.scene?.objects.find((o) => o.id === cmd.anchorObjectId)
          if (!obj) return done(NO(`unknown object "${cmd.anchorObjectId}"`))
          if (cmd.anchorId && !obj.anchors.some((a) => a.id === cmd.anchorId)) return done(NO(`unknown anchor "${cmd.anchorId}"`))
        }
        this.posture = { posture: cmd.posture, ...(cmd.anchorObjectId ? { anchorObjectId: cmd.anchorObjectId } : {}), ...(cmd.anchorId ? { anchorId: cmd.anchorId } : {}) }
        return done(OK)
      }
      case 'perform.idle': {
        if (!this.charOf(cmd)) return done(NO('no character is loaded'))
        this.idle = cmd.profile
        return done(OK)
      }
      case 'perform.interact': {
        if (!this.charOf(cmd)) return done(NO('no character is loaded'))
        if (!this.scene?.objects.some((o) => o.id === cmd.objectId)) return done(NO(`unknown object "${cmd.objectId}"`))
        return done(OK)
      }
    }
  }

  // ---------------------------------------------------------------------------------------------- speech

  private speak(cmd: Extract<StageCommandT, { type: 'perform.speak' }>, done: Done): void {
    if (!this.charOf(cmd)) return done(NO('no character is loaded'))
    const a = cmd.audio
    if (!Number.isInteger(a.sampleRate) || a.sampleRate < 8000 || a.sampleRate > 96_000) return done(NO('unsupported sample rate'))
    if (a.totalMs !== undefined && (!Number.isFinite(a.totalMs) || a.totalMs < 0)) return done(NO('invalid totalMs'))
    const existing = this.utterances.get(cmd.utteranceId)
    if (existing && !existing.ended) return done(NO(`utterance "${cmd.utteranceId}" is already active`))
    if (cmd.faceSource === 'stage' && !this.caps.face.audioToFaceOnStage) {
      // allowed: the sim simply has no face to compute; note it
      this.rec('state', 'face.unavailable', { utteranceId: cmd.utteranceId })
    }
    const u: Utterance = {
      id: cmd.utteranceId,
      hash: utteranceIdHash(cmd.utteranceId),
      text: cmd.text,
      sampleRate: a.sampleRate,
      totalMs: a.totalMs,
      faceSource: cmd.faceSource,
      atMs: cmd.atMs,
      receivedMs: 0,
      lastChunkEndStage: 0,
      frames: 0,
      faceFrames: 0,
      underruns: 0,
      startStage: undefined,
      started: false,
      ended: false,
      cancelled: false,
      startTimer: undefined,
      endTimer: undefined,
      emotionTimeline: structuredClone(cmd.emotionTimeline),
    }
    this.utterances.set(u.id, u)
    done(OK)
  }

  private activeUtteranceByHash(hash: number): Utterance | undefined {
    for (const u of this.utterances.values()) if (u.hash === hash && !u.ended) return u
    return undefined
  }

  private handleBinary(data: Uint8Array): void {
    if (this.stopped) return
    const r = decodeFrame(data)
    if (!r.ok) {
      this.rejectedFrames++
      this.rec('frame', 'rejected', { error: r.error })
      return
    }
    const f = r.frame
    const u = this.activeUtteranceByHash(f.utteranceIdHash)
    if (!u) {
      this.orphanFrames++
      this.rec('frame', 'orphan', { hash: f.utteranceIdHash, kind: f.kind })
      return
    }
    if (u.cancelled) {
      this.orphanFrames++
      return
    }
    if (f.kind === BinaryFrameKind.audio) {
      const ms = audioDurationMs(f.payload.byteLength, u.sampleRate)
      u.frames++
      u.receivedMs += ms
      u.lastChunkEndStage = Math.max(u.lastChunkEndStage, f.tStartMs + ms)
      if (this.o.recordFrames) this.rec('frame', 'audio', { utteranceId: u.id, tStartMs: f.tStartMs, ms })
      if (u.startStage === undefined) this.scheduleStart(u, f.tStartMs)
      this.scheduleEnd(u)
    } else if (f.kind === BinaryFrameKind.face) {
      const n = Math.floor(f.payload.byteLength / 208)
      u.faceFrames += n
      if (this.o.recordFrames) this.rec('frame', 'face', { utteranceId: u.id, tStartMs: f.tStartMs, frames: n })
    } else if (this.o.recordFrames) this.rec('frame', 'body', { utteranceId: u.id })
  }

  private scheduleStart(u: Utterance, firstChunkStage: number): void {
    const now = this.stageNow()
    let start = Math.max(firstChunkStage, u.atMs ?? 0, now)
    // utterances play one after another: wait for everything scheduled before this one
    for (const p of this.utterances.values()) {
      if (p === u || p.ended || p.cancelled || p.startStage === undefined) continue
      start = Math.max(start, p.totalMs !== undefined ? p.startStage + p.totalMs : p.lastChunkEndStage)
    }
    u.startStage = start
    const fire = (): void => {
      if (u.ended || u.cancelled) return
      u.started = true
      this.emit({ type: 'speak.started', utteranceId: u.id, stageMs: this.stageNow() })
      this.scheduleEnd(u)
    }
    const wait = start - now
    if (wait > 0) u.startTimer = this.o.timers.setTimeout(fire, wait)
    else fire()
  }

  private scheduleEnd(u: Utterance): void {
    if (!u.started || u.ended || u.cancelled) return
    if (u.endTimer) {
      this.o.timers.clearTimeout(u.endTimer)
      u.endTimer = undefined
    }
    const now = this.stageNow()
    let endAt: number
    if (u.totalMs !== undefined) {
      // complete only when (nearly) all audio has arrived; otherwise she is mid-utterance and waiting (an underrun)
      if (u.receivedMs + 1 < u.totalMs) {
        if (now >= u.startStage! + u.receivedMs) u.underruns++
        return
      }
      endAt = Math.max(u.startStage! + u.totalMs, now)
    } else {
      endAt = Math.max(u.lastChunkEndStage + 100, now)
    }
    u.endTimer = this.o.timers.setTimeout(() => this.finishUtterance(u, false), Math.max(0, endAt - now))
  }

  private finishUtterance(u: Utterance, interrupted: boolean): void {
    if (u.ended) return
    u.ended = true
    u.cancelled = u.cancelled || interrupted
    if (u.startTimer) this.o.timers.clearTimeout(u.startTimer)
    if (u.endTimer) this.o.timers.clearTimeout(u.endTimer)
    this.emit({ type: 'speak.ended', utteranceId: u.id, stageMs: this.stageNow(), interrupted })
  }

  private cancelUtterance(u: Utterance, fadeMs: number): void {
    u.cancelled = true
    if (u.startTimer) this.o.timers.clearTimeout(u.startTimer)
    if (u.endTimer) this.o.timers.clearTimeout(u.endTimer)
    if (u.started && fadeMs > 0) {
      u.endTimer = this.o.timers.setTimeout(() => this.finishUtterance(u, true), fadeMs)
    } else this.finishUtterance(u, true)
  }

  // ------------------------------------------------------------------------------------------------ state

  utterance(id: string): UtteranceReport | undefined {
    const u = this.utterances.get(id)
    if (!u) return undefined
    return {
      id: u.id,
      text: u.text,
      totalMs: u.totalMs,
      receivedMs: Math.round(u.receivedMs * 100) / 100,
      audioFrames: u.frames,
      faceFrames: u.faceFrames,
      underruns: u.underruns,
      faceSource: u.faceSource,
      startedAtStageMs: u.startStage,
      endedInterrupted: u.ended ? u.cancelled : undefined,
    }
  }

  utteranceIds(): string[] {
    return [...this.utterances.keys()]
  }

  state(): SimState {
    const chars: SimState['characters'] = {}
    for (const [id, c] of this.characters) chars[id] = { id, role: c.role, rigFamily: c.rigFamily, equipped: structuredClone(c.equipped), params: structuredClone(c.params) }
    const cons: SimState['constructs'] = {}
    for (const [id, c] of this.constructsData) cons[id] = structuredClone(c)
    const sc = this.scene
    let speaking: string | null = null
    for (const u of this.utterances.values()) if (u.started && !u.ended) speaking = u.id
    return {
      characters: chars,
      assistantId: this.assistantId,
      scene: sc ? { id: sc.id, environmentAssetId: sc.environmentAssetId, objects: structuredClone(sc.objects), constructs: structuredClone(sc.constructs), cameraIds: sc.cameras.map((c) => c.id), activeCameraId: sc.activeCameraId, ...(sc.lighting.look ? { lightingLook: sc.lighting.look } : {}) } : null,
      camera: { activeId: this.activeCameraId, blend: this.cameraBlend ? { ...this.cameraBlend } : undefined },
      constructs: cons,
      affect: this.affect ? structuredClone(this.affect) : undefined,
      posture: this.posture ? structuredClone(this.posture) : undefined,
      gaze: this.gaze ? structuredClone(this.gaze) : undefined,
      idle: this.idle,
      speaking,
      gestures: [...this.gestures],
      loadedAssets: [...this.loaded.keys()].sort(),
    }
  }

  /** Progress of the current camera blend, 0..1 (1 when none is running). */
  cameraBlendProgress(): number {
    const b = this.cameraBlend
    if (!b) return 1
    return Math.min(1, Math.max(0, (this.stageNow() - b.startMs) / b.durationMs))
  }
}

export function createSimulatorStage(opts: SimulatorOptions): SimulatorStage {
  return new SimulatorStage(opts)
}

