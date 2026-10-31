/**
 * CameraDirector: picks the shot from context, and never jitters.
 *   idle -> wide, conversation -> medium, an emotional or important beat -> closeup, reviewing data with the user ->
 *   profile, working in a construct -> over_shoulder, asleep -> wide.
 * Hysteresis: a new desire must persist for `dwellMs` before the camera moves, and the current shot is held for a
 * minimum time. Beats cut in quickly but still respect a short hold. An explicit request (the stage_camera tool or the
 * user) switches at once and pins the shot for a while.
 */
import type { Clock } from '../util/clock'
import { fail, ok } from '../util/result'
import type { Result } from '../util/result'
import type { CommandDraft } from '../util/commands'
import { SHOT_IDS, isShotId } from '../scene/void'
import type { ShotId } from '../scene/void'

export type CameraActivity = 'idle' | 'conversation' | 'reviewing' | 'working' | 'asleep'
export type BeatKind = 'emotional' | 'important'

export interface CameraContext {
  activity: CameraActivity
}

export interface CameraDirectorOptions {
  clock: Clock
  /** Shots the current scene actually has (default: all six). */
  available?: () => readonly string[]
  /** A desire must persist this long before the camera moves. Default 1200 ms. */
  dwellMs?: number
  /** Minimum time on a shot before the next automatic move. Default 6000 ms. */
  minHoldMs?: number
  /** Minimum hold when a beat wants a close-up. Default 2500 ms. */
  beatMinHoldMs?: number
  /** How long a beat keeps the close-up. Default 4500 ms. */
  beatHoldMs?: number
  /** How long an explicit request pins the shot. Default 12000 ms. */
  pinMs?: number
  initial?: string
}

const FALLBACKS: Record<ShotId, readonly ShotId[]> = {
  wide: ['medium'],
  medium: ['wide'],
  closeup: ['medium', 'wide'],
  profile: ['medium', 'wide'],
  back: ['wide', 'medium'],
  over_shoulder: ['medium', 'wide'],
}

const BLEND_MS: Record<ShotId, number> = { wide: 1400, medium: 1000, closeup: 900, profile: 1200, back: 1500, over_shoulder: 1200 }

export class CameraDirector {
  private current: string | undefined
  private since = Number.NEGATIVE_INFINITY
  private pending: { shot: string; since: number } | undefined
  private beatUntil = 0
  private pinnedUntil = 0
  private readonly dwellMs: number
  private readonly minHoldMs: number
  private readonly beatMinHoldMs: number
  private readonly beatHoldMs: number
  private readonly pinMs: number

  constructor(private readonly opts: CameraDirectorOptions) {
    this.dwellMs = opts.dwellMs ?? 1200
    this.minHoldMs = opts.minHoldMs ?? 6000
    this.beatMinHoldMs = opts.beatMinHoldMs ?? 2500
    this.beatHoldMs = opts.beatHoldMs ?? 4500
    this.pinMs = opts.pinMs ?? 12_000
    this.current = opts.initial
  }

  private available(): readonly string[] {
    return this.opts.available?.() ?? SHOT_IDS
  }

  /** The shot that is on screen according to the director (sync it with the scene's active camera at start). */
  currentShot(): string | undefined {
    return this.current
  }

  setCurrent(shot: string, at = this.opts.clock.now()): void {
    this.current = shot
    this.since = at
    this.pending = undefined
  }

  /** Mark an emotional or important beat: the camera moves in for a close-up for a few seconds. */
  noteBeat(_kind: BeatKind, now = this.opts.clock.now()): void {
    this.beatUntil = now + this.beatHoldMs
  }

  /** What the context calls for, resolved against the shots the scene has (no hysteresis). */
  desiredShot(ctx: CameraContext, now = this.opts.clock.now()): string {
    let want: ShotId
    if (ctx.activity === 'asleep') want = 'wide'
    else if (now < this.beatUntil) want = 'closeup'
    else
      switch (ctx.activity) {
        case 'conversation':
          want = 'medium'
          break
        case 'reviewing':
          want = 'profile'
          break
        case 'working':
          want = 'over_shoulder'
          break
        default:
          want = 'wide'
      }
    return this.resolve(want)
  }

  private resolve(want: ShotId): string {
    const have = new Set(this.available())
    if (have.has(want)) return want
    for (const f of FALLBACKS[want]) if (have.has(f)) return f
    return [...have][0] ?? want
  }

  /** Evaluate the context; returns a `scene.camera` command when (and only when) the camera should move. */
  update(ctx: CameraContext, now = this.opts.clock.now()): CommandDraft | undefined {
    const desired = this.desiredShot(ctx, now)
    if (this.current === undefined) return this.switchTo(desired, now, BLEND_MS[desired as ShotId] ?? 1000)
    if (desired === this.current) {
      this.pending = undefined
      return undefined
    }
    if (now < this.pinnedUntil) return undefined
    const beat = desired === 'closeup' && now < this.beatUntil
    if (!this.pending || this.pending.shot !== desired) this.pending = { shot: desired, since: now }
    const dwell = beat ? 0 : this.dwellMs
    // leaving a close-up needs only the short hold: the beat already kept it on screen for a while
    const hold = beat || this.current === 'closeup' ? this.beatMinHoldMs : this.minHoldMs
    if (now - this.pending.since < dwell) return undefined
    if (now - this.since < hold) return undefined
    return this.switchTo(desired, now, BLEND_MS[desired as ShotId] ?? 1000)
  }

  /** Explicit shot (the stage_camera tool, a user request): immediate, and held for a while. */
  request(shot: string, now = this.opts.clock.now()): Result<CommandDraft> {
    if (!isShotId(shot)) return fail('unknown_shot', `unknown shot "${shot}" (shots: ${SHOT_IDS.join(', ')})`)
    if (!this.available().includes(shot)) return fail('unavailable', `this scene has no "${shot}" shot`)
    this.pinnedUntil = now + this.pinMs
    if (shot === this.current) return ok({ type: 'scene.camera', cameraId: shot, blendMs: 0 })
    return ok(this.switchTo(shot, now, BLEND_MS[shot])!)
  }

  private switchTo(shot: string, now: number, blendMs: number): CommandDraft | undefined {
    this.current = shot
    this.since = now
    this.pending = undefined
    return { type: 'scene.camera', cameraId: shot, blendMs }
  }
}

export function createCameraDirector(opts: CameraDirectorOptions): CameraDirector {
  return new CameraDirector(opts)
}
