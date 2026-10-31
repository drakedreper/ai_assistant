/**
 * Small internal helpers shared by the backends, the broker and the lane. No I/O, no globals.
 */
import type { BackendErrorKind, ToolSpec } from '@ai-assistant/shared'

export type Tier = ToolSpec['tier']

const TIER_RANK: Record<Tier, number> = { T0: 0, T1: 1, T2: 2, T3: 3, T4: 4 }

export const tierRank = (t: Tier): number => TIER_RANK[t]

/** Tiers that run without an approval card unless the user changed that (ADR 0005: T0 auto, T1 auto and logged). */
export const isAutoTier = (t: Tier): boolean => tierRank(t) <= 1

/** Cut a string to `max` characters, marking the cut. Never throws on non-strings. */
export function truncate(text: string, max: number): string {
  if (max <= 0) return ''
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

/** Collapse all whitespace (including CR and LF) to single spaces. */
export const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/sk-ant-[A-Za-z0-9_-]{8,}/g, 'sk-ant-[redacted]'],
  [/\bsk-[A-Za-z0-9]{20,}\b/g, 'sk-[redacted]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, 'Bearer [redacted]'],
  [/\b(gh[pousr]_[A-Za-z0-9]{20,})\b/g, '[redacted-token]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[redacted-key]'],
  [/\b(api[_-]?key|apikey|token|secret|passwd|password|authorization)(["']?\s*[:=]\s*["']?)([^\s"',;&]{4,})/gi, '$1$2[redacted]'],
]

/** Best-effort removal of credentials from text that is about to be shown or persisted. Not a security boundary. */
export function redactSecrets(text: string): string {
  let out = text
  for (const [re, repl] of SECRET_PATTERNS) out = out.replace(re, repl)
  return out
}

/** Stable JSON for previews: object keys sorted, never throws (circular and BigInt values become strings). */
export function safeJson(value: unknown, space = 0): string {
  const seen = new WeakSet<object>()
  const norm = (v: unknown): unknown => {
    if (typeof v === 'bigint') return v.toString()
    if (v === null || typeof v !== 'object') return v
    if (seen.has(v)) return '[circular]'
    seen.add(v)
    if (Array.isArray(v)) return v.map(norm)
    const o: Record<string, unknown> = {}
    for (const k of Object.keys(v as Record<string, unknown>).sort()) o[k] = norm((v as Record<string, unknown>)[k])
    return o
  }
  try {
    return JSON.stringify(norm(value), null, space) ?? ''
  } catch {
    return '[unserialisable]'
  }
}

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export const errorText = (e: unknown): string => (e instanceof Error ? e.message : typeof e === 'string' ? e : 'unknown error')

/** A failure with a machine-readable kind, so the lane can answer in a friendly way and decide about restarting. */
export class BackendError extends Error {
  constructor(
    message: string,
    readonly kind: BackendErrorKind,
    readonly retryable = false,
  ) {
    super(message)
    this.name = 'BackendError'
  }
}

/**
 * A push queue exposed as ONE async iterator. `push` never blocks; `end` lets the consumer drain what is queued
 * and then finish. Single consumer by design (the same iterator is returned every time).
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = []
  private waiter: ((r: IteratorResult<T>) => void) | undefined
  private ended = false
  private readonly iterator: AsyncIterator<T>

  constructor() {
    this.iterator = {
      next: () => {
        const item = this.items.shift()
        if (item !== undefined) return Promise.resolve({ value: item, done: false })
        if (this.ended) return Promise.resolve({ value: undefined, done: true })
        return new Promise<IteratorResult<T>>((resolve) => {
          this.waiter = resolve
        })
      },
      return: () => {
        this.end()
        return Promise.resolve({ value: undefined, done: true })
      },
    }
  }

  push(item: T): void {
    if (this.ended) return
    const w = this.waiter
    if (w) {
      this.waiter = undefined
      w({ value: item, done: false })
    } else {
      this.items.push(item)
    }
  }

  end(): void {
    if (this.ended) return
    this.ended = true
    const w = this.waiter
    if (w) {
      this.waiter = undefined
      w({ value: undefined, done: true })
    }
  }

  get isEnded(): boolean {
    return this.ended
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this.iterator
  }
}

export interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/** A sleep that can be cut short. Resolves true when it ran to completion, false when aborted. */
export function abortableSleep(ms: number, signal?: { aborted: boolean; onAbort(cb: () => void): void }): Promise<boolean> {
  if (ms <= 0) return Promise.resolve(!signal?.aborted)
  return new Promise<boolean>((resolve) => {
    if (signal?.aborted) return resolve(false)
    const t = setTimeout(() => resolve(true), ms)
    signal?.onAbort(() => {
      clearTimeout(t)
      resolve(false)
    })
  })
}

/** The spec's JSON-ish "raw shape" (zod object shape), or undefined when the schema is not an object schema. */
export function rawShapeOf(schema: unknown): Record<string, unknown> | undefined {
  const shape = (schema as { shape?: unknown } | null | undefined)?.shape
  return isRecord(shape) ? shape : undefined
}
