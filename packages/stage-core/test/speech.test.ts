import { describe, expect, it } from 'vitest'
import { ARKIT_52 } from '@ai-assistant/shared'
import type { StageEvent, VoiceProfile } from '@ai-assistant/shared'
import {
  FakeFaceProvider,
  FakeTtsProvider,
  SpeechPipeline,
  TtsAbortError,
  audioSamples,
  createSequentialIds,
  createVirtualTime,
  decodeFrame,
  faceFrames,
  resampleS16,
  speechSegments,
  utteranceIdHash,
} from '../src'
import type { CancelReport, CommandDraft, PipelineEvent, SpeechSink, TtsProvider } from '../src'
import { T0, lcg } from './helpers'
import { flush, makeRig } from './rig'

const VOICE: VoiceProfile = { provider: 'kokoro', voiceId: 'v', speed: 1, pitchSemitones: 0 }
const rms = (a: Int16Array) => Math.sqrt([...a].reduce((s, v) => s + (v / 32768) ** 2, 0) / a.length)
const zeroCrossings = (a: Int16Array) => {
  let n = 0
  for (let i = 1; i < a.length; i++) if (a[i - 1]! < 0 !== a[i]! < 0) n++
  return n
}

describe('FakeTtsProvider', () => {
  const tts = new FakeTtsProvider()
  const synth = (text: string, voice = VOICE) => tts.synthesize({ text, voice, emotion: 'neutral', sampleRate: 24000 })

  it('gives a duration proportional to the text length (24 kHz mono s16)', async () => {
    const short = await synth('Good morning, how are you today')
    const long = await synth('Good morning, how are you today. Good morning, how are you today')
    expect(short.sampleRate).toBe(24000)
    const ms = (r: { pcm: Int16Array }) => (r.pcm.length / 24000) * 1000
    expect(ms(long) / ms(short)).toBeGreaterThan(1.8)
    expect(ms(long) / ms(short)).toBeLessThan(2.3)
    expect(ms(short)).toBeCloseTo(tts.durationMs('Good morning, how are you today'), -1)
    const lengths = await Promise.all(['a', 'ab long text', 'x'.repeat(100), 'x'.repeat(200)].map((t) => synth(t)))
    for (let i = 1; i < lengths.length; i++) expect(lengths[i]!.pcm.length).toBeGreaterThanOrEqual(lengths[i - 1]!.pcm.length)
  })
  it('has a minimum duration, scales with speed, and pauses at punctuation', async () => {
    expect((await synth('a')).pcm.length).toBe(6000)
    const normal = await synth('Hello there, this is a test.')
    const fast = await synth('Hello there, this is a test.', { ...VOICE, speed: 2 })
    expect(normal.pcm.length / fast.pcm.length).toBeGreaterThan(1.8)
    expect(speechSegments('Hi, there.', 62, 1).some(([d, a]) => a === 0 && d >= 120)).toBe(true)
  })
  it('is deterministic and audible (vowels louder than consonants)', async () => {
    const a = await synth('Hello there')
    const b = await synth('Hello there')
    expect([...a.pcm]).toEqual([...b.pcm])
    expect(rms(a.pcm)).toBeGreaterThan(0.02)
    const aaa = await synth('aaaaaaaaaa')
    const sss = await synth('ssssssssss')
    expect(rms(aaa.pcm)).toBeGreaterThan(rms(sss.pcm) * 1.5)
    for (const v of a.pcm) expect(Math.abs(v)).toBeLessThan(32767)
  })
  it('silence mode is all zeros, pitch changes the frequency', async () => {
    const quiet = await new FakeTtsProvider({ mode: 'silence' }).synthesize({ text: 'hello world', voice: VOICE, emotion: 'neutral', sampleRate: 24000 })
    expect(quiet.pcm.every((v) => v === 0)).toBe(true)
    expect(quiet.pcm.length).toBeGreaterThan(5000)
    const low = await synth('aaaaaaaaaaaaaaaa', { ...VOICE, pitchSemitones: -12 })
    const high = await synth('aaaaaaaaaaaaaaaa', { ...VOICE, pitchSemitones: 12 })
    expect(zeroCrossings(high.pcm) / high.pcm.length).toBeGreaterThan((zeroCrossings(low.pcm) / low.pcm.length) * 3)
  })
  it('honours the output sample rate, latency with timers, abort and failures', async () => {
    const r16 = await new FakeTtsProvider({ outputSampleRate: 16000 }).synthesize({ text: 'hello world', voice: VOICE, emotion: 'neutral', sampleRate: 24000 })
    expect(r16.sampleRate).toBe(16000)
    const vt = createVirtualTime(0)
    const slow = new FakeTtsProvider({ latencyMs: 500, timers: vt.timers })
    let done = false
    const p = slow.synthesize({ text: 'hi there', voice: VOICE, emotion: 'neutral', sampleRate: 24000 }).then(() => (done = true))
    vt.advance(499)
    await flush()
    expect(done).toBe(false)
    vt.advance(2)
    await p
    expect(done).toBe(true)
    const ac = new AbortController()
    const q = slow.synthesize({ text: 'hi there', voice: VOICE, emotion: 'neutral', sampleRate: 24000, signal: ac.signal })
    ac.abort()
    await expect(q).rejects.toBeInstanceOf(TtsAbortError)
    await expect(slow.synthesize({ text: 'x', voice: VOICE, emotion: 'neutral', sampleRate: 24000, signal: ac.signal })).rejects.toThrow(/aborted/)
    await expect(new FakeTtsProvider({ failWhen: (t) => t.includes('boom') }).synthesize({ text: 'boom', voice: VOICE, emotion: 'neutral', sampleRate: 24000 })).rejects.toThrow(/simulated/)
    await expect(new FakeTtsProvider({ latencyMs: 5 }).synthesize({ text: 'x', voice: VOICE, emotion: 'neutral', sampleRate: 24000 })).rejects.toThrow(/timers/)
  })
  it('records requests', async () => {
    const t = new FakeTtsProvider()
    await t.synthesize({ text: 'hello', voice: VOICE, emotion: 'happy', sampleRate: 24000 })
    expect(t.requests[0]).toMatchObject({ text: 'hello', emotion: 'happy' })
  })
})

