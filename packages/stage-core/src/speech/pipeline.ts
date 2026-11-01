/**
 * SpeechPipeline: the assistant's text stream, already split into tag-stripped sentences with an emotion
 * ({ text, emotion }; this package does NOT import agent-core), becomes a lip-synced performance on the stage.
 *
 * Per sentence (one utterance each):
 *   1. TTS (a TtsProvider) -> PCM, resampled to 24 kHz mono when the provider answers with another rate;
 *   2. an emotion timeline for the utterance (the sentence's emotion, tapered on long sentences);
 *   3. when the face comes from the backend (faceSource 'backend'): ARKit frames at 30 fps from a FaceProvider;
 *   4. `perform.speak` first, then ~20 ms audio chunks and face frames as binary frames, each stamped with its time on
 *      the STAGE clock, in order.
 *
 * Timing and flow control:
 *   - the next sentence is synthesised while the current one plays (a small prefetch), and starts right after it plus a
 *     natural gap, or as soon as it is ready when TTS is slower than speech;
 *   - frames are released LOOKAHEAD ms ahead of their playback time (not all at once), so a barge-in has little to drop;
 *   - back-pressure: when the session reports a congested transport, sending waits (polling) and ordering is kept;
 *     audio is never dropped, stale face frames (already late) are;
 *   - BARGE-IN: cancel() aborts TTS, drops queued sentences and unsent frames, sends perform.cancel for everything the
 *     stage was told about, and returns a report of what was dropped.
 * Everything runs on the injected clock/timers; nothing blocks on real time.
 *
 * PROVIDERS ARE NOT TRUSTED. A TTS or face provider can hang, ignore its AbortSignal, throw, or answer in the wrong shape:
 *   - every synthesis (and every face call) is raced against a timeout (`synthTimeoutMs`, `faceTimeoutMs`, on the injected
 *     timers) AND against the barge-in signal, so a provider that never settles cannot wedge the pipeline and `cancel()`
 *     frees a stuck synthesis at once (a provider that settles later is ignored, never an unhandled rejection);
 *   - the audio must be a non-empty run of samples at a sane rate and length; the face must be a list of 52-float frames of
 *     a plausible count: anything else drops the FACE (the stage animates from the audio itself) and keeps the voice;
 *   - everything that can throw is built BEFORE the utterance is announced, so a failure never leaves the stage waiting for
 *     audio that will not come, and no failure escapes as an unhandled rejection.
 * Spoken text is cleaned (control characters and lone surrogates dropped) and cut on a code-point boundary, never in the
 * middle of a surrogate pair. Options are clamped (a `chunkMs` of 0 or NaN means the default, not a crash). Times on the
 * stage clock are never negative and timers never wait longer than a minute at a time. When the session reports that the
 * stage clock JUMPED (a restart, a reset), the time everything was planned in no longer exists: the frames and the cursor are
 * dropped and what was announced is cancelled, and the next sentence is planned on the new clock.
 */
import { Emotion } from '@ai-assistant/shared'
import type { Emotion as EmotionT, StageEvent, VoiceProfile } from '@ai-assistant/shared'
import type { Clock, TimerHandle, Timers } from '../util/clock'
import type { IdGenerator } from '../util/ids'
import type { CommandDraft } from '../util/commands'
import { fail, ok } from '../util/result'
import type { Result } from '../util/result'
import { clamp, clampFinite } from '../util/math'
import { ARKIT_COUNT, AUDIO_SAMPLE_RATE, FACE_FPS, MAX_AUDIO_PAYLOAD_BYTES, MAX_FACE_FRAMES_PER_MESSAGE, encodeAudioFrame, encodeFaceFrame, pcmBytes } from '../protocol/frames'
import type { CommandResult, SendOptions } from '../protocol/session'
import type { FaceProvider } from './face'
import type { TtsProvider } from './tts'
import { TtsAbortError, resampleS16 } from './tts'

export interface SpeechSentence {
  text: string
  emotion: EmotionT
}

/** What the pipeline needs from the connection: StageSession satisfies it. */
export interface SpeechSink {
  send(cmd: CommandDraft, opts?: SendOptions): Promise<CommandResult>
  sendBinary(bytes: Uint8Array): boolean
  canSendBinary(): boolean
  stageNow(): number
  faceSource(): 'stage' | 'backend'
  /** Optional: counts the times the stage clock jumped (StageSession has it). Without it the pipeline cannot notice a reset. */
  clockEpoch?(): number
}

