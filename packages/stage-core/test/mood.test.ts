import { describe, expect, it } from 'vitest'
import { AUTHORITY_PRESENCE, Emotion } from '@ai-assistant/shared'
import { DEFAULT_BASELINE, MOOD_DELTAS, MOOD_EVENT_TYPES, MoodEngine, NEUTRAL_RADIUS, createVirtualTime, labelFor, reactivityFor } from '../src'
import type { MoodEventType } from '../src'
import { lcg } from './helpers'

const make = (over: Record<string, unknown> = {}) => {
  const vt = createVirtualTime(1_000_000)
  const mood = new MoodEngine({ clock: vt.clock, baseline: AUTHORITY_PRESENCE.baseline, reactivity: 1, ...over })
  return { vt, mood }
}
const dist = (a: { valence: number; arousal: number; dominance: number }, b: { valence: number; arousal: number; dominance: number }) => Math.hypot(a.valence - b.valence, a.arousal - b.arousal, a.dominance - b.dominance)

describe('MoodEngine basics', () => {
  it('starts at the baseline with a neutral label', () => {
    const { mood } = make()
    expect(mood.get()).toEqual({ ...AUTHORITY_PRESENCE.baseline, label: 'neutral' })
    expect(mood.intensity()).toBe(0)
    expect(mood.baseline()).toEqual(AUTHORITY_PRESENCE.baseline)
  })
  it('praise raises valence and arousal and turns her happy', () => {
    const { mood } = make()
    const a = mood.apply({ type: 'praise' })
    expect(a.valence).toBeCloseTo(0.5)
    expect(a.arousal).toBeCloseTo(0)
    expect(a.label).toBe('happy')
  })
  it('good news lifts more than praise; bad news lowers valence and she looks sad', () => {
    const g = make().mood.apply({ type: 'good_news' })
    const p = make().mood.apply({ type: 'praise' })
    expect(g.valence).toBeGreaterThan(p.valence)
    const b = make().mood.apply({ type: 'bad_news' })
    expect(b.valence).toBeLessThan(AUTHORITY_PRESENCE.baseline.valence)
    expect(b.label).toBe('sad')
  })
  it('long silence and late hours lower arousal (sleepy), never valence', () => {
    for (const type of ['long_silence', 'late_hours'] as const) {
      const { mood } = make()
      const a = mood.apply({ type })
      expect(a.arousal).toBeLessThan(AUTHORITY_PRESENCE.baseline.arousal)
      expect(a.valence).toBe(AUTHORITY_PRESENCE.baseline.valence)
    }
    expect(make().mood.apply({ type: 'late_hours' }).label).toBe('relaxed')
  })
  it('no event in the vocabulary makes her sulk: silence-type events never reduce valence', () => {
    expect(MOOD_DELTAS.long_silence[0]).toBe(0)
    expect(MOOD_DELTAS.late_hours[0]).toBe(0)
  })
  it('user distress keeps her steady: no arousal jolt, dominance up', () => {
    const a = make().mood.apply({ type: 'user_distress' })
    expect(a.arousal).toBeLessThanOrEqual(AUTHORITY_PRESENCE.baseline.arousal)
    expect(a.dominance).toBeGreaterThan(AUTHORITY_PRESENCE.baseline.dominance)
  })
  it('each event type has the documented direction', () => {
    const base = AUTHORITY_PRESENCE.baseline
    const r = (type: MoodEventType) => make().mood.apply({ type })
    expect(r('task_completed').dominance).toBeGreaterThan(base.dominance)
    expect(r('task_failed').valence).toBeLessThan(base.valence)
    expect(r('interrupted').dominance).toBeLessThan(base.dominance)
    expect(r('user_returned').arousal).toBeGreaterThan(base.arousal)
    expect(r('criticism').valence).toBeLessThan(base.valence)
    expect(r('surprise').label).toBe('surprised')
    expect(r('flustered').label).toBe('shy')
    expect(r('thanks').valence).toBeGreaterThan(base.valence)
  })
  it('magnitude scales the effect, is clamped to 0..2, and non-finite or unknown input does nothing', () => {
    const half = make().mood.apply({ type: 'praise', magnitude: 0.5 }).valence
    const full = make().mood.apply({ type: 'praise' }).valence
    const huge = make().mood.apply({ type: 'praise', magnitude: 50 }).valence
    const two = make().mood.apply({ type: 'praise', magnitude: 2 }).valence
    expect(half).toBeLessThan(full)
    expect(huge).toBe(two)
    const base = make().mood.get()
    for (const m of [NaN, Infinity, -Infinity]) expect(make().mood.apply({ type: 'praise', magnitude: m })).toEqual(base)
    expect(make().mood.apply({ type: 'praise', magnitude: -5 })).toEqual(base)
    expect(make().mood.apply({ type: 'nonsense' as MoodEventType })).toEqual(base)
    expect(make().mood.apply(null as never)).toEqual(base)
  })
  it('reactivity scales every delta; composed presence reacts less than an expressive one', () => {
    const calm = make({ reactivity: reactivityFor({ gestureEconomy: 0.9 }) }).mood.apply({ type: 'bad_news' })
    const lively = make({ reactivity: reactivityFor({ gestureEconomy: 0.1 }) }).mood.apply({ type: 'bad_news' })
    expect(Math.abs(calm.valence - 0.2)).toBeLessThan(Math.abs(lively.valence - 0.2))
    expect(reactivityFor({ gestureEconomy: 0.75 })).toBeCloseTo(0.85)
    expect(reactivityFor({ gestureEconomy: 5 })).toBe(0.5)
    expect(reactivityFor({ gestureEconomy: -5 })).toBe(1.2)
  })
  it('fromPresence uses the baseline and reactivity of the style', () => {
    const vt = createVirtualTime(0)
    const m = MoodEngine.fromPresence(AUTHORITY_PRESENCE, vt.clock)
    expect(m.get().dominance).toBe(0.7)
    expect(m.apply({ type: 'praise' }).valence).toBeCloseTo(0.2 + 0.3 * 0.85)
  })
})