describe('resampling', () => {
  it('keeps the rate when equal and scales the length otherwise', () => {
    const pcm = new Int16Array(1600).map((_, i) => Math.round(Math.sin(i / 10) * 8000))
    expect(resampleS16(pcm, 24000, 24000)).toBe(pcm)
    expect(resampleS16(pcm, 16000, 24000).length).toBe(2400)
    expect(resampleS16(pcm, 48000, 24000).length).toBe(800)
    expect(resampleS16(new Int16Array(0), 16000, 24000).length).toBe(0)
  })
  it('preserves a constant level and stays in range', () => {
    const dc = new Int16Array(500).fill(12345)
    expect(new Set(resampleS16(dc, 16000, 24000))).toEqual(new Set([12345]))
    const loud = new Int16Array(500).map((_, i) => (i % 2 ? 32767 : -32768))
    for (const v of resampleS16(loud, 22050, 24000)) expect(v >= -32768 && v <= 32767).toBe(true)
  })
})

describe('FakeFaceProvider', () => {
  const face = new FakeFaceProvider()
  const tone = (ms: number, amp: number) => new Int16Array(Math.round(ms * 24)).map((_, i) => Math.round(Math.sin(i / 8) * amp))
  const idx = (n: (typeof ARKIT_52)[number]) => ARKIT_52.indexOf(n)
  const req = (pcm: Int16Array, over: Record<string, unknown> = {}) => ({ pcm, sampleRate: 24000, fps: 30, emotion: 'neutral' as const, intensity: 0.6, utteranceId: 'u1', ...over })

  it('produces 52-float frames at 30 fps covering the audio', () => {
    const f = face.frames(req(tone(1000, 8000)))
    expect(f).toHaveLength(30)
    for (const fr of f) expect(fr).toHaveLength(52)
    expect(face.frames(req(tone(1001, 8000)))).toHaveLength(31)
    expect(face.frames(req(tone(10, 8000)))).toHaveLength(1)
  })
  it('the jaw follows the audio energy: closed in silence, open when loud, smoothly', () => {
    const quiet = face.frames(req(new Int16Array(24000)))
    expect(quiet.every((f) => f[idx('jawOpen')] === 0)).toBe(true)
    expect(quiet[5]![idx('mouthClose')]).toBeGreaterThan(0)
    const loud = face.frames(req(tone(1000, 14000)))
    expect(loud[15]![idx('jawOpen')]).toBeGreaterThan(0.4)
    const mixed = face.frames(req(new Int16Array([...new Int16Array(12000), ...tone(500, 14000)])))
    expect(mixed[2]![idx('jawOpen')]).toBeLessThan(0.05)
    expect(mixed[25]![idx('jawOpen')]).toBeGreaterThan(0.4)
    // smoothing: no single-frame jump from 0 to the maximum
    const jaw = mixed.map((f) => f[idx('jawOpen')]!)
    for (let i = 1; i < jaw.length; i++) expect(Math.abs(jaw[i]! - jaw[i - 1]!)).toBeLessThan(0.75)
  })
  it('uses funnel, pucker and stretch mouth patterns while speaking', () => {
    const f = face.frames(req(tone(3000, 12000)))
    const used = (n: (typeof ARKIT_52)[number]) => f.some((fr) => fr[idx(n)]! > 0.1)
    expect(used('mouthFunnel')).toBe(true)
    expect(used('mouthPucker')).toBe(true)
    expect(used('mouthStretchLeft')).toBe(true)
    expect(f.some((fr) => fr[idx('mouthFunnel')]! > 0.1 && fr[idx('mouthPucker')]! > 0.1)).toBe(false)
  })
  it('blinks on a deterministic schedule, differently per utterance', () => {
    const blinks = (id: string) => face.frames(req(tone(9000, 6000), { utteranceId: id })).map((f, i) => (f[idx('eyeBlinkLeft')]! > 0.5 ? i : -1)).filter((i) => i >= 0)
    const a = blinks('u1')
    expect(a.length).toBeGreaterThanOrEqual(2)
    expect(blinks('u1')).toEqual(a)
    expect(blinks('u2')).not.toEqual(a)
    const f = face.frames(req(tone(9000, 6000)))
    for (const fr of f) expect(fr[idx('eyeBlinkLeft')]).toBe(fr[idx('eyeBlinkRight')])
  })
  it('adds an expression layer per emotion, scaled by intensity', () => {
    const at = (emotion: string, intensity = 1) => face.frames(req(new Int16Array(6000), { emotion, intensity }))[3]!
    expect(at('happy')[idx('mouthSmileLeft')]).toBeGreaterThan(0.3)
    expect(at('sad')[idx('mouthFrownLeft')]).toBeGreaterThan(0.25)
    expect(at('angry')[idx('browDownLeft')]).toBeGreaterThan(0.5)
    expect(at('surprised')[idx('eyeWideLeft')]).toBeGreaterThan(0.4)
    expect(at('thinking')[idx('eyeLookUpLeft')]).toBeGreaterThan(0.2)
    expect(at('neutral')[idx('mouthSmileLeft')]).toBe(0)
    expect(at('happy', 0.5)[idx('mouthSmileLeft')]).toBeCloseTo(at('happy', 1)[idx('mouthSmileLeft')]! / 2, 5)
    expect(at('happy', 0)[idx('mouthSmileLeft')]).toBe(0)
  })
  it('is always finite and within 0..1 and deterministic (property over random audio and emotions)', () => {
    const r = lcg(5)
    const emotions = ['neutral', 'happy', 'sad', 'angry', 'relaxed', 'surprised', 'shy', 'thinking'] as const
    for (let i = 0; i < 60; i++) {
      const pcm = new Int16Array(Math.floor(r() * 30000) + 100).map(() => Math.floor((r() - 0.5) * 65535 * r()))
      const opts = { emotion: emotions[Math.floor(r() * 8)]!, intensity: r() * 1.5 - 0.2, utteranceId: `u${i}` }
      const a = face.frames(req(pcm, opts))
      const b = face.frames(req(pcm, opts))
      expect(a).toHaveLength(b.length)
      for (let k = 0; k < a.length; k++) {
        expect([...a[k]!]).toEqual([...b[k]!])
        for (const w of a[k]!) {
          expect(Number.isFinite(w)).toBe(true)
          expect(w).toBeGreaterThanOrEqual(0)
          expect(w).toBeLessThanOrEqual(1)
        }
      }
    }
    expect(face.frames(req(tone(100, 5000), { intensity: NaN }))[0]!.every(Number.isFinite)).toBe(true)
  })
})

