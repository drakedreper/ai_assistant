/**
 * OutfitDirector: suggests an outfit preset from context (time of day, weather, calendar activity, recent outfits,
 * remembered preferences) with a one-line explanation. It is conservative on purpose:
 *  - a COOLDOWN after any change, so she does not change constantly (the caller can bypass it explicitly);
 *  - an explicit USER choice always wins: it is held for a while and remembered as a preference for that context.
 * Suggestions never apply themselves; the caller applies the preset (cosmetic, low-risk) and reports back.
 */
import type { OutfitPreset } from '@ai-assistant/shared'
import type { Clock } from '../util/clock'
import { timeOfDay as timeOfDayOf } from '../util/time'
import type { TimeOfDay } from '../util/time'
import type { ChangeSource, WardrobeChange } from './service'

export type OutfitActivity = 'work' | 'meeting' | 'relax' | 'sleep' | 'out'
export type OutfitWeather = 'clear' | 'cloudy' | 'rain' | 'snow' | 'cold' | 'hot'

/** "work|morning", "work|*" or "*|night" -> preset id. */
export type OutfitPreferences = Record<string, string>

export interface OutfitContext {
  timeOfDay?: TimeOfDay
  weather?: OutfitWeather
  activity?: OutfitActivity
  /** Preset ids, newest first. Defaults to what the director itself has applied. */
  recentOutfits?: readonly string[]
  /** Defaults to the director's remembered preferences. */
  preferences?: OutfitPreferences
  /** Candidates; defaults to the director's `presets()` getter. */
  presets?: readonly OutfitPreset[]
  /** The preset she wears now (so the director can keep it). */
  currentPresetId?: string
  /** Skip the cooldown (e.g. a meeting starts in five minutes). Never skips an explicit user choice. */
  bypassCooldown?: boolean
}

export interface OutfitSuggestion {
  presetId: string
  /** One line, for her to say or for the log. */
  explanation: string
  /** False when the suggestion is "keep what she wears". */
  changed: boolean
  score: number
}

export interface OutfitDirectorOptions {
  clock: Clock
  /** Candidate presets (typically wardrobe.applicablePresets(characterId)). */
  presets?: () => readonly OutfitPreset[]
  currentPresetId?: () => string | undefined
  /** Minimum time between director-initiated changes. Default 90 minutes. */
  minHoldMs?: number
  /** How long an explicit user choice is held. Default 3 hours. */
  userHoldMs?: number
}

export interface OutfitDirectorState {
  lastChangeAt?: number
  history: string[]
  preferences: OutfitPreferences
  userLock?: { presetId?: string; until: number }
}

const ACTIVITY_PHRASE: Record<OutfitActivity, string> = {
  work: "it's a work block",
  meeting: 'you have a meeting',
  relax: 'you are winding down',
  sleep: "it's time to rest",
  out: "you're heading out",
}
const WEATHER_PHRASE: Record<OutfitWeather, string> = {
  clear: "it's clear out",
  cloudy: "it's overcast",
  rain: "it's raining",
  snow: "it's snowing",
  cold: "it's cold out",
  hot: "it's hot out",
}

export class OutfitDirector {
  private readonly minHoldMs: number
  private readonly userHoldMs: number
  private lastChangeAt: number | undefined
  private history: string[] = []
  private prefs: OutfitPreferences = {}
  private userLock: { presetId?: string; until: number } | undefined

  constructor(private readonly opts: OutfitDirectorOptions) {
    this.minHoldMs = opts.minHoldMs ?? 90 * 60_000
    this.userHoldMs = opts.userHoldMs ?? 3 * 3_600_000
  }

  /** Feed wardrobe changes here (WardrobeDeps.onChange). Records history, cooldown and, for the user, a preference. */
  handleChange(change: WardrobeChange, context: Pick<OutfitContext, 'activity' | 'timeOfDay'> = {}): void {
    if (change.presetId) this.noteApplied(change.presetId, change.source, context)
    else {
      // an item-level change still resets the cooldown and, if the user made it, holds it
      this.lastChangeAt = this.opts.clock.now()
      if (change.source === 'user') this.userLock = { until: this.lastChangeAt + this.userHoldMs }
    }
  }

  /** A preset was applied. `user` choices are held and remembered; director/assistant ones only start the cooldown. */
  noteApplied(presetId: string, source: ChangeSource, context: Pick<OutfitContext, 'activity' | 'timeOfDay'> = {}): void {
    const now = this.opts.clock.now()
    this.lastChangeAt = now
    this.history = [presetId, ...this.history.filter((h) => h !== presetId)].slice(0, 8)
    if (source === 'user') {
      this.userLock = { presetId, until: now + this.userHoldMs }
      const tod = context.timeOfDay ?? timeOfDayOf(now)
      this.prefs[`${context.activity ?? '*'}|${tod}`] = presetId
    }
  }

  /** Remember a preference explicitly, e.g. "I like this for meetings". */
  setPreference(activity: OutfitActivity | '*', timeOfDay: TimeOfDay | '*', presetId: string): void {
    this.prefs[`${activity}|${timeOfDay}`] = presetId
  }

