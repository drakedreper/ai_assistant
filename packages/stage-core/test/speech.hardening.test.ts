import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { StageEvent, VoiceProfile } from '@ai-assistant/shared'
import { FakeFaceProvider, FakeTtsProvider, SpeechPipeline, createSequentialIds, createVirtualTime, decodeFrame, faceFrames, sanitizeFaceFrames } from '../src'
import type { CommandDraft, FaceProvider, PipelineEvent, SpeechSink, TtsProvider, TtsResult } from '../src'
import { T0, lcg } from './helpers'
import { flush } from './rig'

/**
 * Regression tests for the speech findings: a TTS that never settles must not wedge the pipeline and cancel() must free
 * it; a face provider in the wrong shape loses its face but not the voice and leaves nothing announced and stuck; no
 * unhandled rejection can come out of the play loop; the text is cut on a code point; options cannot crash it; a stage
 * clock that jumps is recovered from.
 */

const VOICE: VoiceProfile = { provider: 'kokoro', voiceId: 'v', speed: 1, pitchSemitones: 0 }
const unhandled: unknown[] = []
const onUnhandled = (e: unknown): void => void unhandled.push(e)
beforeEach(() => {
  unhandled.length = 0
  process.on('unhandledRejection', onUnhandled)
})
afterEach(() => {
  process.off('unhandledRejection', onUnhandled)
})

interface Opts {
  tts?: TtsProvider
  face?: FaceProvider | null
  pipeline?: Record<string, unknown>
  sink?: Partial<SpeechSink>
  stageOffset?: () => number
  epoch?: () => number
}

function harness(o: Opts = {}) {
  const vt = createVirtualTime(T0)
  const log: Array<{ kind: 'cmd' | 'audio' | 'face'; cmd?: CommandDraft & { type: string; faceSource?: string; atMs?: number; text?: string }; tStart?: number; payload?: Uint8Array }> = []
  const events: PipelineEvent[] = []
  const stageNow = () => vt.now() + (o.stageOffset?.() ?? 0)
  const sink: SpeechSink = {
    send: async (cmd) => {
      log.push({ kind: 'cmd', cmd: cmd as never })
      return { ok: true }
    },
    sendBinary: (bytes) => {
      const d = decodeFrame(bytes)
      if (!d.ok) throw new Error(`undecodable frame: ${d.error}`)
      log.push({ kind: d.frame.kind === 1 ? 'audio' : 'face', tStart: d.frame.tStartMs, payload: d.frame.payload })
      return true
    },
    canSendBinary: () => true,
    stageNow,
    faceSource: () => 'backend',
    ...(o.epoch ? { clockEpoch: o.epoch } : {}),
    ...(o.sink ?? {}),
  }
  const tts = o.tts ?? new FakeTtsProvider({ mode: 'silence', minMs: 200 })
  const pipeline = new SpeechPipeline({
    sink,
    tts,
    ...(o.face === null ? {} : { face: o.face ?? new FakeFaceProvider() }),
    voice: VOICE,
    clock: vt.clock,
    timers: vt.timers,
    newId: createSequentialIds(),
    onEvent: (e) => events.push(e),
    ...(o.pipeline ?? {}),
  })
  const run = async (ms: number, step = 10) => {
    await flush(20)
    for (let t = 0; t < ms; t += step) {
      vt.advance(step)
      await flush(8)
    }
  }
  const stage = (ev: StageEvent) => pipeline.handleStageEvent(ev)
  const speaks = () => log.filter((l) => l.kind === 'cmd' && l.cmd!.type === 'perform.speak').map((l) => l.cmd!)
  return { vt, pipeline, sink, log, events, run, stage, speaks, stageNow }
}

/** A provider that never settles, and says it will ignore its signal. */
const hangingTts = (): TtsProvider => ({ synthesize: () => new Promise<TtsResult>(() => undefined) })
const silence = (ms: number, rate = 24_000): TtsResult => ({ pcm: new Int16Array(Math.round((ms * rate) / 1000)), sampleRate: rate })