// ------------------------------------------------------------------------------------------------ the pipeline

interface LogEntry {
  at: number
  kind: 'cmd' | 'audio' | 'face'
  cmd?: CommandDraft & { type: string }
  hash?: number
  tStart?: number
  bytes?: number
}

function makePipeline(opts: { tts?: TtsProvider; ttsOpts?: ConstructorParameters<typeof FakeTtsProvider>[0]; offset?: number; ttsLatencyMs?: number; faceSource?: 'stage' | 'backend'; noFace?: boolean; sendOk?: () => boolean; pipeline?: Record<string, unknown> } = {}) {
  const vt = createVirtualTime(T0)
  const offset = opts.offset ?? 0
  const log: LogEntry[] = []
  const events: PipelineEvent[] = []
  const state = { congested: false, maxAhead: -Infinity, minBehind: Infinity }
  const stageNow = () => vt.now() + offset
  const sink: SpeechSink = {
    send: async (cmd) => {
      log.push({ at: vt.now(), kind: 'cmd', cmd: cmd as LogEntry['cmd'] })
      return opts.sendOk && !opts.sendOk() ? { ok: false, reason: 'refused' } : { ok: true }
    },
    sendBinary: (bytes) => {
      if (state.congested) return false
      const d = decodeFrame(bytes)
      if (!d.ok) throw new Error('pipeline sent an undecodable frame')
      state.maxAhead = Math.max(state.maxAhead, d.frame.tStartMs - stageNow())
      log.push({ at: vt.now(), kind: d.frame.kind === 1 ? 'audio' : 'face', hash: d.frame.utteranceIdHash, tStart: d.frame.tStartMs, bytes: d.frame.payload.length })
      return true
    },
    canSendBinary: () => !state.congested,
    stageNow,
    faceSource: () => opts.faceSource ?? 'backend',
  }
  const tts = opts.tts ?? new FakeTtsProvider({ timers: vt.timers, ...(opts.ttsOpts ?? {}), ...(opts.ttsLatencyMs ? { latencyMs: opts.ttsLatencyMs, timers: vt.timers } : {}) })
  const pipeline = new SpeechPipeline({
    sink,
    tts,
    ...(opts.noFace ? {} : { face: new FakeFaceProvider() }),
    voice: VOICE,
    clock: vt.clock,
    timers: vt.timers,
    newId: createSequentialIds(),
    onEvent: (e) => events.push(e),
    ...opts.pipeline,
  })
  const run = async (ms: number, step = 10) => {
    await flush(20)
    for (let t = 0; t < ms; t += step) {
      vt.advance(step)
      await flush(6)
    }
  }
  const stage = (ev: StageEvent) => pipeline.handleStageEvent(ev)
  const cmds = (type?: string) => log.filter((l) => l.kind === 'cmd' && (!type || l.cmd!.type === type)).map((l) => l.cmd!)
  return { vt, pipeline, log, events, state, run, stage, cmds, sink, tts, stageNow }
}

