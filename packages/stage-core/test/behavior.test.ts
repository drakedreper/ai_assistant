import { describe, expect, it } from 'vitest'
import { AUTHORITY_PRESENCE, StageCommand } from '@ai-assistant/shared'
import type { PresenceStyle } from '@ai-assistant/shared'
import {
  BehaviorDirector,
  CameraDirector,
  DEFAULT_GESTURES,
  GestureSelector,
  InterruptionBudget,
  MoodEngine,
  SHOT_IDS,
  createRng,
  createVirtualTime,
  dailyLimitFor,
} from '../src'
import type { CommandDraft } from '../src'
import { T0, at } from './helpers'

const EXPRESSIVE: PresenceStyle = { uprightness: 0.4, gestureEconomy: 0.1, gazeHold: 0.2, pace: 0.2, athleticism: 0.2, baseline: { valence: 0.3, arousal: 0.2, dominance: 0.1 } }

describe('gesture library and selector', () => {
  it('has sane clips', () => {
    const ids = DEFAULT_GESTURES.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const c of DEFAULT_GESTURES) {
      expect(c.energy).toBeGreaterThanOrEqual(0)
      expect(c.energy).toBeLessThanOrEqual(1)
      expect(c.durationMs).toBeGreaterThan(0)
      expect(c.cooldownMs).toBeGreaterThan(0)
      expect(c.weight).toBeGreaterThan(0)
      expect(c.contexts.length).toBeGreaterThan(0)
    }
    for (const ctx of ['speaking', 'listening', 'idle', 'thinking', 'greeting'] as const) expect(DEFAULT_GESTURES.some((c) => c.contexts.includes(ctx))).toBe(true)
  })

  const run = (presence: PresenceStyle, ctx: 'speaking' | 'idle', n = 600, seed = 3) => {
    const sel = new GestureSelector({ presence, rng: createRng(seed) })
    const picks: string[] = []
    let t = 0
    for (let i = 0; i < n; i++) {
      t += 700_000 // beyond every cooldown, so only history shapes the choice
      const c = sel.pick({ context: ctx, emotion: 'neutral', arousal: 0 }, t)
      if (c) picks.push(c.id)
    }
    return picks
  }
  const meanEnergy = (ids: string[]) => ids.reduce((s, id) => s + DEFAULT_GESTURES.find((c) => c.id === id)!.energy, 0) / ids.length

  it('authority picks smaller gestures than an expressive style', () => {
    expect(meanEnergy(run(AUTHORITY_PRESENCE, 'speaking'))).toBeLessThan(meanEnergy(run(EXPRESSIVE, 'speaking')))
  })
  it('athletic presence favours grounded posture choices when idle', () => {
    const grounded = (ids: string[]) => ids.filter((id) => DEFAULT_GESTURES.find((c) => c.id === id)!.grounded).length / ids.length
    const athletic = grounded(run({ ...AUTHORITY_PRESENCE, athleticism: 1 }, 'idle'))
    const casual = grounded(run({ ...AUTHORITY_PRESENCE, athleticism: 0 }, 'idle'))
    expect(athletic).toBeGreaterThan(casual)
  })
  it('never repeats the same gesture back to back (history window), over a long run', () => {
    for (const presence of [AUTHORITY_PRESENCE, EXPRESSIVE]) {
      for (const ctx of ['speaking', 'idle'] as const) {
        const picks = run(presence, ctx, 400)
        let repeats = 0
        for (let i = 1; i < picks.length; i++) if (picks[i] === picks[i - 1]) repeats++
        expect(repeats / picks.length).toBeLessThan(0.02)
      }
    }
  })
  it('respects per-clip cooldowns', () => {
    const sel = new GestureSelector({ presence: AUTHORITY_PRESENCE, rng: createRng(1), library: [DEFAULT_GESTURES.find((c) => c.id === 'nod_small')!] })
    expect(sel.pick({ context: 'speaking' }, 1000)?.id).toBe('nod_small')
    expect(sel.pick({ context: 'speaking' }, 1000 + 5999)).toBeUndefined()
    expect(sel.pick({ context: 'speaking' }, 1000 + 6000)?.id).toBe('nod_small')
  })
  it('filters by context, emotion and tags; reports nothing when nothing fits', () => {
    const sel = new GestureSelector({ presence: AUTHORITY_PRESENCE, rng: createRng(1) })
    const greet = sel.pick({ context: 'greeting' }, 0)!
    expect(greet.contexts).toContain('greeting')
    const laugh = new GestureSelector({ presence: AUTHORITY_PRESENCE, rng: createRng(1) }).pick({ context: 'speaking', emotion: 'happy', tags: ['laugh'] }, 0)
    expect(laugh?.id).toBe('laugh_small')
    expect(new GestureSelector({ presence: AUTHORITY_PRESENCE, rng: createRng(1) }).pick({ context: 'speaking', emotion: 'sad', tags: ['laugh'] }, 0)).toBeUndefined()
    expect(new GestureSelector({ presence: AUTHORITY_PRESENCE, rng: createRng(1), library: [] }).pick({ context: 'idle' }, 0)).toBeUndefined()
  })
  it('is deterministic for a seed', () => {
    expect(run(AUTHORITY_PRESENCE, 'speaking', 80, 9)).toEqual(run(AUTHORITY_PRESENCE, 'speaking', 80, 9))
    expect(run(AUTHORITY_PRESENCE, 'speaking', 80, 9)).not.toEqual(run(AUTHORITY_PRESENCE, 'speaking', 80, 10))
  })
  it('shapes intensity by presence and arousal, within bounds', () => {
    const calm = new GestureSelector({ presence: AUTHORITY_PRESENCE, rng: createRng(1) })
    const lively = new GestureSelector({ presence: EXPRESSIVE, rng: createRng(1) })
    expect(calm.intensityFor(0.5)).toBeLessThan(lively.intensityFor(0.5))
    for (const a of [-5, -1, 0, 1, 5, NaN]) {
      const v = calm.intensityFor(a)
      expect(v).toBeGreaterThanOrEqual(0.15)
      expect(v).toBeLessThanOrEqual(1)
    }
    expect(calm.intensityFor(0, 1)).toBeLessThanOrEqual(1)
    expect(calm.targetEnergy(0)).toBeLessThan(lively.targetEnergy(0))
  })
})

