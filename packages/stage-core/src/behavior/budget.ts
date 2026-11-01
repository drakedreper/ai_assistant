/**
 * Interruption budget for UNPROMPTED speech (docs/PERSONA.md section 8): quiet hours, a daily allowance of
 * round(proactivity / 20) proactive utterances (default proactivity 55 -> 3), a minimum gap, and priorities:
 *   P0 urgent  - may interrupt even in quiet hours, but only when it is on the user's own urgent list;
 *   P1 needs you - spoken within the daily budget, never in quiet hours;
 *   P2 FYI     - never spoken unprompted (batched into the briefing).
 * Replies to the user are always allowed (they wake her); the morning briefing is once per day outside quiet hours.
 * A muted assistant speaks nothing at all (text continues elsewhere).
 *
 * A clock that goes BACKWARDS does not lock the budget: the time of the last proactive utterance moves back with it, so the
 * minimum gap is measured from the same moment as before. A time that is not finite is treated as "no time passed".
 */
import type { Clock } from '../util/clock'
import { inQuietHours, localDateKey } from '../util/time'
import type { QuietHoursSpec } from '../util/time'
import { clamp } from '../util/math'

export type UtteranceKind = 'reply' | 'briefing' | 'proactive'
export type UtterancePriority = 'P0' | 'P1' | 'P2'

export interface UtteranceRequest {
  kind: UtteranceKind
  /** Only for proactive. Default P1. */
  priority?: UtterancePriority
  /** P0 only counts when the item is on the user's own urgent list. */
  listedUrgent?: boolean
}

export interface BudgetDecision {
  allowed: boolean
  reason: string
  /** Proactive utterances left today. */
  remainingToday: number
}

export interface InterruptionBudgetOptions {
  clock: Clock
  quietHours?: QuietHoursSpec
  /** 0..100 (persona slider). Default 55. */
  proactivity?: number
  /** Overrides the proactivity-derived daily limit. */
  dailyLimit?: number
  /** Minimum time between proactive utterances. Default 20 minutes. */
  minGapMs?: number
  muted?: boolean
}

export const dailyLimitFor = (proactivity: number): number => Math.max(0, Math.round(clamp(Number.isFinite(proactivity) ? proactivity : 0, 0, 100) / 20))

export class InterruptionBudget {
  private quiet: QuietHoursSpec | undefined
  private limit: number
  private readonly minGapMs: number
  private muted: boolean
  private day = ''
  private used = 0
  private briefingDay = ''
  private lastProactiveAt: number | undefined
  private lastSeen = Number.NEGATIVE_INFINITY

  constructor(private readonly opts: InterruptionBudgetOptions) {
    this.quiet = opts.quietHours
    this.limit = opts.dailyLimit !== undefined ? Math.max(0, Math.floor(opts.dailyLimit)) : dailyLimitFor(opts.proactivity ?? 55)
    this.minGapMs = opts.minGapMs ?? 20 * 60_000
    this.muted = opts.muted ?? false
  }

  /** The clock, checked: a regression shifts what is remembered back with it; a time that is not usable is the last good one. */
  private time(): number {
    const t = this.opts.clock.now()
    if (typeof t !== 'number' || !Number.isFinite(t) || Math.abs(t) > 8.64e15) return Number.isFinite(this.lastSeen) ? this.lastSeen : 0
    if (t < this.lastSeen && this.lastProactiveAt !== undefined) this.lastProactiveAt += t - this.lastSeen
    this.lastSeen = t
    return t
  }

  private roll(now: number): void {
    const k = localDateKey(now)
    if (k !== this.day) {
      this.day = k
      this.used = 0
    }
  }

  setQuietHours(q: QuietHoursSpec | undefined): void {
    this.quiet = q
  }
  setProactivity(p: number): void {
    this.limit = dailyLimitFor(p)
  }
  setMuted(m: boolean): void {
    this.muted = m
  }
  isMuted(): boolean {
    return this.muted
  }
  isQuiet(now = this.time()): boolean {
    return inQuietHours(this.quiet, now)
  }
  remaining(): number {
    this.roll(this.time())
    return Math.max(0, this.limit - this.used)
  }

  /** Ask whether she may speak now. With `commit: false` nothing is consumed (a dry run). */
  request(req: UtteranceRequest, opts: { commit?: boolean } = {}): BudgetDecision {
    const now = this.time()
    this.roll(now)
    const commit = opts.commit !== false
    const deny = (reason: string): BudgetDecision => ({ allowed: false, reason, remainingToday: Math.max(0, this.limit - this.used) })
    const allow = (reason: string): BudgetDecision => ({ allowed: true, reason, remainingToday: Math.max(0, this.limit - this.used) })

    if (this.muted) return deny('muted')
    if (req.kind === 'reply') return allow('reply to the user')

    const quiet = this.isQuiet(now)
    if (req.kind === 'briefing') {
      if (quiet) return deny('quiet hours')
      if (this.briefingDay === this.day) return deny('the briefing was already given today')
      if (commit) this.briefingDay = this.day
      return allow('morning briefing')
    }

    const priority = req.priority ?? 'P1'
    if (priority === 'P2') return deny('FYI items wait for the briefing')
    if (priority === 'P0' && req.listedUrgent === true) return allow('urgent item on the user-defined list')
    // an unlisted P0 is treated as P1
    if (quiet) return deny('quiet hours')
    if (this.used >= this.limit) return deny('daily budget spent')
    if (this.lastProactiveAt !== undefined && now - this.lastProactiveAt < this.minGapMs) return deny('too soon after the last interruption')
    if (commit) {
      this.used++
      this.lastProactiveAt = now
    }
    return { allowed: true, reason: 'within the daily budget', remainingToday: Math.max(0, this.limit - this.used) }
  }
}

export function createInterruptionBudget(opts: InterruptionBudgetOptions): InterruptionBudget {
  return new InterruptionBudget(opts)
}
