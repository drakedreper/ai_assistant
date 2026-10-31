/**
 * Gestures: an animation-library list (clip metadata the stage resolves to real animations) and a selector shaped by the
 * PresenceStyle. Authority = few, deliberate, low-energy gestures; athletic = grounded posture choices (weight shifts,
 * shoulder settles) are favoured. Cooldowns per clip and a recent-history window stop anything repeating mechanically.
 */
import type { Emotion, PresenceStyle } from '@ai-assistant/shared'
import type { Rng } from '../util/rng'
import { clamp, clampFinite } from '../util/math'

export type GestureContext = 'speaking' | 'listening' | 'idle' | 'thinking' | 'greeting'

export interface GestureClip {
  id: string
  /** Semantic tags ("nod", "emphasis", "authority", "grounded"...). */
  tags: readonly string[]
  durationMs: number
  /** The same clip is not offered again before this. */
  cooldownMs: number
  /** How expansive it is, 0 (a breath) .. 1 (a big arm movement). */
  energy: number
  /** Base likelihood. */
  weight: number
  contexts: readonly GestureContext[]
  /** If set, only for these emotions. */
  emotions?: readonly Emotion[]
  /** A balanced, weight-bearing posture choice (favoured by athletic presence). */
  grounded?: boolean
}

export const DEFAULT_GESTURES: readonly GestureClip[] = [
  { id: 'nod_small', tags: ['nod', 'acknowledge'], durationMs: 900, cooldownMs: 6000, energy: 0.15, weight: 1.4, contexts: ['speaking', 'listening'] },
  { id: 'nod_slow', tags: ['nod', 'agree', 'authority'], durationMs: 1400, cooldownMs: 9000, energy: 0.2, weight: 1.2, contexts: ['listening', 'speaking'] },
  { id: 'head_tilt', tags: ['curious'], durationMs: 1200, cooldownMs: 12000, energy: 0.2, weight: 0.8, contexts: ['listening', 'thinking'] },
  { id: 'hand_emphasis_small', tags: ['emphasis'], durationMs: 900, cooldownMs: 10000, energy: 0.3, weight: 1.2, contexts: ['speaking'] },
  { id: 'hand_open_palm', tags: ['explain', 'welcome'], durationMs: 1500, cooldownMs: 18000, energy: 0.45, weight: 0.9, contexts: ['speaking'], emotions: ['happy', 'neutral', 'relaxed'] },
  { id: 'hand_point_soft', tags: ['point', 'refer'], durationMs: 1300, cooldownMs: 25000, energy: 0.5, weight: 0.5, contexts: ['speaking'] },
  { id: 'shrug_slight', tags: ['uncertain'], durationMs: 1100, cooldownMs: 30000, energy: 0.4, weight: 0.5, contexts: ['speaking'], emotions: ['neutral', 'thinking', 'sad'] },
  { id: 'chin_touch', tags: ['think'], durationMs: 2200, cooldownMs: 40000, energy: 0.25, weight: 1, contexts: ['thinking', 'idle'], emotions: ['thinking', 'neutral'] },
  { id: 'chin_raise', tags: ['confident', 'authority'], durationMs: 1100, cooldownMs: 30000, energy: 0.15, weight: 0.7, contexts: ['speaking'], emotions: ['neutral', 'happy', 'angry'] },
  { id: 'laugh_small', tags: ['laugh'], durationMs: 1800, cooldownMs: 60000, energy: 0.35, weight: 1, contexts: ['speaking'], emotions: ['happy'] },
  { id: 'lean_forward', tags: ['attentive'], durationMs: 2000, cooldownMs: 40000, energy: 0.25, weight: 0.8, contexts: ['listening'] },
  { id: 'weight_shift', tags: ['grounded', 'posture'], durationMs: 2000, cooldownMs: 20000, energy: 0.1, weight: 1.2, contexts: ['idle', 'listening'], grounded: true },
  { id: 'shoulder_settle', tags: ['grounded', 'posture', 'breath'], durationMs: 1600, cooldownMs: 30000, energy: 0.1, weight: 1, contexts: ['idle'], grounded: true },
  { id: 'adjust_cuff', tags: ['fidget'], durationMs: 1800, cooldownMs: 60000, energy: 0.15, weight: 0.6, contexts: ['idle'] },
  { id: 'breath_deep', tags: ['calm', 'breath'], durationMs: 2800, cooldownMs: 45000, energy: 0.1, weight: 0.8, contexts: ['idle'], emotions: ['relaxed', 'sad', 'neutral'] },
  { id: 'arms_folded', tags: ['authority', 'grounded', 'closed'], durationMs: 3000, cooldownMs: 90000, energy: 0.2, weight: 0.5, contexts: ['idle', 'listening'], grounded: true },
  { id: 'stretch_light', tags: ['athletic', 'grounded'], durationMs: 3000, cooldownMs: 600000, energy: 0.55, weight: 0.4, contexts: ['idle'], emotions: ['relaxed', 'neutral', 'happy'], grounded: true },
  { id: 'wave_small', tags: ['greet', 'wave'], durationMs: 1500, cooldownMs: 60000, energy: 0.4, weight: 1, contexts: ['greeting'], emotions: ['happy', 'neutral', 'relaxed'] },
  { id: 'greeting_nod', tags: ['greet', 'nod', 'authority'], durationMs: 1400, cooldownMs: 60000, energy: 0.2, weight: 1.2, contexts: ['greeting'] },
]

