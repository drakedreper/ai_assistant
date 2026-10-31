import { describe, expect, it } from 'vitest'
import { createBudgetGuard } from '../src'

function setup(over: Partial<Parameters<typeof createBudgetGuard>[0]> = {}) {
  const clock = { now: new Date(2026, 10, 2, 9, 0, 0) }
  const guard = createBudgetGuard({
    lanes: [
      { lane: 'secretary', dailyBudgetUsd: 4 },
      { lane: 'reader', dailyBudgetUsd: 1 },
      { lane: 'voice', dailyBudgetUsd: 1 },
    ],
    globalDailyCapUsd: 10,
    now: () => clock.now,
    ...over,
  })
  return { guard, clock }
}

describe('createBudgetGuard', () => {
  it('allows spending until the lane budget is used, then blocks with a readable reason', () => {
    const { guard } = setup()
    expect(guard.check('secretary')).toEqual({ ok: true })
    guard.record('secretary', 3.99)
    expect(guard.check('secretary')).toEqual({ ok: true })
    guard.record('secretary', 0.01)
    const r = guard.check('secretary')
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toMatch(/secretary lane's daily budget of \$4\.00 is used up/)
    expect(r.ok === false && r.reason).toMatch(/resets at midnight/)
  })

  it('one lane running out does not block another', () => {
    const { guard } = setup()
    guard.record('reader', 5)
    expect(guard.check('reader').ok).toBe(false)
    expect(guard.check('secretary').ok).toBe(true)
  })

  it('the global cap blocks every lane, whatever their own budgets say', () => {
    const { guard } = setup({ globalDailyCapUsd: 5 })
    guard.record('secretary', 3.5)
    guard.record('reader', 0.9)
    guard.record('voice', 0.6)
    for (const lane of ['secretary', 'reader', 'voice'] as const) {
      const r = guard.check(lane)
      expect(r.ok).toBe(false)
      expect(r.ok === false && r.reason).toMatch(/global daily cap of \$5\.00/)
    }
  })

  it('resets at local midnight, not 24 hours after the first spend', () => {
    const { guard, clock } = setup()
    guard.record('secretary', 4)
    expect(guard.check('secretary').ok).toBe(false)
    clock.now = new Date(2026, 10, 2, 23, 59, 59)
    expect(guard.check('secretary').ok).toBe(false)
    clock.now = new Date(2026, 10, 3, 0, 0, 1)
    expect(guard.check('secretary').ok).toBe(true)
    expect(guard.status().globalSpentTodayUsd).toBe(0)
    expect(guard.status().lanes.find((l) => l.lane === 'secretary')?.spentTodayUsd).toBe(0)
  })

  it('a spend recorded just after midnight belongs to the new day', () => {
    const { guard, clock } = setup()
    guard.record('secretary', 2)
    clock.now = new Date(2026, 10, 3, 0, 5)
    guard.record('secretary', 1)
    expect(guard.status().lanes.find((l) => l.lane === 'secretary')?.spentTodayUsd).toBe(1)
  })

  it('status reports every lane, the cap and today\'s totals', () => {
    const { guard } = setup()
    guard.record('secretary', 1.25)
    guard.record('reader', 0.5)
    expect(guard.status()).toEqual({
      lanes: [
        { lane: 'secretary', dailyBudgetUsd: 4, spentTodayUsd: 1.25 },
        { lane: 'reader', dailyBudgetUsd: 1, spentTodayUsd: 0.5 },
        { lane: 'voice', dailyBudgetUsd: 1, spentTodayUsd: 0 },
      ],
      globalDailyCapUsd: 10,
      globalSpentTodayUsd: 1.75,
    })
  })

  it('does not accumulate float noise', () => {
    const { guard } = setup()
    for (let i = 0; i < 10; i++) guard.record('secretary', 0.1)
    expect(guard.status().lanes[0]?.spentTodayUsd).toBe(1)
  })

  it('ignores negative, zero, NaN and infinite costs', () => {
    const { guard } = setup()
    guard.record('secretary', -5)
    guard.record('secretary', 0)
    guard.record('secretary', Number.NaN)
    guard.record('secretary', Number.POSITIVE_INFINITY)
    expect(guard.status().globalSpentTodayUsd).toBe(0)
  })

  it('fails closed for a lane that has no budget', () => {
    const { guard } = setup({ lanes: [{ lane: 'secretary', dailyBudgetUsd: 4 }] })
    const r = guard.check('reader')
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toMatch(/No daily budget is configured for the reader lane/)
  })

  it('a zero budget means the lane may not spend', () => {
    const { guard } = setup({ lanes: [{ lane: 'secretary', dailyBudgetUsd: 0 }] })
    expect(guard.check('secretary').ok).toBe(false)
  })

  it('restore seeds today\'s spend after a restart', () => {
    const { guard } = setup()
    guard.restore({ lanes: { secretary: 3.9 }, globalUsd: 4.2 })
    expect(guard.check('secretary').ok).toBe(true)
    guard.record('secretary', 0.2)
    expect(guard.check('secretary').ok).toBe(false)
    expect(guard.status().globalSpentTodayUsd).toBe(4.4)
  })

  it('configure changes limits and keeps spend', () => {
    const { guard } = setup()
    guard.record('secretary', 3)
    guard.configure({ lanes: [{ lane: 'secretary', dailyBudgetUsd: 2 }], globalDailyCapUsd: 100 })
    expect(guard.check('secretary').ok).toBe(false)
    guard.configure({ lanes: [{ lane: 'secretary', dailyBudgetUsd: 8 }] })
    expect(guard.check('secretary').ok).toBe(true)
    expect(guard.status().globalDailyCapUsd).toBe(100)
  })

  it('defaults to the real clock when none is injected', () => {
    const guard = createBudgetGuard({ lanes: [{ lane: 'secretary', dailyBudgetUsd: 1 }], globalDailyCapUsd: 1 })
    guard.record('secretary', 0.5)
    expect(guard.status().lanes[0]?.spentTodayUsd).toBe(0.5)
  })
})
