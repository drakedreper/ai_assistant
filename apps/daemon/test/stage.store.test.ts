import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { buildSnapshot } from '@ai-assistant/shared/fixtures'
import { AUTHORITY_PRESENCE } from '@ai-assistant/shared'
import { CharacterMemory, createSeedCatalog, createCharacterService, createSceneService, createSequentialIds, seedBaseId } from '@ai-assistant/stage-core'
import { EventBus } from '../src/bus'
import { createIdGen } from '../src/ids'
import { silentLogger } from '../src/log'
import { StageHub, STAGE_KV } from '../src/stage/hub'
import { ABSTRACT_BASE_ID, ASSISTANT_CHARACTER_ID, USER_CHARACTER_ID, seedManifests } from '../src/stage/seed'
import { MIGRATIONS, LATEST_VERSION, migrate, openStore, StageStore, Store } from '../src/store'
import { makeClock, makeTmp, testConfig } from './helpers'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

function memStore(): Store {
  const s = openStore({ file: ':memory:' })
  cleanups.push(() => s.close())
  return s
}

function makeHub(store: Store, dir = '/tmp/x') {
  const clock = makeClock()
  const bus = new EventBus()
  const persona = buildSnapshot(new Date(clock.now())).settings.persona
  const hub = new StageHub({ config: testConfig(dir), store, bus, log: silentLogger, now: () => new Date(clock.now()), clock: clock.fn, newId: createIdGen(clock.fn), persona: () => persona })
  return { hub, clock, bus }
}

