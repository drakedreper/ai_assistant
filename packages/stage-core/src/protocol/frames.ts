/**
 * Binary frames of mira-stage/1, exactly as documented in packages/shared/src/stage.ts:
 *
 *   [kind:u8][utteranceIdHash:u32][tStartMs:f64][payload...]      all little-endian, header = 13 bytes
 *
 *   kind 1 audio  pcm_s16le mono, 24 kHz, ~20 ms per frame (a frame may carry more; whole samples only)
 *   kind 2 face   ARKit weights: one f32 per entry of ARKIT_52 in canonical order = 208 bytes per 30 fps frame. A message
 *                 carries k >= 1 consecutive frames; the i-th is at tStartMs + i * 1000/30 ms
 *   kind 3 body   reserved for retargeted joint streams (payload is opaque here)
 *
 * UTTERANCE ID HASH. The contract only says "u32", so this package fixes it: FNV-1a 32-bit over the UTF-8 bytes of the
 * utteranceId (offset basis 0x811c9dc5, prime 0x01000193, arithmetic mod 2^32). Engine stages must use the same function
 * to match frames to the `perform.speak` that announced them. A collision between two utterances in flight at once is
 * possible in principle (2^-32 per pair) and harmless in practice: the stage plays by arrival and the backend never has
 * more than a handful in flight.
 *
 * The DECODER never throws: every malformed input yields { ok: false, error }. The ENCODER throws FrameEncodeError on
 * programmer mistakes (NaN weights, odd PCM length), which the pipeline never produces.
 */
import { ARKIT_52, BinaryFrameKind } from '@ai-assistant/shared'
import { fnv1a32 } from '../util/rng'

export const FRAME_HEADER_BYTES = 13
export const ARKIT_COUNT = ARKIT_52.length // 52
export const FACE_FRAME_BYTES = ARKIT_COUNT * 4 // 208
export const FACE_FPS = 30
export const AUDIO_SAMPLE_RATE = 24_000
/** Hard ceiling for any frame. */
export const MAX_FRAME_BYTES = 1 << 20
/** 2 seconds of 24 kHz s16 mono. The pipeline sends ~20 ms (960 byte) frames. */
export const MAX_AUDIO_PAYLOAD_BYTES = 96_000
/** 10 seconds of 30 fps frames in one message. */
export const MAX_FACE_FRAMES_PER_MESSAGE = 300

export type FrameError = 'not_binary' | 'truncated' | 'oversized' | 'unknown_kind' | 'bad_time' | 'empty_payload' | 'misaligned' | 'non_finite' | 'payload_too_large'

export interface BinaryFrame {
  kind: BinaryFrameKind
  utteranceIdHash: number
  tStartMs: number
  payload: Uint8Array
}

export type DecodeResult = { ok: true; frame: BinaryFrame } | { ok: false; error: FrameError }

export class FrameEncodeError extends Error {}

/** The utteranceId hash (FNV-1a 32 over UTF-8). */
export const utteranceIdHash = (id: string): number => fnv1a32(id)

const KINDS = new Set<number>([BinaryFrameKind.audio, BinaryFrameKind.face, BinaryFrameKind.body])

function toBytes(data: unknown): Uint8Array | undefined {
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  return undefined
}

/** Strict decode. Accepts Uint8Array, Buffer, ArrayBuffer or any ArrayBufferView. Never throws. */
export function decodeFrame(data: unknown): DecodeResult {
  try {
    const bytes = toBytes(data)
    if (!bytes) return { ok: false, error: 'not_binary' }
    if (bytes.byteLength > MAX_FRAME_BYTES) return { ok: false, error: 'oversized' }
    if (bytes.byteLength < FRAME_HEADER_BYTES) return { ok: false, error: 'truncated' }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const kind = view.getUint8(0)
    if (!KINDS.has(kind)) return { ok: false, error: 'unknown_kind' }
    const hash = view.getUint32(1, true)
    const t = view.getFloat64(5, true)
    if (!Number.isFinite(t) || t < 0 || t > Number.MAX_SAFE_INTEGER) return { ok: false, error: 'bad_time' }
    const payloadLen = bytes.byteLength - FRAME_HEADER_BYTES
    if (payloadLen === 0) return { ok: false, error: 'empty_payload' }
    if (kind === BinaryFrameKind.audio) {
      if (payloadLen > MAX_AUDIO_PAYLOAD_BYTES) return { ok: false, error: 'payload_too_large' }
      if (payloadLen % 2 !== 0) return { ok: false, error: 'misaligned' }
    } else if (kind === BinaryFrameKind.face) {
      if (payloadLen % FACE_FRAME_BYTES !== 0) return { ok: false, error: 'misaligned' }
      if (payloadLen / FACE_FRAME_BYTES > MAX_FACE_FRAMES_PER_MESSAGE) return { ok: false, error: 'payload_too_large' }
      for (let o = FRAME_HEADER_BYTES; o < bytes.byteLength; o += 4) {
        if (!Number.isFinite(view.getFloat32(o, true))) return { ok: false, error: 'non_finite' }
      }
    }
    return { ok: true, frame: { kind: kind as BinaryFrameKind, utteranceIdHash: hash, tStartMs: t, payload: bytes.slice(FRAME_HEADER_BYTES) } }
  } catch {
    return { ok: false, error: 'not_binary' }
  }
}

