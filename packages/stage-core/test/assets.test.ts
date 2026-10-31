import { describe, expect, it } from 'vitest'
import {
  AssetCatalog,
  AssetManifest,
  SEED_ASSETS,
  SEED_IDS,
  canUse,
  createAssetCatalog,
  createSeedCatalog,
  seedBaseId,
  validateLocator,
  validateThumbnail,
  worstCaseNeoteny,
  NEOTENY_MAX,
  ADULT_BOUNDS,
} from '../src'
import type { AssetManifestInput } from '../src'

const lic = { id: 'MIT', personalUse: true, commercialUse: true, redistribution: true }
const prop = (over: Record<string, unknown> = {}): AssetManifestInput =>
  ({ id: 'prop.test', kind: 'prop', name: 'Test prop', locator: 'props/test', license: lic, ...over }) as AssetManifestInput

describe('locator safety', () => {
  const root = 'C:\\Users\\me\\mira\\content'
  it.each([
    ['props/chair', true],
    ['props\\chair.glb', true],
    ['./props/chair', true],
    ['asset://chairs/a', true],
    ['https://cdn.example.com/a.vrm', true],
    ['pack:props/a', true],
  ])('accepts %s', (loc, expected) => {
    expect(validateLocator(loc, { contentRoot: root }).ok).toBe(expected)
  })

  it.each([
    ['../secret', 'traversal'],
    ['props/../../secret', 'traversal'],
    ['props\\..\\..\\secret', 'traversal'],
    ['%2e%2e/secret', 'traversal'],
    ['%252e%252e/secret', 'traversal'],
    ['props/%2E%2E%5Csecret', 'traversal'],
    ['/etc/passwd', 'absolute'],
    ['\\Windows\\System32', 'absolute'],
    ['C:\\Windows\\System32\\x', 'outside'],
    ['c:/users/other/x', 'outside'],
    ['\\\\server\\share\\x', 'UNC'],
    ['//server/share', 'UNC'],
    ['file:///C:/x', 'scheme'],
    ['javascript:alert(1)', 'scheme'],
    ['data:text/html;base64,AAAA', 'scheme'],
    ['http://example.com/a', 'scheme'],
    ['https://user:pw@example.com/a', 'credentials'],
    ['https:///a', 'authority'],
    ['', 'empty'],
    [' props/a', 'whitespace'],
    ['props/a\u0000.glb', 'control'],
    ['props/NUL', 'reserved'],
    ['props/com1.txt', 'reserved'],
    ['props/a.', 'dot'],
    ['props/a?b', 'Windows'],
    ['props/a:stream', ':'],
    ['https://cdn.example.com/%2e%2e/x', 'traversal'],
    ['%zz', 'traversal'],
  ])('refuses %j (%s)', (loc, _why) => {
    expect(validateLocator(loc, { contentRoot: root }).ok).toBe(false)
  })

  it('accepts absolute paths only inside the content root, with Windows separators and case folding', () => {
    expect(validateLocator('C:\\Users\\me\\mira\\content\\props\\a.glb', { contentRoot: root }).ok).toBe(true)
    expect(validateLocator('c:/users/me/mira/content/props/a.glb', { contentRoot: root }).ok).toBe(true)
    expect(validateLocator('C:\\Users\\me\\mira\\content-evil\\a.glb', { contentRoot: root }).ok).toBe(false)
    expect(validateLocator('C:\\Users\\me\\mira\\content', { contentRoot: root }).ok).toBe(false)
    expect(validateLocator('C:\\Users\\me\\mira\\content\\..\\secret', { contentRoot: root }).ok).toBe(false)
    expect(validateLocator('C:\\Users\\me\\a.glb').ok).toBe(false) // no content root
  })

  it('honours a custom scheme allowlist and rejects non-strings', () => {
    expect(validateLocator('https://a.example/x', { allowedSchemes: ['asset'] }).ok).toBe(false)
    expect(validateLocator('ASSET://x', { allowedSchemes: ['asset'] }).ok).toBe(true)
    expect(validateLocator(5 as unknown as string).ok).toBe(false)
    expect(validateLocator('x'.repeat(2000)).ok).toBe(false)
  })

  it('normalises separators in relative locators', () => {
    const r = validateLocator('props\\\\a//b/./c.glb')
    expect(r).toEqual({ ok: true, kind: 'relative', normalized: 'props/a/b/c.glb' })
  })

  it('thumbnails: raster data URIs only', () => {
    expect(validateThumbnail('data:image/png;base64,AAAA').ok).toBe(true)
    expect(validateThumbnail('data:image/svg+xml;base64,AAAA').ok).toBe(false)
    expect(validateThumbnail('data:image/png;base64,AAAA<script>').ok).toBe(false)
    expect(validateThumbnail('thumbs/a.png').ok).toBe(true)
    expect(validateThumbnail('../a.png').ok).toBe(false)
    expect(validateThumbnail('data:image/png;base64,' + 'A'.repeat(300_000)).ok).toBe(false)
  })
})

