import { describe, expect, it } from 'vitest'
import { AUTHORITY_PRESENCE } from '@ai-assistant/shared'
import {
  BehaviorDirector,
  CameraDirector,
  InterruptionBudget,
  MAX_PENDING,
  MOOD_DELTAS,
  MoodEngine,
  createRng,
  createVirtualTime,
  inQuietHours,
  isQuietHoursSpec,
  localMinutes,
  msUntilQuietEnds,
  parseHm,
} from '../src'
import type { CommandDraft } from '../src'
import { clampFinite } from '../src/util/math'
import { T0, at, lcg } from './helpers'

/**
 * Regression tests for the mood and behaviour findings: event types are looked up in the table's own entries, restore
 * does not trust a row, the director's queue is bounded and coalesced, a clock that goes back (or is not a time at all)
 * does not silence her or poison her cooldowns, and a quiet-hours spec of any shape cannot make a tick throw.
 */

const ALL_OBJECT_PROTOTYPE_NAMES = [...Object.getOwnPropertyNames(Object.prototype), '__proto__', 'prototype', 'then', 'toJSON', '__lookupGetter__']

describe('MoodEngine event types are looked up in the table, not on Object.prototype (MEDIUM: mood-prototype-event-types)', () => {
  it.each(ALL_OBJECT_PROTOTYPE_NAMES)('apply({ type: %j }) changes nothing and never makes the mood NaN', (type) => {
    const vt = createVirtualTime(T0)
    const m = new MoodEngine({ clock: vt.clock })
    const before = m.snapshot()
    const after = m.apply({ type: type as never })
    expect(after).toMatchObject({ valence: before.valence, arousal: before.arousal, dominance: before.dominance })
    for (const v of [after.valence, after.arousal, after.dominance]) expect(Number.isFinite(v)).toBe(true)
    const s = m.snapshot()
    expect([s.valence, s.arousal, s.dominance].every(Number.isFinite)).toBe(true)
    expect(JSON.parse(JSON.stringify(s)).valence).toBe(before.valence) // a NaN would serialise as null
    expect(m.get().label).toBe('neutral')
  })
  it('the real event types still work, with a magnitude, and nothing else does', () => {
    const vt = createVirtualTime(T0)
    const m = new MoodEngine({ clock: vt.clock })
    const v0 = m.get().valence
    expect(m.apply({ type: 'praise', magnitude: 1 }).valence).toBeGreaterThan(v0)
    for (const bad of [null, undefined, 'praise', 5, [], { type: 5 }, { type: null }, { type: ['praise'] }, { type: 'praise', magnitude: 'big' }, { type: 'praise', magnitude: Number.NaN }, { type: 'praise', magnitude: Number.POSITIVE_INFINITY }, {}]) {
      const before = m.snapshot()
      expect(() => m.apply(bad as never), JSON.stringify(bad)).not.toThrow()
      const after = m.snapshot()
      expect(after.valence).toBe(before.valence)
    }
    expect(Object.keys(MOOD_DELTAS)).toContain('praise')
  })
  it('a table entry that is not an own entry cannot be reached through the prototype chain of a type string object', () => {
    const vt = createVirtualTime(T0)
    const m = new MoodEngine({ clock: vt.clock })
    const before = m.snapshot()
    m.apply({ type: new String('praise') as never })
    expect(m.snapshot().valence).toBe(before.valence)
  })
})

