import type { Asset, AssetKind, RigFamily, WardrobeSlot } from '@ai-assistant/shared'
import { AssetManifest, MAX_MANIFEST_CHARS } from './manifest'
import type { AssetManifestInput } from './manifest'
import { checkOpaqueParams, exposesGovernedRole } from '../characters/adult-policy'
import { canUse } from './license'
import type { UseDecision, UseIntent, UseOptions } from './license'
import { validateLocator, validateThumbnail } from './locator'
import type { LocatorOptions } from './locator'
import { fail, ok } from '../util/result'
import type { Result } from '../util/result'

export interface AssetFilter {
  kind?: AssetKind | readonly AssetKind[]
  /** Items that can occupy this slot. */
  slot?: WardrobeSlot
  /** Items that fit this rig. Assets that declare no rigs fit any. */
  rig?: RigFamily
  /** Must carry ALL of these tags. */
  tags?: readonly string[]
  /** Must carry AT LEAST ONE of these tags. */
  anyTag?: readonly string[]
  /** Case-insensitive substring of the name. */
  text?: string
  /** Only assets whose licence permits this intent. */
  usableFor?: UseIntent
}

/** Reads asset.json files from somewhere (a folder on disk, a pack index). The catalog never touches the file system. */
export interface AssetDirectoryReader {
  /** Paths (or ids) of manifests to load, in a stable order. */
  list(): Promise<string[]> | string[]
  /** Raw text of one manifest. */
  read(path: string): Promise<string> | string
}

export interface LoadReport {
  added: string[]
  rejected: Array<{ source: string; reason: string }>
}

export interface AssetCatalogOptions extends LocatorOptions {}

export type AddCode = 'invalid_manifest' | 'unsafe_locator' | 'duplicate'

export interface AddOptions {
  /** Replace an entry with the same id (the entry then loses any vetting it had unless `vetted` is set again). */
  replace?: boolean
  /**
   * The OWNER of the catalog vouches for this entry (the daemon vets its own seed, nothing a user or a manifest on disk
   * can ask for). A vetted entry may be picked as the default clothed baseline, and is exempt from the rules that exist
   * because nobody has looked at it: opaque scalar parameters within -1..1, and a character base that exposes at least
   * one governed parameter. A manifest cannot vet itself: there is no field for it.
   */
  vetted?: boolean
}

const MAX_JSON_BYTES = 256 * 1024
/** More manifests than this in one directory load are not read (a hostile reader could list millions). */
const MAX_DIRECTORY_ENTRIES = 5000

export class AssetCatalog {
  private readonly assets = new Map<string, AssetManifest>()
  private readonly vettedIds = new Set<string>()
  constructor(private readonly options: AssetCatalogOptions = {}) {}

  /** Validate and add one manifest. A duplicate id is refused unless `replace` is set. */
  add(input: unknown, opts: AddOptions = {}): Result<AssetManifest, AddCode> {
    const parsed = AssetManifest.safeParse(input)
    if (!parsed.success) {
      const first = parsed.error.issues[0]
      const where = first && first.path.length > 0 ? `${first.path.join('.')}: ` : ''
      return fail('invalid_manifest', `${where}${first?.message ?? 'invalid manifest'}`)
    }
    const m = parsed.data
    if (JSON.stringify(m).length > MAX_MANIFEST_CHARS) return fail('invalid_manifest', `manifest of "${m.id}" is too large (the limit is ${MAX_MANIFEST_CHARS} characters of JSON)`)
    const loc = validateLocator(m.locator, this.options)
    if (!loc.ok) return fail('unsafe_locator', `locator of "${m.id}": ${loc.reason}`)
    if (m.thumbnail !== undefined) {
      const th = validateThumbnail(m.thumbnail, this.options)
      if (!th.ok) return fail('unsafe_locator', `thumbnail of "${m.id}": ${th.reason}`)
    }
    // what an asset nobody vouched for must satisfy on top of the manifest rules (see AddOptions.vetted)
    if (opts.vetted !== true) {
      const unvetted = checkOpaqueParams(m.params)
      if (m.kind === 'character_base' && !exposesGovernedRole(m.params)) {
        unvetted.push('a character base must expose at least one governed parameter (face.apparent_age, body.height_cm, ...) or the adult envelope cannot judge it; only an asset vetted by the owner of the catalog is exempt')
      }
      if (unvetted.length > 0) return fail('invalid_manifest', `params: ${unvetted[0]}`)
    }
    if (this.assets.has(m.id) && !opts.replace) return fail('duplicate', `asset "${m.id}" already exists`)
    const stored: AssetManifest = structuredClone({ ...m, locator: loc.normalized })
    this.assets.set(m.id, stored)
    if (opts.vetted === true) this.vettedIds.add(m.id)
    else this.vettedIds.delete(m.id)
    return ok(structuredClone(stored))
  }

  /** Did the owner of the catalog vouch for this entry? (Vetting is state of the catalog, never of the manifest.) */
  isVetted(id: string): boolean {
    return this.vettedIds.has(id) && this.assets.has(id)
  }

  /** Add many; never throws, reports each rejection. */
  addMany(list: readonly unknown[], opts: AddOptions = {}): LoadReport {
    const report: LoadReport = { added: [], rejected: [] }
    list.forEach((item, i) => {
      const r = this.add(item, opts)
      if (r.ok) report.added.push(r.value.id)
      else {
        const id = typeof item === 'object' && item !== null && typeof (item as { id?: unknown }).id === 'string' ? (item as { id: string }).id : `#${i}`
        report.rejected.push({ source: id, reason: r.error })
      }
    })
    return report
  }

