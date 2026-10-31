import { describe, expect, it } from 'vitest'
import { OutfitDirector, SEED_OUTFIT_PRESETS, createOutfitDirector, createWardrobeService } from '../src'
import { T0, at, makeAssistant, makeWorld } from './helpers'

function make(start = T0) {
  const w = makeAssistant(makeWorld(start))
  const director = createOutfitDirector({ clock: w.vt.clock, presets: () => SEED_OUTFIT_PRESETS })
  return { ...w, director }
}

describe('OutfitDirector.suggest', () => {
  it('returns null without candidates', () => {
    const { director } = make()
    expect(director.suggest({ presets: [] })).toBeNull()
    expect(new OutfitDirector({ clock: { now: () => 0 } }).suggest()).toBeNull()
  })

  it.each([
    ['a meeting', { activity: 'meeting' as const, timeOfDay: 'day' as const }, 'preset.meeting', /meeting/],
    ['a work block in the morning', { activity: 'work' as const, timeOfDay: 'morning' as const }, 'preset.work', /work block/],
    ['going out in the cold', { activity: 'out' as const, weather: 'cold' as const, timeOfDay: 'day' as const }, 'preset.out', /heading out|cold/],
    ['resting at night', { activity: 'sleep' as const, timeOfDay: 'night' as const }, 'preset.restful', /rest/],
    ['an evening at ease', { activity: 'relax' as const, timeOfDay: 'evening' as const }, undefined, /./],
  ])('picks a fitting preset for %s', (_n, ctx, expected, phrase) => {
    const { director } = make()
    const s = director.suggest(ctx)!
    if (expected) expect(s.presetId).toBe(expected)
    expect(s.explanation).toMatch(phrase)
    expect(s.explanation).not.toMatch(/\n/)
    expect(s.explanation.endsWith('.')).toBe(true)
    expect(s.changed).toBe(true)
    expect(SEED_OUTFIT_PRESETS.some((p) => p.id === s.presetId)).toBe(true)
  })

  it('derives time of day from the clock when it is not given', () => {
    const w = make(at(23, 0))
    const s = w.director.suggest({ activity: 'sleep' })!
    expect(s.presetId).toBe('preset.restful')
    expect(s.explanation).toMatch(/rest/)
    const morning = make(at(8, 0)).director.suggest({ activity: 'work' })!
    expect(morning.presetId).toBe('preset.work')
  })

  it('is deterministic', () => {
    const a = make().director.suggest({ activity: 'relax', timeOfDay: 'evening', weather: 'clear' })
    const b = make().director.suggest({ activity: 'relax', timeOfDay: 'evening', weather: 'clear' })
    expect(a).toEqual(b)
  })

  it('keeps the current look when it is already the best', () => {
    const { director } = make()
    const s = director.suggest({ activity: 'meeting', timeOfDay: 'day', currentPresetId: 'preset.meeting' })!
    expect(s.presetId).toBe('preset.meeting')
    expect(s.changed).toBe(false)
    expect(s.explanation).toMatch(/Keeping Meeting/)
  })

  it('applies a cooldown after a change so she does not change constantly, then allows it', () => {
    const { director, vt } = make()
    director.noteApplied('preset.work', 'director', { activity: 'work', timeOfDay: 'morning' })
    expect(director.cooldownRemainingMs()).toBe(90 * 60_000)
    vt.advance(10 * 60_000)
    const held = director.suggest({ activity: 'meeting', timeOfDay: 'day', currentPresetId: 'preset.work' })!
    expect(held).toMatchObject({ presetId: 'preset.work', changed: false })
    expect(held.explanation).toMatch(/changed recently.*80 min/)
    vt.advance(80 * 60_000)
    expect(director.cooldownRemainingMs()).toBe(0)
    const later = director.suggest({ activity: 'meeting', timeOfDay: 'day', currentPresetId: 'preset.work' })!
    expect(later).toMatchObject({ presetId: 'preset.meeting', changed: true })
  })

  it('the caller can bypass the cooldown explicitly', () => {
    const { director } = make()
    director.noteApplied('preset.work', 'director')
    const s = director.suggest({ activity: 'meeting', timeOfDay: 'day', currentPresetId: 'preset.work', bypassCooldown: true })!
    expect(s.presetId).toBe('preset.meeting')
  })

  it('an explicit user choice always wins while held, even over the context and bypassCooldown', () => {
    const { director, vt } = make()
    director.noteApplied('preset.training', 'user', { activity: 'work', timeOfDay: 'morning' })
    const s = director.suggest({ activity: 'meeting', timeOfDay: 'day', currentPresetId: 'preset.work', bypassCooldown: true })!
    expect(s).toMatchObject({ presetId: 'preset.training', changed: true })
    expect(s.explanation).toMatch(/you chose it/)
    const same = director.suggest({ activity: 'meeting', currentPresetId: 'preset.training' })!
    expect(same.changed).toBe(false)
    vt.advance(3 * 3_600_000 + 1)
    const after = director.suggest({ activity: 'meeting', timeOfDay: 'day', currentPresetId: 'preset.training' })!
    expect(after.presetId).toBe('preset.meeting')
  })

  it('remembers a user choice as a preference for that context', () => {
    const { director, vt } = make()
    director.noteApplied('preset.training', 'user', { activity: 'work', timeOfDay: 'morning' })
    expect(director.preferences()).toEqual({ 'work|morning': 'preset.training' })
    vt.advance(4 * 3_600_000) // hold and cooldown over
    const s = director.suggest({ activity: 'work', timeOfDay: 'morning', currentPresetId: 'preset.meeting' })!
    expect(s.presetId).toBe('preset.training')
    expect(s.explanation).toMatch(/you usually choose it/)
    // a different context is unaffected
    expect(director.suggest({ activity: 'meeting', timeOfDay: 'day', currentPresetId: 'preset.work' })!.presetId).toBe('preset.meeting')
  })

  it('preferences without an activity are keyed by time of day; explicit setPreference works; context can override', () => {
    const { director, vt } = make()
    director.noteApplied('preset.evening', 'user', { timeOfDay: 'evening' })
    expect(director.preferences()).toEqual({ '*|evening': 'preset.evening' })
    vt.advance(5 * 3_600_000)
    director.setPreference('meeting', '*', 'preset.out')
    expect(director.suggest({ activity: 'meeting', timeOfDay: 'day' })!.presetId).toBe('preset.out')
    expect(director.suggest({ activity: 'meeting', timeOfDay: 'day', preferences: {} })!.presetId).toBe('preset.meeting')
  })

  it('director and assistant changes do not become preferences or locks', () => {
    const { director } = make()
    director.noteApplied('preset.out', 'assistant', { activity: 'out' })
    director.noteApplied('preset.work', 'director', { activity: 'work' })
    expect(director.preferences()).toEqual({})
    expect(director.suggest({ activity: 'meeting', bypassCooldown: true })!.presetId).toBe('preset.meeting')
  })

  it('varies: recently worn outfits score lower so the same one is not picked forever', () => {
    const { director } = make()
    const ctx = { activity: 'relax' as const, timeOfDay: 'evening' as const }
    const first = director.suggest({ ...ctx })!
    const second = director.suggest({ ...ctx, recentOutfits: [first.presetId] })!
    expect(second.presetId).not.toBe(first.presetId)
    expect(director.suggest({ ...ctx, recentOutfits: [] })!.presetId).toBe(first.presetId)
  })

  it('tracks history newest first, deduplicated and bounded', () => {
    const { director } = make()
    for (let i = 0; i < 12; i++) director.noteApplied(`p${i % 10}`, 'director')
    expect(director.recent()).toHaveLength(8)
    director.noteApplied('p5', 'director')
    expect(director.recent()[0]).toBe('p5')
    expect(new Set(director.recent()).size).toBe(director.recent().length)
  })

  it('exports and imports its state', () => {
    const a = make()
    a.director.noteApplied('preset.training', 'user', { activity: 'work', timeOfDay: 'morning' })
    const state = JSON.parse(JSON.stringify(a.director.exportState()))
    const b = make()
    b.director.importState(state)
    expect(b.director.preferences()).toEqual(a.director.preferences())
    expect(b.director.recent()).toEqual(['preset.training'])
    expect(b.director.suggest({ activity: 'meeting', currentPresetId: 'preset.work' })!.presetId).toBe('preset.training')
  })

  it('wires to the wardrobe: user changes hold, manual item changes hold the current look', () => {
    const w = makeAssistant(makeWorld())
    let director!: OutfitDirector
    const wardrobe = createWardrobeService({
      characters: w.characters,
      catalog: w.catalog,
      newId: w.newId,
      onChange: (c) => director.handleChange(c, { activity: 'work', timeOfDay: 'morning' }),
    })
    director = createOutfitDirector({ clock: w.vt.clock, presets: () => wardrobe.applicablePresets(w.assistant.id), currentPresetId: () => wardrobe.currentPresetId(w.assistant.id) })
    wardrobe.applyPreset(w.assistant.id, 'preset.training', { source: 'user' })
    expect(director.preferences()['work|morning']).toBe('preset.training')
    expect(director.suggest({ activity: 'meeting', timeOfDay: 'day' })!).toMatchObject({ presetId: 'preset.training', changed: false })
    wardrobe.applyPreset(w.assistant.id, 'preset.work', { source: 'director' })
    expect(director.recent()[0]).toBe('preset.work')
    // a hand-made change (no preset matches) holds: nothing to suggest
    wardrobe.equip(w.assistant.id, 'accessory.leather-gloves', { source: 'user' })
    expect(wardrobe.currentPresetId(w.assistant.id)).toBeUndefined()
    expect(director.suggest({ activity: 'meeting', timeOfDay: 'day' })).toBeNull()
    w.vt.advance(3 * 3_600_000 + 1)
    expect(director.suggest({ activity: 'meeting', timeOfDay: 'day' })!.presetId).toBe('preset.meeting')
  })

  it('only suggests presets she can actually wear', () => {
    const w = makeAssistant(makeWorld())
    const wardrobe = createWardrobeService({ characters: w.characters, catalog: w.catalog, newId: w.newId })
    w.catalog.remove('outfit.tailored-blazer')
    const director = createOutfitDirector({ clock: w.vt.clock, presets: () => wardrobe.applicablePresets(w.assistant.id) })
    const s = director.suggest({ activity: 'meeting', timeOfDay: 'day' })!
    expect(s.presetId).not.toBe('preset.meeting')
  })
})