describe('licence enforcement', () => {
  const base = { id: 'a', name: 'A' }
  it('requires the flag for each intent', () => {
    const l = { id: 'EULA', personalUse: true, commercialUse: false, redistribution: false }
    expect(canUse({ ...base, license: l }, 'personal').ok).toBe(true)
    const c = canUse({ ...base, license: l }, 'commercial')
    expect(c.ok).toBe(false)
    expect(c.reasons[0]).toMatch(/commercial use/)
    expect(canUse({ ...base, license: l }, 'redistribute').ok).toBe(false)
  })
  it('refuses unknown licences for every intent', () => {
    for (const id of ['unknown', 'UNKNOWN', '', '  ', 'unlicensed', 'none']) {
      for (const intent of ['personal', 'commercial', 'redistribute'] as const) {
        const d = canUse({ ...base, license: { id, personalUse: true, commercialUse: true, redistribution: true } }, intent)
        expect(d.ok).toBe(false)
        expect(d.reasons.join(' ')).toMatch(/unknown licence/)
      }
    }
  })
  it('respects the adultExpression flag only when the use needs it', () => {
    const forbid = { ...base, license: { ...lic, adultExpression: false } }
    const unknown = { ...base, license: { ...lic } }
    const allow = { ...base, license: { ...lic, adultExpression: true } }
    expect(canUse(forbid, 'personal').ok).toBe(true)
    expect(canUse(forbid, 'personal', { adultExpression: true }).reasons[0]).toMatch(/forbids/)
    expect(canUse(unknown, 'personal', { adultExpression: true }).reasons[0]).toMatch(/does not state/)
    expect(canUse(allow, 'personal', { adultExpression: true }).ok).toBe(true)
  })
  it('surfaces licence notes as warnings', () => {
    const d = canUse({ ...base, license: { ...lic, notes: 'revenue thresholds apply' } }, 'commercial')
    expect(d.ok).toBe(true)
    expect(d.warnings).toEqual(['revenue thresholds apply'])
  })
  it('collects every reason', () => {
    const d = canUse({ ...base, license: { id: 'x', personalUse: false, commercialUse: false, redistribution: false, adultExpression: false } }, 'personal', { adultExpression: true })
    expect(d.reasons).toHaveLength(2)
  })
})