describe('MoodEngine.restore does not trust a stored row (LOW: mood-restore-type-confusion)', () => {
  const base = { valence: 0.2, arousal: -0.1, dominance: 0.7 }
  const HOSTILE: unknown[] = ['0.5', 'abc', '', null, undefined, {}, [], [0.2], true, false, Symbol('x'), 5n, () => 0.1, new Date(0), Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]
  it.each(HOSTILE.map((h, i) => [i, h] as const))('a stored value of kind #%s becomes the baseline (or a clamped number), always a finite number', (_i, bad) => {
    const vt = createVirtualTime(T0)
    const m = new MoodEngine({ clock: vt.clock, baseline: base })
    expect(() => m.restore({ valence: bad as number, arousal: bad as number, dominance: bad as number, at: T0 })).not.toThrow()
    const a = m.get()
    for (const v of [a.valence, a.arousal, a.dominance]) {
      expect(typeof v).toBe('number')
      expect(Number.isFinite(v)).toBe(true)
      expect(v).toBeGreaterThanOrEqual(-1)
      expect(v).toBeLessThanOrEqual(1)
    }
    if (typeof bad !== 'number') expect([a.valence, a.arousal, a.dominance]).toEqual([base.valence, base.arousal, base.dominance])
  })
  it('a snapshot that is not an object, or has a bad time, is tolerated', () => {
    const vt = createVirtualTime(T0)
    const m = new MoodEngine({ clock: vt.clock, baseline: base })
    for (const s of [null, undefined, 5, 'x', []]) expect(() => m.restore(s as never)).not.toThrow()
    for (const at of ['x', null, Number.NaN, Number.POSITIVE_INFINITY, {}]) {
      m.restore({ valence: 0.9, arousal: 0.9, dominance: 0.9, at: at as number })
      expect(m.snapshot().at).toBe(T0)
    }
    m.restore({ valence: 0.9, arousal: 0.9, dominance: 0.9, at: T0 - 60_000 })
    expect(m.get().valence).toBeLessThan(0.9) // a good row still decays toward the baseline
  })
  it('a numeric string is NOT read as a number any more (the daemon feeds Number()-converted rows, so it never relied on it)', () => {
    const vt = createVirtualTime(T0)
    const m = new MoodEngine({ clock: vt.clock, baseline: base })
    m.restore({ valence: '0.9' as never, arousal: 0, dominance: 0, at: T0 })
    expect(m.get().valence).toBe(base.valence)
  })
  it('clampFinite: everything that is not a number falls back, numbers clamp, infinities hit the ends', () => {
    expect(clampFinite('5' as never, 0, 1, 0.3)).toBe(0.3)
    expect(clampFinite(null as never, 0, 1, 0.3)).toBe(0.3)
    expect(clampFinite({} as never, 0, 1, 0.3)).toBe(0.3)
    expect(clampFinite(Symbol('s') as never, 0, 1, 0.3)).toBe(0.3)
    expect(clampFinite(5n as never, 0, 1, 0.3)).toBe(0.3)
    expect(clampFinite(Number.NaN, 0, 1, 0.3)).toBe(0.3)
    expect(clampFinite(Number.POSITIVE_INFINITY, 0, 1)).toBe(1)
    expect(clampFinite(Number.NEGATIVE_INFINITY, 0, 1)).toBe(0)
    expect(clampFinite(0.5, 0, 1)).toBe(0.5)
    expect(clampFinite(7, 0, 1, 99)).toBe(1)
    expect(clampFinite(Number.NaN, 0, 1, 99)).toBe(1) // the fallback is clamped too
  })
  it('a baseline that is not an object does not crash the engine', () => {
    const vt = createVirtualTime(T0)
    expect(() => new MoodEngine({ clock: vt.clock, baseline: null as never })).not.toThrow()
    const m = new MoodEngine({ clock: vt.clock })
    expect(() => m.setBaseline(undefined as never)).not.toThrow()
    expect(m.get().valence).toBeLessThanOrEqual(1)
  })
})

function director(over: Record<string, unknown> = {}, start = T0) {
  const vt = createVirtualTime(start)
  const mood = MoodEngine.fromPresence(AUTHORITY_PRESENCE, vt.clock)
  const d = new BehaviorDirector({ clock: vt.clock, rng: createRng(5), presence: AUTHORITY_PRESENCE, mood, ...over })
  return { vt, mood, d }
}
const count = (cmds: CommandDraft[], type: string): number => cmds.filter((c) => c.type === type).length

