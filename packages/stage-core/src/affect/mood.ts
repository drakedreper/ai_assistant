/**
 * MoodEngine: continuous mood as valence / arousal / dominance in -1..1 that
 *   - jumps by an event-specific delta (praise, bad news, a long silence, late hours, being interrupted, a finished task,
 *     the user returning, ...), scaled by her reactivity (composed presence reacts less);
 *   - decays exponentially toward the PresenceStyle baseline as time passes (injected clock, lazy: no timers);
 *   - maps to the closed Emotion label set the stage knows.
 * Deterministic, never NaN, always clamped. Persona rule: silence and absence lower AROUSAL (she gets sleepy), never
 * valence: no sulking, no guilt (docs/PERSONA.md section 3).
 */
import { Emotion } from '@ai-assistant/shared'
import type { Affect, Emotion as EmotionT, PresenceStyle } from '@ai-assistant/shared'
import type { Clock } from '../util/clock'
import { clamp, clampFinite } from '../util/math'

export type MoodEventType =
  | 'praise'
  | 'thanks'
  | 'good_news'
  | 'bad_news'
  | 'long_silence'
  | 'late_hours'
  | 'interrupted'
  | 'task_completed'
  | 'task_failed'
  | 'user_returned'
  | 'user_distress'
  | 'criticism'
  | 'surprise'
  | 'flustered'

export interface MoodEvent {
  type: MoodEventType
  /** 0..2, default 1. Non-finite values are ignored (the event does nothing). */
  magnitude?: number
}

type Delta = readonly [valence: number, arousal: number, dominance: number]

/** Raw deltas at reactivity 1 and magnitude 1. */
export const MOOD_DELTAS: Readonly<Record<MoodEventType, Delta>> = {
  praise: [0.3, 0.1, 0.05],
  thanks: [0.2, 0.05, 0.05],
  good_news: [0.4, 0.25, 0.05],
  bad_news: [-0.35, 0.15, -0.15],
  long_silence: [0, -0.25, -0.02],
  late_hours: [0, -0.3, -0.05],
  interrupted: [-0.1, 0.15, -0.1],
  task_completed: [0.25, 0.05, 0.15],
  task_failed: [-0.25, 0.1, -0.2],
  user_returned: [0.2, 0.2, 0],
  // calm and steady for someone in distress: composure up, no jolt of arousal (PERSONA.md section 4)
  user_distress: [-0.1, -0.1, 0.2],
  criticism: [-0.2, 0.1, -0.05],
  surprise: [0.05, 0.6, -0.2],
  flustered: [0.1, 0.2, -0.4],
}

export const MOOD_EVENT_TYPES = Object.keys(MOOD_DELTAS) as MoodEventType[]

/** Event types are looked up in a Map built from the table's OWN entries: "constructor", "toString", "__proto__" and the rest of Object.prototype are not event types. */
const DELTA_BY_TYPE: ReadonlyMap<string, Delta> = new Map(Object.entries(MOOD_DELTAS))

export interface MoodEngineOptions {
  clock: Clock
  /** The persona's resting mood. Default AUTHORITY-like (slightly positive, low arousal, high dominance). */
  baseline?: PresenceStyle['baseline']
  /** Scales every delta. Default 1. See `reactivityFor`. */
  reactivity?: number
  /** Half-life of the pull back to baseline per axis, in ms. */
  halfLifeMs?: { valence?: number; arousal?: number; dominance?: number }
  initial?: { valence: number; arousal: number; dominance: number }
}

export interface MoodSnapshot {
  valence: number
  arousal: number
  dominance: number
  /** Epoch ms of the last update. */
  at: number
}

export const DEFAULT_BASELINE: PresenceStyle['baseline'] = { valence: 0.2, arousal: -0.1, dominance: 0.7 }
const DEFAULT_HALF_LIFE = { valence: 25 * 60_000, arousal: 10 * 60_000, dominance: 40 * 60_000 }