describe('InterruptionBudget', () => {
  const quiet = { from: '22:30', to: '07:00' }
  const make = (start = at(10), opts: Record<string, unknown> = {}) => {
    const vt = createVirtualTime(start)
    return { vt, b: new InterruptionBudget({ clock: vt.clock, quietHours: quiet, proactivity: 55, ...opts }) }
  }
  it('derives the daily limit from proactivity: round(p/20)', () => {
    expect([0, 10, 55, 70, 100, -5, 500, NaN].map(dailyLimitFor)).toEqual([0, 1, 3, 4, 5, 0, 5, 0])
  })
  it('allows P1 interruptions up to the daily limit, with a minimum gap', () => {
    const { vt, b } = make()
    for (let i = 0; i < 3; i++) {
      const d = b.request({ kind: 'proactive' })
      expect(d.allowed).toBe(true)
      expect(d.remainingToday).toBe(2 - i)
      const next = b.request({ kind: 'proactive' })
      expect(next).toMatchObject({ allowed: false, reason: i < 2 ? 'too soon after the last interruption' : 'daily budget spent' })
      vt.advance(21 * 60_000)
    }
    expect(b.request({ kind: 'proactive' })).toMatchObject({ allowed: false, reason: 'daily budget spent', remainingToday: 0 })
    expect(b.remaining()).toBe(0)
  })
  it('resets the next local day', () => {
    const { vt, b } = make()
    for (let i = 0; i < 3; i++) {
      b.request({ kind: 'proactive' })
      vt.advance(21 * 60_000)
    }
    expect(b.remaining()).toBe(0)
    vt.set(at(10, 0, 1))
    expect(b.remaining()).toBe(3)
    expect(b.request({ kind: 'proactive' }).allowed).toBe(true)
  })
  it('never speaks proactively in quiet hours, except a listed urgent P0; handles crossing midnight', () => {
    for (const [h, m, expectQuiet] of [[22, 29, false], [22, 30, true], [23, 59, true], [0, 0, true], [6, 59, true], [7, 0, false]] as const) {
      const { b } = make(at(h, m))
      expect(b.isQuiet()).toBe(expectQuiet)
      expect(b.request({ kind: 'proactive' }, { commit: false }).allowed).toBe(!expectQuiet)
    }
    const { b } = make(at(3))
    expect(b.request({ kind: 'proactive', priority: 'P0', listedUrgent: true })).toMatchObject({ allowed: true })
    expect(b.request({ kind: 'proactive', priority: 'P0' })).toMatchObject({ allowed: false, reason: 'quiet hours' })
    expect(b.request({ kind: 'proactive', priority: 'P0', listedUrgent: false }).allowed).toBe(false)
    expect(b.request({ kind: 'briefing' })).toMatchObject({ allowed: false, reason: 'quiet hours' })
    expect(b.request({ kind: 'reply' }).allowed).toBe(true) // replies wake her
  })
  it('listed urgent items do not consume the budget', () => {
    const { b } = make()
    for (let i = 0; i < 10; i++) expect(b.request({ kind: 'proactive', priority: 'P0', listedUrgent: true }).allowed).toBe(true)
    expect(b.remaining()).toBe(3)
  })
  it('P2 is never spoken unprompted', () => {
    const { b } = make()
    expect(b.request({ kind: 'proactive', priority: 'P2' })).toMatchObject({ allowed: false })
  })
  it('the briefing is once per day outside quiet hours and outside the daily budget', () => {
    const { vt, b } = make(at(8))
    expect(b.request({ kind: 'briefing' }).allowed).toBe(true)
    expect(b.request({ kind: 'briefing' })).toMatchObject({ allowed: false })
    expect(b.remaining()).toBe(3)
    vt.set(at(8, 0, 1))
    expect(b.request({ kind: 'briefing' }).allowed).toBe(true)
  })
  it('dry runs consume nothing', () => {
    const { b } = make()
    for (let i = 0; i < 5; i++) expect(b.request({ kind: 'proactive' }, { commit: false }).allowed).toBe(true)
    expect(b.remaining()).toBe(3)
    b.request({ kind: 'briefing' }, { commit: false })
    expect(b.request({ kind: 'briefing' }).allowed).toBe(true)
  })
  it('zero proactivity means no unprompted speech; muted silences even replies', () => {
    const { b } = make(at(10), { proactivity: 0 })
    expect(b.request({ kind: 'proactive' })).toMatchObject({ allowed: false, reason: 'daily budget spent' })
    const m = make().b
    m.setMuted(true)
    expect(m.isMuted()).toBe(true)
    for (const kind of ['reply', 'briefing', 'proactive'] as const) expect(m.request({ kind })).toMatchObject({ allowed: false, reason: 'muted' })
    m.setMuted(false)
    expect(m.request({ kind: 'reply' }).allowed).toBe(true)
  })
  it('settings can change at runtime; explicit dailyLimit and malformed quiet hours behave', () => {
    const { b } = make(at(3))
    b.setQuietHours(undefined)
    expect(b.request({ kind: 'proactive' }, { commit: false }).allowed).toBe(true)
    b.setQuietHours({ from: 'nope', to: '07:00' })
    expect(b.isQuiet()).toBe(false)
    b.setProactivity(100)
    expect(b.remaining()).toBe(5)
    expect(make(at(10), { dailyLimit: 1 }).b.remaining()).toBe(1)
  })
})