export type PipelineEvent =
  | { type: 'queued'; utteranceId: string; text: string }
  | { type: 'announced'; utteranceId: string; startAtMs: number; durationMs: number }
  | { type: 'started'; utteranceId: string; stageMs: number }
  | { type: 'ended'; utteranceId: string; interrupted: boolean; reason?: string }
  | { type: 'failed'; utteranceId: string; reason: string }
  | { type: 'cancelled'; report: CancelReport }

export interface CancelReport {
  /** Utterances the stage had been told about and was told to stop. */
  cancelled: string[]
  /** Sentences never synthesised or never announced. */
  droppedSentences: number
  /** Binary frames that were queued but not yet sent. */
  droppedChunks: number
  droppedAudioMs: number
  /** Audio already sent to the stage for the cancelled utterances. */
  sentAudioMs: number
  /** How many perform.cancel the stage acknowledged. */
  acknowledged: number
}

export interface SpeechPipelineOptions {
  sink: SpeechSink
  tts: TtsProvider
  /** Needed only when the stage wants backend face frames. */
  face?: FaceProvider
  voice: VoiceProfile | (() => VoiceProfile)
  clock: Clock
  timers: Timers
  newId: IdGenerator
  /** Binary frames are released this far ahead of their playback time. Default 250 ms. */
  lookaheadMs?: number
  /** Audio chunk length. Default 20 ms. */
  chunkMs?: number
  /** Face frames per binary message. Default 1. */
  faceBatch?: number
  /** Time between "announce" and the first audio sample. Default 120 ms. */
  startDelayMs?: number
  /** Natural gap between two sentences. Default 140 ms. */
  gapMs?: number
  /** Poll interval while the transport is congested. Default 10 ms. */
  pollMs?: number
  /** Sentences waiting for synthesis. Default 32. */
  maxQueued?: number
  /** Face frames later than this behind the stage clock are dropped instead of sent. Default 150 ms. */
  staleFaceMs?: number
  /** Give up waiting for speak.ended this long after the planned end. Default 3000 ms. */
  watchdogMs?: number
  /**
   * The next sentence is announced to the stage only when the previous one has this much left to play, so a barge-in has
   * at most one utterance beyond the current one to take back. Default 1500 ms.
   */
  announceAheadMs?: number
  /** Give up on one TTS call after this long (and free the pipeline). Default 15 s. */
  synthTimeoutMs?: number
  /** Give up on one face call after this long (the utterance then goes out without backend face frames). Default 10 s. */
  faceTimeoutMs?: number
  /** 'auto' follows the session's capabilities. */
  faceSource?: 'auto' | 'stage' | 'backend'
  onEvent?: (e: PipelineEvent) => void
}

export interface PipelineStats {
  utterances: number
  audioChunksSent: number
  faceFramesSent: number
  staleFaceDropped: number
  backPressureWaits: number
  synthFailures: number
  cancels: number
}

interface Item {
  id: string
  sentence: SpeechSentence
  epoch: number
}
interface ReadyItem extends Item {
  pcm: Int16Array
  durationMs: number
  face: Float32Array[] | undefined
}
interface Utterance {
  id: string
  epoch: number
  startAt: number
  endAt: number
  durationMs: number
  announced: boolean
  started: boolean
  ended: boolean
  audioSentMs: number
  watchdog: TimerHandle | undefined
}
interface Out {
  tStart: number
  bytes: Uint8Array
  kind: 'audio' | 'face'
  utteranceId: string
  ms: number
}

const MAX_TEXT = 2000
/** The longest utterance the pipeline will carry: a provider that answers with an hour of audio is broken. */
const MAX_UTTERANCE_SECONDS = 300
/** Timers never wait longer than this at a time (a clock far away would otherwise park a timer for ever, or spin one at 1 ms past 2^31). */
const MAX_WAIT_MS = 60_000

/** Remove control characters (except nothing: whitespace was already collapsed) and lone surrogates, then cut on a code-point boundary. */
function cleanSpeech(text: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\p{Cs}/gu, '')
  if (clean.length <= max) return clean
  let end = max
  const last = clean.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end-- // the cut would split a surrogate pair
  return clean.slice(0, end)
}

