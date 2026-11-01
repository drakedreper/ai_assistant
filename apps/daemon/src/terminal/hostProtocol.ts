/**
 * The framed protocol between the daemon and a PTY host process (src/terminal/ptyHost.ts), over the host's stdin
 * (daemon to host) and stdout (host to daemon).
 *
 * Why the host speaks over stdin and stdout and not over an IPC channel: the PTY child is started by the host, and a
 * descriptor above 2 that is not close-on-exec would be inherited by the shell and everything it runs. The host's
 * descriptors 0, 1 and 2 are replaced by the PTY slave in the child, so nothing of this channel can reach it.
 *
 * A frame is `type (1 byte) | length (4 bytes, big endian) | payload`. The payload of `data` and `write` is raw bytes
 * (output, and UTF-8 text typed by the user); every other payload is a small JSON object. Terminal bytes travel only
 * as the payload of those two frame types and are never logged by either side.
 */

export const FrameType = {
  /** daemon -> host: start the program. JSON {@link SpawnRequest}. The first frame, and the only one that may come first. */
  spawn: 0x01,
  /** daemon -> host: UTF-8 text for the PTY (keystrokes). */
  write: 0x02,
  /** daemon -> host: JSON {cols, rows}. */
  resize: 0x03,
  /** daemon -> host: end the PTY (SIGHUP on POSIX, the process on Windows). Empty payload. */
  kill: 0x04,
  /** host -> daemon: the program started. JSON {pid}. */
  spawned: 0x81,
  /** host -> daemon: it could not start. JSON {message, unavailable}. The host exits right after. */
  spawnFailed: 0x82,
  /** host -> daemon: output bytes. */
  data: 0x83,
  /** host -> daemon: the program ended. JSON {exitCode, signal?}. The host exits right after. */
  exit: 0x84,
} as const

export type FrameTypeValue = (typeof FrameType)[keyof typeof FrameType]
const KNOWN = new Set<number>(Object.values(FrameType))

export const HEADER_BYTES = 5
/** No legitimate frame is this large (output is cut into 64 KiB frames, a keystroke frame is capped at 64 KiB). */
export const MAX_FRAME_BYTES = 4 * 1024 * 1024
/** The host cuts output into frames of at most this many bytes. */
export const MAX_DATA_FRAME = 64 * 1024

export class ProtocolError extends Error {
  override name = 'ProtocolError'
}

export interface Frame {
  type: FrameTypeValue
  payload: Buffer
}

export interface SpawnRequest {
  file: string
  /** argv, or on Windows a ready-made command line. */
  args: string | string[]
  cwd: string
  env: Record<string, string>
  cols: number
  rows: number
  /** How long the host waits for a polite end before it kills hard, when it has to end the tree itself (the daemon is gone). */
  graceMs?: number
}

export function encodeFrame(type: FrameTypeValue, payload?: Uint8Array | string | object): Buffer {
  const body = payload === undefined ? Buffer.alloc(0) : typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload instanceof Uint8Array ? Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength) : Buffer.from(JSON.stringify(payload), 'utf8')
  if (body.length > MAX_FRAME_BYTES) throw new ProtocolError('frame too large')
  const out = Buffer.allocUnsafe(HEADER_BYTES + body.length)
  out[0] = type
  out.writeUInt32BE(body.length, 1)
  body.copy(out, HEADER_BYTES)
  return out
}

/** Cut a byte stream into frames. Throws ProtocolError on an unknown type or an oversized length: the stream is then unusable. */
export class FrameDecoder {
  private pending: Buffer = Buffer.alloc(0)

  push(chunk: Buffer): Frame[] {
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk])
    const out: Frame[] = []
    let off = 0
    while (this.pending.length - off >= HEADER_BYTES) {
      const type = this.pending[off] as number
      const len = this.pending.readUInt32BE(off + 1)
      if (!KNOWN.has(type)) throw new ProtocolError('unknown frame type')
      if (len > MAX_FRAME_BYTES) throw new ProtocolError('frame too large')
      if (this.pending.length - off - HEADER_BYTES < len) break
      out.push({ type: type as FrameTypeValue, payload: this.pending.subarray(off + HEADER_BYTES, off + HEADER_BYTES + len) })
      off += HEADER_BYTES + len
    }
    // Copy what is left so a retained subarray never pins a large chunk.
    this.pending = off >= this.pending.length ? Buffer.alloc(0) : Buffer.from(this.pending.subarray(off))
    return out
  }

  /** Bytes of an incomplete frame that are waiting for the rest. */
  get buffered(): number {
    return this.pending.length
  }
}

export function parseJson(payload: Buffer): Record<string, unknown> {
  let v: unknown
  try {
    v = JSON.parse(payload.toString('utf8'))
  } catch {
    throw new ProtocolError('bad JSON payload')
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new ProtocolError('payload is not an object')
  return v as Record<string, unknown>
}

const isInt = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max

/** Validate a spawn payload strictly: the host runs whatever it says. */
export function parseSpawnRequest(payload: Buffer): SpawnRequest {
  const o = parseJson(payload)
  const { file, args, cwd, env, cols, rows } = o
  if (typeof file !== 'string' || file.length === 0 || file.includes('\0')) throw new ProtocolError('bad file')
  const argsOk = typeof args === 'string' ? !args.includes('\0') : Array.isArray(args) && args.every((a) => typeof a === 'string' && !a.includes('\0'))
  if (!argsOk) throw new ProtocolError('bad args')
  if (typeof cwd !== 'string' || cwd.length === 0 || cwd.includes('\0')) throw new ProtocolError('bad cwd')
  if (env === null || typeof env !== 'object' || Array.isArray(env)) throw new ProtocolError('bad env')
  const cleanEnv: Record<string, string> = {}
  for (const [k, v] of Object.entries(env as Record<string, unknown>)) {
    if (typeof v !== 'string' || k.length === 0 || k.includes('=') || k.includes('\0') || v.includes('\0')) throw new ProtocolError('bad env entry')
    cleanEnv[k] = v
  }
  if (!isInt(cols, 1, 1000) || !isInt(rows, 1, 1000)) throw new ProtocolError('bad size')
  const graceMs = o.graceMs
  if (graceMs !== undefined && !isInt(graceMs, 0, 60_000)) throw new ProtocolError('bad grace')
  return { file, args: args as string | string[], cwd, env: cleanEnv, cols, rows, ...(graceMs !== undefined ? { graceMs } : {}) }
}

export function parseResize(payload: Buffer): { cols: number; rows: number } {
  const o = parseJson(payload)
  if (!isInt(o.cols, 1, 1000) || !isInt(o.rows, 1, 1000)) throw new ProtocolError('bad size')
  return { cols: o.cols, rows: o.rows }
}