/** A composed, economical presence reacts less than an expressive one: 1.15 - 0.4 * gestureEconomy (authority: 0.85). */
export const reactivityFor = (presence: Pick<PresenceStyle, 'gestureEconomy'>): number => clamp(1.15 - 0.4 * presence.gestureEconomy, 0.5, 1.2)

const PROTOTYPES: ReadonlyArray<readonly [EmotionT, Delta]> = [
  ['happy', [0.5, 0.35, 0.1]],
  ['sad', [-0.5, -0.3, -0.3]],
  ['angry', [-0.5, 0.5, 0.35]],
  ['relaxed', [0.25, -0.45, 0]],
  ['surprised', [0.1, 0.7, -0.25]],
  ['shy', [0.15, 0.15, -0.6]],
]
/** Inside this distance from baseline the label is neutral: she does not flicker between expressions. */
export const NEUTRAL_RADIUS = 0.2

/** Closest label of the closed vocabulary, judged by the deviation from her baseline. 'thinking' is only ever set by holdLabel. */
export function labelFor(v: number, a: number, d: number, baseline: PresenceStyle['baseline']): EmotionT {
  const dv = v - baseline.valence
  const da = a - baseline.arousal
  const dd = d - baseline.dominance
  if (Math.hypot(dv, da, dd) < NEUTRAL_RADIUS) return 'neutral'
  let best: EmotionT = 'neutral'
  let bestDist = Infinity
  for (const [label, p] of PROTOTYPES) {
    const dist = Math.hypot(dv - p[0], da - p[1], dd - p[2])
    if (dist < bestDist) {
      bestDist = dist
      best = label
    }
  }
  return best
}

export class MoodEngine {
  private v: number
  private a: number
  private d: number
  private at: number
  private base: PresenceStyle['baseline']
  private readonly reactivity: number
  private readonly half: { valence: number; arousal: number; dominance: number }
  private held: { label: EmotionT; until: number } | undefined

  constructor(private readonly opts: MoodEngineOptions) {
    this.base = sanitizeBaseline(opts.baseline ?? DEFAULT_BASELINE)
    this.reactivity = clamp(Number.isFinite(opts.reactivity) ? (opts.reactivity as number) : 1, 0, 3)
    this.half = {
      valence: positive(opts.halfLifeMs?.valence, DEFAULT_HALF_LIFE.valence),
      arousal: positive(opts.halfLifeMs?.arousal, DEFAULT_HALF_LIFE.arousal),
      dominance: positive(opts.halfLifeMs?.dominance, DEFAULT_HALF_LIFE.dominance),
    }
    const init = opts.initial
    this.v = init ? clampFinite(init.valence, -1, 1, this.base.valence) : this.base.valence
    this.a = init ? clampFinite(init.arousal, -1, 1, this.base.arousal) : this.base.arousal
    this.d = init ? clampFinite(init.dominance, -1, 1, this.base.dominance) : this.base.dominance
    this.at = opts.clock.now()
  }

  static fromPresence(presence: PresenceStyle, clock: Clock, extra: Partial<MoodEngineOptions> = {}): MoodEngine {
    return new MoodEngine({ clock, baseline: presence.baseline, reactivity: reactivityFor(presence), ...extra })
  }

  private decayTo(now: number): void {
    const dt = now - this.at
    if (!(dt > 0)) {
      if (dt < 0) this.at = now // the clock went backwards: no decay, just resync
      return
    }
    const f = (half: number): number => 0.5 ** (dt / half)
    this.v = clampFinite(this.base.valence + (this.v - this.base.valence) * f(this.half.valence), -1, 1, this.base.valence)
    this.a = clampFinite(this.base.arousal + (this.a - this.base.arousal) * f(this.half.arousal), -1, 1, this.base.arousal)
    this.d = clampFinite(this.base.dominance + (this.d - this.base.dominance) * f(this.half.dominance), -1, 1, this.base.dominance)
    this.at = now
  }

