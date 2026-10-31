/**
 * BehaviorDirector: the "tick(now)" loop that makes her feel alive. Each tick it may return StageCommands:
 *   - an idle profile (attentive / relaxed / busy / sleepy / asleep) chosen from context, mood and quiet hours;
 *   - a posture, tied to the scene's anchors (sit, lean, stand);
 *   - gaze: held on the user for as long as her style says, with natural away glances and returns;
 *   - gestures shaped by her PresenceStyle, with cooldowns and a recent-history window;
 *   - her mood as perform.affect when it moved enough to show.
 * It also turns to the user on return, wakes on a message, and owns the interruption budget for unprompted speech.
 * Everything is driven by the injected clock and seeded Rng: the same inputs produce the same performance.
 */
import type { Affect, Anchor, Emotion, GazeTarget, Posture, PresenceStyle } from '@ai-assistant/shared'
import type { Clock } from '../util/clock'
import type { Rng } from '../util/rng'
import type { CommandDraft } from '../util/commands'
import { clamp } from '../util/math'
import { fail, ok } from '../util/result'
import type { Result } from '../util/result'
import { inQuietHours, localMinutes } from '../util/time'
import type { QuietHoursSpec } from '../util/time'
import type { MoodEngine } from '../affect/mood'
import { InterruptionBudget } from './budget'
import type { BudgetDecision, UtteranceRequest } from './budget'
import { GestureSelector } from './gestures'
import type { GestureClip, GestureContext } from './gestures'

export type IdleProfile = 'attentive' | 'relaxed' | 'busy' | 'sleepy' | 'asleep'
export type WorkActivity = 'idle' | 'conversation' | 'working' | 'reviewing'

export interface AnchorRef {
  objectId: string
  anchor: Pick<Anchor, 'id' | 'kind'>
}

export interface BehaviorTimings {
  minProfileHoldMs: number
  minPostureHoldMs: number
  /** After the last interaction she stays awake this long even inside quiet hours. */
  wakeHoldMs: number
  gazeBaseMs: number
  speakGestureBaseMs: number
  idleGestureBaseMs: number
  longSilenceMs: number
  sleepyIdleMs: number
  affectMinGapMs: number
  affectDelta: number
  /** Local hours when "late hours" fatigue applies: from (inclusive) to (exclusive), crossing midnight. */
  lateFromHour: number
  lateToHour: number
}

export const DEFAULT_TIMINGS: BehaviorTimings = {
  minProfileHoldMs: 30_000,
  minPostureHoldMs: 60_000,
  wakeHoldMs: 10 * 60_000,
  gazeBaseMs: 3500,
  speakGestureBaseMs: 7000,
  idleGestureBaseMs: 75_000,
  longSilenceMs: 45 * 60_000,
  sleepyIdleMs: 60 * 60_000,
  affectMinGapMs: 2000,
  affectDelta: 0.08,
  lateFromHour: 23,
  lateToHour: 5,
}

export interface BehaviorDirectorOptions {
  clock: Clock
  rng: Rng
  presence: PresenceStyle
  mood: MoodEngine
  gestures?: readonly GestureClip[]
  quietHours?: QuietHoursSpec
  /** Proactivity slider 0..100 for the budget when none is supplied. Default 55. */
  proactivity?: number
  budget?: InterruptionBudget
  /** Set as characterId on every command (omitted = the assistant, the contract default). */
  characterId?: string
  timings?: Partial<BehaviorTimings>
}

interface GazeState {
  mode: 'user' | 'screen' | 'away' | 'none'
  nextAt: number
}

export class BehaviorDirector {
  readonly budget: InterruptionBudget
  readonly gestures: GestureSelector
  private readonly t: BehaviorTimings
  private presence: PresenceStyle
  private quiet: QuietHoursSpec | undefined

  // context
  private userPresent: boolean | undefined
  private activity: WorkActivity = 'idle'
  private load = { running: 0, blocked: 0 }
  private speaking = false
  private anchors: AnchorRef[] = []
  private screenObjectId: string | undefined
  private lastInteractionAt: number
  private readonly startedAt: number

  // outputs / state
  private profile: IdleProfile | undefined
  private profileSince = Number.NEGATIVE_INFINITY
  private posture: { posture: Posture; anchorKey?: string } | undefined
  private postureSince = Number.NEGATIVE_INFINITY
  private gaze: GazeState = { mode: 'none', nextAt: 0 }
  private nextGestureAt = 0
  private lastAffect: { v: number; a: number; d: number; label: Emotion; at: number } | undefined
  private lastLateAt = Number.NEGATIVE_INFINITY
  private lastSilenceAt = Number.NEGATIVE_INFINITY
  private pending: CommandDraft[] = []
  private forcedGaze: { target: GazeTarget; until: number } | undefined

