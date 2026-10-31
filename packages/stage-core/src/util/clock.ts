/**
 * Time seams. Nothing in stage-core reads Date.now(), Math.random() or setTimeout directly: the owner injects a
 * Clock and Timers (real ones in the daemon, a VirtualTime in tests), so every behaviour is deterministic.
 */
export interface Clock {
  /** Epoch milliseconds. */
  now(): number
}

export type TimerHandle = unknown

export interface Timers {
  setTimeout(fn: () => void, ms: number): TimerHandle
  clearTimeout(handle: TimerHandle): void
}

export const systemClock: Clock = { now: () => Date.now() }

export const systemTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
}

export interface VirtualTime {
  clock: Clock
  timers: Timers
  /** Move time forward, firing due timers in order (timers scheduled by fired timers also fire if due). */
  advance(ms: number): void
  /** Set absolute time (never backwards for timers; it only fires timers that became due). */
  set(ms: number): void
  /** Number of timers waiting. */
  pending(): number
  /** Fire everything that is pending regardless of its due time (time jumps to the last one). Guarded loop. */
  runAll(maxTimers?: number): void
  now(): number
}

/** A manual clock plus timers for tests and the simulator. Deterministic: ties fire in scheduling order. */
export function createVirtualTime(startMs = 0): VirtualTime {
  let t = startMs
  let seq = 0
  interface Entry { id: number; at: number; fn: () => void }
  let queue: Entry[] = []
  const handles = new Map<number, Entry>()

  const fireDue = (limit: number): void => {
    for (;;) {
      let best: Entry | undefined
      for (const e of queue) {
        if (e.at <= limit && (!best || e.at < best.at || (e.at === best.at && e.id < best.id))) best = e
      }
      if (!best) return
      queue = queue.filter((e) => e !== best)
      handles.delete(best.id)
      if (best.at > t) t = best.at
      best.fn()
    }
  }

  const vt: VirtualTime = {
    clock: { now: () => t },
    timers: {
      setTimeout(fn, ms) {
        const delay = Number.isFinite(ms) && ms > 0 ? ms : 0
        const e: Entry = { id: ++seq, at: t + delay, fn }
        queue.push(e)
        handles.set(e.id, e)
        return e.id
      },
      clearTimeout(h) {
        if (typeof h !== 'number') return
        const e = handles.get(h)
        if (!e) return
        handles.delete(h)
        queue = queue.filter((x) => x !== e)
      },
    },
    advance(ms) {
      const target = t + Math.max(0, ms)
      fireDue(target)
      t = target
    },
    set(ms) {
      if (ms < t) {
        t = ms
        return
      }
      fireDue(ms)
      t = ms
    },
    pending: () => queue.length,
    runAll(maxTimers = 100_000) {
      let n = 0
      while (queue.length > 0) {
        if (++n > maxTimers) throw new Error('VirtualTime.runAll: too many timers (runaway loop?)')
        const next = queue.reduce((a, b) => (b.at < a.at || (b.at === a.at && b.id < a.id) ? b : a))
        fireDue(next.at)
      }
    },
    now: () => t,
  }
  return vt
}

export const isoFromMs = (ms: number): string => new Date(ms).toISOString()