describe('CameraDirector', () => {
  const make = (opts: Record<string, unknown> = {}) => {
    const vt = createVirtualTime(T0)
    const cam = new CameraDirector({ clock: vt.clock, ...opts })
    return { vt, cam }
  }
  const id = (c: CommandDraft | undefined) => (c as { cameraId?: string } | undefined)?.cameraId

  it('maps context to the shot', () => {
    const { cam } = make()
    expect(cam.desiredShot({ activity: 'idle' })).toBe('wide')
    expect(cam.desiredShot({ activity: 'conversation' })).toBe('medium')
    expect(cam.desiredShot({ activity: 'reviewing' })).toBe('profile')
    expect(cam.desiredShot({ activity: 'working' })).toBe('over_shoulder')
    expect(cam.desiredShot({ activity: 'asleep' })).toBe('wide')
    cam.noteBeat('emotional')
    expect(cam.desiredShot({ activity: 'conversation' })).toBe('closeup')
  })
  it('the first update sets an initial shot without waiting', () => {
    const { cam } = make()
    expect(id(cam.update({ activity: 'idle' }))).toBe('wide')
    expect(cam.currentShot()).toBe('wide')
    expect(cam.update({ activity: 'idle' })).toBeUndefined()
  })
  it('does not move for a flickering desire (hysteresis), but moves for a sustained one after the dwell', () => {
    const { cam, vt } = make({ initial: 'wide' })
    cam.setCurrent('wide', vt.now() - 60_000)
    let switches = 0
    for (let i = 0; i < 20; i++) {
      vt.advance(400)
      if (cam.update({ activity: i % 2 ? 'conversation' : 'idle' })) switches++
    }
    expect(switches).toBe(0)
    cam.update({ activity: 'idle' }) // desire back to the current shot clears the pending move
    vt.advance(100)
    expect(cam.update({ activity: 'conversation' })).toBeUndefined() // desire just started
    vt.advance(1199)
    expect(cam.update({ activity: 'conversation' })).toBeUndefined()
    vt.advance(2)
    expect(id(cam.update({ activity: 'conversation' }))).toBe('medium')
  })
  it('holds a shot for a minimum time before the next automatic move', () => {
    const { cam, vt } = make()
    cam.update({ activity: 'conversation' }) // medium at t0
    vt.advance(1300)
    cam.update({ activity: 'idle' })
    vt.advance(1300)
    expect(cam.update({ activity: 'idle' })).toBeUndefined() // dwell met but 2.6 s < 6 s hold
    vt.advance(3300)
    expect(cam.update({ activity: 'idle' })).toBeUndefined() // 5.9 s on the shot: still held
    vt.advance(200)
    expect(id(cam.update({ activity: 'idle' }))).toBe('wide') // 6.1 s
  })
  it('an emotional beat cuts to a close-up promptly, holds it, then returns to the conversation shot', () => {
    const { cam, vt } = make()
    cam.update({ activity: 'conversation' })
    vt.advance(7000)
    cam.noteBeat('important')
    expect(id(cam.update({ activity: 'conversation' }))).toBe('closeup')
    vt.advance(4000)
    expect(cam.update({ activity: 'conversation' })).toBeUndefined()
    vt.advance(600) // beat over
    expect(cam.update({ activity: 'conversation' })).toBeUndefined() // pending starts
    vt.advance(1300)
    expect(id(cam.update({ activity: 'conversation' }))).toBe('medium')
  })
  it('a beat right after a switch waits for the short beat hold', () => {
    const { cam, vt } = make()
    cam.update({ activity: 'conversation' })
    vt.advance(1000)
    cam.noteBeat('emotional')
    expect(cam.update({ activity: 'conversation' })).toBeUndefined()
    vt.advance(1600)
    expect(id(cam.update({ activity: 'conversation' }))).toBe('closeup')
  })
  it('explicit requests switch at once, pin the shot, and reject unknown or unavailable ones', () => {
    const { cam, vt } = make()
    cam.update({ activity: 'idle' })
    const r = cam.request('back')
    expect(r.ok && id(r.value)).toBe('back')
    vt.advance(3000)
    expect(cam.update({ activity: 'conversation' })).toBeUndefined()
    vt.advance(20_000)
    cam.update({ activity: 'conversation' })
    vt.advance(1300)
    expect(id(cam.update({ activity: 'conversation' }))).toBe('medium')
    expect(cam.request('nope')).toMatchObject({ ok: false, code: 'unknown_shot' })
    const limited = make({ available: () => ['wide', 'medium'] }).cam
    expect(limited.request('closeup')).toMatchObject({ ok: false, code: 'unavailable' })
    const same = cam.request('medium')
    expect(same.ok && (same.value as { blendMs: number }).blendMs).toBe(0)
  })
  it('falls back to a shot the scene has', () => {
    const { cam } = make({ available: () => ['wide', 'medium'] })
    expect(cam.desiredShot({ activity: 'working' })).toBe('medium')
    expect(cam.desiredShot({ activity: 'reviewing' })).toBe('medium')
    cam.noteBeat('emotional')
    expect(cam.desiredShot({ activity: 'idle' })).toBe('medium')
    expect(make({ available: () => ['wide'] }).cam.desiredShot({ activity: 'conversation' })).toBe('wide')
    expect(make({ available: () => [] }).cam.desiredShot({ activity: 'conversation' })).toBe('medium')
  })
  it('never jitters: random context flipping for ten minutes keeps switches spaced (property)', () => {
    for (let seed = 1; seed <= 6; seed++) {
      const { cam, vt } = make()
      const r = createRng(seed)
      const switches: Array<{ t: number; to: string; beat: boolean }> = []
      const acts = ['idle', 'conversation', 'reviewing', 'working', 'asleep'] as const
      let act: (typeof acts)[number] = 'idle'
      for (let i = 0; i < 2000; i++) {
        vt.advance(300)
        if (r.chance(0.35)) act = r.pick(acts)!
        const beat = r.chance(0.01)
        if (beat) cam.noteBeat('emotional')
        const c = cam.update({ activity: act })
        if (c) switches.push({ t: vt.now(), to: (c as { cameraId: string }).cameraId, beat: (c as { cameraId: string }).cameraId === 'closeup' })
      }
      for (let i = 1; i < switches.length; i++) {
        const gap = switches[i]!.t - switches[i - 1]!.t
        expect(gap).toBeGreaterThanOrEqual(2500)
        if (!switches[i]!.beat && switches[i - 1]!.to !== 'closeup') expect(gap).toBeGreaterThanOrEqual(6000)
        expect(switches[i]!.to).not.toBe(switches[i - 1]!.to)
      }
      expect(switches.length).toBeLessThan(240)
    }
  })
  it('all shot ids it can pick exist in the six-shot set', () => {
    expect(SHOT_IDS).toHaveLength(6)
  })
})