describe('the queue of commands waiting for the next tick is bounded and coalesced (MEDIUM: behavior-pending-growth)', () => {
  it('a flood of lookAt calls keeps only the latest gaze: the next tick returns a handful of commands, not a million', () => {
    const { d } = director()
    d.tick() // settle the first tick
    const t0 = performance.now()
    for (let i = 0; i < 200_000; i++) d.lookAt({ kind: 'point', position: [i % 7, 1, 2] })
    expect(performance.now() - t0).toBeLessThan(3000)
    const out = d.tick()
    expect(out.length).toBeLessThanOrEqual(MAX_PENDING + 8) // the queue plus what an ordinary tick adds
    const gazes = out.filter((c) => c.type === 'perform.gaze') as Array<{ target: { kind: string; position?: number[] } }>
    expect(gazes.length).toBeLessThanOrEqual(2)
    expect(gazes[0]!.target).toEqual({ kind: 'point', position: [(200_000 - 1) % 7, 1, 2] }) // the LATEST one
  })
  it('a flood of presence changes is bounded too, and the greeting gesture is not queued twice', () => {
    const { d, vt } = director()
    d.tick()
    for (let i = 0; i < 100_000; i++) {
      d.onUserPresence({ present: i % 2 === 0 })
      if (i % 5000 === 0) vt.advance(10)
    }
    const out = d.tick()
    expect(out.length).toBeLessThanOrEqual(MAX_PENDING + 8)
    expect(count(out, 'perform.gesture')).toBeLessThanOrEqual(2)
  })
  it('the cap holds for any mix, and an explicit hold time is clamped', () => {
    const { d } = director()
    d.tick()
    for (let i = 0; i < 5000; i++) {
      d.lookAt({ kind: 'user' }, i % 2 ? Number.NaN : 1e300)
      d.onUserPresence({ present: i % 3 !== 0 })
    }
    expect(d.tick().length).toBeLessThanOrEqual(MAX_PENDING + 8)
  })
  it('ordinary use is unchanged: one lookAt is delivered once, with the speed her style gives it', () => {
    const { d } = director()
    d.tick()
    d.lookAt({ kind: 'camera' })
    const out = d.tick()
    expect(out.filter((c) => c.type === 'perform.gaze')).toHaveLength(1)
    expect(d.tick().filter((c) => c.type === 'perform.gaze' && (c as { target: { kind: string } }).target.kind === 'camera')).toHaveLength(0)
  })
})