describe('stage migration (schema 3)', () => {
  it('creates every stage table on an empty database', () => {
    const s = memStore()
    expect(s.schemaVersion()).toBe(LATEST_VERSION)
    expect(LATEST_VERSION).toBeGreaterThanOrEqual(3)
    const tables = (s.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((t) => t.name)
    for (const t of ['stage_assets', 'stage_characters', 'stage_outfit_presets', 'stage_active', 'stage_scene', 'stage_scene_presets', 'stage_memory', 'stage_mood']) expect(tables, t).toContain(t)
  })

  it('migrates a Phase 1 database (schema 2) in place and keeps its data', () => {
    const db = new Database(':memory:')
    cleanups.push(() => db.close())
    db.pragma('foreign_keys = ON')
    for (const m of MIGRATIONS.filter((x) => x.version <= 2)) m.up(db)
    db.pragma('user_version = 2')
    db.prepare("INSERT INTO kv (key, value_json, updated_at) VALUES ('settings.guestMode', 'true', '2026-11-02T10:00:00.000Z')").run()
    db.prepare("INSERT INTO chat_messages (id, role, created_at, modality, parts_json) VALUES ('c1', 'user', '2026-11-02T10:00:00.000Z', 'text', '[]')").run()
    db.prepare("INSERT INTO usage (day, lane, model, cost_usd) VALUES ('2026-11-02', 'secretary', 'm', 0.5)").run()
    const r = migrate(db)
    expect(r).toEqual({ from: 2, to: LATEST_VERSION })
    expect(db.prepare("SELECT value_json FROM kv WHERE key = 'settings.guestMode'").get()).toEqual({ value_json: 'true' })
    expect(db.prepare('SELECT COUNT(*) AS n FROM chat_messages').get()).toEqual({ n: 1 })
    expect(db.prepare('SELECT cost_usd FROM usage').get()).toEqual({ cost_usd: 0.5 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM stage_assets').get()).toEqual({ n: 0 })
    // and the stage works on the migrated file
    const { hub } = makeHub(new Store(db))
    expect(hub.snapshot().characters.map((c) => c.id)).toEqual([ASSISTANT_CHARACTER_ID, USER_CHARACTER_ID])
  })

  it('is idempotent and refuses nothing it already did', () => {
    const s = memStore()
    expect(migrate(s.db)).toEqual({ from: LATEST_VERSION, to: LATEST_VERSION })
  })

  it('the stage migration is append-only: versions are consecutive and 3 is the stage one', () => {
    expect(MIGRATIONS.map((m) => m.version)).toEqual(MIGRATIONS.map((_, i) => i + 1))
    expect(MIGRATIONS.find((m) => m.version === 3)?.name).toMatch(/stage/)
  })
})

describe('StageStore repositories', () => {
  const catalog = () => createSeedCatalog()

  function chars(store: Store) {
    const clock = makeClock()
    const cat = catalog()
    const ss = new StageStore(store)
    const service = createCharacterService({ repo: ss.characterRepo(), catalog: cat, clock: { now: clock.fn }, newId: createSequentialIds() })
    return { ss, service, cat, clock }
  }

  it('saves, lists and restores characters with their presets in the preset table', () => {
    const store = memStore()
    const { ss, service } = chars(store)
    const a = service.create({ id: 'c.one', name: 'Ana', baseAssetId: seedBaseId('vrm1') })
    if (!a.ok) throw new Error(a.error)
    expect(a.value.presets.length).toBeGreaterThan(3)
    expect(ss.presetRows('c.one').length).toBe(a.value.presets.length)
    // the profile row carries NO presets: the table is their home
    const row = store.db.prepare('SELECT profile_json FROM stage_characters WHERE id = ?').get('c.one') as { profile_json: string }
    expect(JSON.parse(row.profile_json).presets).toBeUndefined()
    // a fresh service over the same database sees the same character
    const again = createCharacterService({ repo: ss.characterRepo(), catalog: catalog(), clock: { now: () => 0 }, newId: createSequentialIds() })
    expect(again.get('c.one')).toEqual(a.value)
  })

  it('keeps insertion order, replaces presets on save and cascades on delete', () => {
    const store = memStore()
    const { ss, service } = chars(store)
    for (const id of ['c.b', 'c.a', 'c.c']) service.create({ id, name: id, baseAssetId: seedBaseId('vrm1') })
    expect(service.list().map((c) => c.id)).toEqual(['c.b', 'c.a', 'c.c'])
    service.setPresets('c.a', service.get('c.a')!.presets.slice(0, 2))
    expect(ss.presetRows('c.a')).toHaveLength(2)
    expect(service.get('c.a')!.presets).toHaveLength(2)
    service.update('c.a', { name: 'Renamed' })
    expect(service.list().map((c) => c.id)).toEqual(['c.b', 'c.a', 'c.c']) // updating does not reorder
    expect(service.delete('c.a').ok).toBe(true)
    expect(ss.presetRows('c.a')).toHaveLength(0)
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM stage_outfit_presets WHERE character_id = 'c.a'").get()).toEqual({ n: 0 })
  })

  it('stores the active character per role and clears it when the character goes', () => {
    const store = memStore()
    const { ss, service } = chars(store)
    service.create({ id: 'c.a1', name: 'A1', baseAssetId: seedBaseId('vrm1') })
    service.create({ id: 'c.a2', name: 'A2', baseAssetId: seedBaseId('vrm1') })
    const repo = ss.characterRepo()
    expect(repo.getActiveId('assistant')).toBe('c.a1')
    service.select('c.a2')
    expect(repo.getActiveId('assistant')).toBe('c.a2')
    repo.setActiveId('assistant', undefined)
    expect(repo.getActiveId('assistant')).toBeUndefined()
    repo.setActiveId('user', 'c.a1')
    repo.delete('c.a1')
    expect(repo.getActiveId('user')).toBeUndefined() // ON DELETE CASCADE
  })

  it('a corrupt row reads as missing instead of throwing', () => {
    const store = memStore()
    const { ss, service } = chars(store)
    service.create({ id: 'c.ok', name: 'Fine', baseAssetId: seedBaseId('vrm1') })
    store.db.prepare("INSERT INTO stage_characters (id, ord, role, name, base_asset_id, profile_json, created_at, updated_at) VALUES ('c.bad', 99, 'assistant', 'Bad', 'x', '{not json', 't', 't')").run()
    store.db.prepare("INSERT INTO stage_scene (id, scene_json, updated_at) VALUES (1, '[]', 't')").run()
    const repo = ss.characterRepo()
    expect(repo.get('c.bad')).toBeUndefined()
    expect(repo.list().map((c) => c.id)).toEqual(['c.ok'])
    expect(ss.sceneRepo().getActive()).toBeUndefined()
  })

  it('persists the working scene and the scene presets', () => {
    const store = memStore()
    const ss = new StageStore(store)
    const scenes = createSceneService({ repo: ss.sceneRepo(), catalog: catalog(), clock: { now: () => 0 }, newId: createSequentialIds() })
    const scene = scenes.ensureVoid()
    expect(ss.sceneRepo().getActive()).toEqual(scene)
    expect(scenes.listPresets().map((p) => p.id).sort()).toEqual(['preset.void', 'preset.void-seating'])
    expect(scenes.applyPreset('preset.void-seating').ok).toBe(true)
    expect(ss.sceneRepo().getActive()!.objects.map((o) => o.id)).toEqual(['lounge_chair', 'data_plinth'])
    expect(ss.sceneRepo().deletePreset('preset.void')).toBe(true)
    expect(ss.sceneRepo().getPreset('preset.void')).toBeUndefined()
    // exactly one working scene row
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM stage_scene').get()).toEqual({ n: 1 })
  })

  it('persists memory items with sensitivity and recall counters, in order', () => {
    const store = memStore()
    const ss = new StageStore(store)
    const clock = makeClock()
    const memory = new CharacterMemory({ repo: ss.memoryRepo(), clock: { now: clock.fn }, newId: createSequentialIds() })
    const first = memory.remember({ kind: 'preference', text: 'Prefers short answers in the morning', importance: 4, tags: ['style'] })
    clock.advance(1000)
    const second = memory.remember({ kind: 'episode', text: 'We finished the Q4 positioning draft together', importance: 3, emotion: 'happy' })
    clock.advance(1000)
    memory.remember({ kind: 'relationship', text: 'Talked about the therapist appointment', importance: 2 })
    if (!first.ok || !second.ok) throw new Error('remember failed')
    expect(ss.memoryRepo().list().map((i) => i.kind)).toEqual(['preference', 'episode', 'relationship'])
    expect(ss.memoryRepo().list({ kind: 'episode' })).toHaveLength(1)
    // sensitive material is classified and stays out of the cloud audience
    expect(ss.memoryRepo().list().find((i) => i.kind === 'relationship')?.sensitivity).toBe('sensitive')
    expect(memory.digest({ audience: 'cloud' }).text).not.toMatch(/therapist/)
    const hit = memory.recall('positioning draft', 3, { touch: true })
    expect(hit[0]?.item.id).toBe(second.value.item.id)
    expect(ss.memoryRepo().get(second.value.item.id)?.recallCount).toBe(1)
    expect(ss.memoryRepo().get(second.value.item.id)?.emotion).toBe('happy')
    expect(ss.memoryRepo().update({ ...second.value.item, importance: 5 })).toBe(true)
    expect(ss.memoryRepo().update({ ...second.value.item, id: 'nope' })).toBe(false)
    expect(ss.memoryRepo().delete(second.value.item.id)).toBe(true)
    expect(ss.memoryRepo().count()).toBe(2)
  })

  it('keeps one mood row and ignores non-finite numbers', () => {
    const store = memStore()
    const ss = new StageStore(store)
    expect(ss.loadMood()).toBeUndefined()
    ss.saveMood({ valence: 0.3, arousal: -0.2, dominance: 0.6, at: 1000 })
    ss.saveMood({ valence: 0.1, arousal: 0, dominance: 0.5, at: 2000 })
    expect(ss.loadMood()).toEqual({ valence: 0.1, arousal: 0, dominance: 0.5, at: 2000 })
    ss.saveMood({ valence: Number.NaN, arousal: 0, dominance: 0, at: 3000 })
    expect(ss.loadMood()?.at).toBe(2000)
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM stage_mood').get()).toEqual({ n: 1 })
  })

  it('stores catalog metadata with the licence in columns, never a binary', () => {
    const store = memStore()
    const ss = new StageStore(store)
    const cat = catalog()
    const m = cat.get('outfit.crisp-shirt')!
    ss.upsertAsset(m, 'seed', 't0')
    expect(ss.hasAsset('outfit.crisp-shirt')).toBe(true)
    expect(ss.assetLicense('outfit.crisp-shirt')).toEqual({ licenseId: 'first-party-placeholder', personalUse: true, commercialUse: true, redistribution: true, adultExpression: false, source: 'seed' })
    expect(ss.assetLicense('nope')).toBeUndefined()
    const cols = (store.db.prepare('PRAGMA table_info(stage_assets)').all() as Array<{ name: string; type: string }>).map((c) => `${c.name}:${c.type}`)
    expect(cols.join(' ')).not.toMatch(/BLOB/i)
    expect(ss.deleteAsset('outfit.crisp-shirt')).toBe(true)
  })
})

describe('the first-run seed', () => {
  it('creates the seed catalog, the assistant (AUTHORITY presence), the abstract user and the void, once', () => {
    const store = memStore()
    const { hub } = makeHub(store)
    const snap = hub.snapshot()
    expect(snap.enabled).toBe(true)
    expect(snap.assets.length).toBe(seedManifests().length)
    expect(store.kvGet(STAGE_KV.seeded)).toBe(1)

    const assistant = snap.characters.find((c) => c.id === ASSISTANT_CHARACTER_ID)!
    expect(assistant.role).toBe('assistant')
    expect(assistant.presence).toEqual(AUTHORITY_PRESENCE)
    expect(snap.assistantCharacterId).toBe(ASSISTANT_CHARACTER_ID)
    expect(assistant.name).toBe(buildSnapshot(new Date()).settings.persona.name)

    const user = snap.characters.find((c) => c.id === USER_CHARACTER_ID)!
    expect(user.role).toBe('user')
    expect(user.baseAssetId).toBe(ABSTRACT_BASE_ID)
    expect(snap.userCharacterId).toBe(USER_CHARACTER_ID)
    const base = snap.assets.find((a) => a.id === ABSTRACT_BASE_ID)!
    expect(base.tags).toEqual(expect.arrayContaining(['abstract', 'no-face-capture', 'adult']))

    expect(snap.scene?.name).toBe('Cerebral void')
    expect(snap.scene?.objects).toEqual([])
    expect(snap.scenePresets.map((p) => p.id).sort()).toEqual(['preset.void', 'preset.void-seating'])
    // fully clothed from the first moment
    for (const c of snap.characters) expect(!!c.equipped.fullBody || (!!c.equipped.top && !!c.equipped.bottom)).toBe(true)
  })

  it('never seeds twice: a restart keeps what the user changed', () => {
    const tmp = makeTmp('stage-seed-')
    cleanups.push(tmp.cleanup)
    const file = join(tmp.dir, 'app.db')
    const s1 = openStore({ file })
    const a = makeHub(s1, tmp.dir)
    // the user renames her, deletes a preset, and deletes a catalog entry
    expect(a.hub.characters.update(ASSISTANT_CHARACTER_ID, { name: 'Renamed' }).ok).toBe(true)
    expect(a.hub.wardrobe.deletePreset(ASSISTANT_CHARACTER_ID, 'preset.restful').ok).toBe(true)
    a.hub.stageStore.deleteAsset('prop.lounge-chair')
    s1.close()

    const s2 = openStore({ file })
    cleanups.push(() => s2.close())
    const b = makeHub(s2, tmp.dir)
    const snap = b.hub.snapshot()
    expect(snap.characters.find((c) => c.id === ASSISTANT_CHARACTER_ID)?.name).toBe('Renamed')
    expect(snap.characters.find((c) => c.id === ASSISTANT_CHARACTER_ID)?.presets.map((p) => p.id)).not.toContain('preset.restful')
    expect(snap.assets.some((a2) => a2.id === 'prop.lounge-chair')).toBe(false)
    expect(snap.characters).toHaveLength(2)
  })

  it('every seed entry is metadata with a coherent licence and adult bases', () => {
    const m = seedManifests() as Array<{ id: string; kind: string; adult?: boolean; license: { id: string; personalUse: boolean }; locator: string; tags?: string[] }>
    expect(m.length).toBeGreaterThanOrEqual(30)
    for (const a of m) {
      expect(a.license.personalUse, a.id).toBe(true)
      expect(a.locator, a.id).not.toMatch(/^[a-z]+:\/\/[^/]*@|\.\./) // no credentials, no traversal
      if (a.kind === 'character_base') expect(a.adult, a.id).toBe(true)
      expect(a.tags?.join(' ') ?? '', a.id).not.toMatch(/nude|lingerie|sexy|nsfw|revealing|underwear|bikini/i)
    }
  })

  it('the demo-style fresh database also seeds, with the persona name', () => {
    const store = memStore()
    const clock = makeClock()
    const hub = new StageHub({
      config: testConfig('/tmp/x'),
      store,
      bus: new EventBus(),
      log: silentLogger,
      now: () => new Date(clock.now()),
      clock: clock.fn,
      newId: createIdGen(clock.fn),
      persona: () => ({ ...buildSnapshot(new Date(clock.now())).settings.persona, name: 'Vesper' }),
    })
    expect(hub.assistant()?.name).toBe('Vesper')
  })
})

describe('restore on start', () => {
  it('takes off an equipped item whose licence no longer allows it and keeps her fully dressed', () => {
    const tmp = makeTmp('stage-restore-')
    cleanups.push(tmp.cleanup)
    const file = join(tmp.dir, 'app.db')
    const s1 = openStore({ file })
    const a = makeHub(s1, tmp.dir)
    expect(a.hub.wardrobe.equip(ASSISTANT_CHARACTER_ID, 'outfit.tailored-blazer').ok).toBe(true)
    // the licence of the blazer is withdrawn in the stored catalog (a changed record)
    const manifest = a.hub.catalog.get('outfit.tailored-blazer')!
    a.hub.stageStore.upsertAsset({ ...manifest, license: { ...manifest.license, id: 'vendor-eula', personalUse: false, commercialUse: false, redistribution: false } }, 'seed', 't')
    s1.close()

    const s2 = openStore({ file })
    cleanups.push(() => s2.close())
    const b = makeHub(s2, tmp.dir)
    const eq = b.hub.assistant()!.equipped
    expect(eq.outerwear).toBeNull()
    expect(!!eq.fullBody || (!!eq.top && !!eq.bottom)).toBe(true)
  })
})