export class SpeechPipeline {
  private readonly lookahead: number
  private readonly chunkMs: number
  private readonly faceBatch: number
  private readonly startDelay: number
  private readonly gap: number
  private readonly poll: number
  private readonly maxQueued: number
  private readonly staleFace: number
  private readonly watchdogMs: number
  private readonly announceAhead: number
  private readonly synthTimeoutMs: number
  private readonly faceTimeoutMs: number
  private seenClockEpoch: number

  private pending: Item[] = []
  private ready: ReadyItem[] = []
  private outbox: Out[] = []
  private readonly utterances = new Map<string, Utterance>()
  private epoch = 0
  private abort: AbortController | undefined
  private synthRunning = false
  private playRunning = false
  private cursor = 0 // stage time when the last announced utterance is planned to end
  private pumpTimer: TimerHandle | undefined
  private playTimer: TimerHandle | undefined
  private idleWaiters: Array<() => void> = []
  private readonly counters: PipelineStats = { utterances: 0, audioChunksSent: 0, faceFramesSent: 0, staleFaceDropped: 0, backPressureWaits: 0, synthFailures: 0, cancels: 0 }

  constructor(private readonly o: SpeechPipelineOptions) {
    // options are owner-supplied numbers: NaN, zero, negatives and absurd values are clamped, never allowed to crash a play loop
    this.lookahead = clampFinite(o.lookaheadMs ?? 250, 0, 5000, 250)
    this.chunkMs = clampFinite(o.chunkMs ?? 20, 5, 500, 20)
    this.faceBatch = clampFinite(Math.floor(o.faceBatch ?? 1), 1, MAX_FACE_FRAMES_PER_MESSAGE, 1)
    this.startDelay = clampFinite(o.startDelayMs ?? 120, 0, 10_000, 120)
    this.gap = clampFinite(o.gapMs ?? 140, 0, 10_000, 140)
    this.poll = clampFinite(o.pollMs ?? 10, 1, 1000, 10)
    this.maxQueued = clampFinite(Math.floor(o.maxQueued ?? 32), 1, 1000, 32)
    this.staleFace = clampFinite(o.staleFaceMs ?? 150, 0, 5000, 150)
    this.watchdogMs = clampFinite(o.watchdogMs ?? 3000, 100, 600_000, 3000)
    this.announceAhead = clampFinite(o.announceAheadMs ?? 1500, 0, 10_000, 1500)
    this.synthTimeoutMs = clampFinite(o.synthTimeoutMs ?? 15_000, 10, 600_000, 15_000)
    this.faceTimeoutMs = clampFinite(o.faceTimeoutMs ?? 10_000, 10, 600_000, 10_000)
    this.seenClockEpoch = this.sinkEpoch()
  }

  /** The stage time now: finite and never negative (a hostile or restarted clock cannot make a frame unencodable). */
  private stageNow(): number {
    const t = this.o.sink.stageNow()
    return Number.isFinite(t) ? Math.max(0, t) : 0
  }

  private sinkEpoch(): number {
    try {
      const e = this.o.sink.clockEpoch?.()
      return typeof e === 'number' && Number.isFinite(e) ? e : 0
    } catch {
      return 0
    }
  }

  /** Has the stage clock jumped since the pipeline last looked? Then everything planned in the old time is meaningless. */
  private checkClock(): void {
    const e = this.sinkEpoch()
    if (e === this.seenClockEpoch) return
    this.seenClockEpoch = e
    this.onClockReset()
  }

  private onClockReset(): void {
    if (this.playTimer !== undefined) {
      this.o.timers.clearTimeout(this.playTimer)
      this.playTimer = undefined
    }
    if (this.pumpTimer !== undefined) {
      this.o.timers.clearTimeout(this.pumpTimer)
      this.pumpTimer = undefined
    }
    this.outbox = []
    this.cursor = 0
    // what the stage was told about is planned in the old clock: tell it to stop, and close the books
    for (const u of [...this.utterances.values()]) {
      if (u.ended) continue
      this.safeSend({ type: 'perform.cancel', utteranceId: u.id, fadeMs: 0 })
      this.finishUtterance(u.id, true, 'the stage clock restarted')
    }
    void this.runPlay()
  }