  /**
   * Load manifests through an injected reader (asset.json per asset). Bad JSON or bad manifests are reported, not thrown,
   * and so is a reader that misbehaves (a list that is not a list, a path that is not text, something that is not text where
   * a manifest should be, a read that throws, millions of entries).
   */
  async loadFromDirectory(reader: AssetDirectoryReader, opts: AddOptions = {}): Promise<LoadReport> {
    const report: LoadReport = { added: [], rejected: [] }
    let paths: string[]
    try {
      const listed: unknown = await reader.list()
      if (!Array.isArray(listed)) {
        report.rejected.push({ source: '(list)', reason: 'the reader did not return a list of manifests' })
        return report
      }
      paths = []
      for (const p of listed as unknown[]) {
        if (typeof p === 'string') paths.push(p)
        else report.rejected.push({ source: '(list)', reason: 'a manifest path that is not text was ignored' })
      }
      paths.sort()
    } catch (e) {
      report.rejected.push({ source: '(list)', reason: `could not list manifests: ${errorText(e)}` })
      return report
    }
    if (paths.length > MAX_DIRECTORY_ENTRIES) {
      report.rejected.push({ source: '(list)', reason: `${paths.length} manifests listed; only the first ${MAX_DIRECTORY_ENTRIES} are read` })
      paths = paths.slice(0, MAX_DIRECTORY_ENTRIES)
    }
    for (const path of paths) {
      let text: unknown
      try {
        text = await reader.read(path)
      } catch (e) {
        report.rejected.push({ source: path, reason: `could not read: ${errorText(e)}` })
        continue
      }
      if (typeof text !== 'string') {
        report.rejected.push({ source: path, reason: 'the reader returned something that is not text' })
        continue
      }
      if (text.length > MAX_JSON_BYTES) {
        report.rejected.push({ source: path, reason: 'manifest is too large' })
        continue
      }
      let json: unknown
      try {
        json = JSON.parse(text)
      } catch {
        report.rejected.push({ source: path, reason: 'not valid JSON' })
        continue
      }
      const r = this.add(json, opts)
      if (r.ok) report.added.push(r.value.id)
      else report.rejected.push({ source: path, reason: r.error })
    }
    return report
  }

  has(id: string): boolean {
    return this.assets.has(id)
  }

  get(id: string): AssetManifest | undefined {
    const a = this.assets.get(id)
    return a ? structuredClone(a) : undefined
  }

  remove(id: string): boolean {
    this.vettedIds.delete(id)
    return this.assets.delete(id)
  }

  get size(): number {
    return this.assets.size
  }

  list(filter: AssetFilter = {}): AssetManifest[] {
    const kinds = filter.kind === undefined ? undefined : new Set(Array.isArray(filter.kind) ? filter.kind : [filter.kind])
    const text = filter.text?.toLowerCase()
    const out: AssetManifest[] = []
    for (const a of this.assets.values()) {
      if (kinds && !kinds.has(a.kind)) continue
      if (filter.slot && !a.slots.includes(filter.slot)) continue
      if (filter.rig && a.rigFamilies.length > 0 && !a.rigFamilies.includes(filter.rig)) continue
      if (filter.tags && !filter.tags.every((t) => a.tags.includes(t))) continue
      if (filter.anyTag && filter.anyTag.length > 0 && !filter.anyTag.some((t) => a.tags.includes(t))) continue
      if (text && !a.name.toLowerCase().includes(text)) continue
      if (filter.usableFor && !canUse(a, filter.usableFor).ok) continue
      out.push(structuredClone(a))
    }
    return out.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
  }

  /** Licence decision for an asset id; an unknown id is refused with a clear reason. */
  canUse(id: string, intent: UseIntent, options?: UseOptions): UseDecision {
    const a = this.assets.get(id)
    if (!a) return { ok: false, reasons: [`asset "${id}" is not in the catalog`], warnings: [] }
    return canUse(a, intent, options)
  }

  /** Does the asset fit the rig? (an asset that declares no rigs fits any) */
  fitsRig(id: string, rig: RigFamily): boolean {
    const a = this.assets.get(id)
    return !!a && (a.rigFamilies.length === 0 || a.rigFamilies.includes(rig))
  }

  /** Cross-asset consistency: variantOf must point at an existing asset of the same kind. */
  validateReferences(): string[] {
    const issues: string[] = []
    for (const a of this.assets.values()) {
      if (a.variantOf === undefined) continue
      const base = this.assets.get(a.variantOf)
      if (!base) issues.push(`"${a.id}" is a variant of "${a.variantOf}", which is not in the catalog`)
      else if (base.kind !== a.kind) issues.push(`"${a.id}" (${a.kind}) is a variant of "${base.id}" (${base.kind})`)
    }
    return issues
  }

  /** Metadata only (what the dashboard snapshot shows). */
  toAssets(): Asset[] {
    return this.list()
  }
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 160)

export function createAssetCatalog(options: AssetCatalogOptions = {}, initial: readonly AssetManifestInput[] = [], extra: Pick<AddOptions, 'vetted'> = {}): AssetCatalog {
  const c = new AssetCatalog(options)
  if (initial.length > 0) {
    const report = c.addMany(initial, extra)
    if (report.rejected.length > 0) {
      throw new Error(`createAssetCatalog: ${report.rejected.length} initial asset(s) rejected: ${report.rejected.map((r) => `${r.source} (${r.reason})`).join('; ')}`)
    }
  }
  return c
}