describe('a clock that goes backwards does not silence her (LOW: behavior-clock-backwards-stall)', () => {
  /** The same 80 minutes of ticks every time; the clock is stepped back by `jumpMs` after the 50th minute. Returns what happened in the last 30 minutes. */
  const run = (jumpMs: number) => {
    const { d, vt } = director()
    let now = T0
    const step = (ms: number, total: number) => {
      const counts = { gaze: 0, gesture: 0, affect: 0, idle: 0 }
      for (let t = 0; t < total; t += ms) {
        now += ms
        vt.set(now)
        const out = d.tick(now)
        counts.gaze += count(out, 'perform.gaze')
        counts.gesture += count(out, 'perform.gesture')
        counts.affect += count(out, 'perform.affect')
        counts.idle += count(out, 'perform.idle')
      }
      return counts
    }
    step(1000, 50 * 60_000) // fifty minutes, so every deadline and cooldown is somewhere around "now"
    now -= jumpMs
    vt.set(now)
    return step(1000, 30 * 60_000)
  }
  it('the control (no jump) is the 30 minutes after fifty quiet ones: she gazes, gestures and shows her mood', () => {
    const c = run(0)
    expect(c.gaze).toBeGreaterThan(100)
    expect(c.gesture).toBeGreaterThan(0)
  })
  it.each([
    [60_000, '1 minute'],
    [3_600_000, '1 hour'],
    [86_400_000, '1 day'],
  ] as Array<[number, string]>)('after the clock jumps back %s ms (%s) she keeps moving exactly as without the jump', (jump: number) => {
    const control = run(0)
    const after = run(jump)
    // the old behaviour was { gaze: 0, gesture: 0, affect: 0 } for as long as the jump was
    expect(after.gaze).toBeGreaterThan(50)
    expect(after.gesture).toBeGreaterThan(0)
    // stored times were all shifted by the same amount, so the performance is the same one (the rng draws are the same too);
    // only the mood engine's own decay differs by a hair (it resyncs instead of shifting), which can move one perform.affect
    expect({ ...after, affect: 0 }).toEqual({ ...control, affect: 0 })
    expect(Math.abs(after.affect - control.affect)).toBeLessThanOrEqual(1)
  })
  it('the first tick after a jump back is not "late" for anything: affect and gaze arrive within seconds', () => {
    const { d, vt } = director()
    let now = T0
    for (let i = 0; i < 600; i++) {
      now += 1000
      vt.set(now)
      d.tick(now)
    }
    now -= 86_400_000
    vt.set(now)
    let gazeAt = -1
    for (let s = 0; s < 120 && gazeAt < 0; s++) {
      now += 1000
      vt.set(now)
      if (count(d.tick(now), 'perform.gaze') > 0) gazeAt = s
    }
    expect(gazeAt).toBeGreaterThanOrEqual(0)
    expect(gazeAt).toBeLessThan(30)
  })
  it('the budget measures its minimum gap from the same moment after a jump back', () => {
    const vt = createVirtualTime(T0)
    const b = new InterruptionBudget({ clock: vt.clock, proactivity: 100, minGapMs: 20 * 60_000 })
    expect(b.request({ kind: 'proactive' }).allowed).toBe(true)
    vt.advance(5 * 60_000)
    expect(b.request({ kind: 'proactive' }).reason).toMatch(/too soon/)
    vt.set(vt.now() - 3_600_000) // the clock steps back an hour
    expect(b.request({ kind: 'proactive' }).reason).toMatch(/too soon/) // not "an hour in the future": it is still 5 minutes since the last one
    vt.advance(10 * 60_000)
    expect(b.request({ kind: 'proactive' }).reason).toMatch(/too soon/)
    vt.advance(6 * 60_000)
    expect(b.request({ kind: 'proactive' }).allowed).toBe(true) // 21 minutes after the first: the gap has passed
  })
  it('a pinned camera shot is not pinned for as long as the jump was', () => {
    const vt = createVirtualTime(T0)
    const cam = new CameraDirector({ clock: vt.clock, initial: 'wide' })
    expect(cam.request('closeup').ok).toBe(true) // pinned for 12 s
    vt.advance(2000)
    expect(cam.update({ activity: 'idle' })).toBeUndefined() // still pinned
    vt.set(vt.now() - 86_400_000)
    expect(cam.update({ activity: 'idle' })).toBeUndefined() // the jump itself changes nothing
    vt.advance(14_000) // 14 s of REAL time since the pin
    // it may move now (after the dwell and the minimum hold, which were also measured from the same moment)
    let moved = false
    for (let i = 0; i < 20 && !moved; i++) {
      vt.advance(1000)
      moved = cam.update({ activity: 'idle' }) !== undefined
    }
    expect(moved).toBe(true)
  })
  it('a scene whose cameras are named like methods ("toString", "constructor") still gets a plain number as the blend time', () => {
    for (const name of ['toString', 'valueOf', 'hasOwnProperty', 'constructor']) {
      const vt = createVirtualTime(T0)
      const cam = new CameraDirector({ clock: vt.clock, available: () => [name], initial: name })
      let sent: unknown
      for (let i = 0; i < 40 && sent === undefined; i++) {
        vt.advance(1000)
        const cmd = cam.update({ activity: 'conversation' })
        if (cmd && cmd.type === 'scene.camera') sent = cmd
      }
      // the only camera is already the current one, so nothing is sent; and a request for a shot that does not exist is refused
      expect(sent).toBeUndefined()
      expect(cam.request('profile')).toMatchObject({ ok: false })
    }
    // the same with a first move: the start has no current camera, so the first update sends one, with a numeric blend
    const vt = createVirtualTime(T0)
    const cam = new CameraDirector({ clock: vt.clock, available: () => ['toString'] })
    let first: { blendMs?: unknown } | undefined
    for (let i = 0; i < 20 && !first; i++) {
      vt.advance(1000)
      const cmd = cam.update({ activity: 'idle' })
      if (cmd && cmd.type === 'scene.camera') first = cmd
    }
    expect(first).toBeDefined()
    expect(typeof first!.blendMs).toBe('number')
    expect(Number.isFinite(first!.blendMs as number)).toBe(true)
  })
  it('a camera or a budget given a time that is not finite does nothing and does not poison itself', () => {
    const vt = createVirtualTime(T0)
    const cam = new CameraDirector({ clock: vt.clock, initial: 'wide' })
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 1e300, -1e300]) {
      expect(cam.update({ activity: 'conversation' }, bad)).toBeUndefined()
      expect(cam.request('profile', bad)).toMatchObject({ ok: false })
      expect(() => cam.noteBeat('emotional', bad)).not.toThrow()
    }
    // it still works afterwards: the first update starts the dwell, the next one (after it) moves the camera
    expect(cam.update({ activity: 'conversation' }, T0 + 20_000)).toBeUndefined()
    expect(cam.update({ activity: 'conversation' }, T0 + 22_000)).toMatchObject({ type: 'scene.camera', cameraId: 'medium' })
    const bad = { now: () => Number.NaN }
    const b = new InterruptionBudget({ clock: bad, proactivity: 100 })
    expect(() => b.request({ kind: 'proactive' })).not.toThrow()
  })
})

