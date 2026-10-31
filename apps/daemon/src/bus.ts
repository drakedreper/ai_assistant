import { randomBytes } from 'node:crypto'
import type { ServerEvent, ServerEventDraft } from '@ai-assistant/shared'

export type ReplayPlan =
  /** The client is current or can be brought current by replaying `events` (oldest first). */
  | { kind: 'replay'; events: ServerEvent[] }
  /** The client must discard its state and refetch GET /api/snapshot. */
  | { kind: 'resync'; reason: 'epoch' | 'gap' | 'future' | 'unknown_epoch' }

export interface EventBusOptions {
  bufferSize?: number
  now?: () => Date
  epoch?: string
}

export type BusListener = (event: ServerEvent) => void

/**
 * One monotonic sequence for every ServerEvent, plus a ring buffer for WebSocket replay.
 *
 * Resume rule (documented in README and sent in the WS hello as `resync`):
 *   - no `since`                    -> live events only, nothing replayed;
 *   - `epoch` differs               -> resync (a daemon restart resets the sequence, numbers are never compared across runs);
 *   - `since` newer than latest     -> resync (the client is from another run);
 *   - `since` older than the buffer -> resync (a gap: events were evicted);
 *   - otherwise                     -> replay every buffered event with seq > since.
 * A client that passes `since` without `epoch` cannot be verified and is told to resync, so send the epoch
 * (the X-Daemon-Epoch header of GET /api/snapshot and /api/health, or the hello of an earlier connection).
 */
export class EventBus {
  readonly epoch: string
  private seq = 0
  private readonly ring: ServerEvent[] = []
  private readonly size: number
  private readonly listeners = new Set<BusListener>()
  private readonly now: () => Date

  constructor(opts: EventBusOptions = {}) {
    this.size = Math.max(1, opts.bufferSize ?? 2000)
    this.now = opts.now ?? (() => new Date())
    this.epoch = opts.epoch ?? randomBytes(8).toString('hex')
  }

  get latestSeq(): number {
    return this.seq
  }

  /** Seq of the oldest event still buffered, or latest+1 when the buffer is empty. */
  get oldestSeq(): number {
    return this.ring[0]?.seq ?? this.seq + 1
  }

  get buffered(): number {
    return this.ring.length
  }

  /** Stamp a draft with the next seq and ts, buffer it, and fan it out. */
  publish(draft: ServerEventDraft): ServerEvent {
    return this.publishLazy(() => draft)
  }

  /** Like publish, but the draft is built knowing its own seq (a snapshot.reset must carry that seq). */
  publishLazy(build: (seq: number) => ServerEventDraft): ServerEvent {
    const seq = this.seq + 1
    const draft = build(seq)
    this.seq = seq
    const event = { ...draft, seq, ts: this.now().toISOString() } as ServerEvent
    this.ring.push(event)
    if (this.ring.length > this.size) this.ring.splice(0, this.ring.length - this.size)
    for (const l of [...this.listeners]) {
      try {
        l(event)
      } catch {
        // a broken subscriber must not stop the others or the publisher
      }
    }
    return event
  }

  subscribe(listener: BusListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Buffered events with seq > `since`, oldest first. */
  eventsAfter(since: number): ServerEvent[] {
    return this.ring.filter((e) => e.seq > since)
  }

  /** Decide how to serve a client that asks to resume from `since` in `epoch`. */
  planReplay(since: number | undefined, epoch: string | undefined): ReplayPlan {
    if (since === undefined) return { kind: 'replay', events: [] }
    if (epoch === undefined) return { kind: 'resync', reason: 'unknown_epoch' }
    if (epoch !== this.epoch) return { kind: 'resync', reason: 'epoch' }
    if (since > this.seq) return { kind: 'resync', reason: 'future' }
    if (since < this.seq && since + 1 < this.oldestSeq) return { kind: 'resync', reason: 'gap' }
    return { kind: 'replay', events: this.eventsAfter(since) }
  }

  listenerCount(): number {
    return this.listeners.size
  }
}
