import { describe, expect, it } from 'vitest'
import { ARKIT_52, BinaryFrameKind } from '@ai-assistant/shared'
import {
  ARKIT_COUNT,
  FACE_FRAME_BYTES,
  FRAME_HEADER_BYTES,
  FrameEncodeError,
  MAX_AUDIO_PAYLOAD_BYTES,
  MAX_FACE_FRAMES_PER_MESSAGE,
  MAX_FRAME_BYTES,
  audioDurationMs,
  audioSamples,
  decodeFrame,
  encodeAudioFrame,
  encodeFaceFrame,
  encodeFrame,
  faceFrameTimeMs,
  faceFrames,
  fnv1a32,
  pcmBytes,
  utteranceIdHash,
} from '../src'
import { lcg } from './helpers'

const header = (kind: number, hash: number, t: number, payload: number[] | Uint8Array = [0, 0]): Uint8Array => {
  const out = new Uint8Array(13 + payload.length)
  const v = new DataView(out.buffer)
  v.setUint8(0, kind)
  v.setUint32(1, hash, true)
  v.setFloat64(5, t, true)
  out.set(payload, 13)
  return out
}

describe('utteranceId hash (FNV-1a 32 over UTF-8)', () => {
  it('matches the published FNV-1a test vectors', () => {
    expect(fnv1a32('')).toBe(0x811c9dc5)
    expect(fnv1a32('a')).toBe(0xe40c292c)
    expect(fnv1a32('foobar')).toBe(0xbf9cf968)
    expect(utteranceIdHash('foobar')).toBe(0xbf9cf968)
  })
  it('hashes UTF-8 bytes, not UTF-16 code units', () => {
    expect(utteranceIdHash('é')).toBe(fnv1a32(new Uint8Array([0xc3, 0xa9])))
    expect(utteranceIdHash('\u{1F600}')).toBe(fnv1a32(new Uint8Array([0xf0, 0x9f, 0x98, 0x80])))
  })
  it('is a u32 and spreads ids (no collisions among 5000 sequential utterance ids)', () => {
    const seen = new Set<number>()
    for (let i = 0; i < 5000; i++) {
      const h = utteranceIdHash(`utt_${i}`)
      expect(Number.isInteger(h) && h >= 0 && h <= 0xffffffff).toBe(true)
      seen.add(h)
    }
    expect(seen.size).toBe(5000)
  })
})

describe('frame layout (little-endian)', () => {
  it('constants agree with the contract', () => {
    expect(FRAME_HEADER_BYTES).toBe(13)
    expect(ARKIT_COUNT).toBe(ARKIT_52.length)
    expect(ARKIT_COUNT).toBe(52)
    expect(FACE_FRAME_BYTES).toBe(208)
    expect(BinaryFrameKind).toEqual({ audio: 1, face: 2, body: 3 })
  })
  it('writes kind, hash and time exactly as documented', () => {
    const f = encodeAudioFrame('a', 1.5, new Uint8Array([0x34, 0x12, 0xcc, 0xed]))
    expect([...f]).toEqual([
      1, // kind
      0x2c, 0x29, 0x0c, 0xe4, // hash 0xe40c292c little-endian
      0, 0, 0, 0, 0, 0, 0xf8, 0x3f, // 1.5 as f64 little-endian
      0x34, 0x12, 0xcc, 0xed, // payload untouched
    ])
  })
  it('face frames are f32 little-endian in ARKIT_52 order', () => {
    const w = new Array(52).fill(0)
    w[ARKIT_52.indexOf('jawOpen')] = 0.5
    const f = encodeFaceFrame('u', 0, w)
    expect(f.length).toBe(13 + 208)
    const view = new DataView(f.buffer)
    expect(view.getUint8(0)).toBe(2)
    expect(view.getFloat32(13 + ARKIT_52.indexOf('jawOpen') * 4, true)).toBe(0.5)
    expect([...f.slice(13 + 24 * 4, 13 + 25 * 4)]).toEqual([0, 0, 0, 0x3f]) // 0.5f = 0x3f000000 LE
  })
  it('audio samples decode little-endian regardless of platform', () => {
    expect([...audioSamples(new Uint8Array([0x34, 0x12, 0xff, 0xff, 0x00, 0x80]))]).toEqual([0x1234, -1, -32768])
    expect([...pcmBytes(new Int16Array([0x1234, -1]))]).toEqual([0x34, 0x12, 0xff, 0xff])
    expect([...pcmBytes([70000, -70000])]).toEqual([0xff, 0x7f, 0x00, 0x80]) // clamped
  })
  it('durations and face timing helpers', () => {
    expect(audioDurationMs(960)).toBeCloseTo(20)
    expect(audioDurationMs(48000, 24000)).toBeCloseTo(1000)
    expect(faceFrameTimeMs(100, 3)).toBeCloseTo(200)
  })
})