describe('manifest schema', () => {
  const parse = (over: Record<string, unknown>) => AssetManifest.safeParse(prop(over))
  it('accepts a minimal prop and applies defaults', () => {
    const r = parse({})
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.schema).toBe('mira-asset/1')
      expect(r.data.version).toBe('1.0.0')
      expect(r.data.tags).toEqual([])
    }
  })
  it.each([
    ['unsafe id', { id: '../x' }],
    ['proto id', { id: '__proto__' }],
    ['empty name', { name: '  ' }],
    ['bad tag', { tags: ['Has Space'] }],
    ['wearable without slot', { kind: 'outfit', slots: [] }],
    ['prop with a slot', { slots: ['top'] }],
    ['prop hides', { hides: ['torso'] }],
    ['hair in wrong slot', { kind: 'hair', slots: ['top'] }],
    ['fullBody plus top', { kind: 'outfit', slots: ['fullBody', 'top'] }],
    ['duplicate slots', { kind: 'outfit', slots: ['top', 'top'] }],
    ['variant of itself', { variantOf: 'prop.test' }],
    ['param min>max', { params: [{ id: 'a.b', group: 'other', label: 'x', min: 1, max: 0, default: 0 }] }],
    ['param default outside', { params: [{ id: 'a.b', group: 'other', label: 'x', min: 0, max: 1, default: 2 }] }],
    ['param bad id', { params: [{ id: 'Bad Id', group: 'other', label: 'x', min: 0, max: 1, default: 0 }] }],
    ['param proto id', { params: [{ id: 'constructor', group: 'other', label: 'x', min: 0, max: 1, default: 0 }] }],
    ['duplicate param', { params: [{ id: 'a.b', group: 'other', label: 'x', min: 0, max: 1, default: 0 }, { id: 'a.b', group: 'other', label: 'x', min: 0, max: 1, default: 0 }] }],
    ['colour param with scalar range', { params: [{ id: 'a.c', group: 'other', label: 'x', min: 0, max: 5, default: 1, type: 'color' }] }],
    ['commercial without personal', { license: { id: 'x', personalUse: false, commercialUse: true, redistribution: false } }],
    ['empty licence id', { license: { id: '', personalUse: true, commercialUse: false, redistribution: false } }],
    ['base without adult attestation', { kind: 'character_base', rigFamilies: ['vrm1'] }],
    ['base without rig', { kind: 'character_base', adult: true }],
  ])('refuses %s', (_name, over) => {
    expect(parse(over).success).toBe(false)
  })
  it('refuses non-finite parameter numbers', () => {
    expect(parse({ params: [{ id: 'a.b', group: 'other', label: 'x', min: 0, max: Infinity, default: 0 }] }).success).toBe(false)
  })
})

describe('adult envelope on base declarations', () => {
  const baseWith = (params: unknown[]) =>
    ({ id: 'base.x', kind: 'character_base', name: 'X', locator: 'bases/x', rigFamilies: ['vrm1'], adult: true, license: lic, params }) as AssetManifestInput
  const p = (id: string, min: number, max: number, def: number) => ({ id, group: 'face', label: id, min, max, default: def })
  it('refuses a base whose age slider reaches below the adult floor', () => {
    expect(AssetManifest.safeParse(baseWith([p('face.apparent_age', 14, 40, 30)])).success).toBe(false)
    expect(AssetManifest.safeParse(baseWith([p('face.apparent_age', 25, 40, 30)])).success).toBe(true)
  })
  it('refuses oversized head scale, tiny height, and a default outside the envelope', () => {
    expect(AssetManifest.safeParse(baseWith([p('body.head_scale', 0.9, 1.3, 1)])).success).toBe(false)
    expect(AssetManifest.safeParse(baseWith([p('body.height_cm', 120, 180, 170)])).success).toBe(false)
    expect(AssetManifest.safeParse(baseWith([p('face.jaw_definition', 0, 1, 0.5)])).success).toBe(false)
  })
  it('refuses a governed axis declared as a colour', () => {
    const colour = { id: 'eyes.size', group: 'eyes', label: 'x', min: 0, max: 0xffffff, default: 5, type: 'color' }
    expect(AssetManifest.safeParse(baseWith([colour])).success).toBe(false)
  })
})

