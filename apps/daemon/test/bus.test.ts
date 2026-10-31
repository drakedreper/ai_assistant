import { describe, expect, it } from 'vitest'
import { EventBus } from '../src/bus'

const draft = (n: number) => ({ type: 'chat.done' as const, messageId: `m${n}` })

describe('EventBus', () => {
  it('stamps a monotonic seq and an ISO ts, starting at 1', () => {
    const bus = new EventBus({ now: () => new Date('2026-11-02T10:00:00.000Z') })
    expect(bus.latestSeq).toBe(0)
    const a = bus.publish(draft(1))
    const b = bus.publish(draft(2))
    expect([a.seq, b.seq]).toEqual([1, 2])
    expect(a.ts).toBe('2026-11-02T10:00:00.000Z')
    expect(bus.latestSeq).toBe(2)
  })

  it('has a random epoch per instance', () => {
    expect(new EventBus().epoch).not.toBe(new EventBus().epoch)
    expect(new EventBus({ epoch: 'fixed' }).epoch).toBe('fixed')
  })

  it('keeps a bounded ring buffer and reports the oldest buffered seq', () => {
    const bus = new EventBus({ bufferSize: 5 })
    expect(bus.oldestSeq).toBe(1)
    for (let i = 1; i <= 12; i++) bus.publish(draft(i))
    expect(bus.buffered).toBe(5)
    expect(bus.oldestSeq).toBe(8)
    expect(bus.eventsAfter(9).map((e) => e.seq)).toEqual([10, 11, 12])
    expect(bus.eventsAfter(0).map((e) => e.seq)).toEqual([8, 9, 10, 11, 12])
  })

  it('lets a lazy publisher know its own seq (snapshot.reset carries it)', () => {
    const bus = new EventBus()
    bus.publish(draft(1))
    let seen = -1
    const e = bus.publishLazy((seq) => {
      seen = seq
      return draft(2)
    })
    expect(seen).toBe(2)
    expect(e.seq).toBe(2)
  })

  it('isolates subscribers: a throwing listener does not stop the others or the publisher', () => {
    const bus = new EventBus()
    const got: number[] = []
    bus.subscribe(() => {
      throw new Error('boom')
    })
    bus.subscribe((e) => got.push(e.seq))
    expect(() => bus.publish(draft(1))).not.toThrow()
    expect(got).toEqual([1])
  })

  it('unsubscribes', () => {
    const bus = new EventBus()
    const got: number[] = []
    const off = bus.subscribe((e) => got.push(e.seq))
    bus.publish(draft(1))
    off()
    bus.publish(draft(2))
    expect(got).toEqual([1])
    expect(bus.listenerCount()).toBe(0)
  })
})

describe('EventBus.planReplay (resume rule)', () => {
  const make = (published: number, bufferSize = 5) => {
    const bus = new EventBus({ bufferSize, epoch: 'E1' })
    for (let i = 1; i <= published; i++) bus.publish(draft(i))
    return bus
  }

  it('without `since`: live only, nothing replayed', () => {
    expect(make(3).planReplay(undefined, undefined)).toEqual({ kind: 'replay', events: [] })
    expect(make(3).planReplay(undefined, 'E1')).toEqual({ kind: 'replay', events: [] })
  })

  it('same epoch and since inside the buffer: replays exactly the missed events', () => {
    const plan = make(4).planReplay(2, 'E1')
    expect(plan.kind).toBe('replay')
    if (plan.kind === 'replay') expect(plan.events.map((e) => e.seq)).toEqual([3, 4])
  })

  it('up to date: replays nothing and does not resync', () => {
    expect(make(4).planReplay(4, 'E1')).toEqual({ kind: 'replay', events: [] })
    expect(new EventBus({ epoch: 'E1' }).planReplay(0, 'E1')).toEqual({ kind: 'replay', events: [] })
  })

  it('a different epoch means a daemon restart: resync, whatever the numbers say', () => {
    expect(make(4).planReplay(2, 'OTHER')).toEqual({ kind: 'resync', reason: 'epoch' })
    expect(make(4).planReplay(0, 'OTHER')).toEqual({ kind: 'resync', reason: 'epoch' })
  })

  it('a since newer than anything published belongs to another run: resync', () => {
    expect(make(4).planReplay(99, 'E1')).toEqual({ kind: 'resync', reason: 'future' })
  })

  it('a since older than the buffer is a gap: resync; exactly at the edge is still fine', () => {
    const bus = make(12) // buffer holds 8..12
    expect(bus.planReplay(2, 'E1')).toEqual({ kind: 'resync', reason: 'gap' })
    expect(bus.planReplay(6, 'E1')).toEqual({ kind: 'resync', reason: 'gap' })
    const edge = bus.planReplay(7, 'E1')
    expect(edge.kind).toBe('replay')
    if (edge.kind === 'replay') expect(edge.events.map((e) => e.seq)).toEqual([8, 9, 10, 11, 12])
  })

  it('`since` without an epoch cannot be verified: resync', () => {
    expect(make(4).planReplay(2, undefined)).toEqual({ kind: 'resync', reason: 'unknown_epoch' })
  })
})