describe('encode/decode round trips (property style)', () => {
  it('audio: random payloads survive', () => {
    const r = lcg(1)
    for (let i = 0; i < 300; i++) {
      const n = 1 + Math.floor(r() * 4000)
      const pcm = new Int16Array(n).map(() => Math.floor((r() - 0.5) * 65535))
      const t = Math.floor(r() * 1e9) / 7
      const id = `utt_${Math.floor(r() * 1e6)}`
      const d = decodeFrame(encodeAudioFrame(id, t, pcm))
      expect(d.ok).toBe(true)
      if (!d.ok) return
      expect(d.frame.kind).toBe(1)
      expect(d.frame.utteranceIdHash).toBe(utteranceIdHash(id))
      expect(d.frame.tStartMs).toBe(t)
      expect([...audioSamples(d.frame.payload)]).toEqual([...pcm])
    }
  })
  it('face: random weights survive (as f32) with one or many frames', () => {
    const r = lcg(2)
    for (let i = 0; i < 200; i++) {
      const k = 1 + Math.floor(r() * 12)
      const w = Array.from({ length: k * 52 }, () => Math.fround(r()))
      const d = decodeFrame(encodeFaceFrame('x', i * 33.3, w))
      expect(d.ok).toBe(true)
      if (!d.ok) return
      const frames = faceFrames(d.frame.payload)
      expect(frames).toHaveLength(k)
      expect(frames.flatMap((f) => [...f])).toEqual(w)
    }
  })
  it('body frames carry an opaque payload', () => {
    const d = decodeFrame(encodeFrame({ kind: BinaryFrameKind.body, utteranceId: 7, tStartMs: 5, payload: new Uint8Array([1, 2, 3]) }))
    expect(d.ok && d.frame.kind).toBe(3)
    expect(d.ok && d.frame.utteranceIdHash).toBe(7)
  })
  it('the decoded payload is detached from the source buffer', () => {
    const f = encodeAudioFrame('u', 0, new Uint8Array([1, 2, 3, 4]))
    const d = decodeFrame(f)
    f.fill(9)
    expect(d.ok && [...d.frame.payload]).toEqual([1, 2, 3, 4])
  })
  it('accepts Uint8Array, ArrayBuffer, DataView, Buffer and a subarray with an offset', () => {
    const f = encodeAudioFrame('u', 0, new Uint8Array([1, 2]))
    expect(decodeFrame(f).ok).toBe(true)
    expect(decodeFrame(f.buffer.slice(0)).ok).toBe(true)
    expect(decodeFrame(new DataView(f.buffer)).ok).toBe(true)
    expect(decodeFrame(Buffer.from(f)).ok).toBe(true)
    const padded = new Uint8Array(f.length + 10)
    padded.set(f, 7)
    expect(decodeFrame(padded.subarray(7, 7 + f.length)).ok).toBe(true)
  })
})