describe('catalog', () => {
  it('adds, gets (as a copy), lists and removes', () => {
    const c = new AssetCatalog()
    const r = c.add(prop())
    expect(r.ok).toBe(true)
    const got = c.get('prop.test')!
    got.name = 'mutated'
    expect(c.get('prop.test')!.name).toBe('Test prop')
    expect(c.has('prop.test')).toBe(true)
    expect(c.size).toBe(1)
    expect(c.remove('prop.test')).toBe(true)
    expect(c.remove('prop.test')).toBe(false)
  })
  it('refuses duplicates unless replace is set', () => {
    const c = new AssetCatalog()
    c.add(prop())
    const dup = c.add(prop())
    expect(dup.ok).toBe(false)
    if (!dup.ok) expect(dup.code).toBe('duplicate')
    const rep = c.add(prop({ name: 'New name' }), { replace: true })
    expect(rep.ok && rep.value.name).toBe('New name')
  })
  it('reports invalid and unsafe manifests with codes', () => {
    const c = new AssetCatalog({ contentRoot: 'C:\\content' })
    const bad = c.add({ nope: true })
    expect(!bad.ok && bad.code).toBe('invalid_manifest')
    const unsafe = c.add(prop({ locator: '../x' }))
    expect(!unsafe.ok && unsafe.code).toBe('unsafe_locator')
    const unsafeThumb = c.add(prop({ thumbnail: 'file:///x' }))
    expect(!unsafeThumb.ok && unsafeThumb.code).toBe('unsafe_locator')
    expect(c.size).toBe(0)
  })
  it('filters by kind, slot, rig, tags, text and licence', () => {
    const c = createSeedCatalog()
    expect(c.list({ kind: 'environment' }).map((a) => a.id)).toEqual([SEED_IDS.void])
    expect(c.list({ slot: 'footwear' }).map((a) => a.id)).toEqual([SEED_IDS.boots])
    expect(c.list({ kind: 'character_base', rig: 'cc5' })).toHaveLength(2)
    expect(c.list({ kind: ['prop', 'environment'] })).toHaveLength(3)
    expect(c.list({ tags: ['athletic', 'training'] }).map((a) => a.id)).toEqual([SEED_IDS.trainingTop, SEED_IDS.leggings].sort())
    expect(c.list({ anyTag: ['cold', 'seat'] }).map((a) => a.id).sort()).toEqual([SEED_IDS.chair, SEED_IDS.coat].sort())
    expect(c.list({ text: 'BLAZER' })).toHaveLength(1)
    expect(c.list({ kind: 'character_base', usableFor: 'commercial' }).every((a) => a.rigFamilies[0] === 'vrm1')).toBe(true)
    expect(c.list({ kind: 'character_base', usableFor: 'commercial' })).toHaveLength(2)
  })
  it('assets without rigs fit any rig in filters', () => {
    const c = new AssetCatalog()
    c.add(prop())
    expect(c.list({ rig: 'metahuman' })).toHaveLength(1)
    expect(c.fitsRig('prop.test', 'cc5')).toBe(true)
    expect(c.fitsRig('missing', 'cc5')).toBe(false)
  })
  it('canUse by id explains a missing asset', () => {
    const c = createSeedCatalog()
    expect(c.canUse('nope', 'personal').reasons[0]).toMatch(/not in the catalog/)
    expect(c.canUse(SEED_IDS.blazer, 'personal').ok).toBe(true)
  })
  it('returns results sorted by id', () => {
    const ids = createSeedCatalog().list().map((a) => a.id)
    expect(ids).toEqual([...ids].sort())
  })
  it('loads from an in-memory list and reports rejections', () => {
    const c = new AssetCatalog()
    const report = c.addMany([prop(), prop({ id: 'prop.b' }), { id: 5 }, prop()])
    expect(report.added).toEqual(['prop.test', 'prop.b'])
    expect(report.rejected).toHaveLength(2)
    expect(report.rejected[0]!.source).toBe('#2')
  })
  it('loads from a directory reader, tolerating bad files', async () => {
    const files: Record<string, string> = {
      'a/asset.json': JSON.stringify(prop({ id: 'prop.a' })),
      'b/asset.json': '{not json',
      'c/asset.json': JSON.stringify(prop({ id: 'prop.c', locator: '/etc/passwd' })),
      'd/asset.json': JSON.stringify(prop({ id: 'prop.d' })),
      'e/asset.json': ' '.repeat(300_000),
    }
    const c = new AssetCatalog()
    const report = await c.loadFromDirectory({
      list: () => Object.keys(files),
      read: (p) => {
        if (p === 'z/asset.json') throw new Error('boom')
        return files[p]!
      },
    })
    expect(report.added).toEqual(['prop.a', 'prop.d'])
    expect(report.rejected.map((r) => r.source)).toEqual(['b/asset.json', 'c/asset.json', 'e/asset.json'])
    expect(report.rejected[0]!.reason).toMatch(/not valid JSON/)
  })
  it('directory reader failures never throw', async () => {
    const c = new AssetCatalog()
    const r1 = await c.loadFromDirectory({ list: () => { throw new Error('nope') }, read: () => '' })
    expect(r1.rejected[0]!.reason).toMatch(/could not list/)
    const r2 = await c.loadFromDirectory({ list: () => ['x'], read: () => { throw new Error('denied') } })
    expect(r2.rejected[0]!.reason).toMatch(/could not read/)
  })
  it('validates variant references', () => {
    const c = new AssetCatalog()
    c.add(prop({ id: 'prop.a', variantOf: 'prop.zzz' }))
    c.add(prop({ id: 'prop.b' }))
    c.add(prop({ id: 'prop.c', variantOf: 'prop.b' }))
    expect(c.validateReferences()).toEqual(['"prop.a" is a variant of "prop.zzz", which is not in the catalog'])
  })
  it('createAssetCatalog throws on a bad initial entry', () => {
    expect(() => createAssetCatalog({}, [prop({ id: '../x' })])).toThrow(/rejected/)
  })
})