describe('a time that is not a time cannot poison the director (LOW: behavior-nonfinite-now-poisons)', () => {
  const profile = (counts: { affect: number }) => counts.affect
  const run = (poison: number | undefined) => {
    const { d, vt } = director()
    let now = T0
    let affect = 0
    for (let i = 0; i < 1200; i++) {
      now += 1000
      vt.set(now)
      if (i === 300 && poison !== undefined) d.tick(poison)
      affect += count(d.tick(now), 'perform.affect')
      if (i % 120 === 0) d.lookAt({ kind: 'user' }) // some activity
    }
    return profile({ affect })
  }
  it.each([Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN, 1e300, -1e300, 8.64e15 + 1, 2 ** 53])('one tick(%s) leaves the later perform.affect, gaze and gestures as they were', (poison) => {
    const control = run(undefined)
    const poisoned = run(poison)
    expect(poisoned).toBe(control)
  })
  it('the poisoned tick itself returns only what was waiting (nothing else, no throw), and a queued gaze is not lost', () => {
    const { d } = director()
    d.tick()
    d.lookAt({ kind: 'user' })
    const out = d.tick(Number.NaN)
    expect(out.map((c) => c.type)).toEqual(['perform.gaze'])
    expect(d.tick(Number.POSITIVE_INFINITY)).toEqual([])
  })
  it('an injected clock that returns nonsense does not break the entry points that read it', () => {
    const bad = { now: (() => { let n = 0; return () => (n++ % 2 === 0 ? Number.NaN : T0) })() }
    const mood = MoodEngine.fromPresence(AUTHORITY_PRESENCE, { now: () => T0 })
    const d = new BehaviorDirector({ clock: bad, rng: createRng(1), presence: AUTHORITY_PRESENCE, mood })
    expect(() => {
      d.onUserMessage()
      d.onSpeechStarted()
      d.onSpeechEnded(true)
      d.lookAt({ kind: 'user' })
      d.requestPosture('stand')
      d.requestGesture('nod_small')
      d.onUserPresence({ present: true })
      d.tick()
    }).not.toThrow()
  })
})

