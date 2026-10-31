import type { Asset, AssetKind, RigFamily, WardrobeSlot } from '@ai-assistant/shared'
import { AssetManifest } from './manifest'
import type { AssetManifestInput } from './manifest'
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

const MAX_JSON_BYTES = 256 * 1024

export class AssetCatalog {
  private readonly assets = new Map<string, AssetManifest>()
  constructor(private readonly options: AssetCatalogOptions = {}) {}

  /** Validate and add one manifest. A duplicate id is refused unless `replace` is set. */
  add(input: unknown, opts: { replace?: boolean } = {}): Result<AssetManifest, AddCode> {
    const parsed = AssetManifest.safeParse(input)
    if (!parsed.success) {
      const first = parsed.error.issues[0]
      const where = first && first.path.length > 0 ? `${first.path.join('.')}: ` : ''
      return fail('invalid_manifest', `${where}${first?.message ?? 'invalid manifest'}`)
    }
    const m = parsed.data
    const loc = validateLocator(m.locator, this.options)
    if (!loc.ok) return fail('unsafe_locator', `locator of "${m.id}": ${loc.reason}`)
    if (m.thumbnail !== undefined) {
      const th = validateThumbnail(m.thumbnail, this.options)
      if (!th.ok) return fail('unsafe_locator', `thumbnail of "${m.id}": ${th.reason}`)
    }
    if (this.assets.has(m.id) && !opts.replace) return fail('duplicate', `asset "${m.id}" already exists`)
    const stored: AssetManifest = structuredClone({ ...m, locator: loc.normalized })
    this.assets.set(m.id, stored)
    return ok(structuredClone(stored))
  }

  /** Add many; never throws, reports each rejection. */
  addMany(list: readonly unknown[], opts: { replace?: boolean } = {}): LoadReport {
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

  /** Load manifests through an injected reader (asset.json per asset). Bad JSON or bad manifests are reported, not thrown. */
  async loadFromDirectory(reader: AssetDirectoryReader, opts: { replace?: boolean } = {}): Promise<LoadReport> {
    const report: LoadReport = { added: [], rejected: [] }
    let paths: string[]
    try {
      paths = [...(await reader.list())].sort()
    } catch (e) {
      report.rejected.push({ source: '(list)', reason: `could not list manifests: ${(e as Error).message}` })
      return report
    }
    for (const path of paths) {
      let text: string
      try {
        text = await reader.read(path)
      } catch (e) {
        report.rejected.push({ source: path, reason: `could not read: ${(e as Error).message}` })
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

export function createAssetCatalog(options: AssetCatalogOptions = {}, initial: readonly AssetManifestInput[] = []): AssetCatalog {
  const c = new AssetCatalog(options)
  if (initial.length > 0) {
    const report = c.addMany(initial)
    if (report.rejected.length > 0) {
      throw new Error(`createAssetCatalog: ${report.rejected.length} initial asset(s) rejected: ${report.rejected.map((r) => `${r.source} (${r.reason})`).join('; ')}`)
    }
  }
  return c
}