  /** Fire and forget a command; the sink is documented to never reject, but a custom one might. */
  private safeSend(cmd: CommandDraft, opts: SendOptions = { ack: false }): void {
    try {
      void Promise.resolve(this.o.sink.send(cmd, opts)).catch(() => undefined)
    } catch {
      /* a sink that throws synchronously has nothing more to give */
    }
  }

  /** Run a provider call with a timeout and the barge-in signal. A provider that never settles, or settles after we gave up, is harmless. */
  private guarded<T>(call: (signal: AbortSignal) => Promise<T> | T, timeoutMs: number, what: string): Promise<T> {
    const ac = new AbortController()
    this.abort = ac
    return new Promise<T>((resolve, reject) => {
      let finished = false
      const finish = (fn: () => void): void => {
        if (finished) return
        finished = true
        this.o.timers.clearTimeout(timer)
        ac.signal.removeEventListener('abort', onAbort)
        if (this.abort === ac) this.abort = undefined
        fn()
      }
      const onAbort = (): void => finish(() => reject(new TtsAbortError()))
      const timer = this.o.timers.setTimeout(() => {
        finish(() => reject(new Error(`${what} timed out after ${Math.round(timeoutMs)} ms`)))
        ac.abort() // tell a provider that is listening to stop (the pipeline is no longer waiting)
      }, timeoutMs)
      ac.signal.addEventListener('abort', onAbort, { once: true })
      let p: Promise<T>
      try {
        p = Promise.resolve(call(ac.signal))
      } catch (e) {
        finish(() => reject(e))
        return
      }
      p.then(
        (v) => finish(() => resolve(v)),
        (e) => finish(() => reject(e)),
      )
    })
  }

  // ----------------------------------------------------------------------------------------------- input

  /** Queue one sentence. Returns at once with the id of the utterance it will become. */
  enqueue(sentence: SpeechSentence): Result<{ utteranceId: string }> {
    this.checkClock()
    const raw = typeof sentence?.text === 'string' ? sentence.text.replace(/\s+/g, ' ').trim() : ''
    // control characters and lone surrogates are dropped, and the cut never splits a surrogate pair
    const text = cleanSpeech(raw, MAX_TEXT).trim()
    if (text.length === 0) return fail('empty', 'nothing to say')
    if (!Emotion.safeParse(sentence.emotion).success) return fail('invalid_emotion', 'emotion is not in the closed vocabulary')
    if (this.pending.length >= this.maxQueued) return fail('queue_full', 'too many sentences waiting')
    const id = this.o.newId('utt')
    this.pending.push({ id, sentence: { text, emotion: sentence.emotion }, epoch: this.epoch })
    this.emit({ type: 'queued', utteranceId: id, text })
    void this.runSynth()
    return ok({ utteranceId: id })
  }

  enqueueAll(sentences: Iterable<SpeechSentence>): Array<Result<{ utteranceId: string }>> {
    return [...sentences].map((s) => this.enqueue(s))
  }

  // ------------------------------------------------------------------------------------------- synthesis

  private voice(): VoiceProfile {
    return typeof this.o.voice === 'function' ? this.o.voice() : this.o.voice
  }

  private faceFromBackend(): boolean {
    const mode = this.o.faceSource ?? 'auto'
    const want = mode === 'auto' ? this.o.sink.faceSource() === 'backend' : mode === 'backend'
    return want && !!this.o.face
  }

  private emit(e: PipelineEvent): void {
    try {
      this.o.onEvent?.(e)
    } catch {
      /* an observer that throws must not break the play loop */
    }
  }

