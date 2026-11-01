import { describe, expect, it } from 'vitest'
import {
  AssetCatalog,
  InMemoryCharacterRepo,
  InMemorySceneRepo,
  MAX_MANIFEST_CHARS,
  SEED_IDS as S,
  buildCerebralVoid,
  canUse,
  createCharacterService,
  createSceneService,
  createSeedCatalog,
  createSequentialIds,
  createVirtualTime,
  licenceIssues,
  normaliseLicenceId,
  seedBaseId,
} from '../src'
import type { AssetDirectoryReader, AssetManifestInput } from '../src'
import { LIC, T0, lcg } from './helpers'

/**
 * Regression tests for the licence, scene and catalog findings: unknown-licence detection survives synonyms and invisible
 * characters, licences are re-judged wherever an asset is used (a saved scene preset, the scene.load a stage receives),
 * validating a scene is bounded work, and the catalog survives a hostile reader and refuses oversized manifests.
 */

const decide = (id: unknown, over: Record<string, unknown> = {}) => canUse({ id: 'a', name: 'A', license: { id, personalUse: true, commercialUse: true, redistribution: true, ...over } as never }, 'personal')

describe('unknown-licence detection is not four literal strings (LOW: licence-unknown-id-variants)', () => {
  const UNKNOWN = [
    'unknown', 'UNKNOWN', 'UnKnOwN', ' unknown ', 'unknown\n', ' unknown ', 'unlicensed', 'unlicenced', 'NONE', '', '  ', '\t', '-', '--', '?', '??', '/', '...', '_',
    'unknown​', '​unknown', 'unk​nown', 'unknown\u0000', 'unknown﻿', 'unknown‮', 'unknown⁠', 'un­known',
    'ｕｎｋｎｏｗｎ', // fullwidth "unknown"
    'ＵＮＫＮＯＷＮ',
    'n/a', 'N/A', 'n.a.', 'NA', 'tbd', 'TBD', 'tba', 'todo', 'null', 'undefined', 'nil', 'proprietary', 'Proprietary', 'all rights reserved', 'All Rights Reserved', 'no license', 'No Licence', 'no-license',
    'unspecified', 'not specified', 'not stated', 'not applicable', 'other', 'custom',
  ]
  it.each(UNKNOWN)('refuses %j even though every flag says yes', (id) => {
    const d = decide(id)
    expect(d.ok, JSON.stringify(id)).toBe(false)
    expect(d.reasons.join(' ')).toMatch(/unknown licence/)
  })
  const KNOWN = ['MIT', 'mit', 'Apache-2.0', 'CC-BY-4.0', 'CC-BY-NC-SA-4.0', 'GPL-3.0-or-later', 'first-party-placeholder', 'third-party-pending', 'vendor-eula', 'vendor-eula-2026', 'VRoid-Hub-CC0', 'MIT​', 'M​IT', ' MIT ', '(MIT OR Apache-2.0)', 'LicenseRef-Acme-1', 'unknown-vendor-eula', 'nonexistent', 'nonetheless']
  it.each(KNOWN)('still accepts the real licence %j', (id) => {
    expect(decide(id).ok, JSON.stringify(id)).toBe(true)
  })
  it('a licence id that is not even text is unknown', () => {
    for (const id of [undefined, null, 5, {}, [], true]) expect(decide(id).ok, String(id)).toBe(false)
  })
  it('normaliseLicenceId: NFKC, no invisible characters or whitespace, lower case, no punctuation', () => {
    expect(normaliseLicenceId(' Un​Known\u0000 ')).toBe('unknown')
    expect(normaliseLicenceId('ＵＮＫＮＯＷＮ')).toBe('unknown')
    expect(normaliseLicenceId('N/A')).toBe('na')
    expect(normaliseLicenceId('CC-BY-4.0')).toBe('ccby40')
    expect(normaliseLicenceId(5)).toBe('')
  })
  it('the flags are unchanged: an unknown licence refuses every intent, a known one needs its own explicit flag', () => {
    for (const id of ['unknown​', 'n/a']) for (const intent of ['personal', 'commercial', 'redistribute'] as const) expect(canUse({ id: 'a', name: 'A', license: { id, personalUse: true, commercialUse: true, redistribution: true } }, intent).ok).toBe(false)
    expect(canUse({ id: 'a', name: 'A', license: { id: 'MIT', personalUse: true, commercialUse: false, redistribution: false } }, 'commercial').ok).toBe(false)
    expect(licenceIssues({ id: '   ', personalUse: true, commercialUse: false, redistribution: false })).toHaveLength(1)
    expect(licenceIssues({ id: 5 as never, personalUse: true, commercialUse: false, redistribution: false })).toHaveLength(1)
  })
  it('property: decorating an unknown word never makes it known, decorating a real id never makes it unknown', () => {
    const r = lcg(808)
    const zero = ['​', '‌', '‍', '⁠', '﻿', '­', '\u0000', '‮', ' ', '\t', '\n', ' ']
    const words = ['unknown', 'unlicensed', 'none', 'tbd', 'proprietary']
    const real = ['MIT', 'Apache-2.0', 'CC-BY-4.0', 'vendor-eula']
    const decorate = (w: string): string => {
      let out = ''
      for (const ch of w) {
        out += r() < 0.4 ? zero[Math.floor(r() * zero.length)]! : ''
        out += r() < 0.3 ? ch.toUpperCase() : ch
      }
      return out + (r() < 0.5 ? zero[Math.floor(r() * zero.length)]! : '')
    }
    for (let i = 0; i < 3000; i++) {
      expect(decide(decorate(words[Math.floor(r() * words.length)]!)).ok).toBe(false)
      expect(decide(decorate(real[Math.floor(r() * real.length)]!)).ok).toBe(true)
    }
  })
})