describe('decay toward the baseline', () => {
  it('halves the distance after one half-life per axis', () => {
    const { mood, vt } = make()
    mood.apply({ type: 'good_news', magnitude: 2 }) // valence +0.8
    const v0 = mood.get().valence - AUTHORITY_PRESENCE.baseline.valence
    vt.advance(25 * 60_000)
    expect(mood.get().valence - AUTHORITY_PRESENCE.baseline.valence).toBeCloseTo(v0 / 2, 6)
    vt.advance(25 * 60_000)
    expect(mood.get().valence - AUTHORITY_PRESENCE.baseline.valence).toBeCloseTo(v0 / 4, 6)
  })
  it('arousal recovers faster than dominance', () => {
    const { mood, vt } = make()
    mood.apply({ type: 'surprise', magnitude: 2 })
    const a0 = mood.get()
    vt.advance(10 * 60_000)
    const a1 = mood.get()
    expect(Math.abs(a1.arousal - AUTHORITY_PRESENCE.baseline.arousal)).toBeCloseTo(Math.abs(a0.arousal - AUTHORITY_PRESENCE.baseline.arousal) / 2, 5)
    expect(Math.abs(a1.dominance - AUTHORITY_PRESENCE.baseline.dominance) / Math.abs(a0.dominance - AUTHORITY_PRESENCE.baseline.dominance)).toBeGreaterThan(0.8)
  })
  it('returns to neutral and the baseline after enough time', () => {
    const { mood, vt } = make()
    mood.apply({ type: 'bad_news', magnitude: 2 })
    vt.advance(12 * 3_600_000)
    const a = mood.get()
    expect(a.label).toBe('neutral')
    expect(dist(a, AUTHORITY_PRESENCE.baseline)).toBeLessThan(1e-4)
  })
  it('decay is monotone: without events the distance to the baseline never grows (property)', () => {
    const r = lcg(1)
    const { mood, vt } = make()
    for (let i = 0; i < 6; i++) mood.apply({ type: MOOD_EVENT_TYPES[Math.floor(r() * MOOD_EVENT_TYPES.length)]!, magnitude: 1 + r() })
    let prev = dist(mood.get(), AUTHORITY_PRESENCE.baseline)
    for (let i = 0; i < 100; i++) {
      vt.advance(1 + Math.floor(r() * 600_000))
      const d = dist(mood.get(), AUTHORITY_PRESENCE.baseline)
      expect(d).toBeLessThanOrEqual(prev + 1e-12)
      prev = d
    }
  })
  it('reading is idempotent: get() twice at the same time gives the same mood', () => {
    const { mood, vt } = make()
    mood.apply({ type: 'praise' })
    vt.advance(123_456)
    expect(mood.get()).toEqual(mood.get())
  })
  it('a clock that goes backwards neither decays nor breaks anything', () => {
    const { mood, vt } = make()
    mood.apply({ type: 'praise' })
    const before = mood.get()
    vt.set(vt.now() - 5000)
    expect(mood.get()).toEqual(before)
    vt.advance(10_000)
    expect(Number.isFinite(mood.get().valence)).toBe(true)
  })
})