  constructor(private readonly opts: BehaviorDirectorOptions) {
    this.t = { ...DEFAULT_TIMINGS, ...opts.timings }
    this.presence = opts.presence
    this.quiet = opts.quietHours
    this.budget = opts.budget ?? new InterruptionBudget({ clock: opts.clock, ...(opts.quietHours ? { quietHours: opts.quietHours } : {}), proactivity: opts.proactivity ?? 55 })
    this.gestures = new GestureSelector({ presence: opts.presence, rng: opts.rng, ...(opts.gestures ? { library: opts.gestures } : {}) })
    this.startedAt = opts.clock.now()
    // booting counts as no recent interaction: started inside quiet hours she is asleep at once
    this.lastInteractionAt = this.startedAt - this.t.wakeHoldMs
  }

  // ----------------------------------------------------------------------------------------------- inputs

  setPresence(p: PresenceStyle): void {
    this.presence = p
    this.gestures.setPresence(p)
    this.opts.mood.setBaseline(p.baseline)
  }

  setQuietHours(q: QuietHoursSpec | undefined): void {
    this.quiet = q
    this.budget.setQuietHours(q)
  }

  setActivity(a: WorkActivity): void {
    this.activity = a
  }

  /** Claude sessions running / waiting for the user: running sessions make her look busy when not in conversation. */
  setWorkLoad(load: { running: number; blocked: number }): void {
    this.load = { running: Math.max(0, load.running | 0), blocked: Math.max(0, load.blocked | 0) }
  }

  setAnchors(anchors: readonly AnchorRef[]): void {
    this.anchors = [...anchors]
  }

  /** The object (a monitor) she glances at when she is working; without one she glances toward the camera. */
  setScreenObject(objectId: string | undefined): void {
    this.screenObjectId = objectId
  }

  /** Presence from the stage (`user.presence`). Never carries image data. */
  onUserPresence(ev: { present: boolean; lookingAtScreen?: boolean }): void {
    const now = this.opts.clock.now()
    const was = this.userPresent
    this.userPresent = ev.present
    if (ev.present && was !== true) {
      // she turns to the user on return (unless she is asleep: presence alone does not wake her)
      if (was === false) this.opts.mood.apply({ type: 'user_returned' })
      this.gaze = { mode: 'none', nextAt: now }
      this.forcedGaze = undefined
      this.pending.push(this.cmd({ type: 'perform.gaze', target: { kind: 'user' }, speed: 0.8, saccades: true }))
      this.gaze = { mode: 'user', nextAt: now + this.holdMs() }
      if (!this.isAsleep(now) && was === false) {
        const clip = this.gestures.pick({ context: 'greeting', arousal: this.opts.mood.get().arousal, emotion: this.opts.mood.get().label }, now)
        if (clip) this.pending.push(this.gestureCmd(clip, now))
      }
    }
    if (!ev.present && was === true) this.gaze = { mode: 'none', nextAt: now }
  }

  /** The user wrote or spoke: she wakes and gives attention. */
  onUserMessage(): void {
    this.lastInteractionAt = this.opts.clock.now()
  }

  onSpeechStarted(): void {
    const now = this.opts.clock.now()
    this.speaking = true
    this.lastInteractionAt = now
    if (this.nextGestureAt < now + 600) this.nextGestureAt = now + 600 + Math.round(this.opts.rng.range(0, 900))
  }

  /** `interrupted` = the user barged in; she registers it (mildly) and looks back at the user. */
  onSpeechEnded(interrupted = false): void {
    const now = this.opts.clock.now()
    this.speaking = false
    this.lastInteractionAt = now
    if (interrupted) {
      this.opts.mood.apply({ type: 'interrupted', magnitude: 0.5 })
      this.gaze = { mode: 'none', nextAt: now }
      this.nextGestureAt = Math.max(this.nextGestureAt, now + 1500)
    }
  }

  // ------------------------------------------------------------------------------------------ explicit actions

  /** Look at something for a while (e.g. the note she is citing). */
  lookAt(target: GazeTarget, holdMs = 2500): void {
    const now = this.opts.clock.now()
    this.forcedGaze = { target, until: now + Math.max(300, holdMs) }
    this.pending.push(this.cmd({ type: 'perform.gaze', target, speed: this.gazeSpeed(), saccades: true }))
  }