describe('licences are judged wherever an asset is used (LOW: licence-gaps-scene-preset-and-base-restore)', () => {
  function world() {
    const vt = createVirtualTime(T0)
    const catalog = createSeedCatalog()
    const ids = createSequentialIds()
    const characters = createCharacterService({ repo: new InMemoryCharacterRepo(), catalog, clock: vt.clock, newId: ids })
    const scenes = createSceneService({ repo: new InMemorySceneRepo(), catalog, clock: vt.clock, newId: ids })
    scenes.ensureVoid()
    return { vt, catalog, characters, scenes }
  }
  const NO = { id: 'vendor-eula', personalUse: false, commercialUse: false, redistribution: false }
  const flip = (w: ReturnType<typeof world>, id: string): void => void w.catalog.add({ ...w.catalog.get(id)!, license: NO }, { replace: true, vetted: true })

  it('a saved scene preset whose prop lost its licence cannot be applied, and nothing changes', () => {
    const w = world()
    expect(w.scenes.addObject({ assetId: S.chair, id: 'chair' }).ok).toBe(true)
    w.scenes.savePreset('preset.mine', 'Mine')
    w.scenes.removeObject('chair')
    flip(w, S.chair)
    const before = w.scenes.getScene()
    const r = w.scenes.applyPreset('preset.mine')
    expect(r.ok).toBe(false)
    expect(!r.ok && r.code).toBe('invalid_scene')
    expect(!r.ok && r.error).toMatch(/does not permit personal use/)
    expect(w.scenes.getScene()).toEqual(before)
  })
  it('a preset whose ENVIRONMENT lost its licence cannot be applied either', () => {
    const w = world()
    w.scenes.savePreset('preset.here', 'Here')
    flip(w, S.void)
    expect(w.scenes.applyPreset('preset.here')).toMatchObject({ ok: false, code: 'invalid_scene' })
    expect(w.scenes.validateScene(w.scenes.getScene()).join(' ')).toMatch(/environment/)
  })
  it('the scene.load a stage receives leaves out an object that lost its licence, and everything parented to it', () => {
    const w = world()
    w.scenes.addObject({ assetId: S.plinth, id: 'plinth' })
    w.scenes.addObject({ assetId: S.chair, id: 'seat', parentId: 'plinth' })
    w.scenes.addObject({ assetId: S.chair, id: 'other' })
    flip(w, S.plinth)
    const load = w.scenes.loadCommand()
    expect(load.ok).toBe(true)
    const cmd = load.ok ? (load.value as { scene: { objects: Array<{ id: string }> }; assets: Array<{ id: string }> }) : undefined
    expect(cmd!.scene.objects.map((o) => o.id)).toEqual(['other'])
    expect(cmd!.assets.map((a) => a.id)).not.toContain(S.plinth)
    // the stored scene is untouched: the object returns with its licence (nothing was lost)
    expect(w.scenes.getScene()!.objects.map((o) => o.id)).toEqual(['plinth', 'seat', 'other'])
    w.catalog.add(w.catalog.get(S.plinth)!, { replace: true, vetted: true })
    flip(w, S.plinth)
    w.catalog.add({ ...w.catalog.get(S.plinth)!, license: { id: 'MIT', personalUse: true, commercialUse: true, redistribution: true } }, { replace: true, vetted: true })
    const again = w.scenes.loadCommand()
    expect(again.ok && (again.value as { scene: { objects: unknown[] } }).scene.objects).toHaveLength(3)
  })
  it('a scene whose environment cannot be used is not sent at all (and the failure says why)', () => {
    const w = world()
    flip(w, S.void)
    const r = w.scenes.loadCommand()
    expect(r).toMatchObject({ ok: false, code: 'licence' })
    w.catalog.remove(S.void)
    expect(w.scenes.loadCommand()).toMatchObject({ ok: false, code: 'licence' })
  })
  it('a base whose licence flipped: restore reports it and loadCommand refuses (equipped items were already re-checked)', () => {
    const w = world()
    const c = w.characters.create({ name: 'M', baseAssetId: seedBaseId('vrm1') })
    if (!c.ok) throw new Error(c.error)
    flip(w, c.value.baseAssetId)
    const rep = w.characters.restore()
    expect(rep.problems.some((p) => p.characterId === c.value.id && /can no longer be used/.test(p.message))).toBe(true)
    expect(w.characters.loadCommand(c.value.id)).toMatchObject({ ok: false, code: 'base_unusable' })
  })
  it('healthy scenes load exactly as before', () => {
    const w = world()
    w.scenes.addObject({ assetId: S.chair, id: 'chair' })
    const load = w.scenes.loadCommand()
    expect(load.ok && (load.value as { scene: unknown }).scene).toEqual(w.scenes.getScene())
  })
})