describe('bounds and determinism (property style)', () => {
  it('stays in -1..1, finite, with a label from the closed set, across random event storms', () => {
    const labels = new Set(Emotion.options)
    for (let seed = 0; seed < 25; seed++) {
      const r = lcg(seed)
      const { mood, vt } = make({ reactivity: r() * 3 })
      for (let i = 0; i < 300; i++) {
        vt.advance(Math.floor(r() * 900_000))
        const roll = r()
        const type = roll < 0.05 ? ('bogus' as MoodEventType) : MOOD_EVENT_TYPES[Math.floor(r() * MOOD_EVENT_TYPES.length)]!
        const magnitude = roll < 0.1 ? [NaN, Infinity, -1, 1e9][Math.floor(r() * 4)] : r() * 3
        const a = mood.apply({ type, magnitude })
        for (const v of [a.valence, a.arousal, a.dominance]) {
          expect(Number.isFinite(v)).toBe(true)
          expect(v).toBeGreaterThanOrEqual(-1)
          expect(v).toBeLessThanOrEqual(1)
        }
        expect(labels.has(a.label)).toBe(true)
      }
    }
  })
  it('is fully deterministic', () => {
    const run = () => {
      const r = lcg(77)
      const { mood, vt } = make()
      const out: unknown[] = []
      for (let i = 0; i < 100; i++) {
        vt.advance(Math.floor(r() * 400_000))
        out.push(mood.apply({ type: MOOD_EVENT_TYPES[Math.floor(r() * MOOD_EVENT_TYPES.length)]!, magnitude: r() * 2 }))
      }
      return JSON.stringify(out)
    }
    expect(run()).toBe(run())
  })
  it('sanitises nonsense options', () => {
    const vt = createVirtualTime(0)
    const m = new MoodEngine({ clock: vt.clock, baseline: { valence: NaN, arousal: 9, dominance: -9 }, reactivity: NaN, halfLifeMs: { valence: -1, arousal: NaN, dominance: 0 }, initial: { valence: Infinity, arousal: NaN, dominance: 5 } })
    const a = m.get()
    for (const v of [a.valence, a.arousal, a.dominance]) expect(v >= -1 && v <= 1 && Number.isFinite(v)).toBe(true)
    vt.advance(1e12)
    expect(Number.isFinite(m.get().arousal)).toBe(true)
  })
})