describe('strict decoding', () => {
  const err = (data: unknown) => {
    const r = decodeFrame(data)
    return r.ok ? 'ok' : r.error
  }
  it('rejects truncated frames at every length below the header', () => {
    for (let n = 0; n < 13; n++) expect(err(new Uint8Array(n).fill(1))).toBe('truncated')
  })
  it('rejects an empty payload', () => {
    expect(err(new Uint8Array(13).fill(0).map((_, i) => (i === 0 ? 1 : 0)))).toBe('empty_payload')
  })
  it.each([0, 4, 5, 127, 255])('rejects unknown kind %i', (k) => {
    expect(err(header(k, 1, 0))).toBe('unknown_kind')
  })
  it.each([NaN, Infinity, -Infinity, -1, -0.001, 1e300])('rejects tStartMs %s', (t) => {
    expect(err(header(1, 1, t))).toBe('bad_time')
  })
  it('rejects misaligned audio and face payloads', () => {
    expect(err(header(1, 1, 0, [1, 2, 3]))).toBe('misaligned')
    expect(err(header(2, 1, 0, new Uint8Array(207)))).toBe('misaligned')
    expect(err(header(2, 1, 0, new Uint8Array(209)))).toBe('misaligned')
  })
  it('rejects NaN and Infinity face weights anywhere in the payload', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      for (const pos of [0, 25, 51]) {
        const payload = new Uint8Array(208)
        new DataView(payload.buffer).setFloat32(pos * 4, bad, true)
        expect(err(header(2, 1, 0, payload))).toBe('non_finite')
      }
    }
    const second = new Uint8Array(416)
    new DataView(second.buffer).setFloat32(300, NaN, true)
    expect(err(header(2, 1, 0, second))).toBe('non_finite')
  })
  it('rejects oversized frames and per-kind payload limits', () => {
    expect(err(new Uint8Array(MAX_FRAME_BYTES + 1))).toBe('oversized')
    expect(err(header(1, 1, 0, new Uint8Array(MAX_AUDIO_PAYLOAD_BYTES + 2)))).toBe('payload_too_large')
    expect(err(header(1, 1, 0, new Uint8Array(MAX_AUDIO_PAYLOAD_BYTES)))).toBe('ok')
    expect(err(header(2, 1, 0, new Uint8Array((MAX_FACE_FRAMES_PER_MESSAGE + 1) * 208)))).toBe('payload_too_large')
    expect(err(header(2, 1, 0, new Uint8Array(MAX_FACE_FRAMES_PER_MESSAGE * 208)))).toBe('ok')
  })
  it.each([[null], [undefined], ['text'], [42], [{}], [[1, 2, 3]], [true]])('rejects non-binary input %j', (v) => {
    expect(err(v)).toBe('not_binary')
  })
  it('never throws, whatever the bytes (fuzz) and only accepts frames that satisfy every rule', () => {
    const r = lcg(99)
    let accepted = 0
    for (let i = 0; i < 6000; i++) {
      const len = Math.floor(r() * 300)
      const bytes = new Uint8Array(len).map(() => Math.floor(r() * 256))
      if (len > 0 && r() < 0.5) bytes[0] = 1 + Math.floor(r() * 3)
      if (len >= 13 && r() < 0.5) new DataView(bytes.buffer).setFloat64(5, Math.floor(r() * 1e6), true)
      const d = decodeFrame(bytes)
      if (d.ok) {
        accepted++
        expect([1, 2, 3]).toContain(d.frame.kind)
        expect(Number.isFinite(d.frame.tStartMs) && d.frame.tStartMs >= 0).toBe(true)
        expect(d.frame.payload.length).toBe(len - 13)
        if (d.frame.kind === 1) expect(d.frame.payload.length % 2).toBe(0)
        if (d.frame.kind === 2) for (const f of faceFrames(d.frame.payload)) expect([...f].every(Number.isFinite)).toBe(true)
      }
    }
    expect(accepted).toBeGreaterThan(0)
  })
})

describe('encoder errors are programmer mistakes and throw FrameEncodeError', () => {
  it.each([
    ['NaN weight', () => encodeFaceFrame('u', 0, new Array(52).fill(NaN))],
    ['Infinity weight', () => encodeFaceFrame('u', 0, new Array(52).fill(Infinity))],
    ['partial face frame', () => encodeFaceFrame('u', 0, new Array(51).fill(0))],
    ['no face frame', () => encodeFaceFrame('u', 0, [])],
    ['too many face frames', () => encodeFaceFrame('u', 0, new Array(52 * (MAX_FACE_FRAMES_PER_MESSAGE + 1)).fill(0))],
    ['odd pcm bytes', () => encodeAudioFrame('u', 0, new Uint8Array(3))],
    ['empty audio', () => encodeAudioFrame('u', 0, new Uint8Array(0))],
    ['oversized audio', () => encodeAudioFrame('u', 0, new Uint8Array(MAX_AUDIO_PAYLOAD_BYTES + 2))],
    ['negative time', () => encodeAudioFrame('u', -1, new Uint8Array(2))],
    ['NaN time', () => encodeAudioFrame('u', NaN, new Uint8Array(2))],
    ['unknown kind', () => encodeFrame({ kind: 9 as never, utteranceId: 'u', tStartMs: 0, payload: new Uint8Array(2) })],
    ['hash out of range', () => encodeFrame({ kind: 1, utteranceId: 2 ** 32, tStartMs: 0, payload: new Uint8Array(2) })],
    ['fractional hash', () => encodeFrame({ kind: 1, utteranceId: 1.5, tStartMs: 0, payload: new Uint8Array(2) })],
  ])('%s', (_n, fn) => {
    expect(fn).toThrow(FrameEncodeError)
  })
})