describe('a quiet-hours spec of any shape cannot make a tick throw (LOW: behavior-quiethours-hostile)', () => {
  const HOSTILE: unknown[] = [
    { from: null, to: '07:00' },
    { from: '22:00', to: 5 },
    {},
    'x',
    5,
    null,
    [],
    { from: '25:00', to: '07:00' },
    { from: '22:30', to: '22:30' },
    { from: ' 22:30 ', to: '07:00' },
    { from: { toString: () => '22:00' }, to: '07:00' },
    new Proxy({}, { get: () => { throw new Error('boom') } }),
    Object.defineProperty({}, 'from', { get: () => { throw new Error('boom') }, enumerable: true }),
  ]
  it.each(HOSTILE.map((h, i) => [i, h] as const))('spec #%s: setQuietHours then ticking at every hour of the day never throws and never puts her to sleep', (_i, spec) => {
    const { d, vt } = director({}, at(10, 0))
    expect(() => d.setQuietHours(spec as never)).not.toThrow()
    for (let h = 0; h < 24; h++) {
      vt.set(at(h, 30))
      expect(() => d.tick(at(h, 30))).not.toThrow()
    }
    // a spec that is not usable means no quiet hours: at 03:00 she is not "asleep" because of it
    if (!isQuietHoursSpec(spec)) {
      const x = director({ quietHours: spec }, at(3, 0))
      x.d.onUserMessage()
      x.d.tick()
      expect(x.d.currentProfile()).not.toBe('asleep')
    }
  })
  it('the constructor option is guarded the same way, and the helpers say "no quiet hours" instead of throwing', () => {
    for (const spec of HOSTILE) {
      expect(() => director({ quietHours: spec })).not.toThrow()
      expect(inQuietHours(spec as never, at(3, 0))).toBe(isQuietHoursSpec(spec))
      expect(() => msUntilQuietEnds(spec as never, at(3, 0))).not.toThrow()
    }
    expect(inQuietHours({ from: '22:30', to: '07:00' }, at(3, 0))).toBe(true)
    expect(inQuietHours({ from: '22:30', to: '07:00' }, at(12, 0))).toBe(false)
    expect(inQuietHours({ from: '22:30', to: '07:00' }, Number.NaN)).toBe(false)
    expect(msUntilQuietEnds({ from: '22:30', to: '07:00' }, at(3, 0))).toBe(4 * 3_600_000)
  })
  it('parseHm and localMinutes take any input', () => {
    for (const v of [null, undefined, 5, {}, [], true, Symbol('x'), 5n, () => '22:00']) expect(parseHm(v)).toBeUndefined()
    expect(parseHm('22:30')).toBe(22 * 60 + 30)
    expect(parseHm(' 7:05 ')).toBe(7 * 60 + 5)
    expect(parseHm('24:00')).toBeUndefined()
    expect(localMinutes(Number.NaN)).toBe(0)
    expect(localMinutes(8.64e15 + 1)).toBe(0)
    expect(localMinutes(at(7, 45))).toBe(7 * 60 + 45)
  })
  it('a valid spec keeps working exactly as before (asleep inside, awake outside)', () => {
    const inside = director({ quietHours: { from: '22:30', to: '07:00' } }, at(3, 0))
    inside.d.tick()
    expect(inside.d.currentProfile()).toBe('asleep')
    const outside = director({ quietHours: { from: '22:30', to: '07:00' } }, at(12, 0))
    outside.d.tick()
    expect(outside.d.currentProfile()).not.toBe('asleep')
  })
  it('property: random specs built from hostile tokens never throw and agree with isQuietHoursSpec', () => {
    const r = lcg(3)
    const tokens: unknown[] = ['22:30', '07:00', '', ' ', 'x', null, undefined, 5, {}, [], '24:00', '7:5', '07:60', true]
    for (let i = 0; i < 2000; i++) {
      const spec = r() < 0.15 ? tokens[Math.floor(r() * tokens.length)] : { from: tokens[Math.floor(r() * tokens.length)], to: tokens[Math.floor(r() * tokens.length)] }
      const t = at(Math.floor(r() * 24), Math.floor(r() * 60))
      expect(() => inQuietHours(spec as never, t)).not.toThrow()
      if (!isQuietHoursSpec(spec)) expect(inQuietHours(spec as never, t)).toBe(false)
    }
  })
})