describe('a TTS call that never settles cannot wedge the pipeline (MEDIUM: speech-tts-hang-wedges-pipeline)', () => {
  it('cancel() frees the stuck synthesis at once and the next sentence is spoken (the reported scenario)', async () => {
    let calls = 0
    const tts: TtsProvider = {
      synthesize: (req) => {
        calls++
        return calls === 1 ? new Promise<TtsResult>(() => undefined) : Promise.resolve(silence(300))
      },
    }
    const h = harness({ tts })
    h.pipeline.enqueue({ text: 'this one hangs', emotion: 'neutral' })
    await h.run(500)
    expect(h.pipeline.pendingCount()).toBe(1)
    expect(h.speaks()).toHaveLength(0)
    const report = await h.pipeline.cancel()
    expect(report.droppedSentences).toBe(0)
    await flush(20)
    expect(h.pipeline.pendingCount()).toBe(0) // the stuck synthesis is no longer counted: cancel freed it
    h.pipeline.enqueue({ text: 'and then this one', emotion: 'neutral' })
    await h.run(2000)
    expect(h.speaks()).toHaveLength(1)
    expect(h.speaks()[0]!.text).toBe('and then this one')
    expect(calls).toBe(2)
    expect(unhandled).toEqual([])
  })

  it('without a cancel, the call times out (15 s by default, on the injected timers), is reported, and the queue moves on', async () => {
    let calls = 0
    const tts: TtsProvider = { synthesize: () => (++calls === 1 ? new Promise<TtsResult>(() => undefined) : Promise.resolve(silence(300))) }
    const h = harness({ tts })
    h.pipeline.enqueue({ text: 'hangs', emotion: 'neutral' })
    h.pipeline.enqueue({ text: 'works', emotion: 'neutral' })
    await h.run(14_900, 100)
    expect(h.speaks()).toHaveLength(0)
    await h.run(500, 100)
    const failed = h.events.filter((e) => e.type === 'failed') as Array<{ reason: string }>
    expect(failed).toHaveLength(1)
    expect(failed[0]!.reason).toMatch(/tts: tts timed out after 15000 ms/)
    await h.run(2000, 50)
    expect(h.speaks().map((s) => s.text)).toEqual(['works'])
    expect(h.pipeline.stats().synthFailures).toBe(1)
    expect(unhandled).toEqual([])
  })

  it('the timeout is an option, and a signal-aware provider is told to stop when it fires', async () => {
    let aborted = false
    const tts: TtsProvider = {
      synthesize: (req) =>
        new Promise<TtsResult>((_resolve, reject) => {
          req.signal?.addEventListener('abort', () => {
            aborted = true
            reject(new Error('stopped'))
          })
        }),
    }
    const h = harness({ tts, pipeline: { synthTimeoutMs: 1000 } })
    h.pipeline.enqueue({ text: 'slow', emotion: 'neutral' })
    await h.run(1200, 50)
    expect(aborted).toBe(true)
    expect(h.events.some((e) => e.type === 'failed' && /timed out after 1000 ms/.test(e.reason))).toBe(true)
    expect(unhandled).toEqual([])
  })

  it('a provider that settles AFTER the pipeline gave up (late resolve, late reject) is ignored without a stray rejection', async () => {
    let lateResolve: (r: TtsResult) => void = () => undefined
    let lateReject: (e: Error) => void = () => undefined
    let n = 0
    const tts: TtsProvider = {
      synthesize: () => {
        n++
        return new Promise<TtsResult>((res, rej) => {
          if (n === 1) lateResolve = res
          else if (n === 2) lateReject = rej
          else res(silence(300))
        })
      },
    }
    const h = harness({ tts, pipeline: { synthTimeoutMs: 500 } })
    h.pipeline.enqueue({ text: 'one', emotion: 'neutral' })
    h.pipeline.enqueue({ text: 'two', emotion: 'neutral' })
    h.pipeline.enqueue({ text: 'three', emotion: 'neutral' })
    await h.run(1500, 50)
    lateResolve(silence(300))
    lateReject(new Error('too late'))
    await h.run(2500, 50)
    expect(h.speaks().map((s) => s.text)).toEqual(['three'])
    expect(unhandled).toEqual([])
  })

  it('a provider that throws synchronously, rejects, or returns a non-promise is handled like any failure', async () => {
    const answers: Array<() => unknown> = [
      () => {
        throw new Error('sync boom')
      },
      () => Promise.reject(new Error('async boom')),
      () => silence(300), // not a promise at all
    ]
    let i = 0
    const tts = { synthesize: () => answers[i++]!() } as unknown as TtsProvider
    const h = harness({ tts })
    for (const t of ['a', 'b', 'c']) h.pipeline.enqueue({ text: t, emotion: 'neutral' })
    await h.run(3000, 50)
    expect(h.events.filter((e) => e.type === 'failed')).toHaveLength(2)
    expect(h.speaks().map((s) => s.text)).toEqual(['c'])
    expect(unhandled).toEqual([])
  })

  it('rapid cancel/enqueue cycles with a hanging provider never accumulate stuck work (property)', async () => {
    const r = lcg(9)
    const h = harness({ tts: { synthesize: () => (r() < 0.5 ? new Promise<TtsResult>(() => undefined) : Promise.resolve(silence(200))) } })
    for (let i = 0; i < 60; i++) {
      h.pipeline.enqueue({ text: `s${i}`, emotion: 'neutral' })
      if (r() < 0.6) await h.pipeline.cancel()
      await h.run(40, 20)
    }
    await h.pipeline.cancel()
    await h.run(100, 20)
    expect(h.pipeline.pendingCount()).toBe(0)
    expect(unhandled).toEqual([])
  })
})