describe('SpeechPipeline: one sentence', () => {
  it('rejects empty text, an unknown emotion and an overfull queue', () => {
    const p = makePipeline()
    expect(p.pipeline.enqueue({ text: '   ', emotion: 'neutral' })).toMatchObject({ ok: false, code: 'empty' })
    expect(p.pipeline.enqueue({ text: 'hi', emotion: 'ecstatic' as never })).toMatchObject({ ok: false, code: 'invalid_emotion' })
    expect(p.pipeline.enqueue(null as never)).toMatchObject({ ok: false })
    const q = makePipeline({ pipeline: { maxQueued: 2 }, ttsOpts: { latencyMs: 10_000, timers: createVirtualTime(0).timers } })
    q.pipeline.enqueue({ text: 'one', emotion: 'neutral' })
    q.pipeline.enqueue({ text: 'two', emotion: 'neutral' })
    q.pipeline.enqueue({ text: 'three', emotion: 'neutral' })
    expect(q.pipeline.enqueue({ text: 'four', emotion: 'neutral' })).toMatchObject({ ok: false, code: 'queue_full' })
  })

  it('announces with perform.speak BEFORE any binary frame, with the full description of the utterance', async () => {
    const p = makePipeline()
    const r = p.pipeline.enqueue({ text: 'Good morning, I have two things for you.', emotion: 'happy' })
    expect(r.ok && r.value.utteranceId).toBe('utt_1')
    await p.run(1500)
    expect(p.log[0]!.kind).toBe('cmd')
    const speak = p.cmds('perform.speak')[0] as unknown as { utteranceId: string; text: string; emotion: string; emotionTimeline: unknown[]; audio: { format: string; sampleRate: number; channels: number; totalMs: number }; faceSource: string; atMs: number }
    expect(speak).toMatchObject({ utteranceId: 'utt_1', text: 'Good morning, I have two things for you.', emotion: 'happy', faceSource: 'backend', audio: { format: 'pcm_s16le', sampleRate: 24000, channels: 1 } })
    expect(speak.emotionTimeline).toEqual([{ tMs: 0, emotion: 'happy', intensity: 0.7 }])
    const durationMs = new FakeTtsProvider().durationMs('Good morning, I have two things for you.')
    expect(speak.audio.totalMs).toBeCloseTo(durationMs, 0)
    expect(speak.atMs).toBe(T0 + 120)
    const firstBinary = p.log.findIndex((l) => l.kind !== 'cmd')
    expect(firstBinary).toBeGreaterThan(0)
  })

  it('sends ~20 ms audio chunks whose stage-clock timestamps are contiguous from the announced start, and 30 fps face frames', async () => {
    const p = makePipeline({ offset: 777_000 })
    p.pipeline.enqueue({ text: 'This is a reasonably long sentence to speak out loud.', emotion: 'neutral' })
    await p.run(5000)
    const speak = p.cmds('perform.speak')[0] as unknown as { atMs: number; audio: { totalMs: number } }
    const hash = utteranceIdHash('utt_1')
    const audio = p.log.filter((l) => l.kind === 'audio')
    const faces = p.log.filter((l) => l.kind === 'face')
    expect(audio.every((a) => a.hash === hash)).toBe(true)
    expect(audio[0]!.tStart).toBe(speak.atMs)
    for (let i = 1; i < audio.length; i++) expect(audio[i]!.tStart! - audio[i - 1]!.tStart!).toBeCloseTo(20, 2)
    expect(audio.slice(0, -1).every((a) => a.bytes === 960)).toBe(true)
    const totalBytes = audio.reduce((s, a) => s + a.bytes!, 0)
    expect((totalBytes / 2 / 24000) * 1000).toBeCloseTo(speak.audio.totalMs, 0)
    expect(faces.length).toBe(Math.ceil((speak.audio.totalMs * 30) / 1000))
    expect(faces.every((f) => f.hash === hash && f.bytes === 208)).toBe(true)
    for (let i = 1; i < faces.length; i++) expect(faces[i]!.tStart! - faces[i - 1]!.tStart!).toBeCloseTo(1000 / 30, 2) // epoch-scale f64 times
    expect(speak.atMs).toBeGreaterThan(p.vt.now() - 5000 + 777_000) // on the STAGE clock (offset applied)
    expect(p.pipeline.stats()).toMatchObject({ utterances: 1, audioChunksSent: audio.length, faceFramesSent: faces.length })
  })

  it('releases frames only LOOKAHEAD ms ahead of playback (never the whole utterance at once) and nothing is late', async () => {
    const p = makePipeline()
    p.pipeline.enqueue({ text: 'A long sentence that takes a few seconds to say, so the lookahead matters.', emotion: 'neutral' })
    await p.run(500)
    const early = p.log.filter((l) => l.kind === 'audio').length
    expect(early).toBeGreaterThan(5)
    expect(early).toBeLessThan(60) // far fewer than the ~200 chunks of the whole utterance
    await p.run(6000)
    expect(p.state.maxAhead).toBeLessThanOrEqual(250 + 10)
    // every chunk went out no later than its playback time
    for (const a of p.log.filter((l) => l.kind === 'audio')) expect(a.at).toBeLessThanOrEqual(a.tStart! + 1)
  })

  it('a custom lookahead is honoured', async () => {
    const p = makePipeline({ pipeline: { lookaheadMs: 60 } })
    p.pipeline.enqueue({ text: 'A long sentence that takes a few seconds to say.', emotion: 'neutral' })
    await p.run(4000)
    expect(p.state.maxAhead).toBeLessThanOrEqual(60 + 10)
  })

  it('tapers the emotion timeline on long non-neutral sentences and shapes intensity by punctuation', async () => {
    const p = makePipeline()
    p.pipeline.enqueue({ text: 'x'.repeat(120), emotion: 'sad' })
    p.pipeline.enqueue({ text: 'Great news!', emotion: 'happy' })
    p.pipeline.enqueue({ text: 'Is that so?', emotion: 'thinking' })
    p.pipeline.enqueue({ text: 'Plain words.', emotion: 'neutral' })
    await p.run(500)
    const tl = (n: number) => (p.cmds('perform.speak')[n] as unknown as { emotionTimeline: Array<{ tMs: number; intensity: number }> }).emotionTimeline
    await p.run(25_000)
    expect(tl(0)).toHaveLength(2)
    expect(tl(0)[1]!.tMs).toBeGreaterThan(3000)
    expect(tl(0)[1]!.intensity).toBeLessThan(tl(0)[0]!.intensity)
    expect(tl(1)[0]!.intensity).toBe(0.9)
    expect(tl(2)[0]!.intensity).toBe(0.6)
    expect(tl(3)[0]!.intensity).toBe(0.35)
    expect(tl(3)).toHaveLength(1)
  })

  it('uses the voice profile at synthesis time, from a getter if given', async () => {
    let speed = 1
    const p = makePipeline({ pipeline: { voice: () => ({ ...VOICE, speed }) } })
    p.pipeline.enqueue({ text: 'hello there my friend', emotion: 'neutral' })
    await p.run(200)
    speed = 2
    p.pipeline.enqueue({ text: 'hello there my friend', emotion: 'neutral' })
    await p.run(4000)
    const t = p.tts as FakeTtsProvider
    expect(t.requests[0]!.voice.speed).toBe(1)
    expect(t.requests[1]!.voice.speed).toBe(2)
  })

  it('chooses the face source: stage-side face means no face frames; no provider falls back to the stage', async () => {
    const stageFace = makePipeline({ faceSource: 'stage' })
    stageFace.pipeline.enqueue({ text: 'hello there my friend', emotion: 'neutral' })
    await stageFace.run(3000)
    expect((stageFace.cmds('perform.speak')[0] as unknown as { faceSource: string }).faceSource).toBe('stage')
    expect(stageFace.log.some((l) => l.kind === 'face')).toBe(false)
    expect(stageFace.log.some((l) => l.kind === 'audio')).toBe(true)
    const noProvider = makePipeline({ faceSource: 'backend', noFace: true })
    noProvider.pipeline.enqueue({ text: 'hello there my friend', emotion: 'neutral' })
    await noProvider.run(3000)
    expect((noProvider.cmds('perform.speak')[0] as unknown as { faceSource: string }).faceSource).toBe('stage')
    const forced = makePipeline({ faceSource: 'backend', pipeline: { faceSource: 'stage' } })
    forced.pipeline.enqueue({ text: 'hello there my friend', emotion: 'neutral' })
    await forced.run(3000)
    expect((forced.cmds('perform.speak')[0] as unknown as { faceSource: string }).faceSource).toBe('stage')
  })

  it('batches face frames when asked', async () => {
    const p = makePipeline({ pipeline: { faceBatch: 3 } })
    p.pipeline.enqueue({ text: 'hello there my friend how are you', emotion: 'neutral' })
    await p.run(5000)
    const faces = p.log.filter((l) => l.kind === 'face')
    expect(faces.slice(0, -1).every((f) => f.bytes === 208 * 3)).toBe(true)
    const frames = faces.reduce((s, f) => s + f.bytes! / 208, 0)
    expect(frames).toBe(Math.ceil((((p.cmds('perform.speak')[0] as unknown as { audio: { totalMs: number } }).audio.totalMs) * 30) / 1000))
  })

  it('resamples a provider that answers at another rate and keeps the contract at 24 kHz', async () => {
    const p = makePipeline({ ttsOpts: { outputSampleRate: 16000, timers: createVirtualTime(0).timers } })
    p.pipeline.enqueue({ text: 'hello there my friend', emotion: 'neutral' })
    await p.run(3000)
    const speak = p.cmds('perform.speak')[0] as unknown as { audio: { sampleRate: number; totalMs: number } }
    expect(speak.audio.sampleRate).toBe(24000)
    const bytes = p.log.filter((l) => l.kind === 'audio').reduce((s, a) => s + a.bytes!, 0)
    expect((bytes / 2 / 24000) * 1000).toBeCloseTo(speak.audio.totalMs, 0)
  })

  it('reports a synthesis failure and carries on with the next sentence', async () => {
    const p = makePipeline({ ttsOpts: { failWhen: (t) => t.includes('boom'), timers: createVirtualTime(0).timers } })
    p.pipeline.enqueue({ text: 'boom goes the first', emotion: 'neutral' })
    p.pipeline.enqueue({ text: 'but the second is fine', emotion: 'neutral' })
    await p.run(4000)
    expect(p.events.find((e) => e.type === 'failed')).toMatchObject({ utteranceId: 'utt_1' })
    expect(p.cmds('perform.speak')).toHaveLength(1)
    expect(p.pipeline.stats().synthFailures).toBe(1)
  })
  it('reports unusable audio from a provider', async () => {
    const empty: TtsProvider = { synthesize: async () => ({ pcm: new Int16Array(0), sampleRate: 24000 }) }
    const p = makePipeline({ tts: empty })
    p.pipeline.enqueue({ text: 'hello', emotion: 'neutral' })
    await p.run(200)
    expect(p.events.some((e) => e.type === 'failed')).toBe(true)
    const bad: TtsProvider = { synthesize: async () => ({ pcm: new Int16Array(100), sampleRate: NaN }) }
    const q = makePipeline({ tts: bad })
    q.pipeline.enqueue({ text: 'hello', emotion: 'neutral' })
    await q.run(200)
    expect(q.events.some((e) => e.type === 'failed')).toBe(true)
  })
  it('a refused perform.speak drops the utterance without sending its frames', async () => {
    let n = 0
    const p = makePipeline({ sendOk: () => ++n > 1 })
    p.pipeline.enqueue({ text: 'first sentence here', emotion: 'neutral' })
    p.pipeline.enqueue({ text: 'second sentence here', emotion: 'neutral' })
    await p.run(5000)
    expect(p.events.find((e) => e.type === 'failed')).toMatchObject({ utteranceId: 'utt_1' })
    const hashes = new Set(p.log.filter((l) => l.kind !== 'cmd').map((l) => l.hash))
    expect([...hashes]).toEqual([utteranceIdHash('utt_2')])
  })
  it('a face provider failure still speaks (without a face)', async () => {
    const p = makePipeline()
    const failing = new SpeechPipeline({ sink: p.sink, tts: new FakeTtsProvider(), face: { frames: () => { throw new Error('gpu lost') } }, voice: VOICE, clock: p.vt.clock, timers: p.vt.timers, newId: createSequentialIds() })
    failing.enqueue({ text: 'hello there', emotion: 'neutral' })
    await p.run(2000)
    expect(p.log.some((l) => l.kind === 'audio')).toBe(true)
    expect(p.log.some((l) => l.kind === 'face')).toBe(false)
    expect((p.cmds('perform.speak')[0] as unknown as { faceSource: string }).faceSource).toBe('stage')
  })
})