describe('labels', () => {
  const base = AUTHORITY_PRESENCE.baseline
  it('neutral inside the dead zone around the baseline, whatever the baseline is', () => {
    expect(labelFor(base.valence, base.arousal, base.dominance, base)).toBe('neutral')
    expect(labelFor(base.valence + NEUTRAL_RADIUS * 0.9, base.arousal, base.dominance, base)).toBe('neutral')
    expect(labelFor(0, 0, 0, { valence: 0, arousal: 0, dominance: 0 })).toBe('neutral')
  })
  it('maps clear deviations to the expected labels', () => {
    const at = (dv: number, da: number, dd: number) => labelFor(base.valence + dv, base.arousal + da, base.dominance + dd, base)
    expect(at(0.5, 0.35, 0.1)).toBe('happy')
    expect(at(-0.5, -0.3, -0.3)).toBe('sad')
    expect(at(-0.5, 0.5, 0.2)).toBe('angry')
    expect(at(0.25, -0.45, 0)).toBe('relaxed')
    expect(at(0.1, 0.7, -0.25)).toBe('surprised')
    expect(at(0.15, 0.15, -0.6)).toBe('shy')
  })
  it('thinking is only ever a held label, and it expires', () => {
    const { mood, vt } = make()
    mood.holdLabel('thinking', 3000)
    expect(mood.get().label).toBe('thinking')
    vt.advance(2999)
    expect(mood.get().label).toBe('thinking')
    vt.advance(2)
    expect(mood.get().label).toBe('neutral')
    mood.holdLabel('thinking', 5000)
    mood.releaseLabel()
    expect(mood.get().label).toBe('neutral')
    mood.holdLabel('bogus' as never, 1000)
    mood.holdLabel('thinking', NaN)
    mood.holdLabel('thinking', -5)
    expect(mood.get().label).toBe('neutral')
  })
  it('intensity grows with the deviation and is bounded', () => {
    const { mood } = make()
    const i0 = mood.intensity()
    mood.apply({ type: 'good_news' })
    const i1 = mood.intensity()
    mood.apply({ type: 'good_news', magnitude: 2 })
    expect(i1).toBeGreaterThan(i0)
    expect(mood.intensity()).toBeGreaterThanOrEqual(i1)
    expect(mood.intensity()).toBeLessThanOrEqual(1)
  })
  it('the default baseline is the authority brief: slightly positive, low arousal, high dominance', () => {
    expect(DEFAULT_BASELINE.valence).toBeGreaterThan(0)
    expect(DEFAULT_BASELINE.arousal).toBeLessThan(0)
    expect(DEFAULT_BASELINE.dominance).toBeGreaterThan(0.5)
  })
})

describe('persistence', () => {
  it('snapshot and restore round trip, and time since the snapshot decays the restored mood', () => {
    const a = make()
    a.mood.apply({ type: 'good_news', magnitude: 2 })
    const snap = JSON.parse(JSON.stringify(a.mood.snapshot()))
    const b = make()
    b.vt.set(snap.at + 25 * 60_000)
    b.mood.restore(snap)
    const dv = b.mood.get().valence - AUTHORITY_PRESENCE.baseline.valence
    expect(dv).toBeCloseTo((snap.valence - AUTHORITY_PRESENCE.baseline.valence) / 2, 6)
    b.mood.restore({ valence: NaN, arousal: 5, dominance: -5, at: NaN })
    const x = b.mood.get()
    expect(x.arousal).toBe(1)
    expect(Number.isFinite(x.valence)).toBe(true)
  })
  it('setBaseline keeps the current mood and decays toward the new rest point', () => {
    const { mood, vt } = make()
    mood.apply({ type: 'praise' })
    mood.setBaseline({ valence: -0.5, arousal: 0, dominance: 0 })
    vt.advance(6 * 3_600_000)
    expect(mood.get().valence).toBeCloseTo(-0.5, 2)
    expect(mood.baseline().valence).toBe(-0.5)
  })
})
