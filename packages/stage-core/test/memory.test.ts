import { describe, expect, it } from 'vitest'
import { STAGE_TOOL_SURFACE } from '@ai-assistant/shared'
import type { ToolBinding } from '@ai-assistant/shared'
import {
  BehaviorDirector,
  CameraDirector,
  CharacterMemory,
  InMemoryMemoryRepo,
  InMemorySceneRepo,
  MoodEngine,
  SEED_IDS as S,
  classifySensitivity,
  createCharacterMemory,
  createCharacterService,
  createRng,
  createSceneService,
  createSequentialIds,
  createStageToolBindings,
  createWardrobeService,
  createSeedCatalog,
  InMemoryCharacterRepo,
  looksLikeSecret,
  seedBaseId,
  tokenize,
} from '../src'
import type { CommandDraft } from '../src'
import { AUTHORITY_PRESENCE } from '@ai-assistant/shared'
import { T0, at, lcg } from './helpers'
import { createVirtualTime } from '../src'

const DAY = 86_400_000
function mem(opts: { start?: number; max?: number } = {}) {
  const vt = createVirtualTime(opts.start ?? T0)
  const repo = new InMemoryMemoryRepo()
  const memory = new CharacterMemory({ repo, clock: vt.clock, newId: createSequentialIds(), ...(opts.max ? { maxItems: opts.max } : {}) })
  return { vt, repo, memory }
}

