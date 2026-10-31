import { HookPayload } from '@ai-assistant/shared'
import type { Logger } from '../log'
import type { Store } from '../store'
import { redactHookPayload } from '../store/redact'
import type { HookProjection } from './projection'

export interface Scheduler {
  setInterval(fn: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
}

export const realScheduler: Scheduler = {
  setInterval(fn, ms) {
    const h = setInterval(fn, ms)
    h.unref()
    return h
  },
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
}

export interface HookServiceDeps {
  store: Store
  projection: HookProjection
  clock: () => number
  log: Logger
  literals?: () => string[]
  scheduler?: Scheduler
  sweepIntervalMs: number
  /** Raw events kept per session. */
  rawEventsPerSession?: number
  /** Jobs waiting for projection. Beyond this, events are dropped (counted) rather than growing memory. */
  maxQueue?: number
}

export interface HookStats {
  received: number
  lastAt: string | null
  /** Bodies that were not a JSON object. */
  invalid: number
  dropped: number
  duplicates: number
  /** Events of sessions the Secretary lane owns: dropped, the lane streams those. */
  ownedDropped: number
  projected: number
}

const STRING_FIELDS = [
  'session_id', 'hook_event_name', 'cwd', 'transcript_path', 'permission_mode', 'agent_id', 'agent_type',
  'tool_name', 'tool_use_id', 'prompt', 'message', 'notification_type', 'model', 'source', 'reason',
] as const

/** Keep only well-typed values for the fields the projection reads, so one odd field never discards a whole event. */
function sanitize(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...obj }
  for (const k of STRING_FIELDS) if (k in out && typeof out[k] !== 'string') delete out[k]
  return out
}

const EVENT_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/

interface Job {
  urlEvent: string
  body: string
}

/**
 * Receives hook bodies after the HTTP response has been sent. Nothing here can slow Claude Code down or make a
 * hook fail: the route answers 200 first, this queue processes later, and every job is wrapped in a try/catch.
 */
export class HookService {
  private readonly queue: Job[] = []
  private scheduled = false
  private waiters: Array<() => void> = []
  private timer: unknown
  private insertCount = 0
  readonly counters: HookStats = { received: 0, lastAt: null, invalid: 0, dropped: 0, duplicates: 0, ownedDropped: 0, projected: 0 }

  constructor(private readonly deps: HookServiceDeps) {}

  stats(): HookStats {
    return { ...this.counters }
  }

  /** Called by the route once a bearer-authenticated hook request has arrived. Returns immediately. */
  enqueue(urlEvent: string, body: string): void {
    this.counters.received++
    this.counters.lastAt = new Date(this.deps.clock()).toISOString()
    if (this.queue.length >= (this.deps.maxQueue ?? 2000)) {
      this.counters.dropped++
      return
    }
    this.queue.push({ urlEvent, body })
    this.schedule()
  }

  private schedule(): void {
    if (this.scheduled) return
    this.scheduled = true
    setImmediate(() => this.flush())
  }

  private flush(): void {
    for (let i = 0; i < 50; i++) {
      const job = this.queue.shift()
      if (!job) break
      try {
        this.process(job)
      } catch (err) {
        this.deps.log.warn('hook processing failed', { error: err instanceof Error ? err.message : 'unknown' })
      }
    }
    this.scheduled = false
    if (this.queue.length > 0) this.schedule()
    else {
      const w = this.waiters
      this.waiters = []
      for (const r of w) r()
    }
  }

  /** Resolves once every event received so far has been processed (tests, graceful shutdown). */
  drain(): Promise<void> {
    if (this.queue.length === 0 && !this.scheduled) return Promise.resolve()
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  private process(job: Job): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(job.body)
    } catch {
      this.counters.invalid++
      return
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.counters.invalid++
      return
    }
    const obj = sanitize(parsed as Record<string, unknown>)
    const literals = this.deps.literals?.() ?? []
    const named = typeof obj.hook_event_name === 'string' ? obj.hook_event_name : job.urlEvent
    const event = EVENT_NAME.test(named) ? named : EVENT_NAME.test(job.urlEvent) ? job.urlEvent : 'Unknown'
    const sid = typeof obj.session_id === 'string' && obj.session_id.length > 0 && obj.session_id.length <= 200 ? obj.session_id : null

    if (sid && this.deps.store.isLaneSession(sid)) {
      this.counters.ownedDropped++
      return
    }

    const toolUseId = typeof obj.tool_use_id === 'string' ? obj.tool_use_id : null
    const agentId = typeof obj.agent_id === 'string' ? obj.agent_id : null
    // Events without a tool_use_id (Stop, UserPromptSubmit...) can legitimately repeat, so they get no dedupe key.
    const dedupeKey = sid && toolUseId ? `${sid}|${toolUseId}|${event}` : sid && agentId && event.startsWith('Subagent') ? `${sid}|${agentId}|${event}` : null

    const redacted = redactHookPayload(obj, literals)
    const { inserted } = this.deps.store.insertEvent({
      ts: new Date(this.deps.clock()).toISOString(),
      source: 'hook',
      sessionId: sid,
      hookEvent: event,
      toolUseId,
      payloadJson: redacted.json,
      dedupeKey,
    })
    if (!inserted) {
      this.counters.duplicates++
      return
    }
    if (sid && ++this.insertCount % 25 === 0) this.deps.store.pruneEvents(sid, this.deps.rawEventsPerSession ?? 500)

    const valid = HookPayload.safeParse(obj)
    if (!sid || !valid.success) return // stored raw, nothing to project
    const result = this.deps.projection.apply(event, valid.data)
    if (result.handled) this.counters.projected++
  }

  /** Start the staleness timer. */
  start(): void {
    if (this.timer !== undefined) return
    const scheduler = this.deps.scheduler ?? realScheduler
    this.timer = scheduler.setInterval(() => {
      try {
        this.deps.projection.sweep()
      } catch (err) {
        this.deps.log.warn('staleness sweep failed', { error: err instanceof Error ? err.message : 'unknown' })
      }
    }, this.deps.sweepIntervalMs)
  }

  stop(): void {
    if (this.timer === undefined) return
    ;(this.deps.scheduler ?? realScheduler).clearInterval(this.timer)
    this.timer = undefined
  }
}
