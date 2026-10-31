/**
 * FaceProvider: audio in, 52 ARKit blendshape weights per 30 fps frame out. A real one wraps Audio2Face-3D or similar;
 * the FAKE derives a plausible face from the audio energy: the jaw follows the loudness, the mouth alternates between
 * funnel, pucker and stretch shapes, the eyes blink on a deterministic schedule, and the emotion adds a soft expression
 * layer. Used when the stage declares faceSource 'backend'. Finite and in 0..1 by construction.
 */
import { ARKIT_52 } from '@ai-assistant/shared'
import type { Emotion } from '@ai-assistant/shared'
import { fnv1a32, createRng } from '../util/rng'
import { clamp } from '../util/math'

export interface FaceRequest {
  pcm: Int16Array
  sampleRate: number
  fps: number
  emotion: Emotion
  /** 0..1 strength of the expression layer. */
  intensity: number
  /** Stable seed for the blink schedule and mouth patterns. */
  utteranceId: string
}

export interface FaceProvider {
  frames(req: FaceRequest): Float32Array[] | Promise<Float32Array[]>
}

const IDX = Object.fromEntries(ARKIT_52.map((n, i) => [n, i])) as Record<(typeof ARKIT_52)[number], number>

const EXPRESSIONS: Record<Emotion, Partial<Record<(typeof ARKIT_52)[number], number>>> = {
  neutral: {},
  happy: { mouthSmileLeft: 0.35, mouthSmileRight: 0.35, cheekSquintLeft: 0.2, cheekSquintRight: 0.2, browInnerUp: 0.1 },
  sad: { mouthFrownLeft: 0.3, mouthFrownRight: 0.3, browInnerUp: 0.45, browDownLeft: 0.1, browDownRight: 0.1 },
  angry: { browDownLeft: 0.55, browDownRight: 0.55, noseSneerLeft: 0.2, noseSneerRight: 0.2, mouthPressLeft: 0.2, mouthPressRight: 0.2, eyeSquintLeft: 0.2, eyeSquintRight: 0.2 },
  relaxed: { mouthSmileLeft: 0.1, mouthSmileRight: 0.1 },
  surprised: { eyeWideLeft: 0.5, eyeWideRight: 0.5, browInnerUp: 0.5, browOuterUpLeft: 0.5, browOuterUpRight: 0.5 },
  shy: { mouthSmileLeft: 0.15, mouthSmileRight: 0.15, eyeLookDownLeft: 0.25, eyeLookDownRight: 0.25, browInnerUp: 0.2 },
  thinking: { eyeLookUpLeft: 0.25, eyeLookUpRight: 0.25, browInnerUp: 0.15, mouthPressLeft: 0.1, mouthPressRight: 0.1 },
}

const BLINK_SHAPE = [0.3, 0.9, 1, 0.8, 0.4, 0.1]

export class FakeFaceProvider implements FaceProvider {
  frames(req: FaceRequest): Float32Array[] {
    const { pcm, sampleRate, fps } = req
    const durationMs = (pcm.length / sampleRate) * 1000
    const count = Math.max(1, Math.ceil((durationMs * fps) / 1000))
    const out: Float32Array[] = []
    const hash = fnv1a32(req.utteranceId)
    const rng = createRng(hash)
    const intensity = clamp(Number.isFinite(req.intensity) ? req.intensity : 0.6, 0, 1)

    // blink schedule: every 2.8 - 5.2 s, six frames long
    const blinkStarts: number[] = []
    let t = rng.range(1.2, 3.2)
    while (t * fps < count) {
      blinkStarts.push(Math.round(t * fps))
      t += rng.range(2.8, 5.2)
    }
    const blinkAt = (i: number): number => {
      for (const s of blinkStarts) if (i >= s && i < s + BLINK_SHAPE.length) return BLINK_SHAPE[i - s]!
      return 0
    }

    const half = Math.max(1, Math.round((sampleRate * 0.0165)))
    let smooth = 0
    const expr = EXPRESSIONS[req.emotion]
    for (let i = 0; i < count; i++) {
      const centre = Math.round(((i * 1000) / fps / 1000) * sampleRate)
      let sum = 0
      let n = 0
      for (let k = Math.max(0, centre - half); k < Math.min(pcm.length, centre + half); k++) {
        const v = pcm[k]! / 32768
        sum += v * v
        n++
      }
      const rms = n > 0 ? Math.sqrt(sum / n) : 0
      const e = clamp(rms * 7, 0, 1)
      smooth += (e - smooth) * (e > smooth ? 0.65 : 0.35) // quick attack, softer release
      const jaw = smooth < 0.03 ? 0 : clamp(0.06 + 0.8 * smooth, 0, 1)

      const f = new Float32Array(ARKIT_52.length)
      f[IDX.jawOpen] = jaw
      f[IDX.mouthLowerDownLeft] = jaw * 0.45
      f[IDX.mouthLowerDownRight] = jaw * 0.45
      f[IDX.mouthUpperUpLeft] = jaw * 0.15
      f[IDX.mouthUpperUpRight] = jaw * 0.15
      if (jaw === 0) f[IDX.mouthClose] = 0.12
      // mouth shape pattern changes every ~4 frames (about 130 ms), chosen deterministically
      const pattern = fnv1a32(`${req.utteranceId}|${Math.floor(i / 4)}`) % 4
      const amt = smooth
      if (pattern === 0) f[IDX.mouthFunnel] = clamp(0.55 * amt, 0, 1)
      else if (pattern === 1) f[IDX.mouthPucker] = clamp(0.5 * amt, 0, 1)
      else if (pattern === 2) {
        f[IDX.mouthStretchLeft] = clamp(0.3 * amt, 0, 1)
        f[IDX.mouthStretchRight] = clamp(0.3 * amt, 0, 1)
      }
      const b = blinkAt(i)
      if (b > 0) {
        f[IDX.eyeBlinkLeft] = b
        f[IDX.eyeBlinkRight] = b
      }
      for (const [name, w] of Object.entries(expr)) {
        const idx = IDX[name as keyof typeof IDX]
        f[idx] = clamp(Math.max(f[idx]!, (w as number) * intensity), 0, 1)
      }
      if (req.emotion === 'surprised') f[IDX.jawOpen] = clamp(f[IDX.jawOpen]! + 0.1 * intensity, 0, 1)
      out.push(f)
    }
    return out
  }
}