describe('a face provider in the wrong shape loses its face, never the voice (MEDIUM: speech-face-provider-bad-shape)', () => {
  const WRONG: Array<[string, () => unknown]> = [
    ['one frame of 51 floats (the reported case)', () => [new Float32Array(51)]],
    ['a frame of 53 floats', () => [new Float32Array(53)]],
    ['a frame of 0 floats', () => [new Float32Array(0)]],
    ['a mix of good and bad frames', () => [new Float32Array(52), new Float32Array(51)]],
    ['an empty list', () => []],
    ['null', () => null],
    ['undefined', () => undefined],
    ['an object', () => ({ frames: [] })],
    ['a string', () => 'frames'],
    ['a list of numbers', () => [1, 2, 3]],
    ['a list of null', () => [null, null]],
    ['a million frames', () => new Array(1_000_000).fill(new Float32Array(52))],
  ]
  it.each(WRONG)('%s: the utterance is announced WITHOUT backend face frames, audio is sent, nothing is stuck', async (_n, frames) => {
    const h = harness({ face: { frames: () => frames() as never } })
    h.pipeline.enqueue({ text: 'a sentence that is long enough to have several frames', emotion: 'neutral' })
    await h.run(800)
    const speak = h.speaks()[0]
    expect(speak?.faceSource).toBe('stage')
    expect(h.log.filter((l) => l.kind === 'audio').length).toBeGreaterThan(2)
    expect(h.log.filter((l) => l.kind === 'face')).toHaveLength(0)
    // the stage plays it and says so: everything finishes
    h.stage({ type: 'speak.started', utteranceId: 'utt_1', stageMs: h.stageNow() })
    h.stage({ type: 'speak.ended', utteranceId: 'utt_1', stageMs: h.stageNow(), interrupted: false })
    await h.run(100)
    expect(h.pipeline.pendingCount()).toBe(0)
    expect(unhandled).toEqual([])
  })

  it('and without the stage ever answering, the watchdog closes the utterance (pendingCount does not stay at 1 for ever)', async () => {
    const h = harness({ face: { frames: () => [new Float32Array(51)] as never } })
    h.pipeline.enqueue({ text: 'no answer from the stage', emotion: 'neutral' })
    await h.run(6000, 50)
    expect(h.pipeline.pendingCount()).toBe(0)
    expect(h.events.some((e) => e.type === 'ended' && e.reason === 'timeout waiting for speak.ended')).toBe(true)
  })

  it('a provider that throws or never answers loses its face the same way', async () => {
    const throwing = harness({ face: { frames: () => { throw new Error('boom') } } })
    throwing.pipeline.enqueue({ text: 'x one', emotion: 'neutral' })
    await throwing.run(800)
    expect(throwing.speaks()[0]?.faceSource).toBe('stage')
    const hanging = harness({ face: { frames: () => new Promise<Float32Array[]>(() => undefined) }, pipeline: { faceTimeoutMs: 500 } })
    hanging.pipeline.enqueue({ text: 'x two', emotion: 'neutral' })
    await hanging.run(1500, 50)
    expect(hanging.speaks()[0]?.faceSource).toBe('stage')
    expect(hanging.log.filter((l) => l.kind === 'audio').length).toBeGreaterThan(0)
    expect(unhandled).toEqual([])
  })

  it('weights outside 0..1 or not finite are clamped (the frames stay usable and decodable)', async () => {
    const wild = (n: number): Float32Array[] =>
      Array.from({ length: n }, () => {
        const f = new Float32Array(52).fill(0.5)
        f[0] = 5
        f[1] = -3
        f[2] = Number.NaN
        f[3] = Number.POSITIVE_INFINITY
        return f
      })
    const h = harness({ face: { frames: () => wild(Math.ceil((300 * 30) / 1000)) } })
    h.pipeline.enqueue({ text: 'hello', emotion: 'neutral' })
    await h.run(1500)
    expect(h.speaks()[0]?.faceSource).toBe('backend')
    const faces = h.log.filter((l) => l.kind === 'face')
    expect(faces.length).toBeGreaterThan(0)
    for (const f of faces) for (const fr of faceFrames(f.payload!)) {
      expect(fr[0]).toBe(1) // 5 is clamped to 1, -3 to 0, NaN and Infinity to 0
      expect(fr[1]).toBe(0)
      expect(fr[2]).toBe(0)
      expect(fr[3]).toBe(0) // not finite: becomes 0 (the pipeline never guesses a direction for it)
      expect(fr[4]).toBeCloseTo(0.5, 5)
    }
    expect(unhandled).toEqual([])
  })

  it('sanitizeFaceFrames: examples (counts, shapes, plain arrays)', () => {
    const good = Array.from({ length: 9 }, () => new Float32Array(52))
    expect(sanitizeFaceFrames(good, 300)).toHaveLength(9)
    expect(sanitizeFaceFrames(good.map((g) => [...g]), 300)).toHaveLength(9) // plain arrays of 52 numbers are accepted and copied
    expect(sanitizeFaceFrames(good, 3000)).toHaveLength(9) // fewer frames than the audio needs is fine (the stage holds the last)
    expect(sanitizeFaceFrames(new Array(500).fill(new Float32Array(52)), 300)).toBeUndefined() // far more than 30 fps can need for 300 ms
    expect(sanitizeFaceFrames([], 300)).toBeUndefined()
    expect(sanitizeFaceFrames(null, 300)).toBeUndefined()
    expect(sanitizeFaceFrames([new Float32Array(52), 'x'], 300)).toBeUndefined()
    const copy = sanitizeFaceFrames(good, 300)!
    expect(copy[0]).not.toBe(good[0]) // a copy: a provider that reuses its buffers cannot change a queued frame later
  })
})