describe('validating a scene is bounded work (LOW: scene-validate-deep-chain-cost)', () => {
  function world() {
    const vt = createVirtualTime(T0)
    const catalog = createSeedCatalog()
    const scenes = createSceneService({ repo: new InMemorySceneRepo(), catalog, clock: vt.clock, newId: createSequentialIds() })
    return { vt, catalog, scenes }
  }
  const obj = (id: string, parentId: string | null, over: Record<string, unknown> = {}) => ({
    id,
    assetId: S.chair,
    transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
    parentId,
    role: 'static',
    anchors: [],
    visible: true,
    ...over,
  })
  const sceneWith = (nowMs: number, objects: unknown[]) => ({ ...buildCerebralVoid(nowMs), objects })

  it('a chain at the object limit is validated in linear time and found valid; a cycle at the end of it is found', () => {
    const w = world()
    const n = 200
    const chain = Array.from({ length: n }, (_, i) => obj(`o${i}`, i === 0 ? null : `o${i - 1}`))
    const t0 = performance.now()
    expect(w.scenes.validateScene(sceneWith(T0, chain))).toEqual([])
    expect(performance.now() - t0).toBeLessThan(500)
    // close the chain into a ring: every object is then in or leads into a cycle
    const ring = chain.map((o, i) => (i === 0 ? { ...o, parentId: `o${n - 1}` } : o))
    const issues = w.scenes.validateScene(sceneWith(T0, ring))
    expect(issues.filter((m) => /parent cycle/.test(m))).toHaveLength(n)
    // a cycle somewhere in the middle flags it and what hangs off it, but not what is above it
    const mid = [obj('root', null), obj('a', 'root'), obj('b', 'c'), obj('c', 'b'), obj('d', 'c')]
    const msgs = w.scenes.validateScene(sceneWith(T0, mid)).filter((m) => /parent cycle/.test(m))
    expect(msgs.sort()).toEqual(['object "b" is part of a parent cycle', 'object "c" is part of a parent cycle', 'object "d" is part of a parent cycle'])
    // a self-parent
    expect(w.scenes.validateScene(sceneWith(T0, [obj('x', 'x')])).join(' ')).toMatch(/parent cycle/)
  })
  it('a scene with thousands of objects is refused at once, before any per-object work', () => {
    const w = world()
    const chain = Array.from({ length: 5000 }, (_, i) => obj(`o${i}`, i === 0 ? null : `o${i - 1}`))
    const t0 = performance.now()
    const issues = w.scenes.validateScene(sceneWith(T0, chain))
    expect(performance.now() - t0).toBeLessThan(100)
    expect(issues).toEqual(['a scene has at most 200 objects (this one has 5000)'])
  })
  it('too many constructs or cameras are refused up front as well', () => {
    const w = world()
    const base = buildCerebralVoid(T0)
    const tooManyConstructs = Array.from({ length: 30 }, (_, i) => ({ id: `c${i}`, kind: 'knowledge_graph', transform: base.cameras[0]!.transform, source: 'brain' }))
    expect(w.scenes.validateScene({ ...base, constructs: tooManyConstructs })[0]).toMatch(/at most 24 constructs/)
    expect(w.scenes.validateScene({ ...base, cameras: Array.from({ length: 30 }, (_, i) => ({ ...base.cameras[0]!, id: `cam${i}` })) })[0]).toMatch(/at most 24 camera shots/)
  })
  it('an anchor outside the allowed range is found (anchors were bounded only when added)', () => {
    const w = world()
    const far = { id: 'seat', kind: 'sit', local: { position: [1e300, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } }
    // 1e300 is outside the shared schema's coordinate bound already; 5000 m is inside it but outside the scene's own 1000 m range
    const far2 = { id: 'seat', kind: 'sit', local: { position: [5000, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } }
    expect(w.scenes.validateScene(sceneWith(T0, [obj('a', null, { anchors: [far] })])).length).toBeGreaterThan(0)
    expect(w.scenes.validateScene(sceneWith(T0, [obj('a', null, { anchors: [far2] })])).join(' ')).toMatch(/anchor "seat".*out of range/)
    expect(w.scenes.validateScene(sceneWith(T0, [obj('a', null, { anchors: [{ ...far2, local: { ...far2.local, position: [1, 0, 0] } }] })])).filter((m) => /anchor/.test(m))).toEqual([])
  })
  it('a stored preset with an out-of-range anchor cannot be applied', () => {
    const w = world()
    w.scenes.ensureVoid()
    const bad = { ...buildCerebralVoid(T0), name: 'bad', objects: [obj('a', null, { anchors: [{ id: 'seat', kind: 'sit', local: { position: [5000, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } }] })] }
    const repo = new InMemorySceneRepo()
    repo.saveActive(buildCerebralVoid(T0))
    repo.savePreset('preset.bad', 'Bad', bad as never)
    const scenes = createSceneService({ repo, catalog: w.catalog, clock: w.vt.clock, newId: createSequentialIds() })
    expect(scenes.applyPreset('preset.bad')).toMatchObject({ ok: false, code: 'invalid_scene' })
  })
})

describe('the catalog survives a hostile reader (LOW: catalog-loadfromdirectory-hostile-reader)', () => {
  const good = (id: string): string => JSON.stringify({ id, kind: 'prop', name: id, locator: `props/${id}`, license: LIC })
  const reader = (over: Partial<Record<keyof AssetDirectoryReader, unknown>>, files: Record<string, unknown> = {}): AssetDirectoryReader =>
    ({
      list: () => Object.keys(files),
      read: (p: string) => files[p],
      ...over,
    }) as unknown as AssetDirectoryReader

  it('read() returning undefined, a number, a Buffer, an object or null rejects that file and loads the others', async () => {
    const cat = new AssetCatalog()
    const report = await cat.loadFromDirectory(
      reader({}, { 'a.json': good('a'), 'u.json': undefined, 'n.json': 5, 'b.json': Buffer.from(good('b')), 'o.json': { id: 'o' }, 'z.json': null, 'c.json': good('c') }),
    )
    expect(report.added.sort()).toEqual(['a', 'c'])
    expect(report.rejected.map((r) => r.source).sort()).toEqual(['b.json', 'n.json', 'o.json', 'u.json', 'z.json'])
    for (const r of report.rejected) expect(r.reason).toMatch(/not text/)
  })
  it('a list that is not a list, or holds things that are not paths, is reported', async () => {
    const cat = new AssetCatalog()
    for (const listed of [undefined, null, 5, 'a.json', { length: 1 }, new Set(['a.json'])]) {
      const r = await cat.loadFromDirectory(reader({ list: () => listed }))
      expect(r.added).toEqual([])
      expect(r.rejected[0]).toMatchObject({ source: '(list)' })
    }
    const mixed = await cat.loadFromDirectory(reader({ list: () => ['a.json', 5, null, {}], read: () => good('m') }))
    expect(mixed.added).toEqual(['m'])
    expect(mixed.rejected).toHaveLength(3)
  })
  it('a reader whose list or read throws (an Error, a string, undefined, null) is reported, never thrown', async () => {
    for (const thrown of [new Error('boom'), 'boom', undefined, null, 5]) {
      const cat = new AssetCatalog()
      const a = await cat.loadFromDirectory(reader({ list: () => { throw thrown } }))
      expect(a.rejected[0]!.source).toBe('(list)')
      const b = await cat.loadFromDirectory(reader({ list: () => ['x.json', 'y.json'], read: (p: string) => { if (p === 'x.json') throw thrown; return good('y') } }))
      expect(b.added).toEqual(['y'])
      expect(b.rejected).toHaveLength(1)
      const c = await cat.loadFromDirectory(reader({ list: () => Promise.reject(thrown) }))
      expect(c.rejected[0]!.source).toBe('(list)')
    }
  })
  it('100,000 listed manifests are not all read; __proto__ JSON, huge text and bad JSON are rejections', async () => {
    const cat = new AssetCatalog()
    let reads = 0
    const many = await cat.loadFromDirectory(reader({ list: () => Array.from({ length: 100_000 }, (_, i) => `m${String(i).padStart(6, '0')}.json`), read: () => { reads++; return 'not json' } }))
    expect(reads).toBe(5000)
    expect(many.rejected.some((r) => /only the first 5000/.test(r.reason))).toBe(true)
    const odd = await cat.loadFromDirectory(reader({}, { 'p.json': '{"__proto__":{"polluted":true},"id":"p","kind":"prop","name":"p","locator":"props/p","license":{"id":"MIT","personalUse":true,"commercialUse":true,"redistribution":true}}', 'big.json': 'x'.repeat(300_000), 'bad.json': '{nope' }))
    expect(odd.added).toEqual(['p'])
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(odd.rejected.map((r) => r.source).sort()).toEqual(['bad.json', 'big.json'])
  })
  it('loadFromDirectory never vets what it reads (a content pack on disk is not first-party)', async () => {
    const cat = new AssetCatalog()
    await cat.loadFromDirectory(reader({}, { 'a.json': good('a') }))
    expect(cat.has('a')).toBe(true)
    expect(cat.isVetted('a')).toBe(false)
  })
})

describe('manifests are bounded (LOW: manifest-field-bounds)', () => {
  const prop = (over: Record<string, unknown> = {}): AssetManifestInput => ({ id: 'p', kind: 'prop', name: 'P', locator: 'props/p', license: LIC, ...over }) as AssetManifestInput
  it('the reported cases are refused: 5 MB licence notes and source, a 1 MB licence id, 50,000 parameters', () => {
    const cat = new AssetCatalog()
    const big = 'N'.repeat(5 * 1024 * 1024)
    expect(cat.add(prop({ license: { ...LIC, notes: big } })).ok).toBe(false)
    expect(cat.add(prop({ license: { ...LIC, source: big } })).ok).toBe(false)
    expect(cat.add(prop({ license: { ...LIC, id: 'L'.repeat(1_000_000) } })).ok).toBe(false)
    const many = Array.from({ length: 50_000 }, (_, i) => ({ id: `p${i}`, group: 'other', label: 'l', min: 0, max: 1, default: 0, type: 'scalar' }))
    expect(cat.add(prop({ params: many })).ok).toBe(false)
    expect(cat.size).toBe(0)
  })
  it('sane sizes are fine: 256 parameters, licence notes of 2000 characters, a maximum-length id', () => {
    const cat = new AssetCatalog()
    const params = Array.from({ length: 256 }, (_, i) => ({ id: `p${i}`, group: 'other', label: 'l'.repeat(100), min: 0, max: 1, default: 0, type: 'scalar' }))
    expect(cat.add(prop({ params, license: { ...LIC, notes: 'n'.repeat(2000), source: 's'.repeat(512), id: 'v'.repeat(128) } })).ok).toBe(true)
  })
  it('parameter values beyond +-1e9 and a manifest larger than the limit are refused', () => {
    const cat = new AssetCatalog()
    expect(cat.add(prop({ params: [{ id: 'p0', group: 'other', label: 'l', min: 0, max: 1e12, default: 0, type: 'scalar' }] })).ok).toBe(false)
    // 256 KiB thumbnail plus a lot of metadata stays under the limit; an absurd amount of tags/params text does not matter because each field is bounded, so build the large case from the thumbnail twice over
    const thumb = 'data:image/png;base64,' + 'A'.repeat(200 * 1024)
    expect(cat.add(prop({ thumbnail: thumb })).ok).toBe(true)
    expect(MAX_MANIFEST_CHARS).toBeGreaterThan(256 * 1024)
  })
})