  /** A gesture asked for explicitly (the stage_gesture tool). The frequency limiter does not apply; the clip must exist. */
  requestGesture(clipId: string, requestedIntensity?: number): Result<CommandDraft> {
    const clip = this.gestures.get(clipId)
    if (!clip) return fail('unknown_clip', `unknown gesture "${clipId}" (try: ${this.gestures.clips().map((c) => c.id).join(', ')})`)
    const now = this.opts.clock.now()
    if (this.isAsleep(now)) return fail('asleep', 'she is asleep')
    this.gestures.record(clip.id, now)
    this.nextGestureAt = Math.max(this.nextGestureAt, now + clip.durationMs + 1000)
    return ok(this.gestureCmd(clip, now, requestedIntensity))
  }

  /** Ask for a posture; resolved to an anchor when the scene has one of the right kind. */
  requestPosture(posture: Posture): CommandDraft {
    const now = this.opts.clock.now()
    const cmd = this.postureCommand(posture)
    this.posture = { posture: (cmd.command as { posture: Posture }).posture, ...(cmd.anchorKey ? { anchorKey: cmd.anchorKey } : {}) }
    this.postureSince = now
    return cmd.command
  }

  /** May she speak unprompted now? Pass-through to the interruption budget. */
  requestUtterance(req: UtteranceRequest, opts?: { commit?: boolean }): BudgetDecision {
    return this.budget.request(req, opts)
  }

  // ---------------------------------------------------------------------------------------------------- state

  currentProfile(): IdleProfile | undefined {
    return this.profile
  }
  currentPosture(): Posture | undefined {
    return this.posture?.posture
  }
  isSpeaking(): boolean {
    return this.speaking
  }
  isPresent(): boolean | undefined {
    return this.userPresent
  }

  private isAsleep(now: number): boolean {
    return this.wantedProfile(now) === 'asleep'
  }

  // ------------------------------------------------------------------------------------------------- the loop

  /** Advance to `now` (default: the clock) and return the commands to send. */
  tick(now: number = this.opts.clock.now()): CommandDraft[] {
    const out: CommandDraft[] = this.pending
    this.pending = []

    this.ambientMood(now)

    // idle profile and posture
    const wanted = this.wantedProfile(now)
    const mood = this.opts.mood.get()
    const switching = this.profile !== wanted
    const waking = this.profile === 'asleep' && wanted !== 'asleep'
    const sleepingNow = wanted === 'asleep' && this.profile !== 'asleep'
    if (switching && (this.profile === undefined || waking || sleepingNow || now - this.profileSince >= this.t.minProfileHoldMs)) {
      this.profile = wanted
      this.profileSince = now
      out.push(this.cmd({ type: 'perform.idle', profile: wanted }))
      if (waking) {
        this.gaze = { mode: 'none', nextAt: now }
        out.push(this.cmd({ type: 'perform.gaze', target: this.userPresent === false ? this.awayTarget() : { kind: 'user' }, speed: 0.5, saccades: true }))
        this.gaze = { mode: this.userPresent === false ? 'away' : 'user', nextAt: now + this.holdMs() }
      }
    }
    const profile = this.profile ?? wanted
    this.tickPosture(now, profile, waking || sleepingNow, out)

    if (profile !== 'asleep') {
      this.tickGaze(now, profile, mood, out)
      this.tickGesture(now, profile, mood, out)
    }
    this.tickAffect(now, mood, out)
    return out
  }

  private wantedProfile(now: number): IdleProfile {
    const sinceInteraction = now - this.lastInteractionAt
    const quiet = inQuietHours(this.quiet, now)
    if (quiet && sinceInteraction >= this.t.wakeHoldMs && !this.speaking) return 'asleep'
    const mood = this.opts.mood.get()
    const late = this.isLateHour(now)
    if (mood.arousal < -0.5 || (late && sinceInteraction > 15 * 60_000) || sinceInteraction > this.t.sleepyIdleMs) return 'sleepy'
    if (this.activity === 'conversation' || this.speaking) return 'attentive'
    if (this.activity === 'working' || this.activity === 'reviewing' || this.load.running > 0) return 'busy'
    if (this.userPresent === true && sinceInteraction < 3 * 60_000) return 'attentive'
    return 'relaxed'
  }

  private isLateHour(now: number): boolean {
    const h = Math.floor(localMinutes(now) / 60)
    const { lateFromHour: from, lateToHour: to } = this.t
    return from < to ? h >= from && h < to : h >= from || h < to
  }