export interface GesturePickRequest {
  context: GestureContext
  emotion?: Emotion
  /** -1..1, from the mood. */
  arousal?: number
  /** Require at least one of these tags. */
  tags?: readonly string[]
}

export interface GestureSelectorOptions {
  presence: PresenceStyle
  rng: Rng
  library?: readonly GestureClip[]
  /** How many recent gestures are remembered. Default 6. */
  historySize?: number
}

export class GestureSelector {
  private readonly library: readonly GestureClip[]
  private readonly lastUsed = new Map<string, number>()
  private history: string[] = []
  private presence: PresenceStyle
  private readonly historySize: number

  constructor(private readonly opts: GestureSelectorOptions) {
    this.library = opts.library ?? DEFAULT_GESTURES
    this.presence = opts.presence
    this.historySize = Math.max(1, opts.historySize ?? 6)
  }

  setPresence(p: PresenceStyle): void {
    this.presence = p
  }

  clips(): readonly GestureClip[] {
    return this.library
  }

  get(id: string): GestureClip | undefined {
    return this.library.find((c) => c.id === id)
  }

  recent(): string[] {
    return [...this.history]
  }

  /** Preferred expansiveness: composed presence wants small gestures, arousal widens them a little. */
  targetEnergy(arousal = 0): number {
    const a01 = (clampFinite(arousal, -1, 1, 0) + 1) / 2
    return clamp((1 - this.presence.gestureEconomy) * 0.6 + a01 * 0.25 + 0.1, 0.05, 1)
  }

  /** The weight a clip would have right now (0 when it is not allowed). Exposed for tests and tuning. */
  weightOf(clip: GestureClip, req: GesturePickRequest, now: number): number {
    if (!clip.contexts.includes(req.context)) return 0
    if (clip.emotions && req.emotion && !clip.emotions.includes(req.emotion)) return 0
    if (req.tags && req.tags.length > 0 && !req.tags.some((t) => clip.tags.includes(t))) return 0
    const used = this.lastUsed.get(clip.id)
    if (used !== undefined && now - used < clip.cooldownMs) return 0
    const target = this.targetEnergy(req.arousal)
    const fit = Math.exp(-(((clip.energy - target) / 0.3) ** 2))
    let w = clip.weight * (0.15 + 0.85 * fit)
    if (clip.grounded) w *= 1 + this.presence.athleticism * 0.8
    if (clip.tags.includes('authority')) w *= 1 + this.presence.uprightness * 0.5
    // recent-history window: the same clip again is strongly discouraged, a clip sharing a tag mildly
    for (let i = 0; i < this.history.length; i++) {
      const prev = this.library.find((c) => c.id === this.history[i])
      if (!prev) continue
      const recency = 1 - i / (this.historySize + 1)
      if (prev.id === clip.id) w *= 1 - 0.9 * recency
      else if (prev.tags.some((t) => clip.tags.includes(t))) w *= 1 - 0.45 * recency
    }
    return w
  }

  /** Choose a gesture for the context, or undefined if nothing is allowed. Records the choice. */
  pick(req: GesturePickRequest, now: number): GestureClip | undefined {
    const weights = new Map<string, number>()
    for (const c of this.library) weights.set(c.id, this.weightOf(c, req, now))
    // never the same clip twice in a row while there is anything else to do
    const last = this.history[0]
    if (last && (weights.get(last) ?? 0) > 0 && this.library.some((c) => c.id !== last && (weights.get(c.id) ?? 0) > 0)) weights.set(last, 0)
    const clip = this.opts.rng.weighted(this.library, (c) => weights.get(c.id) ?? 0)
    if (clip) this.record(clip.id, now)
    return clip
  }

  record(id: string, now: number): void {
    this.lastUsed.set(id, now)
    this.history = [id, ...this.history].slice(0, this.historySize)
  }

  /** Intensity for a clip, shaped by presence (economical presence is subtler) and arousal. */
  intensityFor(arousal = 0, requested?: number): number {
    const a01 = (clampFinite(arousal, -1, 1, 0) + 1) / 2
    const base = requested ?? 0.3 + 0.4 * a01
    return Math.round(clamp(base * (1 - 0.25 * this.presence.gestureEconomy), 0.15, 1) * 100) / 100
  }
}