export interface EncodeInput {
  kind: BinaryFrameKind
  /** The utterance id (hashed) or an already computed u32 hash. */
  utteranceId: string | number
  tStartMs: number
  payload: Uint8Array
}

export function encodeFrame(f: EncodeInput): Uint8Array {
  if (!KINDS.has(f.kind)) throw new FrameEncodeError(`unknown frame kind ${String(f.kind)}`)
  if (!Number.isFinite(f.tStartMs) || f.tStartMs < 0) throw new FrameEncodeError('tStartMs must be a finite number >= 0')
  const hash = typeof f.utteranceId === 'string' ? utteranceIdHash(f.utteranceId) : f.utteranceId
  if (!Number.isInteger(hash) || hash < 0 || hash > 0xffffffff) throw new FrameEncodeError('utterance hash must be a u32')
  if (f.payload.byteLength === 0) throw new FrameEncodeError('empty payload')
  if (f.payload.byteLength + FRAME_HEADER_BYTES > MAX_FRAME_BYTES) throw new FrameEncodeError('frame is too large')
  const out = new Uint8Array(FRAME_HEADER_BYTES + f.payload.byteLength)
  const view = new DataView(out.buffer)
  view.setUint8(0, f.kind)
  view.setUint32(1, hash, true)
  view.setFloat64(5, f.tStartMs, true)
  out.set(f.payload, FRAME_HEADER_BYTES)
  return out
}

/** PCM as little-endian s16 bytes (from samples, or already bytes). */
export function pcmBytes(pcm: Uint8Array | Int16Array | ArrayLike<number>): Uint8Array {
  if (pcm instanceof Uint8Array) return pcm
  const out = new Uint8Array(pcm.length * 2)
  const view = new DataView(out.buffer)
  for (let i = 0; i < pcm.length; i++) view.setInt16(i * 2, Math.max(-32768, Math.min(32767, Math.round(pcm[i] as number))), true)
  return out
}

export function encodeAudioFrame(utteranceId: string | number, tStartMs: number, pcm: Uint8Array | Int16Array): Uint8Array {
  const bytes = pcmBytes(pcm)
  if (bytes.byteLength % 2 !== 0) throw new FrameEncodeError('pcm_s16le payload must hold whole samples')
  if (bytes.byteLength > MAX_AUDIO_PAYLOAD_BYTES) throw new FrameEncodeError('audio payload is too large')
  return encodeFrame({ kind: BinaryFrameKind.audio, utteranceId, tStartMs, payload: bytes })
}

/** `weights` holds k frames of 52 floats, back to back. NaN/Infinity are programmer errors here. */
export function encodeFaceFrame(utteranceId: string | number, tStartMs: number, weights: ArrayLike<number>): Uint8Array {
  if (weights.length === 0 || weights.length % ARKIT_COUNT !== 0) throw new FrameEncodeError(`face weights must be a multiple of ${ARKIT_COUNT} floats`)
  if (weights.length / ARKIT_COUNT > MAX_FACE_FRAMES_PER_MESSAGE) throw new FrameEncodeError('too many face frames in one message')
  const payload = new Uint8Array(weights.length * 4)
  const view = new DataView(payload.buffer)
  for (let i = 0; i < weights.length; i++) {
    const w = weights[i] as number
    if (!Number.isFinite(w)) throw new FrameEncodeError('face weights must be finite')
    view.setFloat32(i * 4, w, true)
  }
  return encodeFrame({ kind: BinaryFrameKind.face, utteranceId, tStartMs, payload })
}

/** Samples of an audio payload (decoded little-endian, independent of platform endianness). */
export function audioSamples(payload: Uint8Array): Int16Array {
  const n = payload.byteLength >> 1
  const out = new Int16Array(n)
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, true)
  return out
}

/** The 52-float frames of a face payload. */
export function faceFrames(payload: Uint8Array): Float32Array[] {
  const k = Math.floor(payload.byteLength / FACE_FRAME_BYTES)
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  const out: Float32Array[] = []
  for (let f = 0; f < k; f++) {
    const frame = new Float32Array(ARKIT_COUNT)
    for (let i = 0; i < ARKIT_COUNT; i++) frame[i] = view.getFloat32((f * ARKIT_COUNT + i) * 4, true)
    out.push(frame)
  }
  return out
}

export const audioDurationMs = (bytes: number, sampleRate = AUDIO_SAMPLE_RATE): number => (bytes / 2 / sampleRate) * 1000
export const faceFrameTimeMs = (tStartMs: number, index: number): number => tStartMs + (index * 1000) / FACE_FPS