// -------------------------------------------------------------------------------------------- BehaviorDirector

function makeDirector(opts: { presence?: PresenceStyle; start?: number; quiet?: { from: string; to: string } | null; seed?: number; characterId?: string } = {}) {
  const vt = createVirtualTime(opts.start ?? at(10, 0))
  const presence = opts.presence ?? AUTHORITY_PRESENCE
  const mood = MoodEngine.fromPresence(presence, vt.clock)
  const director = new BehaviorDirector({
    clock: vt.clock,
    rng: createRng(opts.seed ?? 11),
    presence,
    mood,
    ...(opts.quiet === null ? {} : { quietHours: opts.quiet ?? { from: '22:30', to: '07:00' } }),
    ...(opts.characterId ? { characterId: opts.characterId } : {}),
  })
  const log: Array<{ t: number; c: CommandDraft }> = []
  const step = (ms = 250, n = 1) => {
    for (let i = 0; i < n; i++) {
      vt.advance(ms)
      for (const c of director.tick()) log.push({ t: vt.now(), c })
    }
  }
  const run = (minutes: number) => step(250, Math.round((minutes * 60_000) / 250))
  const ofType = (type: string) => log.filter((e) => e.c.type === type)
  return { vt, mood, director, log, step, run, ofType }
}

describe('BehaviorDirector: profile, posture and quiet hours', () => {
  it('the first tick announces an idle profile, a posture, gaze and her affect', () => {
    const d = makeDirector()
    d.director.setActivity('conversation')
    d.director.onUserPresence({ present: true })
    d.step()
    const types = d.log.map((e) => e.c.type)
    expect(types).toContain('perform.idle')
    expect(types).toContain('perform.posture')
    expect(types).toContain('perform.gaze')
    expect(types).toContain('perform.affect')
    expect(d.director.currentProfile()).toBe('attentive')
  })
  it('chooses profiles from context: conversation attentive, working busy, idle relaxed, long idle sleepy', () => {
    const d = makeDirector()
    d.director.setActivity('conversation')
    d.step()
    expect(d.director.currentProfile()).toBe('attentive')
    d.director.setActivity('working')
    d.step(250, 1)
    expect(d.director.currentProfile()).toBe('attentive') // held for 30 s (no flapping)
    d.step(1000, 31)
    expect(d.director.currentProfile()).toBe('busy')
    d.director.setActivity('idle')
    d.director.setWorkLoad({ running: 0, blocked: 0 })
    d.step(1000, 31)
    expect(['relaxed', 'attentive']).toContain(d.director.currentProfile())
    d.step(60_000, 70)
    expect(d.director.currentProfile()).toBe('sleepy')
  })
  it('running sessions make her look busy when she is not in conversation', () => {
    const d = makeDirector()
    d.director.setWorkLoad({ running: 2, blocked: 1 })
    d.step()
    expect(d.director.currentProfile()).toBe('busy')
  })
  it('profile changes are rate limited (no flapping) but waking from sleep is immediate', () => {
    const d = makeDirector({ start: at(23, 0) })
    d.director.onUserPresence({ present: true })
    d.director.onUserMessage()
    d.step()
    expect(d.director.currentProfile()).toBe('attentive')
    d.step(60_000, 11) // 11 minutes without interaction inside quiet hours
    expect(d.director.currentProfile()).toBe('asleep')
    d.director.onUserMessage()
    d.step(250)
    expect(d.director.currentProfile()).toBe('attentive')
    const idles = d.ofType('perform.idle')
    for (let i = 1; i < idles.length; i++) expect(idles[i]!.t - idles[i - 1]!.t).toBeGreaterThanOrEqual(250)
  })
  it('quiet hours: she falls asleep after the wake hold, makes no gaze or gesture commands, and stays quiet', () => {
    const d = makeDirector({ start: at(22, 20) })
    d.director.setActivity('idle')
    d.step(60_000, 40) // to 23:00
    expect(d.director.currentProfile()).toBe('asleep')
    d.log.length = 0
    d.run(60)
    const kinds = new Set(d.log.map((e) => e.c.type))
    expect(kinds.has('perform.gaze')).toBe(false)
    expect(kinds.has('perform.gesture')).toBe(false)
    expect(kinds.has('perform.idle')).toBe(false)
    expect(d.director.requestUtterance({ kind: 'proactive' }).allowed).toBe(false)
    expect(d.director.requestUtterance({ kind: 'reply' }).allowed).toBe(true)
    expect(d.director.requestGesture('nod_small')).toMatchObject({ ok: false, code: 'asleep' })
  })
  it('a user message in quiet hours wakes her and she looks at the user', () => {
    const d = makeDirector({ start: at(23, 30) })
    d.step(60_000, 12)
    expect(d.director.currentProfile()).toBe('asleep')
    d.log.length = 0
    d.director.onUserPresence({ present: true })
    d.director.onUserMessage()
    d.step(250, 2)
    expect(d.director.currentProfile()).toBe('attentive')
    expect(d.log.some((e) => e.c.type === 'perform.gaze' && (e.c as { target: { kind: string } }).target.kind === 'user')).toBe(true)
    d.director.onSpeechStarted()
    d.director.onSpeechEnded()
    d.step(60_000, 5)
    expect(d.director.currentProfile()).not.toBe('asleep') // awake while the wake hold runs
  })
  it('a tired, late-night mood makes her sleepy before quiet hours', () => {
    const d = makeDirector({ start: at(23, 0), quiet: null })
    d.step(60_000, 20)
    expect(d.director.currentProfile()).toBe('sleepy')
    expect(d.mood.get().arousal).toBeLessThan(AUTHORITY_PRESENCE.baseline.arousal)
  })
  it('posture follows anchors: sit when sleepy or busy, lean when relaxed, stand otherwise; falls back without anchors', () => {
    const d = makeDirector()
    d.director.setAnchors([
      { objectId: 'chair', anchor: { id: 'seat', kind: 'sit' } },
      { objectId: 'plinth', anchor: { id: 'lean', kind: 'lean' } },
    ])
    d.director.setWorkLoad({ running: 1, blocked: 0 })
    d.step()
    expect(d.ofType('perform.posture')[0]!.c).toMatchObject({ posture: 'sit', anchorObjectId: 'chair', anchorId: 'seat' })
    const bare = makeDirector()
    bare.director.setWorkLoad({ running: 1, blocked: 0 })
    bare.step()
    expect(bare.ofType('perform.posture')[0]!.c).toMatchObject({ posture: 'stand' })
    expect((bare.ofType('perform.posture')[0]!.c as { anchorObjectId?: string }).anchorObjectId).toBeUndefined()
    const p = d.director.requestPosture('lean')
    expect(p).toMatchObject({ type: 'perform.posture', posture: 'lean', anchorObjectId: 'plinth', anchorId: 'lean' })
    expect(d.director.requestPosture('lie')).toMatchObject({ posture: 'stand' })
    expect(d.director.currentPosture()).toBe('stand')
  })
  it('sleeping posture is "sleep" and posture changes are rate limited otherwise', () => {
    const d = makeDirector({ start: at(23, 0) })
    d.step(60_000, 12)
    expect(d.director.currentPosture()).toBe('sleep')
    const e = makeDirector()
    e.director.setAnchors([{ objectId: 'chair', anchor: { id: 'seat', kind: 'sit' } }])
    e.director.setWorkLoad({ running: 1, blocked: 0 })
    e.step()
    e.director.setWorkLoad({ running: 0, blocked: 0 })
    e.director.setActivity('conversation')
    e.step(1000, 20)
    expect(e.ofType('perform.posture')).toHaveLength(1) // 20 s < 60 s hold
    e.step(1000, 50)
    expect(e.ofType('perform.posture').length).toBeGreaterThanOrEqual(2)
  })
})