  /** Current mood (decayed to now) with its closest label. */
  get(): Affect {
    const now = this.opts.clock.now()
    this.decayTo(now)
    return this.build(now)
  }

  private build(now: number): Affect {
    if (this.held && now >= this.held.until) this.held = undefined
    const label = this.held ? this.held.label : labelFor(this.v, this.a, this.d, this.base)
    return Emotion.safeParse(label).success ? { valence: this.v, arousal: this.a, dominance: this.d, label } : { valence: this.v, arousal: this.a, dominance: this.d, label: 'neutral' }
  }

  /** Apply an event. Unknown types and non-finite magnitudes change nothing. */
  apply(event: MoodEvent): Affect {
    const now = this.opts.clock.now()
    this.decayTo(now)
    const type = event !== null && typeof event === 'object' ? (event as { type?: unknown }).type : undefined
    const delta = typeof type === 'string' ? DELTA_BY_TYPE.get(type) : undefined
    const mag = event !== null && typeof event === 'object' ? (event as { magnitude?: unknown }).magnitude : undefined
    const m = mag === undefined ? 1 : mag
    if (delta && typeof m === 'number' && Number.isFinite(m)) {
      const k = this.reactivity * clamp(m, 0, 2)
      this.v = clamp(this.v + delta[0] * k, -1, 1)
      this.a = clamp(this.a + delta[1] * k, -1, 1)
      this.d = clamp(this.d + delta[2] * k, -1, 1)
    }
    return this.build(now)
  }

  /** Force a label for a while (e.g. 'thinking' while a reply is being prepared). The numbers keep evolving underneath. */
  holdLabel(label: EmotionT, ms: number): void {
    if (!Emotion.safeParse(label).success || !Number.isFinite(ms) || ms <= 0) return
    this.held = { label, until: this.opts.clock.now() + ms }
  }

  releaseLabel(): void {
    this.held = undefined
  }

  /** How far from her baseline she is, 0..1: drives how strong the expression is. */
  intensity(): number {
    const a = this.get()
    return clamp(Math.hypot(a.valence - this.base.valence, a.arousal - this.base.arousal, a.dominance - this.base.dominance) * 1.5, 0, 1)
  }

  baseline(): PresenceStyle['baseline'] {
    return { ...this.base }
  }

  /** Change the resting mood (e.g. after the presence style is edited). The current mood is kept. */
  setBaseline(b: PresenceStyle['baseline']): void {
    this.decayTo(this.opts.clock.now())
    this.base = sanitizeBaseline(b)
  }

  snapshot(): MoodSnapshot {
    const now = this.opts.clock.now()
    this.decayTo(now)
    return { valence: this.v, arousal: this.a, dominance: this.d, at: now }
  }

  /** Restore a persisted mood; time since `at` decays it toward the baseline on the next read. */
  restore(s: MoodSnapshot): void {
    // a row from storage is not trusted: anything that is not a finite number (a string, null, an object, a Symbol) falls back to the baseline
    const o: Partial<MoodSnapshot> = s !== null && typeof s === 'object' ? s : {}
    this.v = clampFinite(o.valence as number, -1, 1, this.base.valence)
    this.a = clampFinite(o.arousal as number, -1, 1, this.base.arousal)
    this.d = clampFinite(o.dominance as number, -1, 1, this.base.dominance)
    this.at = typeof o.at === 'number' && Number.isFinite(o.at) ? o.at : this.opts.clock.now()
    this.held = undefined
  }
}

function sanitizeBaseline(b: PresenceStyle['baseline']): PresenceStyle['baseline'] {
  const o: Partial<PresenceStyle['baseline']> = b !== null && typeof b === 'object' ? b : {}
  return { valence: clampFinite(o.valence as number, -1, 1, 0), arousal: clampFinite(o.arousal as number, -1, 1, 0), dominance: clampFinite(o.dominance as number, -1, 1, 0) }
}

function positive(v: number | undefined, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback
}

export function createMoodEngine(opts: MoodEngineOptions): MoodEngine {
  return new MoodEngine(opts)
}