describe('SpeechPipeline: several sentences', () => {
  it('speaks them in order, each announced before its frames, without overlap and with a natural gap', async () => {
    const p = makePipeline()
    for (const t of ['The first sentence is here.', 'Then comes the second one.', 'And finally the third.']) p.pipeline.enqueue({ text: t, emotion: 'neutral' })
    await p.run(12_000)
    const speaks = p.cmds('perform.speak') as unknown as Array<{ utteranceId: string; atMs: number; audio: { totalMs: number } }>
    expect(speaks.map((s) => s.utteranceId)).toEqual(['utt_1', 'utt_2', 'utt_3'])
    for (let i = 1; i < speaks.length; i++) {
      const prevEnd = speaks[i - 1]!.atMs + speaks[i - 1]!.audio.totalMs
      expect(speaks[i]!.atMs).toBeGreaterThanOrEqual(prevEnd + 140 - 1)
      expect(speaks[i]!.atMs).toBeLessThan(prevEnd + 400)
    }
    // time order of audio frames across the whole run
    const audio = p.log.filter((l) => l.kind === 'audio')
    for (let i = 1; i < audio.length; i++) expect(audio[i]!.tStart!).toBeGreaterThan(audio[i - 1]!.tStart!)
    // each utterance's perform.speak precedes its first frame
    for (const s of speaks) {
      const speakIdx = p.log.findIndex((l) => l.kind === 'cmd' && (l.cmd as unknown as { utteranceId?: string }).utteranceId === s.utteranceId)
      const firstFrame = p.log.findIndex((l) => l.kind !== 'cmd' && l.hash === utteranceIdHash(s.utteranceId))
      expect(speakIdx).toBeGreaterThanOrEqual(0)
      expect(speakIdx).toBeLessThan(firstFrame)
    }
  })
  it('when synthesis is slower than speech the next sentence starts as soon as it is ready', async () => {
    const r = makePipeline({ ttsLatencyMs: 1500 })
    r.pipeline.enqueue({ text: 'Short one.', emotion: 'neutral' })
    r.pipeline.enqueue({ text: 'Another short.', emotion: 'neutral' })
    await r.run(9000)
    const speaks = r.cmds('perform.speak') as unknown as Array<{ atMs: number; audio: { totalMs: number } }>
    expect(speaks).toHaveLength(2)
    const prevEnd = speaks[0]!.atMs + speaks[0]!.audio.totalMs
    expect(speaks[1]!.atMs).toBeGreaterThan(prevEnd + 500) // a real gap: TTS could not keep up
    expect(speaks[1]!.atMs).toBe(T0 + 3000 + 120) // announced right when its synthesis finished
  })
  it('prefetches synthesis but announces the next sentence only when the current one is nearly done', async () => {
    const p = makePipeline()
    p.pipeline.enqueue({ text: 'A fairly long first sentence that takes a while.', emotion: 'neutral' })
    p.pipeline.enqueue({ text: 'Second.', emotion: 'neutral' })
    await p.run(300)
    expect((p.tts as FakeTtsProvider).requests).toHaveLength(2) // already synthesised
    expect(p.cmds('perform.speak')).toHaveLength(1) // but not yet announced
    const first = p.cmds('perform.speak')[0] as unknown as { atMs: number; audio: { totalMs: number } }
    await p.run(2500)
    expect(p.cmds('perform.speak')).toHaveLength(2)
    const announcedAt = p.log.filter((l) => l.kind === 'cmd' && l.cmd!.type === 'perform.speak')[1]!.at
    expect(first.atMs + first.audio.totalMs - announcedAt).toBeLessThanOrEqual(1500 + 10)
    expect(first.atMs + first.audio.totalMs - announcedAt).toBeGreaterThan(1300)
  })
  it('idle() resolves once everything has ended (via stage events) and pendingCount reflects progress', async () => {
    const p = makePipeline()
    expect(await Promise.race([p.pipeline.idle().then(() => 'idle'), flush().then(() => 'busy')])).toBe('idle')
    p.pipeline.enqueue({ text: 'Hello there.', emotion: 'neutral' })
    expect(p.pipeline.pendingCount()).toBeGreaterThan(0)
    let idle = false
    void p.pipeline.idle().then(() => (idle = true))
    await p.run(2000)
    expect(idle).toBe(false)
    p.stage({ type: 'speak.started', utteranceId: 'utt_1', stageMs: p.stageNow() })
    expect(p.pipeline.isSpeaking()).toBe(true)
    p.stage({ type: 'speak.ended', utteranceId: 'utt_1', stageMs: p.stageNow(), interrupted: false })
    await flush()
    expect(idle).toBe(true)
    expect(p.pipeline.isSpeaking()).toBe(false)
    expect(p.events.map((e) => e.type)).toEqual(['queued', 'announced', 'started', 'ended'])
    p.pipeline.prune()
  })
  it('forgets old finished utterances so a long session does not grow without bound', async () => {
    const p = makePipeline({ ttsOpts: { minMs: 20, msPerChar: 1, timers: createVirtualTime(0).timers }, pipeline: { watchdogMs: 10, announceAheadMs: 100_000 } })
    for (let i = 0; i < 100; i++) {
      p.pipeline.enqueue({ text: `Sentence number ${i}.`, emotion: 'neutral' })
      await p.run(500, 25)
    }
    await p.run(3000, 50)
    expect(p.events.filter((e) => e.type === 'ended').length).toBeGreaterThan(90)
    expect(p.events.some((e) => e.type === 'failed')).toBe(false)
    expect((p.pipeline as unknown as { utterances: Map<string, unknown> }).utterances.size).toBeLessThanOrEqual(64)
  })
  it('a watchdog closes an utterance whose speak.ended never arrives', async () => {
    const p = makePipeline({ pipeline: { watchdogMs: 500 } })
    p.pipeline.enqueue({ text: 'Hello.', emotion: 'neutral' })
    let idle = false
    void p.pipeline.idle().then(() => (idle = true))
    await p.run(4000)
    expect(idle).toBe(true)
    expect(p.events.find((e) => e.type === 'ended')).toMatchObject({ reason: expect.stringMatching(/timeout/) })
  })
})

