/**
 * TtsProvider: text in, PCM out. The real providers (Kokoro, ElevenLabs, XTTS) live in the daemon; this package only
 * needs the interface and a deterministic FAKE that synthesises silence or a sine "voice" whose duration is
 * proportional to the text length, so the whole speech pipeline can be tested without audio hardware or a network.
 */
import type { Emotion, VoiceProfile } from '@ai-assistant/shared'
import type { Timers } from '../util/clock'
import { clamp } from '../util/math'

export interface TtsRequest {
  text: string
  voice: VoiceProfile
  emotion: Emotion
  /** The sample rate the pipeline wants (24000). A provider may answer with another one; the pipeline resamples. */
  sampleRate: number
  /** Aborted on barge-in: stop work and reject. */
  signal?: AbortSignal
}

export interface TtsResult {
  /** pcm_s16le mono samples. */
  pcm: Int16Array
  sampleRate: number
}

export interface TtsProvider {
  synthesize(req: TtsRequest): Promise<TtsResult>
}

export class TtsAbortError extends Error {
  constructor() {
    super('tts aborted')
    this.name = 'AbortError'
  }
}

export interface FakeTtsOptions {
  /** 'sine' (default) is audible and has speech-like energy; 'silence' is all zeros. */
  mode?: 'sine' | 'silence'
  /** Milliseconds of speech per character at speed 1. Default 62 (about 16 characters a second). */
  msPerChar?: number
  /** Shortest result. Default 250 ms. */
  minMs?: number
  /** Simulated synthesis delay (needs `timers`). Default 0. */
  latencyMs?: number
  timers?: Timers
  /** Throw for texts matching this (failure tests). */
  failWhen?: (text: string) => boolean
  /** Sample rate of the output. Default = the requested one. */
  outputSampleRate?: number
}

const VOWELS = new Set('aeiouyAEIOUYáéíóúàèìòùäëïöüâêîôû')
const SHORT_PAUSE = new Set([',', ';', ':', '-', '–', '—'])
const LONG_PAUSE = new Set(['.', '!', '?', '…', '。', '！', '？'])

/** Per-character speech energy timeline: [durationMs, amplitude 0..1]. Vowels are loud, consonants soft, pauses silent. */
export function speechSegments(text: string, msPerChar: number, speed: number): Array<[number, number]> {
  const segs: Array<[number, number]> = []
  const per = msPerChar / Math.max(0.1, speed)
  for (const ch of text) {
    if (ch === ' ' || ch === '\n' || ch === '\t') segs.push([per * 0.5, 0.02])
    else if (SHORT_PAUSE.has(ch)) segs.push([120 / speed, 0])
    else if (LONG_PAUSE.has(ch)) segs.push([260 / speed, 0])
    else if (VOWELS.has(ch)) segs.push([per * 1.25, 1])
    else if (/\p{L}|\p{N}/u.test(ch)) segs.push([per * 0.75, 0.45])
    else segs.push([per * 0.3, 0])
  }
  return segs
}

export class FakeTtsProvider implements TtsProvider {
  /** Every request seen (for assertions). */
  readonly requests: TtsRequest[] = []
  constructor(private readonly opts: FakeTtsOptions = {}) {}

  /** Duration the fake gives to a text (ms), without synthesising. */
  durationMs(text: string, speed = 1): number {
    const segs = speechSegments(text, this.opts.msPerChar ?? 62, speed)
    const total = segs.reduce((s, [d]) => s + d, 0)
    return Math.max(this.opts.minMs ?? 250, Math.round(total))
  }

  async synthesize(req: TtsRequest): Promise<TtsResult> {
    this.requests.push(req)
    if (req.signal?.aborted) throw new TtsAbortError()
    const lat = this.opts.latencyMs ?? 0
    if (lat > 0) {
      if (!this.opts.timers) throw new Error('FakeTtsProvider: latencyMs needs timers')
      const timers = this.opts.timers
      await new Promise<void>((resolve, reject) => {
        const h = timers.setTimeout(() => resolve(), lat)
        req.signal?.addEventListener('abort', () => {
          timers.clearTimeout(h)
          reject(new TtsAbortError())
        })
      })
    }
    if (req.signal?.aborted) throw new TtsAbortError()
    if (this.opts.failWhen?.(req.text)) throw new Error('simulated tts failure')
    const sr = this.opts.outputSampleRate ?? req.sampleRate
    const speed = clamp(req.voice.speed, 0.5, 2)
    const segs = speechSegments(req.text, this.opts.msPerChar ?? 62, speed)
    const total = this.durationMs(req.text, speed)
    const n = Math.max(1, Math.round((total * sr) / 1000))
    const pcm = new Int16Array(n)
    if ((this.opts.mode ?? 'sine') === 'sine') {
      const hz = 140 * 2 ** (clamp(req.voice.pitchSemitones, -12, 12) / 12)
      let idx = 0
      let phase = 0
      let amp = 0
      const ramp = Math.max(1, Math.round(sr * 0.006))
      for (const [d, a] of segs) {
        const len = Math.round((d * sr) / 1000)
        for (let k = 0; k < len && idx < n; k++, idx++) {
          // smooth the amplitude toward the segment target so there are no clicks
          amp += (a * 0.3 - amp) / ramp
          phase += (2 * Math.PI * hz * (1 + 0.04 * Math.sin(idx / (sr * 0.15)))) / sr
          pcm[idx] = Math.round(Math.sin(phase) * amp * 32767)
        }
      }
    }
    return { pcm, sampleRate: sr }
  }
}

/** Linear resampling of s16 mono PCM. Returns the input when the rates match. */
export function resampleS16(pcm: Int16Array, from: number, to: number): Int16Array {
  if (from === to || pcm.length === 0) return pcm
  const n = Math.max(1, Math.round((pcm.length * to) / from))
  const out = new Int16Array(n)
  const ratio = from / to
  for (let i = 0; i < n; i++) {
    const pos = i * ratio
    const i0 = Math.min(pcm.length - 1, Math.floor(pos))
    const i1 = Math.min(pcm.length - 1, i0 + 1)
    const f = pos - i0
    out[i] = Math.round(pcm[i0]! * (1 - f) + pcm[i1]! * f)
  }
  return out
}