  private async runSynth(): Promise<void> {
    if (this.synthRunning) return
    this.synthRunning = true
    try {
      while (this.pending.length > 0 && this.ready.length < 2) {
        const item = this.pending.shift()!
        if (item.epoch !== this.epoch) continue
        let pcm: Int16Array
        try {
          const req = { text: item.sentence.text, voice: this.voice(), emotion: item.sentence.emotion, sampleRate: AUDIO_SAMPLE_RATE }
          const r = await this.guarded((signal) => this.o.tts.synthesize({ ...req, signal }), this.synthTimeoutMs, 'tts')
          if (item.epoch !== this.epoch) continue
          pcm = this.usableAudio(r)
        } catch (e) {
          if (item.epoch !== this.epoch) continue
          this.counters.synthFailures++
          this.emit({ type: 'failed', utteranceId: item.id, reason: `tts: ${errorMessage(e)}`.slice(0, 160) })
          continue
        }
        const durationMs = (pcm.length / AUDIO_SAMPLE_RATE) * 1000
        let face: Float32Array[] | undefined
        if (this.faceFromBackend()) {
          try {
            const frames = await this.guarded(() => this.o.face!.frames({ pcm, sampleRate: AUDIO_SAMPLE_RATE, fps: FACE_FPS, emotion: item.sentence.emotion, intensity: this.intensity(item.sentence), utteranceId: item.id }), this.faceTimeoutMs, 'face')
            if (item.epoch !== this.epoch) continue
            face = sanitizeFaceFrames(frames, durationMs) // a provider answering in the wrong shape loses its face, not the voice
          } catch {
            if (item.epoch !== this.epoch) continue
            face = undefined // no face is better than no voice
          }
        }
        this.ready.push({ ...item, pcm, durationMs, face })
        void this.runPlay()
      }
    } catch (e) {
      // nothing in the loop above should throw; if something does, the pipeline must still be usable and nothing may escape
      this.counters.synthFailures++
      this.emit({ type: 'failed', utteranceId: 'pipeline', reason: `synthesis loop: ${errorMessage(e)}`.slice(0, 160) })
    } finally {
      this.synthRunning = false
    }
    this.checkIdle()
  }

  /** The audio of a TTS answer as 24 kHz samples, or a thrown error naming what is wrong with it. */
  private usableAudio(r: unknown): Int16Array {
    if (r === null || typeof r !== 'object') throw new Error('tts returned no audio')
    const { pcm, sampleRate } = r as { pcm?: unknown; sampleRate?: unknown }
    if (typeof sampleRate !== 'number' || !Number.isFinite(sampleRate) || sampleRate < 4000 || sampleRate > 192_000) throw new Error('tts returned an unusable sample rate')
    let samples: Int16Array
    if (pcm instanceof Int16Array) samples = pcm
    else if (Array.isArray(pcm) || ArrayBuffer.isView(pcm)) samples = new Int16Array(pcm as ArrayLike<number>)
    else throw new Error('tts returned audio that is not samples')
    if (samples.length === 0) throw new Error('tts returned no audio')
    if (samples.length / sampleRate > MAX_UTTERANCE_SECONDS) throw new Error('tts returned far more audio than the text can need')
    return resampleS16(samples, sampleRate, AUDIO_SAMPLE_RATE)
  }

  private intensity(s: SpeechSentence): number {
    if (s.emotion === 'neutral') return 0.35
    if (/!\s*$/.test(s.text)) return 0.9
    if (/\?\s*$/.test(s.text)) return 0.6
    return 0.7
  }

  /** The emotion changes inside the utterance, as offsets from its start. */
  private emotionTimeline(s: SpeechSentence, durationMs: number): Array<{ tMs: number; emotion: EmotionT; intensity: number }> {
    const i = this.intensity(s)
    const tl = [{ tMs: 0, emotion: s.emotion, intensity: i }]
    if (s.emotion !== 'neutral' && durationMs > 3500) tl.push({ tMs: Math.round(durationMs * 0.7), emotion: s.emotion, intensity: Math.round(i * 0.7 * 100) / 100 })
    return tl
  }

  // ---------------------------------------------------------------------------------------------- playback