  preferences(): OutfitPreferences {
    return { ...this.prefs }
  }

  recent(): string[] {
    return [...this.history]
  }

  exportState(): OutfitDirectorState {
    return { ...(this.lastChangeAt !== undefined ? { lastChangeAt: this.lastChangeAt } : {}), history: [...this.history], preferences: { ...this.prefs }, ...(this.userLock ? { userLock: { ...this.userLock } } : {}) }
  }

  importState(s: OutfitDirectorState): void {
    this.lastChangeAt = s.lastChangeAt
    this.history = [...s.history]
    this.prefs = { ...s.preferences }
    this.userLock = s.userLock ? { ...s.userLock } : undefined
  }

  /** Milliseconds until the cooldown ends (0 when a change is allowed). */
  cooldownRemainingMs(): number {
    if (this.lastChangeAt === undefined) return 0
    return Math.max(0, this.lastChangeAt + this.minHoldMs - this.opts.clock.now())
  }

  suggest(context: OutfitContext = {}): OutfitSuggestion | null {
    const now = this.opts.clock.now()
    const presets = [...(context.presets ?? this.opts.presets?.() ?? [])]
    if (presets.length === 0) return null
    const tod = context.timeOfDay ?? timeOfDayOf(now)
    const current = context.currentPresetId ?? this.opts.currentPresetId?.()
    const byId = new Map(presets.map((p) => [p.id, p]))

    // 1. an explicit user choice always wins while it is held
    if (this.userLock && now < this.userLock.until) {
      const locked = this.userLock.presetId ? byId.get(this.userLock.presetId) : (current ? byId.get(current) : undefined)
      if (locked) {
        return { presetId: locked.id, explanation: `Keeping ${locked.name}: you chose it.`, changed: current !== locked.id, score: Number.POSITIVE_INFINITY }
      }
      if (!this.userLock.presetId) return null // the user dressed her by hand: nothing to suggest while that is held
    }

    // 2. score every candidate
    const recent = context.recentOutfits ?? this.history
    const prefs = context.preferences ?? this.prefs
    const scored = presets.map((p) => this.score(p, context, tod, recent, prefs, current))
    scored.sort((a, b) => b.score - a.score || (a.preset.id < b.preset.id ? -1 : 1))
    const best = scored[0]!

    // 3. keep the current look when it is the best, or when the cooldown holds
    const currentPreset = current ? byId.get(current) : undefined
    if (currentPreset && best.preset.id === currentPreset.id) {
      return { presetId: currentPreset.id, explanation: `Keeping ${currentPreset.name}: it still fits.`, changed: false, score: best.score }
    }
    const cooldown = this.cooldownRemainingMs()
    if (cooldown > 0 && !context.bypassCooldown && currentPreset) {
      const mins = Math.ceil(cooldown / 60_000)
      return { presetId: currentPreset.id, explanation: `Keeping ${currentPreset.name}: I changed recently (next change in about ${mins} min).`, changed: false, score: best.score }
    }
    return { presetId: best.preset.id, explanation: `Changing into ${best.preset.name}: ${best.reason}.`, changed: best.preset.id !== current, score: best.score }
  }

  private score(
    p: OutfitPreset,
    ctx: OutfitContext,
    tod: TimeOfDay,
    recent: readonly string[],
    prefs: OutfitPreferences,
    current: string | undefined,
  ): { preset: OutfitPreset; score: number; reason: string } {
    let score = 0
    const why: Array<{ weight: number; text: string }> = []
    const add = (w: number, text?: string): void => {
      score += w
      if (text && w > 0) why.push({ weight: w, text })
    }
    const c = p.context
    if (ctx.activity && c.activity && c.activity.length > 0) {
      if (c.activity.includes(ctx.activity)) add(3, ACTIVITY_PHRASE[ctx.activity])
      else add(-2.5)
    }
    if (c.timeOfDay && c.timeOfDay.length > 0) {
      if (c.timeOfDay.includes(tod)) add(1.5, `it's ${tod === 'day' ? 'daytime' : tod}`)
      else add(-1)
    }
    if (ctx.weather && c.weather && c.weather.length > 0) {
      if (c.weather.includes(ctx.weather)) add(2, WEATHER_PHRASE[ctx.weather])
      else add(-1)
    }
    const keys = [ctx.activity ? `${ctx.activity}|${tod}` : undefined, ctx.activity ? `${ctx.activity}|*` : undefined, `*|${tod}`]
    const weights = [8, 6, 4]
    keys.forEach((k, i) => {
      if (k && prefs[k] === p.id) add(weights[i]!, 'you usually choose it for this')
    })
    const idx = recent.indexOf(p.id)
    if (idx >= 0 && idx < 4) add(-(1.2 - 0.3 * idx))
    if (current === p.id) add(0.75)
    const top = why.sort((a, b) => b.weight - a.weight)[0]
    return { preset: p, score, reason: top ? top.text : 'it fits the moment' }
  }
}

export function createOutfitDirector(opts: OutfitDirectorOptions): OutfitDirector {
  return new OutfitDirector(opts)
}