  private ambientMood(now: number): void {
    if (this.isLateHour(now) && now - this.lastLateAt >= 30 * 60_000) {
      this.lastLateAt = now
      this.opts.mood.apply({ type: 'late_hours', magnitude: 0.6 })
    }
    const idle = now - this.lastInteractionAt
    if (idle >= this.t.longSilenceMs && now - this.lastSilenceAt >= this.t.longSilenceMs && this.profile !== 'asleep') {
      this.lastSilenceAt = now
      this.opts.mood.apply({ type: 'long_silence', magnitude: 0.6 })
    }
  }

  // ------------------------------------------------------------------------------------------------- posture

  private anchorOf(kind: Anchor['kind']): AnchorRef | undefined {
    return [...this.anchors].sort((a, b) => (a.objectId + a.anchor.id < b.objectId + b.anchor.id ? -1 : 1)).find((a) => a.anchor.kind === kind)
  }

  private postureCommand(posture: Posture): { command: CommandDraft; anchorKey?: string } {
    const kind: Anchor['kind'] | undefined = posture === 'sit' ? 'sit' : posture === 'lean' ? 'lean' : posture === 'lie' ? 'lie' : undefined
    const a = kind ? this.anchorOf(kind) : undefined
    // a posture that needs an anchor falls back to standing when the scene has none
    const eff: Posture = kind && !a ? 'stand' : posture
    const base = { type: 'perform.posture' as const, posture: eff }
    return a ? { command: this.cmd({ ...base, anchorObjectId: a.objectId, anchorId: a.anchor.id }), anchorKey: `${a.objectId}/${a.anchor.id}` } : { command: this.cmd(base) }
  }

  private posturePlan(profile: IdleProfile): Posture {
    switch (profile) {
      case 'asleep':
        return 'sleep'
      case 'sleepy':
        return this.anchorOf('sit') ? 'sit' : 'stand'
      case 'relaxed':
        return this.anchorOf('lean') ? 'lean' : this.anchorOf('sit') ? 'sit' : 'stand'
      case 'busy':
        return this.anchorOf('sit') ? 'sit' : 'stand'
      default:
        return 'stand'
    }
  }

  private tickPosture(now: number, profile: IdleProfile, urgent: boolean, out: CommandDraft[]): void {
    const plan = this.postureCommand(this.posturePlan(profile))
    const planned = plan.command as { posture: Posture }
    const same = this.posture && this.posture.posture === planned.posture && this.posture.anchorKey === plan.anchorKey
    if (same) return
    if (!urgent && this.posture && now - this.postureSince < this.t.minPostureHoldMs) return
    this.posture = { posture: planned.posture, ...(plan.anchorKey ? { anchorKey: plan.anchorKey } : {}) }
    this.postureSince = now
    out.push(plan.command)
  }

  // --------------------------------------------------------------------------------------------------- gaze

  private gazeSpeed(): number {
    return Math.round(clamp(0.4 + 0.4 * (1 - this.presence.pace), 0.2, 0.95) * 100) / 100
  }

  /** How long she holds eye contact before a natural break (ms). Long for authority, jittered. */
  private holdMs(): number {
    const base = this.t.gazeBaseMs * (0.5 + 1.5 * this.presence.gazeHold)
    return Math.round(base * this.opts.rng.range(0.75, 1.25) * (this.speaking ? 1.4 : 1))
  }

  private awayTarget(thinking = false): GazeTarget {
    const dir = this.opts.rng.weighted(['down', 'left', 'right', 'up'] as const, (d) => (d === 'down' ? 0.35 : d === 'up' ? (thinking ? 0.6 : 0.15) : 0.25))
    return { kind: 'away', direction: dir ?? 'down' }
  }

  private screenTarget(): GazeTarget {
    return this.screenObjectId ? { kind: 'object', objectId: this.screenObjectId } : { kind: 'camera' }
  }