  private async runPlay(): Promise<void> {
    if (this.playRunning) return
    this.playRunning = true
    try {
      while (this.ready.length > 0) {
        this.checkClock()
        if (this.ready[0]!.epoch !== this.epoch) {
          this.ready.shift()
          continue
        }
        // announce the next sentence only when the current one is nearly done
        const wait = this.cursor > 0 ? this.cursor - this.stageNow() - this.announceAhead : 0
        if (wait > 0) {
          if (this.playTimer === undefined) {
            this.playTimer = this.o.timers.setTimeout(() => {
              this.playTimer = undefined
              void this.runPlay()
            }, Math.max(1, Math.ceil(Math.min(wait, MAX_WAIT_MS))))
          }
          break
        }
        const item = this.ready.shift()!
        const now = this.stageNow()
        const startAt = Math.max(now + this.startDelay, this.cursor > 0 ? this.cursor + this.gap : 0)
        const u: Utterance = { id: item.id, epoch: item.epoch, startAt, endAt: startAt + item.durationMs, durationMs: item.durationMs, announced: true, started: false, ended: false, audioSentMs: 0, watchdog: undefined }
        // Everything that can throw is built BEFORE the stage hears about the utterance: a failure here leaves nothing announced.
        let frames: Out[]
        try {
          frames = this.buildFrames(u, item)
        } catch (e) {
          this.counters.synthFailures++
          this.emit({ type: 'failed', utteranceId: u.id, reason: `frames: ${errorMessage(e)}`.slice(0, 160) })
          continue
        }
        this.utterances.set(u.id, u)
        this.cursor = u.endAt
        this.counters.utterances++
        const faceSource: 'stage' | 'backend' = item.face ? 'backend' : 'stage'
        const res = await this.sendSpeak(item, u, faceSource)
        if (!res.ok) {
          this.utterances.delete(u.id)
          this.cursor = Math.min(this.cursor, startAt)
          this.emit({ type: 'failed', utteranceId: u.id, reason: `speak refused: ${res.reason ?? 'unknown'}`.slice(0, 160) })
          void this.runSynth()
          continue
        }
        if (item.epoch !== this.epoch || u.ended) {
          // cancelled while the stage was acknowledging; cancel() already told it to stop
          continue
        }
        this.emit({ type: 'announced', utteranceId: u.id, startAtMs: startAt, durationMs: item.durationMs })
        this.addToOutbox(frames)
        u.watchdog = this.o.timers.setTimeout(() => this.finishUtterance(u.id, false, 'timeout waiting for speak.ended'), Math.max(0, Math.min(MAX_WAIT_MS, u.endAt + this.watchdogMs - this.stageNow())))
        this.pump()
        void this.runSynth()
      }
    } catch (e) {
      // never an unhandled rejection: the loop restarts on the next sentence or timer
      this.emit({ type: 'failed', utteranceId: 'pipeline', reason: `play loop: ${errorMessage(e)}`.slice(0, 160) })
    } finally {
      this.playRunning = false
      this.checkIdle()
    }
  }

  private async sendSpeak(item: ReadyItem, u: Utterance, faceSource: 'stage' | 'backend'): Promise<CommandResult> {
    try {
      return await this.o.sink.send(
        {
          type: 'perform.speak',
          utteranceId: u.id,
          text: item.sentence.text,
          emotion: item.sentence.emotion,
          emotionTimeline: this.emotionTimeline(item.sentence, item.durationMs),
          audio: { format: 'pcm_s16le', sampleRate: AUDIO_SAMPLE_RATE, channels: 1, totalMs: Math.round(item.durationMs * 100) / 100 },
          faceSource,
          atMs: u.startAt,
        },
        { ack: true },
      )
    } catch (e) {
      return { ok: false, reason: errorMessage(e) }
    }
  }

  /** The binary messages of one utterance (audio chunks and face frames), encoded. Throws on a programmer error; never sends anything. */
  private buildFrames(u: Utterance, item: ReadyItem): Out[] {
    const out: Out[] = []
    const samplesPerChunk = Math.max(1, Math.round((AUDIO_SAMPLE_RATE * this.chunkMs) / 1000))
    const maxSamples = MAX_AUDIO_PAYLOAD_BYTES / 2
    const per = Math.min(samplesPerChunk, maxSamples)
    for (let s = 0, j = 0; s < item.pcm.length; s += per, j++) {
      const slice = item.pcm.subarray(s, Math.min(item.pcm.length, s + per))
      const tStart = u.startAt + (s / AUDIO_SAMPLE_RATE) * 1000
      out.push({ tStart, bytes: encodeAudioFrame(u.id, tStart, pcmBytes(slice)), kind: 'audio', utteranceId: u.id, ms: (slice.length / AUDIO_SAMPLE_RATE) * 1000 })
    }
    if (item.face) {
      for (let f = 0; f < item.face.length; f += this.faceBatch) {
        const group = item.face.slice(f, f + this.faceBatch)
        const weights: number[] = []
        for (const fr of group) for (const w of fr) weights.push(Number.isFinite(w) ? clamp(w, 0, 1) : 0)
        const tStart = u.startAt + (f * 1000) / FACE_FPS
        out.push({ tStart, bytes: encodeFaceFrame(u.id, tStart, weights), kind: 'face', utteranceId: u.id, ms: 0 })
      }
    }
    return out
  }