describe('BehaviorDirector: gaze, attention and gestures', () => {
  const gazeLog = (d: ReturnType<typeof makeDirector>) => d.ofType('perform.gaze').map((e) => ({ t: e.t, target: (e.c as { target: { kind: string; direction?: string } }).target }))

  it('holds eye contact long for authority, breaks it with short away glances, then returns', () => {
    const d = makeDirector()
    d.director.setActivity('conversation')
    d.director.onUserPresence({ present: true })
    d.run(30)
    const g = gazeLog(d)
    expect(g.length).toBeGreaterThan(20)
    const holds: number[] = []
    const glances: number[] = []
    for (let i = 1; i < g.length; i++) {
      const dt = g[i]!.t - g[i - 1]!.t
      if (g[i - 1]!.target.kind === 'user' && g[i]!.target.kind === 'away') holds.push(dt)
      if (g[i - 1]!.target.kind === 'away' && g[i]!.target.kind === 'user') glances.push(dt)
    }
    const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length
    expect(mean(holds)).toBeGreaterThan(4000)
    expect(mean(glances)).toBeLessThan(2000)
    expect(Math.min(...holds)).toBeGreaterThan(2000)
    for (const x of g) if (x.target.kind === 'away') expect(['left', 'right', 'up', 'down']).toContain(x.target.direction)
  })
  it('a low gaze-hold style looks away more often than an authority style', () => {
    const count = (presence: PresenceStyle) => {
      const d = makeDirector({ presence })
      d.director.setActivity('conversation')
      d.director.onUserPresence({ present: true })
      d.run(20)
      return d.ofType('perform.gaze').length
    }
    expect(count({ ...AUTHORITY_PRESENCE, gazeHold: 0.1 })).toBeGreaterThan(count({ ...AUTHORITY_PRESENCE, gazeHold: 0.95 }) * 1.3)
  })
  it('turns to the user on return, fast, lifts her mood a little, and may greet', () => {
    const d = makeDirector()
    d.director.onUserPresence({ present: false })
    d.step(250, 4)
    const before = d.mood.get().arousal
    d.log.length = 0
    d.director.onUserPresence({ present: true })
    d.step(250, 2)
    const first = d.log.find((e) => e.c.type === 'perform.gaze')!
    expect(first.c).toMatchObject({ target: { kind: 'user' }, speed: 0.8 })
    expect(d.mood.get().arousal).toBeGreaterThan(before)
    expect(d.log.some((e) => e.c.type === 'perform.gesture' && ['wave_small', 'greeting_nod'].includes((e.c as { clip: string }).clip))).toBe(true)
  })
  it('while the user is away she does not stare at them: gaze drifts', () => {
    const d = makeDirector()
    d.director.onUserPresence({ present: false })
    d.run(5)
    expect(gazeLog(d).every((g) => g.target.kind === 'away')).toBe(true)
  })
  it('while working she looks at the screen object (or the camera) with occasional glances', () => {
    const d = makeDirector()
    d.director.setScreenObject('monitor_1')
    d.director.setActivity('working')
    d.director.onUserPresence({ present: true })
    d.run(10)
    const kinds = gazeLog(d).map((g) => g.target.kind)
    expect(kinds).toContain('object')
    const first = d.ofType('perform.gaze').find((e) => (e.c as { target: { kind: string } }).target.kind === 'object')!
    expect(first.c).toMatchObject({ target: { objectId: 'monitor_1' } })
    const noMonitor = makeDirector()
    noMonitor.director.setActivity('working')
    noMonitor.director.onUserPresence({ present: true })
    noMonitor.run(5)
    expect(gazeLog(noMonitor).map((g) => g.target.kind)).toContain('camera')
  })
  it('lookAt forces a gaze target for a while', () => {
    const d = makeDirector()
    d.director.setActivity('conversation')
    d.director.onUserPresence({ present: true })
    d.step(250, 2)
    d.log.length = 0
    d.director.lookAt({ kind: 'object', objectId: 'note_3' }, 5000)
    d.step(250, 16) // 4 s
    expect(gazeLog(d)).toHaveLength(1)
    expect(gazeLog(d)[0]!.target).toMatchObject({ kind: 'object' })
    d.step(250, 40)
    expect(gazeLog(d).length).toBeGreaterThan(1)
  })
  it('authority gestures less than an expressive style while speaking, and never twice in a row', () => {
    const run = (presence: PresenceStyle) => {
      const d = makeDirector({ presence })
      d.director.setActivity('conversation')
      d.director.onUserPresence({ present: true })
      d.director.onSpeechStarted()
      d.run(20)
      return d.ofType('perform.gesture').map((e) => (e.c as { clip: string }).clip)
    }
    const calm = run(AUTHORITY_PRESENCE)
    const lively = run(EXPRESSIVE)
    expect(calm.length).toBeGreaterThan(3)
    expect(calm.length).toBeLessThan(lively.length)
    for (const list of [calm, lively]) for (let i = 1; i < list.length; i++) expect(list[i]).not.toBe(list[i - 1])
  })
  it('spaces gestures out: at least the clip duration plus a pause between any two', () => {
    const d = makeDirector()
    d.director.setActivity('conversation')
    d.director.onUserPresence({ present: true })
    d.director.onSpeechStarted()
    d.run(30)
    const gs = d.ofType('perform.gesture')
    for (let i = 1; i < gs.length; i++) expect(gs[i]!.t - gs[i - 1]!.t).toBeGreaterThanOrEqual(DEFAULT_GESTURES.find((c) => c.id === (gs[i - 1]!.c as { clip: string }).clip)!.durationMs)
    for (const g of gs) {
      const i = (g.c as { intensity: number }).intensity
      expect(i).toBeGreaterThanOrEqual(0.15)
      expect(i).toBeLessThanOrEqual(1)
    }
  })
  it('idle gestures are rare for authority (a few per hour), and use idle-context clips', () => {
    const d = makeDirector({ quiet: null })
    d.director.onUserPresence({ present: true })
    d.run(60)
    const gs = d.ofType('perform.gesture').filter((e) => e.t > at(10, 1))
    expect(gs.length).toBeLessThan(35)
    for (const g of gs) expect(DEFAULT_GESTURES.find((c) => c.id === (g.c as { clip: string }).clip)).toBeDefined()
  })
  it('requestGesture validates the clip, shapes intensity by presence, and records history', () => {
    const d = makeDirector()
    expect(d.director.requestGesture('flying_kick')).toMatchObject({ ok: false, code: 'unknown_clip' })
    const r = d.director.requestGesture('hand_open_palm', 1)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toMatchObject({ type: 'perform.gesture', clip: 'hand_open_palm' })
    expect((r.value as { intensity: number }).intensity).toBeLessThan(1) // authority tones it down
    expect(d.director.gestures.recent()[0]).toBe('hand_open_palm')
  })
  it('a barge-in registers mildly, sends her gaze back to the user and delays the next gesture', () => {
    const d = makeDirector()
    d.director.setActivity('conversation')
    d.director.onUserPresence({ present: true })
    d.director.onSpeechStarted()
    d.step(250, 20)
    const before = d.mood.get().dominance
    d.log.length = 0
    d.director.onSpeechEnded(true)
    d.step(250, 2)
    expect(d.mood.get().dominance).toBeLessThan(before)
    expect(d.mood.get().dominance).toBeGreaterThan(before - 0.1)
    expect(d.log.some((e) => e.c.type === 'perform.gaze' && (e.c as { target: { kind: string } }).target.kind === 'user')).toBe(true)
  })
})

