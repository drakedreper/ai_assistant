/**
 * A byte ring buffer for terminal output: the last `maxBytes` bytes, in memory only (never written to disk, never
 * logged), replayed to a client that attaches later. It is allocated once at its full size, so it can neither grow
 * nor fragment.
 *
 * The cut can land inside a UTF-8 character: the replay then skips the orphaned continuation bytes. It can also land
 * inside an escape sequence or in the middle of a line, and a full-screen program (Claude Code redraws in place)
 * is not reconstructed from a byte tail: the replay is the recent output, not a screen snapshot. That is a known
 * limit, stated in the README.
 */
export class Scrollback {
  private readonly buf: Buffer
  private start = 0
  private len = 0
  private truncatedFlag = false

  constructor(readonly maxBytes: number) {
    if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new RangeError('maxBytes must be a positive integer')
    this.buf = Buffer.alloc(maxBytes)
  }

  get size(): number {
    return this.len
  }

  get truncated(): boolean {
    return this.truncatedFlag
  }

  push(chunk: Uint8Array): void {
    const n = chunk.length
    if (n === 0) return
    const max = this.maxBytes
    if (n >= max) {
      this.buf.set(chunk.subarray(n - max), 0)
      this.start = 0
      this.len = max
      this.truncatedFlag = this.truncatedFlag || n > max
      return
    }
    const end = (this.start + this.len) % max
    const firstPart = Math.min(n, max - end)
    this.buf.set(chunk.subarray(0, firstPart), end)
    if (firstPart < n) this.buf.set(chunk.subarray(firstPart), 0)
    const total = this.len + n
    if (total > max) {
      this.start = (this.start + (total - max)) % max
      this.len = max
      this.truncatedFlag = true
    } else {
      this.len = total
    }
  }

  /** The buffered bytes in order, as one copy. Starts on a UTF-8 character boundary. */
  snapshot(): Buffer {
    if (this.len === 0) return Buffer.alloc(0)
    const out = Buffer.allocUnsafe(this.len)
    const firstPart = Math.min(this.len, this.maxBytes - this.start)
    this.buf.copy(out, 0, this.start, this.start + firstPart)
    if (firstPart < this.len) this.buf.copy(out, firstPart, 0, this.len - firstPart)
    if (!this.truncatedFlag) return out
    let skip = 0
    while (skip < 3 && skip < out.length && ((out[skip] as number) & 0xc0) === 0x80) skip++
    return skip === 0 ? out : out.subarray(skip)
  }

  clear(): void {
    this.start = 0
    this.len = 0
    this.truncatedFlag = false
  }
}