  /** Merge frames into the outbox keeping time order (stable: audio before face at equal times). */
  private addToOutbox(frames: Out[]): void {
    this.outbox = [...this.outbox, ...frames].sort((a, b) => a.tStart - b.tStart || (a.kind === b.kind ? 0 : a.kind === 'audio' ? -1 : 1))
  }

  /** Release every frame that is due (within the lookahead), respecting back-pressure; then schedule the next release. */
  private pump(): void {
    this.checkClock()
    if (this.pumpTimer !== undefined) {
      this.o.timers.clearTimeout(this.pumpTimer)
      this.pumpTimer = undefined
    }
    let wait: number | undefined
    for (;;) {
      const next = this.outbox[0]
      if (!next) break
      const now = this.stageNow()
      const due = next.tStart - this.lookahead
      if (due > now) {
        wait = due - now
        break
      }
      if (next.kind === 'face' && next.tStart < now - this.staleFace) {
        this.outbox.shift()
        this.counters.staleFaceDropped++
        continue
      }
      if (!this.o.sink.canSendBinary()) {
        this.counters.backPressureWaits++
        wait = this.poll
        break
      }
      if (!this.o.sink.sendBinary(next.bytes)) {
        wait = this.poll
        break
      }
      this.outbox.shift()
      const u = this.utterances.get(next.utteranceId)
      if (next.kind === 'audio') {
        this.counters.audioChunksSent++
        if (u) u.audioSentMs += next.ms
      } else this.counters.faceFramesSent += Math.floor((next.bytes.length - 13) / 208)
    }
    if (wait !== undefined) this.pumpTimer = this.o.timers.setTimeout(() => this.pump(), Math.max(1, Math.ceil(Math.min(wait, MAX_WAIT_MS))))
  }

  // ------------------------------------------------------------------------------------------- stage events

  /** Feed the stage's events here (session.onEvent). Only speak.started and speak.ended matter. */
  handleStageEvent(ev: StageEvent): void {
    if (ev.type === 'speak.started') {
      const u = this.utterances.get(ev.utteranceId)
      if (u && !u.started) {
        u.started = true
        this.emit({ type: 'started', utteranceId: u.id, stageMs: ev.stageMs })
      }
    } else if (ev.type === 'speak.ended') {
      this.finishUtterance(ev.utteranceId, ev.interrupted)
    }
  }

  private finishUtterance(id: string, interrupted: boolean, reason?: string): void {
    const u = this.utterances.get(id)
    if (!u || u.ended) return
    u.ended = true
    if (u.watchdog !== undefined) this.o.timers.clearTimeout(u.watchdog)
    // anything of it still queued is pointless now
    this.outbox = this.outbox.filter((o) => o.utteranceId !== id)
    // keep memory bounded in long sessions: only the most recent finished utterances are remembered
    if (this.utterances.size > 64) {
      for (const [k, v] of this.utterances) {
        if (this.utterances.size <= 48) break
        if (v.ended && k !== id) this.utterances.delete(k)
      }
    }
    this.emit({ type: 'ended', utteranceId: id, interrupted, ...(reason ? { reason } : {}) })
    this.checkIdle()
  }

  // -------------------------------------------------------------------------------------------------- cancel