describe('SpeechPipeline: back-pressure', () => {
  it('holds frames while congested, keeps order, never drops audio, and drops only stale face frames', async () => {
    const p = makePipeline()
    p.pipeline.enqueue({ text: 'A sentence long enough to span several seconds of speech.', emotion: 'neutral' })
    await p.run(300)
    p.state.congested = true
    const sentBefore = p.log.length
    await p.run(1200)
    expect(p.log.length).toBe(sentBefore)
    expect(p.pipeline.stats().backPressureWaits).toBeGreaterThan(5)
    expect(p.pipeline.queuedFrames()).toBeGreaterThan(20)
    p.state.congested = false
    await p.run(8000)
    const audio = p.log.filter((l) => l.kind === 'audio')
    const total = (p.cmds('perform.speak')[0] as unknown as { audio: { totalMs: number } }).audio.totalMs
    expect(audio.reduce((s, a) => s + a.bytes! / 2 / 24, 0)).toBeCloseTo(total, 0) // all audio arrived
    for (let i = 1; i < audio.length; i++) expect(audio[i]!.tStart!).toBeGreaterThan(audio[i - 1]!.tStart!)
    expect(p.pipeline.stats().staleFaceDropped).toBeGreaterThan(0)
    const faces = p.log.filter((l) => l.kind === 'face')
    for (let i = 1; i < faces.length; i++) expect(faces[i]!.tStart!).toBeGreaterThan(faces[i - 1]!.tStart!)
  })
})