describe('seed catalog', () => {
  const c = createSeedCatalog()
  it('every entry validates and carries a licence record', () => {
    expect(c.size).toBe(SEED_ASSETS.length)
    for (const a of c.list()) {
      expect(a.license.id.length).toBeGreaterThan(0)
      expect(a.license.id).not.toBe('unknown')
      expect(a.license.personalUse).toBe(true)
    }
    expect(c.validateReferences()).toEqual([])
  })
  it('has a few bases per rig family, hair styles, wardrobe and 3 props/environments', () => {
    for (const rig of ['vrm1', 'metahuman', 'cc5'] as const) {
      expect(c.list({ kind: 'character_base', rig }).length).toBeGreaterThanOrEqual(2)
      expect(c.list({ kind: 'hair', rig }).length).toBeGreaterThanOrEqual(3)
    }
    expect(c.list({ kind: ['outfit', 'accessory'] }).length).toBeGreaterThanOrEqual(8)
    expect(c.list({ kind: ['prop', 'environment'] })).toHaveLength(3)
    expect(c.has(SEED_IDS.void)).toBe(true)
  })
  it('every seed base is adult-attested and its declared ranges sit inside the adult envelope', () => {
    for (const b of c.list({ kind: 'character_base' })) {
      expect(b.adult).toBe(true)
      for (const p of b.params) {
        const bound = ADULT_BOUNDS[p.id]
        if (!bound) continue
        expect(p.min).toBeGreaterThanOrEqual(bound.min)
        expect(p.max).toBeLessThanOrEqual(bound.max)
      }
      expect(worstCaseNeoteny(b.params)).toBeLessThan(NEOTENY_MAX)
    }
  })
  it('contains no revealing wear: every wearable is covering, dark/tailored/athletic, never sexualised', () => {
    const words = /lingerie|bikini|nude|naked|sheer|thong|bra\b|swimsuit|underwear|latex|fetish|corset|stockings|garter/i
    for (const a of c.list()) {
      expect(`${a.id} ${a.name} ${a.tags.join(' ')} ${a.locator}`).not.toMatch(words)
    }
    for (const a of c.list({ kind: ['outfit'] })) expect(a.hides.length).toBeGreaterThan(0)
  })
  it('slots and hidden regions of the wardrobe are sensible', () => {
    expect(c.get(SEED_IDS.jumpsuit)!.slots).toEqual(['fullBody'])
    expect(c.get(SEED_IDS.gloves)!.hides).toEqual(['hands'])
    expect(c.get(SEED_IDS.boots)!.hides).toEqual(['feet'])
    expect(c.get(seedBaseId('vrm1'))!.rigFamilies).toEqual(['vrm1'])
  })
  it('third-party seed licences are conservative, first-party ones permissive', () => {
    expect(c.canUse(seedBaseId('metahuman'), 'redistribute').ok).toBe(false)
    expect(c.canUse(seedBaseId('cc5'), 'commercial').ok).toBe(false)
    expect(c.canUse(seedBaseId('vrm1'), 'redistribute').ok).toBe(true)
    // adult expression is not permitted by any seed asset
    expect(c.canUse(seedBaseId('vrm1'), 'personal', { adultExpression: true }).ok).toBe(false)
  })
})