  /** Barge-in: stop speaking now. Safe to call at any time, including when nothing is playing. */
  async cancel(opts: { fadeMs?: number } = {}): Promise<CancelReport> {
    const fadeMs = clampFinite(opts.fadeMs ?? 120, 0, 10_000, 120) // the contract bounds it; a value outside would make the command invalid and the stage would keep talking
    this.counters.cancels++
    this.epoch++
    this.abort?.abort()
    const droppedSentences = this.pending.length + this.ready.length
    this.pending = []
    this.ready = []
    if (this.playTimer !== undefined) {
      this.o.timers.clearTimeout(this.playTimer)
      this.playTimer = undefined
    }
    if (this.pumpTimer !== undefined) {
      this.o.timers.clearTimeout(this.pumpTimer)
      this.pumpTimer = undefined
    }
    let droppedChunks = 0
    let droppedAudioMs = 0
    for (const o of this.outbox) {
      droppedChunks++
      if (o.kind === 'audio') droppedAudioMs += o.ms
    }
    this.outbox = []
    const live = [...this.utterances.values()].filter((u) => !u.ended)
    const cancelled: string[] = []
    let sentAudioMs = 0
    const sends: Array<Promise<CommandResult>> = []
    for (const u of live) {
      cancelled.push(u.id)
      sentAudioMs += u.audioSentMs
      let p: Promise<CommandResult>
      try {
        p = Promise.resolve(this.o.sink.send({ type: 'perform.cancel', utteranceId: u.id, fadeMs }, { ack: true })).catch((e: unknown) => ({ ok: false, reason: errorMessage(e) }))
      } catch (e) {
        p = Promise.resolve({ ok: false, reason: errorMessage(e) })
      }
      sends.push(p)
    }
    this.cursor = 0
    const results = await Promise.all(sends)
    // the stage reports speak.ended(interrupted) itself; if it never does the watchdog or this fallback closes the books
    for (const u of live) if (!u.ended) this.finishUtterance(u.id, true, 'cancelled')
    const report: CancelReport = { cancelled, droppedSentences, droppedChunks, droppedAudioMs: Math.round(droppedAudioMs * 100) / 100, sentAudioMs: Math.round(sentAudioMs * 100) / 100, acknowledged: results.filter((r) => r.ok).length }
    this.emit({ type: 'cancelled', report })
    this.checkIdle()
    return report
  }

  // ---------------------------------------------------------------------------------------------------- state

  isSpeaking(): boolean {
    return [...this.utterances.values()].some((u) => u.started && !u.ended)
  }

  /** Sentences not yet finished (queued, being synthesised, announced and still playing). */
  pendingCount(): number {
    return this.pending.length + this.ready.length + [...this.utterances.values()].filter((u) => !u.ended).length + (this.synthRunning ? 1 : 0)
  }

  stats(): PipelineStats {
    return { ...this.counters }
  }

  /** Frames waiting for their release time. */
  queuedFrames(): number {
    return this.outbox.length
  }

  private isIdle(): boolean {
    return this.pending.length === 0 && this.ready.length === 0 && !this.synthRunning && !this.playRunning && [...this.utterances.values()].every((u) => u.ended)
  }

  private checkIdle(): void {
    if (!this.isIdle()) return
    const waiters = this.idleWaiters
    this.idleWaiters = []
    for (const w of waiters) w()
  }

  /** Resolves when everything queued has been spoken (or cancelled). */
  idle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve()
    return new Promise<void>((resolve) => this.idleWaiters.push(resolve))
  }

  /** Forget finished utterances (keeps memory bounded in long sessions). */
  prune(): void {
    for (const [id, u] of this.utterances) if (u.ended) this.utterances.delete(id)
  }
}

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : typeof e === 'string' ? e : 'unknown error')

/**
 * A face provider's answer as frames the pipeline can send, or undefined when it is not usable: a list of 1.. frames, each
 * 52 numbers, of a count that fits the audio (at most twice what 30 fps needs, plus a second). Weights are clamped into 0..1
 * (a non-finite one becomes 0). Anything else (a frame of 51 floats, a count of a million, not a list) drops the whole face.
 */
export function sanitizeFaceFrames(frames: unknown, durationMs: number): Float32Array[] | undefined {
  if (!Array.isArray(frames) || frames.length === 0) return undefined
  const expected = Math.max(1, Math.ceil((durationMs * FACE_FPS) / 1000))
  if (frames.length > expected * 2 + FACE_FPS) return undefined
  const out: Float32Array[] = []
  for (const fr of frames as unknown[]) {
    if (!(fr instanceof Float32Array) && !Array.isArray(fr)) return undefined
    const f = fr as ArrayLike<unknown>
    if (f.length !== ARKIT_COUNT) return undefined
    const copy = new Float32Array(ARKIT_COUNT)
    for (let i = 0; i < ARKIT_COUNT; i++) {
      const w = f[i]
      copy[i] = typeof w === 'number' && Number.isFinite(w) ? clamp(w, 0, 1) : 0
    }
    out.push(copy)
  }
  return out
}

export function createSpeechPipeline(opts: SpeechPipelineOptions): SpeechPipeline {
  return new SpeechPipeline(opts)
}