describe('SpeechPipeline: barge-in', () => {
  it('cancel mid-utterance: perform.cancel goes out, queued frames and sentences are dropped, a report says how much', async () => {
    const p = makePipeline()
    p.pipeline.enqueue({ text: 'A long sentence that will be interrupted before it is finished speaking.', emotion: 'neutral' })
    p.pipeline.enqueue({ text: 'This second one never gets announced.', emotion: 'neutral' })
    p.pipeline.enqueue({ text: 'Nor this third one.', emotion: 'neutral' })
    await p.run(1000)
    p.stage({ type: 'speak.started', utteranceId: 'utt_1', stageMs: p.stageNow() })
    const framesBefore = p.log.filter((l) => l.kind !== 'cmd').length
    const speaksBefore = p.cmds('perform.speak').length
    const report: CancelReport = await p.pipeline.cancel({ fadeMs: 80 })
    expect(p.cmds('perform.cancel').length).toBe(speaksBefore)
    expect(p.cmds('perform.cancel')[0]).toMatchObject({ type: 'perform.cancel', utteranceId: 'utt_1', fadeMs: 80 })
    expect(report.cancelled).toContain('utt_1')
    expect(report.droppedChunks).toBeGreaterThan(50)
    expect(report.droppedAudioMs).toBeGreaterThan(1000)
    expect(report.sentAudioMs).toBeGreaterThan(300)
    expect(report.acknowledged).toBe(report.cancelled.length)
    expect(report.cancelled).toEqual(['utt_1'])
    expect(report.droppedSentences).toBe(2) // the second and third were never announced
    await p.run(3000)
    // nothing more is sent for the cancelled material
    expect(p.log.filter((l) => l.kind !== 'cmd').length).toBe(framesBefore)
    expect(p.cmds('perform.speak')).toHaveLength(speaksBefore)
    expect(p.pipeline.queuedFrames()).toBe(0)
    expect(p.events.some((e) => e.type === 'cancelled')).toBe(true)
    expect(p.pipeline.stats().cancels).toBe(1)
  })
  it('a barge-in aborts a synthesis in flight and drops what is waiting', async () => {
    const p = makePipeline({ ttsLatencyMs: 2000 })
    p.pipeline.enqueue({ text: 'This will be aborted while it is being synthesised.', emotion: 'neutral' })
    p.pipeline.enqueue({ text: 'Waiting behind it.', emotion: 'neutral' })
    await p.run(100)
    const report = await p.pipeline.cancel()
    expect(report.cancelled).toEqual([])
    expect(report.droppedSentences).toBe(1) // the one waiting; the in-flight one is aborted via its signal
    expect((p.tts as FakeTtsProvider).requests[0]!.signal!.aborted).toBe(true)
    await p.run(5000)
    expect(p.cmds('perform.speak')).toHaveLength(0)
    expect(p.log).toHaveLength(0)
  })
  it('works again after a cancel, and a cancel while idle is a harmless no-op', async () => {
    const p = makePipeline()
    const empty = await p.pipeline.cancel()
    expect(empty).toMatchObject({ cancelled: [], droppedSentences: 0, droppedChunks: 0, acknowledged: 0 })
    expect(p.cmds('perform.cancel')).toHaveLength(0)
    p.pipeline.enqueue({ text: 'Something long that will be cut short by the user.', emotion: 'neutral' })
    await p.run(600)
    await p.pipeline.cancel()
    p.pipeline.enqueue({ text: 'Fresh start.', emotion: 'happy' })
    await p.run(3000)
    const speaks = p.cmds('perform.speak') as unknown as Array<{ utteranceId: string; text: string }>
    expect(speaks.map((s) => s.text)).toEqual(['Something long that will be cut short by the user.', 'Fresh start.'])
    const lastHash = utteranceIdHash(speaks[1]!.utteranceId)
    expect(p.log.some((l) => l.kind === 'audio' && l.hash === lastHash)).toBe(true)
  })
  it('cancelling twice in a row does not double-cancel anything', async () => {
    const p = makePipeline()
    p.pipeline.enqueue({ text: 'Something long that will be cut short by the user.', emotion: 'neutral' })
    await p.run(600)
    await p.pipeline.cancel()
    const n = p.cmds('perform.cancel').length
    await p.pipeline.cancel()
    expect(p.cmds('perform.cancel').length).toBe(n)
  })
  it('a stage-side speak.ended removes that utterance\'s queued frames', async () => {
    const p = makePipeline()
    p.pipeline.enqueue({ text: 'A long sentence that the stage decides to stop on its own.', emotion: 'neutral' })
    await p.run(600)
    expect(p.pipeline.queuedFrames()).toBeGreaterThan(0)
    p.stage({ type: 'speak.ended', utteranceId: 'utt_1', stageMs: 1, interrupted: true })
    expect(p.pipeline.queuedFrames()).toBe(0)
  })
})