describe('the TTS answer is checked (LOW: part of speech-tts-hang)', () => {
  const BAD: Array<[string, unknown]> = [
    ['undefined', undefined],
    ['null', null],
    ['a number', 5],
    ['an empty object', {}],
    ['no samples', { pcm: new Int16Array(0), sampleRate: 24000 }],
    ['samples that are not samples', { pcm: 'abc', sampleRate: 24000 }],
    ['a NaN rate', { pcm: new Int16Array(100), sampleRate: Number.NaN }],
    ['a rate of 0', { pcm: new Int16Array(100), sampleRate: 0 }],
    ['a rate of a billion', { pcm: new Int16Array(100), sampleRate: 1e9 }],
    ['a string rate', { pcm: new Int16Array(100), sampleRate: '24000' }],
    ['an hour of audio', { pcm: new Int16Array(24_000 * 3600), sampleRate: 24000 }],
  ]
  it.each(BAD)('%s is a reported failure, and the next sentence is still spoken', async (_n, answer) => {
    let calls = 0
    const tts = { synthesize: () => Promise.resolve(++calls === 1 ? answer : silence(300)) } as unknown as TtsProvider
    const h = harness({ tts })
    h.pipeline.enqueue({ text: 'first', emotion: 'neutral' })
    h.pipeline.enqueue({ text: 'second', emotion: 'neutral' })
    await h.run(2500, 50)
    expect(h.events.filter((e) => e.type === 'failed')).toHaveLength(1)
    expect(h.speaks().map((s) => s.text)).toEqual(['second'])
    expect(unhandled).toEqual([])
  })
  it('a plain array of samples and another sample rate still work (resampled)', async () => {
    const tts = { synthesize: () => Promise.resolve({ pcm: Array.from({ length: 8000 }, () => 0), sampleRate: 16000 }) } as unknown as TtsProvider
    const h = harness({ tts, face: null })
    h.pipeline.enqueue({ text: 'array', emotion: 'neutral' })
    await h.run(1000)
    expect(h.speaks()).toHaveLength(1)
    expect((h.speaks()[0] as unknown as { audio: { totalMs: number } }).audio.totalMs).toBeCloseTo(500, 0)
  })
})