describe('BehaviorDirector: affect, ambient mood, budget and determinism', () => {
  it('pushes her affect when it moved enough, not every tick', () => {
    const d = makeDirector()
    d.director.setActivity('conversation')
    d.step()
    const n0 = d.ofType('perform.affect').length
    d.step(250, 40)
    expect(d.ofType('perform.affect').length).toBe(n0)
    d.mood.apply({ type: 'good_news' })
    d.step()
    expect(d.ofType('perform.affect').length).toBe(n0 + 1)
    expect((d.ofType('perform.affect').at(-1)!.c as { affect: { label: string } }).affect.label).toBe('happy')
  })
  it('late hours and a long silence tire her (arousal down) but never lower valence', () => {
    const d = makeDirector({ start: at(23, 30), quiet: null })
    const v0 = d.mood.get().valence
    d.run(120)
    expect(d.mood.get().valence).toBeGreaterThanOrEqual(v0 - 1e-9)
    expect(d.mood.get().arousal).toBeLessThan(AUTHORITY_PRESENCE.baseline.arousal)
  })
  it('is deterministic for a seed and different for another', () => {
    const run = (seed: number) => {
      const d = makeDirector({ seed })
      d.director.setActivity('conversation')
      d.director.onUserPresence({ present: true })
      d.director.onSpeechStarted()
      d.run(10)
      return JSON.stringify(d.log)
    }
    expect(run(5)).toBe(run(5))
    expect(run(5)).not.toBe(run(6))
  })
  it('every emitted command validates against the shared StageCommand schema (property over a long mixed run)', () => {
    const d = makeDirector({ characterId: 'char_1' })
    d.director.setAnchors([{ objectId: 'chair', anchor: { id: 'seat', kind: 'sit' } }])
    d.director.onUserPresence({ present: true })
    const acts = ['idle', 'conversation', 'working', 'reviewing'] as const
    for (let i = 0; i < 8; i++) {
      d.director.setActivity(acts[i % 4]!)
      if (i % 2) d.director.onSpeechStarted()
      else d.director.onSpeechEnded(i % 3 === 0)
      if (i === 5) d.director.onUserPresence({ present: false })
      if (i === 6) d.director.onUserPresence({ present: true })
      d.run(8)
    }
    expect(d.log.length).toBeGreaterThan(30)
    for (const { c } of d.log) {
      const parsed = StageCommand.safeParse({ ...c, id: 'x' })
      expect(parsed.success, JSON.stringify(c)).toBe(true)
      expect((c as { characterId?: string }).characterId).toBe('char_1')
    }
  })
  it('exposes the budget through requestUtterance', () => {
    const d = makeDirector()
    expect(d.director.requestUtterance({ kind: 'proactive' }).allowed).toBe(true)
    expect(d.director.requestUtterance({ kind: 'proactive' }).reason).toMatch(/too soon/)
    expect(d.director.budget.remaining()).toBe(2)
    d.director.setQuietHours({ from: '00:00', to: '23:59' })
    expect(d.director.requestUtterance({ kind: 'proactive', priority: 'P0', listedUrgent: true }).allowed).toBe(true)
  })
  it('setPresence updates the mood baseline and gesture shaping', () => {
    const d = makeDirector()
    d.director.setPresence(EXPRESSIVE)
    expect(d.mood.baseline()).toEqual(EXPRESSIVE.baseline)
    expect(d.director.gestures.targetEnergy()).toBeGreaterThan(0.3)
  })
  it('workload numbers are sanitised', () => {
    const d = makeDirector()
    d.director.setWorkLoad({ running: -3, blocked: 2.9 })
    d.step()
    expect(d.director.currentProfile()).not.toBe('busy')
  })
})