  private tickGaze(now: number, profile: IdleProfile, mood: Affect, out: CommandDraft[]): void {
    if (this.forcedGaze) {
      if (now < this.forcedGaze.until) return
      this.forcedGaze = undefined
      this.gaze = { mode: 'none', nextAt: now }
    }
    if (this.gaze.mode !== 'none' && now < this.gaze.nextAt) return
    const speed = this.gazeSpeed()
    const rng = this.opts.rng
    const present = this.userPresent !== false
    const emit = (target: GazeTarget): void => {
      out.push(this.cmd({ type: 'perform.gaze', target, speed, saccades: true }))
    }

    if (this.gaze.mode === 'none') {
      // establish: user if present, else drift
      if (present) {
        emit({ kind: 'user' })
        this.gaze = { mode: 'user', nextAt: now + this.holdMs() }
      } else {
        emit(this.awayTarget())
        this.gaze = { mode: 'away', nextAt: now + Math.round(rng.range(8000, 20000)) }
      }
      return
    }
    if (!present) {
      emit(this.awayTarget())
      this.gaze = { mode: 'away', nextAt: now + Math.round(rng.range(8000, 20000)) }
      return
    }
    if (profile === 'busy' && this.gaze.mode !== 'screen' && this.activity !== 'conversation') {
      // working: she looks at what she works on, with occasional glances away
      emit(this.screenTarget())
      this.gaze = { mode: 'screen', nextAt: now + Math.round(rng.range(6000, 14000)) }
      return
    }
    if (this.gaze.mode === 'user') {
      // break eye contact naturally: a short glance, shorter the longer she tends to hold gaze
      const target = this.awayTarget(mood.label === 'thinking')
      emit(target)
      const glance = Math.round(rng.range(500, 1300) * (1 - 0.3 * this.presence.gazeHold) * (this.speaking ? 0.8 : 1))
      this.gaze = { mode: 'away', nextAt: now + glance }
      return
    }
    // from away or screen: back to the user (or to the screen when busy and not talking)
    if (profile === 'busy' && this.gaze.mode === 'away' && this.activity !== 'conversation') {
      emit(this.screenTarget())
      this.gaze = { mode: 'screen', nextAt: now + Math.round(rng.range(6000, 14000)) }
      return
    }
    emit({ kind: 'user' })
    this.gaze = { mode: 'user', nextAt: now + this.holdMs() }
  }

  // ------------------------------------------------------------------------------------------------ gesture

  private gestureInterval(context: GestureContext): number {
    const econ = this.presence.gestureEconomy
    const base = context === 'speaking' ? this.t.speakGestureBaseMs * (0.7 + 1.5 * econ) : this.t.idleGestureBaseMs * (0.6 + 1.4 * econ)
    return Math.round(base * this.opts.rng.range(0.7, 1.3))
  }

  private gestureCmd(clip: GestureClip, _now: number, requestedIntensity?: number): CommandDraft {
    const m = this.opts.mood.get()
    return this.cmd({ type: 'perform.gesture', clip: clip.id, intensity: this.gestures.intensityFor(m.arousal, requestedIntensity) })
  }

  private tickGesture(now: number, profile: IdleProfile, mood: Affect, out: CommandDraft[]): void {
    if (now < this.nextGestureAt) return
    const context: GestureContext = this.speaking ? 'speaking' : this.activity === 'conversation' ? 'listening' : mood.label === 'thinking' ? 'thinking' : 'idle'
    // sleepy and busy states move less
    const skip = profile === 'sleepy' ? 0.7 : profile === 'busy' && !this.speaking ? 0.6 : 0
    if (skip > 0 && this.opts.rng.chance(skip)) {
      this.nextGestureAt = now + this.gestureInterval(context)
      return
    }
    const clip = this.gestures.pick({ context, emotion: mood.label, arousal: mood.arousal }, now)
    if (!clip) {
      this.nextGestureAt = now + 5000
      return
    }
    out.push(this.gestureCmd(clip, now))
    this.nextGestureAt = now + clip.durationMs + this.gestureInterval(context)
  }

  // -------------------------------------------------------------------------------------------------- affect

  private tickAffect(now: number, mood: Affect, out: CommandDraft[]): void {
    const last = this.lastAffect
    const moved = !last || Math.max(Math.abs(mood.valence - last.v), Math.abs(mood.arousal - last.a), Math.abs(mood.dominance - last.d)) >= this.t.affectDelta
    const labelChanged = !last || mood.label !== last.label
    if (!last || ((moved || labelChanged) && now - last.at >= this.t.affectMinGapMs)) {
      this.lastAffect = { v: mood.valence, a: mood.arousal, d: mood.dominance, label: mood.label, at: now }
      out.push(this.cmd({ type: 'perform.affect', affect: mood, blendMs: Math.round(400 + 600 * this.presence.pace) }))
    }
  }

  private cmd(c: CommandDraft): CommandDraft {
    return this.opts.characterId ? ({ ...c, characterId: this.opts.characterId } as CommandDraft) : c
  }
}

export function createBehaviorDirector(opts: BehaviorDirectorOptions): BehaviorDirector {
  return new BehaviorDirector(opts)
}