describe('no failure escapes the play loop as an unhandled rejection', () => {
  it('a sink whose send rejects, throws or answers nonsense is handled', async () => {
    for (const send of [
      () => Promise.reject(new Error('sink boom')),
      () => {
        throw new Error('sync sink boom')
      },
    ]) {
      const h = harness({ sink: { send: send as never } })
      h.pipeline.enqueue({ text: 'hello there', emotion: 'neutral' })
      await h.run(1500, 50)
      expect(h.events.some((e) => e.type === 'failed' && /speak refused/.test(e.reason))).toBe(true)
      expect(await h.pipeline.cancel()).toBeDefined() // cancel is safe too
    }
    expect(unhandled).toEqual([])
  })
  it('a sink whose cancel send rejects does not make cancel() reject', async () => {
    const h = harness()
    h.pipeline.enqueue({ text: 'a sentence that takes a while to say out loud please', emotion: 'neutral' })
    await h.run(600)
    ;(h.sink as { send: SpeechSink['send'] }).send = () => Promise.reject(new Error('gone'))
    const report = await h.pipeline.cancel()
    expect(report.cancelled).toEqual(['utt_1'])
    expect(report.acknowledged).toBe(0)
    expect(unhandled).toEqual([])
  })
  it('an observer that throws does not stop the pipeline', async () => {
    const h = harness({ pipeline: { onEvent: () => { throw new Error('observer bug') } } })
    h.pipeline.enqueue({ text: 'still speaking', emotion: 'neutral' })
    await h.run(1000)
    expect(h.speaks()).toHaveLength(1)
    expect(unhandled).toEqual([])
  })
  it('a sink whose sendBinary throws is not a crash either (the play loop reports and the watchdog closes the utterance)', async () => {
    const h = harness({ sink: { sendBinary: () => { throw new Error('socket gone') } } })
    h.pipeline.enqueue({ text: 'frames will fail', emotion: 'neutral' })
    await h.run(6000, 50)
    expect(unhandled).toEqual([])
  })
})

