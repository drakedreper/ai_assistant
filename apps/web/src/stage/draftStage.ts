import type { Emotion, GazeTarget, StageCapabilities, StageLive } from '@ai-assistant/shared'

/**
 * The DRAFT STAGE: the existing three.js Room as the first, limited stage of the backend. It is NOT an engine stage and
 * does not pretend to be one:
 *
 *  - It declares its capabilities honestly (below): no outfit rendering, no constructs, no audio-to-face, no tracking.
 *  - It is fed from the performance feed the daemon publishes to the dashboards (`stage.live`: her mood, idle profile,
 *    posture and gaze) and not from the stage socket, because a browser cannot send the stage bearer token and the
 *    daemon deliberately refuses the browser cookie on that socket.
 *  - It only sets four things in the Room's store: emotion, its strength, where she looks, and whether she is asleep.
 *    Everything else the Room does (poses from chat, the desk, the bed) stays exactly as it was.
 *
 * Small and isolated on purpose: the pure mapping below is unit-testable, and `createDraftStage` holds the only state.
 */

export const DRAFT_STAGE_CAPABILITIES: StageCapabilities = {
  engine: 'web',
  engineVersion: 'draft room (three.js)',
  rigFamilies: [],
  face: { arkit52: false, visemes: false, audioToFaceOnStage: false },
  render: { strandHair: false, clothSim: false, runtimeAssetLoading: false, embeddedStream: false },
  tracking: { face: false, body: false },
  constructs: [],
  maxCharacters: 1,
}

/** What the draft Room draws, in words, for the Settings card. */
export const DRAFT_STAGE_DRAWS = ['her mood as an expression', 'where she looks (you, the screen, away)', 'asleep when the backend says so'] as const
export const DRAFT_STAGE_DOES_NOT = ['outfits and the wardrobe', 'the cerebral space and its constructs', 'speech audio and lip-sync', 'camera shots', 'head or body tracking'] as const

export type RoomLook = 'user' | 'screen' | 'window' | { x: number; y: number }

export interface RoomPatch {
  emotion: Emotion
  emotionIntensity: number
  lookAt: RoomLook
  asleep: boolean
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

/** Mood label and numbers -> the Room's expression and its strength. A neutral mood shows no expression at all. */
export function moodToExpression(mood: StageLive['mood']): { emotion: Emotion; intensity: number } {
  if (!mood || mood.label === 'neutral') return { emotion: 'neutral', intensity: 0 }
  const lean = Math.max(Math.abs(mood.valence), Math.abs(mood.arousal))
  return { emotion: mood.label, intensity: Math.round(clamp01(0.35 + 0.4 * lean) * 100) / 100 }
}

/** Backend gaze -> the Room's look targets. */
export function gazeToLook(g: GazeTarget | undefined): RoomLook {
  if (!g) return 'user'
  switch (g.kind) {
    case 'user':
      return 'user'
    case 'camera':
    case 'object':
    case 'point':
      return 'screen'
    case 'away':
      return g.direction === 'left' || g.direction === 'right' ? 'window' : { x: 0, y: g.direction === 'up' ? 0.6 : -0.6 }
  }
}

export function liveToRoom(live: StageLive): RoomPatch {
  const { emotion, intensity } = moodToExpression(live.mood)
  return { emotion, emotionIntensity: intensity, lookAt: gazeToLook(live.gaze), asleep: live.idle === 'asleep' || live.posture === 'sleep' }
}

const same = (a: RoomLook, b: RoomLook): boolean => (typeof a === 'string' || typeof b === 'string' ? a === b : a.x === b.x && a.y === b.y)

/**
 * The adapter. `apply` receives only what CHANGED since the last live update (the Room store is not touched for an
 * identical frame) and nothing at all while the stage backend is off.
 */
export function createDraftStage(apply: (patch: Partial<RoomPatch>) => void) {
  let last: RoomPatch | undefined
  return {
    capabilities: DRAFT_STAGE_CAPABILITIES,
    update(live: StageLive): void {
      if (!live.enabled) {
        last = undefined
        return
      }
      const next = liveToRoom(live)
      const patch: Partial<RoomPatch> = {}
      if (!last || last.emotion !== next.emotion || last.emotionIntensity !== next.emotionIntensity) {
        patch.emotion = next.emotion
        patch.emotionIntensity = next.emotionIntensity
      }
      if (!last || !same(last.lookAt, next.lookAt)) patch.lookAt = next.lookAt
      // The Room starts from its own quiet-hours guess: only a CHANGE of the backend's sleep state is applied.
      if ((last && last.asleep !== next.asleep) || (!last && next.asleep)) patch.asleep = next.asleep
      last = next
      if (Object.keys(patch).length > 0) apply(patch)
    },
    reset(): void {
      last = undefined
    },
  }
}