describe('SpeechPipeline with the real session and simulator', () => {
  it('speaks end to end: the simulator receives all audio and face frames and reports started and ended', async () => {
    const r = await makeRig({ sim: { clockOffsetMs: 40_000 } })
    const loaded = await (async () => {
      const { loadAll, makeWorldRig } = await import('./rig')
      const w = await makeWorldRig({ vt: r.vt, sim: { clockOffsetMs: 40_000 } })
      await loadAll(w)
      return w
    })()
    const events: PipelineEvent[] = []
    const pipeline = new SpeechPipeline({
      sink: loaded.session,
      tts: new FakeTtsProvider(),
      face: new FakeFaceProvider(),
      voice: VOICE,
      clock: loaded.vt.clock,
      timers: loaded.vt.timers,
      newId: loaded.newId,
      onEvent: (e) => events.push(e),
    })
    loaded.session.onEvent((e) => pipeline.handleStageEvent(e))
    pipeline.enqueue({ text: 'Good morning. Two sessions are waiting for you.', emotion: 'happy' })
    pipeline.enqueue({ text: 'Shall we start with the first?', emotion: 'neutral' })
    for (let i = 0; i < 700; i++) {
      loaded.vt.advance(10)
      await flush(6)
    }
    await pipeline.idle()
    const total = (id: string) => loaded.sim.utterance(id)!
    for (const id of ['utt_1', 'utt_2']) {
      const u = total(id)
      expect(u.receivedMs).toBeCloseTo(u.totalMs!, 0)
      expect(u.faceFrames).toBe(Math.ceil((u.totalMs! * 30) / 1000))
      expect(u.underruns).toBe(0)
      expect(u.endedInterrupted).toBe(false)
      expect(u.faceSource).toBe('backend')
    }
    expect(loaded.sim.names('event').filter((n) => n === 'speak.started')).toHaveLength(2)
    expect(loaded.sim.names('event').filter((n) => n === 'speak.ended')).toHaveLength(2)
    const t1 = total('utt_1')
    const t2 = total('utt_2')
    expect(t2.startedAtStageMs!).toBeGreaterThanOrEqual(t1.startedAtStageMs! + t1.totalMs!)
    expect(events.map((e) => e.type).filter((t) => t === 'ended')).toHaveLength(2)
    expect(loaded.sim.rejectedFrames).toBe(0)
    expect(loaded.sim.orphanFrames).toBe(0)
  })

  it('a barge-in stops the simulator: speak.ended with interrupted=true and no further frames are accepted', async () => {
    const { loadAll, makeWorldRig } = await import('./rig')
    const w = await makeWorldRig()
    await loadAll(w)
    const pipeline = new SpeechPipeline({ sink: w.session, tts: new FakeTtsProvider(), face: new FakeFaceProvider(), voice: VOICE, clock: w.vt.clock, timers: w.vt.timers, newId: w.newId })
    w.session.onEvent((e) => pipeline.handleStageEvent(e))
    pipeline.enqueue({ text: 'This is a long sentence that the user is about to interrupt halfway through.', emotion: 'neutral' })
    for (let i = 0; i < 120; i++) {
      w.vt.advance(10)
      await flush(6)
    }
    expect(w.sim.state().speaking).toBe('utt_1')
    const p = pipeline.cancel({ fadeMs: 100 })
    w.vt.advance(150)
    const report = await p
    expect(report.cancelled).toEqual(['utt_1'])
    await flush(10)
    const u = w.sim.utterance('utt_1')!
    expect(u.endedInterrupted).toBe(true)
    expect(u.receivedMs).toBeLessThan(u.totalMs!)
    expect(w.sim.state().speaking).toBeNull()
    expect(w.sim.entries({ kind: 'event', name: 'speak.ended' })[0]!.data).toMatchObject({ interrupted: true })
    for (let i = 0; i < 100; i++) {
      w.vt.advance(10)
      await flush(3)
    }
    expect(w.sim.utterance('utt_1')!.receivedMs).toBe(u.receivedMs)
    // decoding sanity of what the stage got
    expect(audioSamples(new Uint8Array([0, 0])).length).toBe(1)
    expect(faceFrames(new Uint8Array(208)).length).toBe(1)
  })
})