describe('spoken text is cleaned and cut on a code point (LOW: speech-hostile-text)', () => {
  const quick = (): TtsProvider => new FakeTtsProvider({ mode: 'silence', msPerChar: 0.05, minMs: 100 })
  const lone = (s: string): boolean => /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s)
  it('the 2000-character cut never splits a surrogate pair (the reported case)', async () => {
    const h = harness()
    const r = h.pipeline.enqueue({ text: 'a'.repeat(1999) + '😀 and more', emotion: 'neutral' })
    expect(r.ok).toBe(true)
    await h.run(400)
    const text = h.speaks()[0]!.text!
    expect(text).toBe('a'.repeat(1999))
    expect(lone(text)).toBe(false)
    expect(lone(JSON.stringify(h.speaks()[0]))).toBe(false)
    expect(JSON.stringify(h.speaks()[0])).not.toMatch(/\\ud83d/i)
  })
  it('a pair that fits entirely is kept, and the longest text is exactly 2000 units', async () => {
    const h = harness({ tts: quick() })
    h.pipeline.enqueue({ text: 'a'.repeat(1998) + '😀' + 'zzz', emotion: 'neutral' })
    await h.run(400)
    const text = h.speaks()[0]!.text!
    expect(text.length).toBe(2000)
    expect(text.endsWith('😀')).toBe(true)
  })
  it('a caller\'s own lone surrogates are dropped; control characters are removed; RTL, Arabic and ZWJ emoji survive', async () => {
    const h = harness()
    h.pipeline.enqueue({ text: 'a\ud800b\udfffc\ud83d', emotion: 'neutral' })
    h.pipeline.enqueue({ text: 'x\u0000y\u0007z\u001b[31m', emotion: 'neutral' })
    h.pipeline.enqueue({ text: 'مرحبا بالعالم ‮ abc', emotion: 'neutral' })
    h.pipeline.enqueue({ text: '👩‍💻 ok', emotion: 'neutral' })
    await h.run(8000, 50)
    const texts = h.speaks().map((s) => s.text!)
    expect(texts[0]).toBe('abc')
    expect(texts[1]).toBe('xyz[31m')
    expect(texts[2]).toContain('مرحبا بالعالم')
    expect(texts[3]).toBe('👩‍💻 ok')
    for (const t of texts) expect(lone(t)).toBe(false)
  })
  it('a text that is nothing but control characters or lone surrogates is "empty", and 1 MB or 20 MB texts are cut, not crashed', () => {
    const h = harness({ tts: quick() })
    expect(h.pipeline.enqueue({ text: '\u0000\u0001\u0002', emotion: 'neutral' })).toMatchObject({ ok: false, code: 'empty' })
    expect(h.pipeline.enqueue({ text: '\ud800\ud801', emotion: 'neutral' })).toMatchObject({ ok: false, code: 'empty' })
    expect(h.pipeline.enqueue({ text: 'x'.repeat(1_000_000), emotion: 'neutral' }).ok).toBe(true)
    expect(h.pipeline.enqueue({ text: '😀'.repeat(10_000_000), emotion: 'neutral' }).ok).toBe(true)
  })
  it('property: random texts of surrogates, emoji, control and ordinary characters never produce a lone surrogate, nor more than 2000 units', async () => {
    const r = lcg(77)
    const alphabet = ['a', ' ', '\ud83d', '\ude00', '😀', '\u0000', '‮', 'é', '中', '\n', '\ud800', '\udfff', '👩‍💻']
    for (let i = 0; i < 60; i++) {
      const h = harness({ tts: quick(), face: null })
      let text = ''
      const n = 1 + Math.floor(r() * 2500)
      for (let k = 0; k < n; k++) text += alphabet[Math.floor(r() * alphabet.length)]
      const res = h.pipeline.enqueue({ text, emotion: 'neutral' })
      if (!res.ok) continue
      await h.run(200, 100)
      const sent = h.speaks()[0]?.text
      if (sent === undefined) continue
      expect(lone(sent)).toBe(false)
      expect(sent.length).toBeLessThanOrEqual(2000)
      // eslint-disable-next-line no-control-regex
      expect(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(sent)).toBe(false)
    }
  })
})

describe('option values cannot crash the play loop (INFO: speech-chunkms-zero-crashes)', () => {
  const BAD = [0, -5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1e9, -0, 0.4, 3]
  it.each(BAD)('chunkMs = %s', async (chunkMs) => {
    const h = harness({ pipeline: { chunkMs } })
    h.pipeline.enqueue({ text: 'hello there', emotion: 'neutral' })
    await h.run(1500)
    expect(h.speaks()).toHaveLength(1)
    expect(h.log.filter((l) => l.kind === 'audio').length).toBeGreaterThan(0)
    expect(unhandled).toEqual([])
  })
  it('every other numeric option is clamped as well', async () => {
    for (const v of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1e12]) {
      const h = harness({ pipeline: { lookaheadMs: v, faceBatch: v, startDelayMs: v, gapMs: v, pollMs: v, maxQueued: v, staleFaceMs: v, watchdogMs: v, announceAheadMs: v, synthTimeoutMs: v, faceTimeoutMs: v } })
      h.pipeline.enqueue({ text: 'hello there', emotion: 'neutral' })
      await h.run(300, 50)
      expect(unhandled).toEqual([])
      expect(await h.pipeline.cancel()).toBeDefined()
    }
  })
  it('a cancel with an absurd fade is clamped to what the contract allows (so the stage really is told to stop)', async () => {
    const h = harness()
    h.pipeline.enqueue({ text: 'a long enough sentence to be playing when it is cancelled', emotion: 'neutral' })
    await h.run(600)
    await h.pipeline.cancel({ fadeMs: 1e12 })
    const cancel = h.log.find((l) => l.kind === 'cmd' && l.cmd!.type === 'perform.cancel')!.cmd as unknown as { fadeMs: number }
    expect(cancel.fadeMs).toBe(10_000)
  })
})

