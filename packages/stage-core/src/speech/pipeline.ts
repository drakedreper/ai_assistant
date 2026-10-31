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
 */
import { Emotion } from '@ai-assistant/shared'
import type { Emotion as EmotionT, StageEvent, VoiceProfile } from '@ai-assistant/shared'
import type { Clock, TimerHandle, Timers } from '../util/clock'
import type { IdGenerator } from '../util/ids'
import type { CommandDraft } from '../util/commands'
import { fail, ok } from '../util/result'
import type { Result } from '../util/result'
import { clamp } from '../util/math'
import { AUDIO_SAMPLE_RATE, FACE_FPS, MAX_AUDIO_PAYLOAD_BYTES, encodeAudioFrame, encodeFaceFrame, pcmBytes } from '../protocol/frames'
import type { CommandResult, SendOptions } from '../protocol/session'
import type { FaceProvider } from './face'
import type { TtsProvider } from './tts'
import { resampleS16 } from './tts'

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
    this.lookahead = o.lookaheadMs ?? 250
    this.chunkMs = o.chunkMs ?? 20
    this.faceBatch = Math.max(1, Math.floor(o.faceBatch ?? 1))
    this.startDelay = o.startDelayMs ?? 120
    this.gap = o.gapMs ?? 140
    this.poll = o.pollMs ?? 10
    this.maxQueued = o.maxQueued ?? 32
    this.staleFace = o.staleFaceMs ?? 150
    this.watchdogMs = o.watchdogMs ?? 3000
    this.announceAhead = o.announceAheadMs ?? 1500
  }

  // ----------------------------------------------------------------------------------------------- input

  /** Queue one sentence. Returns at once with the id of the utterance it will become. */
  enqueue(sentence: SpeechSentence): Result<{ utteranceId: string }> {
    const text = typeof sentence?.text === 'string' ? sentence.text.replace(/\s+/g, ' ').trim() : ''
    if (text.length === 0) return fail('empty', 'nothing to say')
    if (!Emotion.safeParse(sentence.emotion).success) return fail('invalid_emotion', 'emotion is not in the closed vocabulary')
    if (this.pending.length >= this.maxQueued) return fail('queue_full', 'too many sentences waiting')
    const id = this.o.newId('utt')
    this.pending.push({ id, sentence: { text: text.slice(0, MAX_TEXT), emotion: sentence.emotion }, epoch: this.epoch })
    this.o.onEvent?.({ type: 'queued', utteranceId: id, text })
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

  private async runSynth(): Promise<void> {
    if (this.synthRunning) return
    this.synthRunning = true
    try {
      while (this.pending.length > 0 && this.ready.length < 2) {
        const item = this.pending.shift()!
        if (item.epoch !== this.epoch) continue
        const ac = new AbortController()
        this.abort = ac
        let pcm: Int16Array
        try {
          const r = await this.o.tts.synthesize({ text: item.sentence.text, voice: this.voice(), emotion: item.sentence.emotion, sampleRate: AUDIO_SAMPLE_RATE, signal: ac.signal })
          if (item.epoch !== this.epoch) continue
          const samples = r.pcm instanceof Int16Array ? r.pcm : new Int16Array(r.pcm)
          if (!Number.isFinite(r.sampleRate) || r.sampleRate < 4000 || r.sampleRate > 192_000 || samples.length === 0) throw new Error('tts returned unusable audio')
          pcm = resampleS16(samples, r.sampleRate, AUDIO_SAMPLE_RATE)
        } catch (e) {
          if (item.epoch !== this.epoch) continue
          this.counters.synthFailures++
          this.o.onEvent?.({ type: 'failed', utteranceId: item.id, reason: `tts: ${(e as Error).message}`.slice(0, 160) })
          continue
        } finally {
          if (this.abort === ac) this.abort = undefined
        }
        const durationMs = (pcm.length / AUDIO_SAMPLE_RATE) * 1000
        let face: Float32Array[] | undefined
        if (this.faceFromBackend()) {
          try {
            face = await this.o.face!.frames({ pcm, sampleRate: AUDIO_SAMPLE_RATE, fps: FACE_FPS, emotion: item.sentence.emotion, intensity: this.intensity(item.sentence), utteranceId: item.id })
            if (item.epoch !== this.epoch) continue
          } catch {
            face = undefined // no face is better than no voice
          }
        }
        this.ready.push({ ...item, pcm, durationMs, face })
        void this.runPlay()
      }
    } finally {
      this.synthRunning = false
    }
    this.checkIdle()
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
        if (this.ready[0]!.epoch !== this.epoch) {
          this.ready.shift()
          continue
        }
        // announce the next sentence only when the current one is nearly done
        const wait = this.cursor > 0 ? this.cursor - this.o.sink.stageNow() - this.announceAhead : 0
        if (wait > 0) {
          if (this.playTimer === undefined) {
            this.playTimer = this.o.timers.setTimeout(() => {
              this.playTimer = undefined
              void this.runPlay()
            }, Math.ceil(wait))
          }
          break
        }
        const item = this.ready.shift()!
        const now = this.o.sink.stageNow()
        const startAt = Math.max(now + this.startDelay, this.cursor > 0 ? this.cursor + this.gap : 0)
        const u: Utterance = { id: item.id, epoch: item.epoch, startAt, endAt: startAt + item.durationMs, durationMs: item.durationMs, announced: true, started: false, ended: false, audioSentMs: 0, watchdog: undefined }
        this.utterances.set(u.id, u)
        this.cursor = u.endAt
        this.counters.utterances++
        const faceSource: 'stage' | 'backend' = item.face ? 'backend' : 'stage'
        const res = await this.o.sink.send(
          {
            type: 'perform.speak',
            utteranceId: u.id,
            text: item.sentence.text,
            emotion: item.sentence.emotion,
            emotionTimeline: this.emotionTimeline(item.sentence, item.durationMs),
            audio: { format: 'pcm_s16le', sampleRate: AUDIO_SAMPLE_RATE, channels: 1, totalMs: Math.round(item.durationMs * 100) / 100 },
            faceSource,
            atMs: startAt,
          },
          { ack: true },
        )
        if (!res.ok) {
          this.utterances.delete(u.id)
          this.cursor = Math.min(this.cursor, startAt)
          this.o.onEvent?.({ type: 'failed', utteranceId: u.id, reason: `speak refused: ${res.reason ?? 'unknown'}`.slice(0, 160) })
          void this.runSynth()
          continue
        }
        if (item.epoch !== this.epoch || u.ended) {
          // cancelled while the stage was acknowledging; cancel() already told it to stop
          continue
        }
        this.o.onEvent?.({ type: 'announced', utteranceId: u.id, startAtMs: startAt, durationMs: item.durationMs })
        this.queueFrames(u, item)
        u.watchdog = this.o.timers.setTimeout(() => this.finishUtterance(u.id, false, 'timeout waiting for speak.ended'), Math.max(0, u.endAt + this.watchdogMs - this.o.sink.stageNow()))
        this.pump()
        void this.runSynth()
      }
    } finally {
      this.playRunning = false
      this.checkIdle()
    }
  }

  private queueFrames(u: Utterance, item: ReadyItem): void {
    const out: Out[] = []
    const samplesPerChunk = Math.round((AUDIO_SAMPLE_RATE * this.chunkMs) / 1000)
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
    // merge into the outbox keeping time order (stable: audio before face at equal times)
    this.outbox = [...this.outbox, ...out].sort((a, b) => a.tStart - b.tStart || (a.kind === b.kind ? 0 : a.kind === 'audio' ? -1 : 1))
  }

  /** Release every frame that is due (within the lookahead), respecting back-pressure; then schedule the next release. */
  private pump(): void {
    if (this.pumpTimer !== undefined) {
      this.o.timers.clearTimeout(this.pumpTimer)
      this.pumpTimer = undefined
    }
    let wait: number | undefined
    for (;;) {
      const next = this.outbox[0]
      if (!next) break
      const now = this.o.sink.stageNow()
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
    if (wait !== undefined) this.pumpTimer = this.o.timers.setTimeout(() => this.pump(), Math.max(1, Math.ceil(wait)))
  }

  // ------------------------------------------------------------------------------------------- stage events

  /** Feed the stage's events here (session.onEvent). Only speak.started and speak.ended matter. */
  handleStageEvent(ev: StageEvent): void {
    if (ev.type === 'speak.started') {
      const u = this.utterances.get(ev.utteranceId)
      if (u && !u.started) {
        u.started = true
        this.o.onEvent?.({ type: 'started', utteranceId: u.id, stageMs: ev.stageMs })
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
    this.o.onEvent?.({ type: 'ended', utteranceId: id, interrupted, ...(reason ? { reason } : {}) })
    this.checkIdle()
  }

  // -------------------------------------------------------------------------------------------------- cancel

  /** Barge-in: stop speaking now. Safe to call at any time, including when nothing is playing. */
  async cancel(opts: { fadeMs?: number } = {}): Promise<CancelReport> {
    const fadeMs = opts.fadeMs ?? 120
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
      sends.push(this.o.sink.send({ type: 'perform.cancel', utteranceId: u.id, fadeMs }, { ack: true }))
    }
    this.cursor = 0
    const results = await Promise.all(sends)
    // the stage reports speak.ended(interrupted) itself; if it never does the watchdog or this fallback closes the books
    for (const u of live) if (!u.ended) this.finishUtterance(u.id, true, 'cancelled')
    const report: CancelReport = { cancelled, droppedSentences, droppedChunks, droppedAudioMs: Math.round(droppedAudioMs * 100) / 100, sentAudioMs: Math.round(sentAudioMs * 100) / 100, acknowledged: results.filter((r) => r.ok).length }
    this.o.onEvent?.({ type: 'cancelled', report })
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

export function createSpeechPipeline(opts: SpeechPipelineOptions): SpeechPipeline {
  return new SpeechPipeline(opts)
}