describe('remember', () => {
  it('stores an item with defaults, timestamps and an id', () => {
    const { memory } = mem()
    const r = memory.remember({ kind: 'preference', text: '  Prefers   the morning briefing short.  ' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.deduped).toBe(false)
    expect(r.value.item).toMatchObject({ id: 'mem_1', kind: 'preference', text: 'Prefers the morning briefing short.', importance: 2, sensitivity: 'normal', recallCount: 0, createdAt: T0, updatedAt: T0 })
    expect(memory.get('mem_1')).toEqual(r.value.item)
  })
  it.each([
    ['not an object', null],
    ['unknown kind', { kind: 'diary', text: 'x' }],
    ['empty text', { kind: 'episode', text: '   ' }],
    ['control-only text', { kind: 'episode', text: '\u0001\u0002' }],
    ['too long', { kind: 'episode', text: 'x'.repeat(501) }],
    ['bad emotion', { kind: 'episode', text: 'fine', emotion: 'ecstatic' }],
    ['non-string text', { kind: 'episode', text: 42 }],
  ])('refuses %s', (_n, input) => {
    const { memory, repo } = mem()
    const r = memory.remember(input as never)
    expect(r.ok).toBe(false)
    expect(repo.count()).toBe(0)
  })
  it('clamps importance to 1..5 and defaults on junk', () => {
    const { memory } = mem()
    const imp = (v: unknown, text: string) => {
      const r = memory.remember({ kind: 'episode', text, importance: v as number })
      return r.ok ? r.value.item.importance : -1
    }
    expect(imp(99, 'one')).toBe(5)
    expect(imp(-4, 'two')).toBe(1)
    expect(imp(3.6, 'three')).toBe(4)
    expect(imp(NaN, 'four')).toBe(2)
    expect(imp('5', 'five')).toBe(2)
  })
  it('refuses anything that looks like a secret, without echoing it', () => {
    const { memory, repo } = mem()
    for (const secret of [
      'my key is sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz',
      'token: ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'password = hunter2hunter2',
      'AKIAIOSFODNN7EXAMPLE is the id',
      '-----BEGIN RSA PRIVATE KEY-----',
      'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc',
      'longopaque' + 'A1b2C3d4'.repeat(8),
    ]) {
      const r = memory.remember({ kind: 'relationship', text: secret })
      expect(r.ok).toBe(false)
      expect(!r.ok && r.code).toBe('secret')
      expect(!r.ok && r.error).not.toContain('hunter2')
      expect(!r.ok && r.error).not.toContain('AKIA')
    }
    expect(repo.count()).toBe(0)
    expect(looksLikeSecret('We met on Tuesday and talked about the quarterly plan.')).toBe(false)
    expect(looksLikeSecret('I like green tea, no sugar.')).toBe(false)
  })
  it('classifies intimate, health and money material as sensitive and family/health words as private', () => {
    expect(classifySensitivity('We kissed after the show')).toBe('sensitive')
    expect(classifySensitivity('He mentioned a therapy appointment')).toBe('sensitive')
    expect(classifySensitivity('The mortgage payment is due')).toBe('sensitive')
    expect(classifySensitivity('Her sister lives in Lisbon')).toBe('private')
    expect(classifySensitivity('Prefers short answers')).toBe('normal')
  })
  it('the caller can only make an item stricter, never looser', () => {
    const { memory } = mem()
    const a = memory.remember({ kind: 'episode', text: 'We kissed after the show', sensitivity: 'normal' })
    expect(a.ok && a.value.item.sensitivity).toBe('sensitive')
    const b = memory.remember({ kind: 'episode', text: 'Ordinary standup notes', sensitivity: 'private' })
    expect(b.ok && b.value.item.sensitivity).toBe('private')
    const c = memory.remember({ kind: 'episode', text: 'Another ordinary day', sensitivity: 'bogus' as never })
    expect(c.ok && c.value.item.sensitivity).toBe('normal')
  })
  it('keeps one copy of the same fact, raising importance and never loosening sensitivity', () => {
    const { memory, vt } = mem()
    memory.remember({ kind: 'preference', text: 'Likes green tea', importance: 2 })
    vt.advance(1000)
    const again = memory.remember({ kind: 'preference', text: 'likes   GREEN tea!', importance: 4, tags: ['Drinks'] })
    expect(again.ok && again.value.deduped).toBe(true)
    expect(again.ok && again.value.item.importance).toBe(4)
    expect(again.ok && again.value.item.tags).toEqual(['drinks'])
    expect(memory.list()).toHaveLength(1)
    expect(memory.remember({ kind: 'episode', text: 'Likes green tea' }).ok).toBe(true) // another kind is a different memory
    expect(memory.list()).toHaveLength(2)
  })
  it('normalises tags and bounds them', () => {
    const { memory } = mem()
    const r = memory.remember({ kind: 'episode', text: 'tagged', tags: ['Work Stuff!', 'a', 'a', ...Array.from({ length: 20 }, (_, i) => `t${i}`)] })
    expect(r.ok && r.value.item.tags.length).toBe(8)
    expect(r.ok && r.value.item.tags[0]).toBe('workstuff')
  })
  it('evicts the least important oldest item when full, but never an importance-5 one', () => {
    const { memory } = mem({ max: 3 })
    memory.remember({ kind: 'episode', text: 'aaa first', importance: 3 })
    memory.remember({ kind: 'episode', text: 'bbb second', importance: 1 })
    memory.remember({ kind: 'episode', text: 'ccc third', importance: 5 })
    memory.remember({ kind: 'episode', text: 'ddd fourth', importance: 2 })
    expect(memory.list().map((i) => i.text)).toEqual(['aaa first', 'ccc third', 'ddd fourth'])
    const full = mem({ max: 2 }).memory
    full.remember({ kind: 'episode', text: 'one', importance: 5 })
    full.remember({ kind: 'episode', text: 'two', importance: 5 })
    const r = full.remember({ kind: 'episode', text: 'three' })
    expect(!r.ok && r.code).toBe('full')
  })
})

describe('recall', () => {
  function seeded() {
    const m = mem()
    const add = (text: string, over: Record<string, unknown> = {}) => m.memory.remember({ kind: 'episode', text, ...over })
    add('Finished the Q4 positioning draft together', { importance: 4 })
    add('Talked about the Lisbon trip and the flights', { importance: 2 })
    m.vt.advance(10 * DAY)
    add('Reviewed the Q4 budget numbers', { importance: 3 })
    add('Likes green tea in the afternoon', { kind: 'preference', importance: 3 })
    add('Prefers short morning briefings', { kind: 'preference', importance: 4 })
    add('Shared that therapy on Fridays helps', { kind: 'relationship', importance: 5 })
    return m
  }
  it('ranks by keyword overlap first, then importance and recency', () => {
    const { memory } = seeded()
    const r = memory.recall('Q4 positioning', 5)
    expect(r.map((x) => x.item.text)).toEqual(['Finished the Q4 positioning draft together', 'Reviewed the Q4 budget numbers'])
    expect(r[0]!.parts.overlap).toBe(1)
    expect(r[1]!.parts.overlap).toBe(0.5)
    expect(r[0]!.score).toBeGreaterThan(r[1]!.score)
  })
  it('stems plurals and verb forms and ignores stop words', () => {
    expect(tokenize('The flights were booked, and she is talking about trips')).toEqual(['flight', 'booked'.slice(0, -2), 'talk', 'trip'])
    const { memory } = seeded()
    expect(memory.recall('flight', 3).map((r) => r.item.text)).toEqual(['Talked about the Lisbon trip and the flights'])
    expect(memory.recall('the and of', 3).every((r) => r.parts.overlap === 0)).toBe(true) // only stop words: same as no query
  })
  it('an empty query returns the most recent and important', () => {
    const { memory } = seeded()
    const r = memory.recall('', 3, { audience: 'local' })
    expect(r).toHaveLength(3)
    expect(r[0]!.parts.overlap).toBe(0)
  })
  it('includeNonMatching pads with the best of the rest', () => {
    const { memory } = seeded()
    expect(memory.recall('zebra', 3)).toEqual([])
    expect(memory.recall('zebra', 3, { includeNonMatching: true })).toHaveLength(3)
  })
  it('recency decays with a 14 day half-life and breaks ties deterministically', () => {
    const m = mem()
    m.memory.remember({ kind: 'episode', text: 'alpha plan review' })
    m.vt.advance(14 * DAY)
    m.memory.remember({ kind: 'episode', text: 'beta plan review' })
    const r = m.memory.recall('plan review', 5)
    expect(r[0]!.item.text).toBe('beta plan review')
    expect(r[0]!.parts.recency).toBe(1)
    expect(r[1]!.parts.recency).toBeCloseTo(0.5, 6)
    const a = mem().memory
    a.remember({ kind: 'episode', text: 'same words here' })
    a.remember({ kind: 'preference', text: 'same words here too' })
    expect(a.recall('same words').map((x) => x.item.id)).toEqual(a.recall('same words').map((x) => x.item.id))
  })
  it('the cloud audience (default) never sees private or sensitive items; local sees all', () => {
    const { memory } = seeded()
    expect(memory.recall('therapy').length).toBe(0)
    expect(memory.recall('therapy', 5, { audience: 'cloud' }).length).toBe(0)
    expect(memory.recall('therapy', 5, { audience: 'local' })).toHaveLength(1)
  })
  it('filters by kind, bounds the limit, and touch records the recall', () => {
    const { memory, vt } = seeded()
    expect(memory.recall('', 10, { kinds: ['preference'] }).every((r) => r.item.kind === 'preference')).toBe(true)
    expect(memory.recall('', 1000, { audience: 'local' }).length).toBeLessThanOrEqual(20)
    expect(memory.recall('q4', NaN).length).toBeGreaterThan(0)
    const [first] = memory.recall('Q4 positioning', 1, { touch: true })
    expect(first!.item.recallCount).toBe(1)
    expect(first!.item.lastRecalledAt).toBe(vt.now())
    expect(memory.get(first!.item.id)!.recallCount).toBe(1)
    expect(memory.recall('Q4 positioning', 1)[0]!.item.recallCount).toBe(1) // plain recall does not touch
  })
  it('is deterministic over random corpora (property)', () => {
    const r = lcg(3)
    const words = ['plan', 'trip', 'tea', 'review', 'draft', 'budget', 'call', 'note', 'walk', 'idea']
    const build = () => {
      const m = mem()
      const rr = lcg(3)
      for (let i = 0; i < 80; i++) {
        m.vt.advance(Math.floor(rr() * DAY))
        m.memory.remember({ kind: (['episode', 'preference', 'relationship'] as const)[Math.floor(rr() * 3)]!, text: `${words[Math.floor(rr() * 10)]} ${words[Math.floor(rr() * 10)]} item ${i}`, importance: 1 + Math.floor(rr() * 5) })
      }
      return m.memory
    }
    for (let i = 0; i < 10; i++) {
      const q = `${words[Math.floor(r() * 10)]} ${words[Math.floor(r() * 10)]}`
      expect(build().recall(q, 7).map((x) => [x.item.id, x.score])).toEqual(build().recall(q, 7).map((x) => [x.item.id, x.score]))
    }
  })
})

describe('digest and forgetting', () => {
  function corpus() {
    const m = mem()
    const add = (kind: 'episode' | 'relationship' | 'preference', text: string, importance = 3) => m.memory.remember({ kind, text, importance })
    add('relationship', 'Works on positioning for a new product line', 4)
    add('relationship', 'Wants direct answers without fluff', 5)
    add('preference', 'Short morning briefings', 4)
    add('preference', 'Green tea in the afternoon', 2)
    add('episode', 'Finished the draft together', 4)
    m.vt.advance(2 * DAY)
    add('episode', 'Agreed to review the budget on Friday', 3)
    add('relationship', 'They kissed on the anniversary dinner', 5)
    add('episode', 'Talked through the therapy session afterwards', 5)
    add('relationship', 'Her sister lives abroad', 4)
    return m
  }
  it('excludes private and sensitive material from the cloud digest by default, and counts what was left out', () => {
    const { memory } = corpus()
    const d = memory.digest()
    expect(d.text).toContain('What I remember about you and us:')
    expect(d.text).toContain('direct answers')
    expect(d.text).not.toMatch(/kissed|therapy|sister/i)
    expect(d.excluded).toEqual({ private: 1, sensitive: 2 })
    for (const id of d.itemIds) expect(memory.get(id)!.sensitivity).toBe('normal')
  })
  it('the local audience includes everything', () => {
    const { memory } = corpus()
    const d = memory.digest({ audience: 'local', maxChars: 2000 })
    expect(d.text).toMatch(/kissed/)
    expect(d.text).toMatch(/sister/)
    expect(d.excluded).toEqual({ private: 0, sensitive: 0 })
  })
  it('is grouped, short and within the character budget', () => {
    const { memory } = corpus()
    const d = memory.digest({ maxChars: 300 })
    expect(d.text.length).toBeLessThanOrEqual(300)
    expect(d.text).toMatch(/Us:\n- /)
    expect(d.text).toMatch(/Preferences:\n- /)
    expect(d.text).toMatch(/Recently:\n- (today|yesterday|\d+ days ago): /)
    expect(memory.digest({ maxItems: 2 }).itemIds).toHaveLength(2)
    const tiny = memory.digest({ maxChars: 80 })
    expect(tiny.text.length).toBeLessThanOrEqual(80)
  })
  it('an empty memory gives an empty digest; old episodes drop out of "Recently"', () => {
    expect(mem().memory.digest()).toEqual({ text: '', itemIds: [], excluded: { private: 0, sensitive: 0 } })
    const m = mem()
    m.memory.remember({ kind: 'episode', text: 'A very old event' })
    m.vt.advance(45 * DAY)
    expect(m.memory.digest().text).toBe('')
  })
  it('never repeats a near-duplicate and orders by importance', () => {
    const m = mem()
    m.memory.remember({ kind: 'relationship', text: 'Likes quiet mornings', importance: 2 })
    m.memory.remember({ kind: 'preference', text: 'likes quiet mornings!', importance: 5 })
    m.memory.remember({ kind: 'relationship', text: 'Runs the Berlin office', importance: 5 })
    const d = m.memory.digest()
    expect(d.itemIds).toHaveLength(2)
    expect(d.text.match(/quiet mornings/gi)).toHaveLength(1)
  })
  it('forget removes one item; forgetWhere removes matches; stats count by kind and sensitivity', () => {
    const { memory } = corpus()
    const before = memory.stats()
    expect(before.total).toBe(9)
    expect(before.bySensitivity).toEqual({ normal: 6, private: 1, sensitive: 2 })
    expect(before.byKind).toEqual({ episode: 3, relationship: 4, preference: 2 })
    expect(memory.forget('mem_1')).toBe(true)
    expect(memory.forget('mem_1')).toBe(false)
    expect(memory.get('mem_1')).toBeUndefined()
    expect(memory.forgetWhere((i) => i.sensitivity !== 'normal')).toBe(3)
    expect(memory.stats().total).toBe(5)
    expect(memory.digest({ audience: 'local', maxChars: 2000 }).excluded).toEqual({ private: 0, sensitive: 0 })
    expect(createCharacterMemory({ repo: new InMemoryMemoryRepo(), clock: createVirtualTime(0).clock, newId: createSequentialIds() })).toBeInstanceOf(CharacterMemory)
  })
})

// ---------------------------------------------------------------------------------------------- tool bindings

function toolRig() {
  const vt = createVirtualTime(at(8, 30))
  const catalog = createSeedCatalog()
  const newId = createSequentialIds()
  const characters = createCharacterService({ repo: new InMemoryCharacterRepo(), catalog, clock: vt.clock, newId })
  const wardrobe = createWardrobeService({ characters, catalog, newId })
  const scenes = createSceneService({ repo: new InMemorySceneRepo(), catalog, clock: vt.clock, newId })
  const memory = new CharacterMemory({ repo: new InMemoryMemoryRepo(), clock: vt.clock, newId })
  const moodE = MoodEngine.fromPresence(AUTHORITY_PRESENCE, vt.clock)
  const behavior = new BehaviorDirector({ clock: vt.clock, rng: createRng(1), presence: AUTHORITY_PRESENCE, mood: moodE })
  const camera = new CameraDirector({ clock: vt.clock })
  const performed: CommandDraft[] = []
  const created = characters.create({ name: 'Mira', baseAssetId: seedBaseId('vrm1') })
  if (!created.ok) throw new Error(created.error)
  scenes.ensureVoid()
  const tools = createStageToolBindings({
    characters,
    wardrobe,
    scenes,
    memory,
    perform: (c) => performed.push(...c),
    requestGesture: (clip, intensity) => behavior.requestGesture(clip, intensity),
    requestShot: (shot) => camera.request(shot),
    mood: () => moodE.get(),
    posture: () => behavior.currentPosture() ?? 'stand',
    stage: () => ({ connected: true, engine: 'sim' }),
  })
  const call = async (name: string, input: unknown) => {
    const t = tools.find((x) => x.spec.name === name)!
    return t.handler(input)
  }
  return { vt, characters, wardrobe, scenes, memory, tools, call, performed, assistant: created.value, moodE }
}

describe('createStageToolBindings', () => {
  it('binds exactly the stage tool surface, with its specs', () => {
    const { tools } = toolRig()
    expect(tools.map((t: ToolBinding) => t.spec.name)).toEqual(STAGE_TOOL_SURFACE.map((s) => s.name))
    for (const t of tools) expect(t.spec).toBe(STAGE_TOOL_SURFACE.find((s) => s.name === t.spec.name))
  })
  it('stage_set_outfit applies a preset and sends the command', async () => {
    const r = toolRig()
    const res = await r.call('stage_set_outfit', { presetId: 'preset.meeting' })
    expect(res.isError).toBeUndefined()
    expect(res.text).toMatch(/Now wearing "Meeting".*Tailored blazer/)
    expect(r.performed.map((c) => c.type)).toEqual(['character.outfit'])
    expect(r.characters.get(r.assistant.id)!.equipped.outerwear).toBe(S.blazer)
  })
  it('stage_set_outfit with an unknown preset lists the available ones', async () => {
    const r = toolRig()
    const res = await r.call('stage_set_outfit', { presetId: 'preset.nope' })
    expect(res.isError).toBe(true)
    expect(res.text).toMatch(/Available: .*preset\.meeting \(Meeting\)/)
    expect(r.performed).toHaveLength(0)
  })
  it('stage_set_outfit wears or removes a single item and refuses what would break the baseline', async () => {
    const r = toolRig()
    const on = await r.call('stage_set_outfit', { slot: 'outerwear', assetId: S.coat })
    expect(on.text).toMatch(/Done\. Now wearing/)
    expect(r.performed[0]).toMatchObject({ type: 'character.equip', slot: 'outerwear' })
    const same = await r.call('stage_set_outfit', { slot: 'outerwear', assetId: S.coat })
    expect(same.text).toBe('Already like that.')
    const off = await r.call('stage_set_outfit', { slot: 'outerwear', assetId: null })
    expect(off.isError).toBeUndefined()
    const top = await r.call('stage_set_outfit', { slot: 'top', assetId: null })
    expect(top.isError).toBe(true)
    expect(top.text).toMatch(/full outfit/)
    expect((await r.call('stage_set_outfit', { slot: 'nonsense', assetId: S.coat })).text).toMatch(/Unknown slot/)
    expect((await r.call('stage_set_outfit', { slot: 'top' })).isError).toBe(true)
    expect((await r.call('stage_set_outfit', {})).isError).toBe(true)
    expect((await r.call('stage_set_outfit', { slot: 'top', assetId: 'nope' })).isError).toBe(true)
  })
  it('stage_set_scene switches presets and places, swaps and removes objects', async () => {
    const r = toolRig()
    const p = await r.call('stage_set_scene', { presetId: 'preset.void-seating' })
    expect(p.text).toBe('Scene set to "Void with seating".')
    expect(r.performed.at(-1)!.type).toBe('scene.load')
    const add = await r.call('stage_set_scene', { op: 'add', assetId: S.plinth, objectId: 'desk_1' })
    expect(add.text).toBe(`Placed ${S.plinth} as "desk_1".`)
    expect(r.scenes.getObject('desk_1')!.role).toBe('furniture')
    expect(r.scenes.getObject('desk_1')!.transform.position.every(Number.isFinite)).toBe(true)
    expect((await r.call('stage_set_scene', { op: 'update', objectId: 'desk_1', assetId: S.chair })).text).toMatch(/Swapped/)
    expect((await r.call('stage_set_scene', { op: 'remove', objectId: 'desk_1' })).text).toBe('Removed "desk_1".')
    for (const bad of [{ op: 'add' }, { op: 'update', objectId: 'x' }, { op: 'remove' }, {}, { presetId: 'nope' }, { op: 'add', assetId: 'nope' }, { op: 'add', assetId: S.blazer }, { op: 'remove', objectId: 'ghost' }]) {
      expect((await r.call('stage_set_scene', bad)).isError).toBe(true)
    }
  })
  it('stage_gesture performs a known clip shaped by her style and rejects unknown ones', async () => {
    const r = toolRig()
    const ok = await r.call('stage_gesture', { clip: 'nod_slow' })
    expect(ok.text).toBe('Gesture "nod_slow".')
    expect(r.performed.at(-1)).toMatchObject({ type: 'perform.gesture', clip: 'nod_slow' })
    const bad = await r.call('stage_gesture', { clip: 'moonwalk' })
    expect(bad.isError).toBe(true)
    expect(bad.text).toMatch(/unknown gesture "moonwalk"/)
    expect((await r.call('stage_gesture', { clip: 'nod_slow', intensity: 7 })).isError).toBe(true)
  })
  it('stage_camera moves the camera, persists the active shot and rejects unknown ones', async () => {
    const r = toolRig()
    const ok = await r.call('stage_camera', { shot: 'closeup' })
    expect(ok.text).toBe('Camera: closeup.')
    expect(r.performed.at(-1)).toMatchObject({ type: 'scene.camera', cameraId: 'closeup' })
    expect(r.scenes.getScene()!.activeCameraId).toBe('closeup')
    const bad = await r.call('stage_camera', { shot: 'drone' })
    expect(bad.isError).toBe(true)
    expect(bad.text).toMatch(/wide, medium, closeup/)
  })
  it('character_remember stores memories, explains sensitivity, dedupes and refuses secrets', async () => {
    const r = toolRig()
    const a = await r.call('character_remember', { kind: 'preference', text: 'Likes short briefings', importance: 3 })
    expect(a.text).toBe('Remembered (preference, importance 3).')
    const dup = await r.call('character_remember', { kind: 'preference', text: 'likes short briefings', importance: 5 })
    expect(dup.text).toBe('Already remembered; importance is now 5.')
    const intimate = await r.call('character_remember', { kind: 'episode', text: 'We kissed at the party' })
    expect(intimate.text).toMatch(/Kept sensitive: it stays out of anything sent to the cloud/)
    const secret = await r.call('character_remember', { kind: 'relationship', text: 'token: ghp_abcdefghijklmnopqrstuvwxyz0123456789' })
    expect(secret.isError).toBe(true)
    expect(secret.text).not.toContain('ghp_')
    expect(r.memory.list()).toHaveLength(2)
    expect((await r.call('character_remember', { kind: 'diary', text: 'x' })).isError).toBe(true)
    expect((await r.call('character_remember', { kind: 'episode', text: 'x'.repeat(501) })).isError).toBe(true)
  })
  it('stage_state reports look, mood, posture, scene and stage concisely', async () => {
    const r = toolRig()
    r.moodE.apply({ type: 'good_news' })
    const res = await r.call('stage_state', {})
    expect(res.isError).toBeUndefined()
    const lines = res.text.split('\n')
    expect(lines[0]).toBe('Look: Crisp shirt, Tailored trousers, Ankle boots')
    expect(lines[1]).toMatch(/^Mood: happy \(valence 0\.\d+, arousal -?0\.\d+, dominance 0\.\d+\)$/)
    expect(lines).toContain('Posture: stand')
    expect(lines).toContain('Scene: Cerebral void, camera wide, 0 object(s), 0 construct(s)')
    expect(lines).toContain('Stage: connected (sim)')
    expect(res.text.length).toBeLessThan(400)
  })
  it('without an assistant the tools answer politely instead of throwing', async () => {
    const r = toolRig()
    // a second rig with no characters
    const vt = createVirtualTime(T0)
    const catalog = createSeedCatalog()
    const newId = createSequentialIds()
    const characters = createCharacterService({ repo: new InMemoryCharacterRepo(), catalog, clock: vt.clock, newId })
    const tools = createStageToolBindings({
      characters,
      wardrobe: createWardrobeService({ characters, catalog, newId }),
      scenes: createSceneService({ repo: new InMemorySceneRepo(), catalog, clock: vt.clock, newId }),
      memory: r.memory,
      perform: () => undefined,
      requestGesture: () => ({ ok: false, code: 'x', error: 'x' }),
      requestShot: () => ({ ok: false, code: 'x', error: 'x' }),
    })
    const outfit = await tools.find((t) => t.spec.name === 'stage_set_outfit')!.handler({ presetId: 'preset.work' })
    expect(outfit).toEqual({ text: 'There is no assistant character yet.', isError: true })
    const state = await tools.find((t) => t.spec.name === 'stage_state')!.handler({})
    expect(state.text).toBe('There is no assistant character yet.')
  })
  it('never throws, whatever the input (fuzz)', async () => {
    const r = toolRig()
    const inputs: unknown[] = [null, undefined, 5, 'x', [], {}, { slot: 5 }, { presetId: {} }, { clip: null }, { shot: 7 }, { kind: [], text: {} }, JSON.parse('{"__proto__":{"x":1},"presetId":"preset.work"}')]
    for (const t of r.tools) for (const input of inputs) {
      const res = await t.handler(input)
      expect(typeof res.text).toBe('string')
    }
  })
  it('a throwing dependency becomes an error result', async () => {
    const r = toolRig()
    const tools = createStageToolBindings({
      characters: r.characters,
      wardrobe: r.wardrobe,
      scenes: r.scenes,
      memory: r.memory,
      perform: () => {
        throw new Error('stage is on fire')
      },
      requestGesture: (c) => ({ ok: true, value: { type: 'perform.gesture', clip: c } as CommandDraft }),
      requestShot: () => ({ ok: false, code: 'x', error: 'x' }),
    })
    const res = await tools.find((t) => t.spec.name === 'stage_gesture')!.handler({ clip: 'nod_small' })
    expect(res.isError).toBe(true)
    expect(res.text).toMatch(/stage is on fire/)
  })
})