describe('the stage clock can jump or be absurd (LOW: speech-stage-clock-discontinuity, frames-encoder-decoder-time-asymmetry)', () => {
  it('after the stage clock jumps back an hour, the next sentence is spoken within seconds, not an hour later (the reported scenario)', async () => {
    let offset = 0
    let epoch = 0
    const h = harness({ stageOffset: () => offset, epoch: () => epoch })
    h.pipeline.enqueue({ text: 'before the jump, a sentence of some length', emotion: 'neutral' })
    await h.run(600)
    expect(h.speaks()).toHaveLength(1)
    h.stage({ type: 'speak.started', utteranceId: 'utt_1', stageMs: h.stageNow() })
    // the stage restarted: its clock is an hour behind (the session saw it and counted a new epoch)
    offset = -3_600_000
    epoch = 1
    h.pipeline.enqueue({ text: 'after the jump', emotion: 'neutral' })
    await h.run(4000)
    const texts = h.speaks().map((s) => s.text)
    expect(texts).toEqual(['before the jump, a sentence of some length', 'after the jump'])
    // what had been announced in the old clock was cancelled and closed, not left for an hour
    expect(h.log.some((l) => l.kind === 'cmd' && l.cmd!.type === 'perform.cancel')).toBe(true)
    expect(h.events.some((e) => e.type === 'ended' && e.utteranceId === 'utt_1' && e.reason === 'the stage clock restarted')).toBe(true)
    const startAt = (h.speaks()[1] as { atMs: number }).atMs
    expect(startAt).toBeLessThan(h.stageNow() + 5000) // planned on the NEW clock
    await h.run(3000)
    expect(h.pipeline.pendingCount()).toBeLessThanOrEqual(1)
    expect(unhandled).toEqual([])
  })

  it('the same for a jump forward, and frames queued for the old clock are dropped (none is sent with an old timestamp)', async () => {
    let offset = 0
    let epoch = 0
    const h = harness({ stageOffset: () => offset, epoch: () => epoch, pipeline: { lookaheadMs: 100 } })
    h.pipeline.enqueue({ text: 'a rather long sentence so there are many frames queued up', emotion: 'neutral' })
    await h.run(300)
    const queued = h.pipeline.queuedFrames()
    expect(queued).toBeGreaterThan(5)
    offset = 7_200_000
    epoch = 1
    h.pipeline.enqueue({ text: 'next', emotion: 'neutral' })
    await h.run(300)
    expect(h.pipeline.queuedFrames()).toBeLessThan(queued)
    const oldStamps = h.log.filter((l) => (l.kind === 'audio' || l.kind === 'face') && l.tStart! > h.stageNow() - 1000 && l.tStart! < h.stageNow() - 60_000)
    expect(oldStamps).toHaveLength(0)
    await h.run(3000)
    expect(h.speaks().map((s) => s.text)).toContain('next')
  })

  it('a clock that never changes epoch behaves exactly as before (no cancel is sent)', async () => {
    const h = harness({ epoch: () => 0 })
    h.pipeline.enqueue({ text: 'steady', emotion: 'neutral' })
    h.pipeline.enqueue({ text: 'and steady again', emotion: 'neutral' })
    await h.run(4000)
    expect(h.speaks()).toHaveLength(2)
    expect(h.log.some((l) => l.kind === 'cmd' && l.cmd!.type === 'perform.cancel')).toBe(false)
  })

  it.each([-1e15, -1e300, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1e300, 2 ** 53, -1])('an absurd stage clock (%s) never throws, never sends a negative or unencodable time, never parks a timer for ever', async (clock) => {
    const h = harness({ sink: { stageNow: () => clock } })
    h.pipeline.enqueue({ text: 'a sentence on a broken clock', emotion: 'neutral' })
    await h.run(2000, 50)
    for (const l of h.log) {
      if (l.kind === 'audio' || l.kind === 'face') expect(Number.isFinite(l.tStart!) && l.tStart! >= 0 && l.tStart! <= Number.MAX_SAFE_INTEGER).toBe(true)
    }
    for (const s of h.speaks()) expect(Number.isFinite(s.atMs!) && s.atMs! >= 0).toBe(true)
    expect(unhandled).toEqual([])
    expect(h.vt.pending()).toBeLessThanOrEqual(3)
  })
})
