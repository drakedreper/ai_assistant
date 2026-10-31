import type Database from 'better-sqlite3'
import { CharacterProfile, OutfitPreset, Scene } from '@ai-assistant/shared'
import type { CharacterProfile as CharacterProfileT, OutfitPreset as OutfitPresetT, Scene as SceneT } from '@ai-assistant/shared'
import type { CharacterRepo, CharacterRole, MemoryItem, MemoryKind, MemoryRepo, SceneRepo } from '@ai-assistant/stage-core'
import type { Store } from './store'

/**
 * SQLite behind the stage-core repository interfaces (CharacterRepo, SceneRepo, MemoryRepo) plus the catalog metadata
 * and the mood row. SQL for the stage lives here and nowhere else. Everything is synchronous (better-sqlite3) and
 * copy-safe: every read parses fresh JSON, so a caller can never mutate what the database holds by accident.
 *
 * A row that no longer validates (hand-edited database, an older schema) reads as missing instead of throwing, so one
 * corrupt row cannot take the daemon down; the stage services then treat it as "not there".
 *
 * METADATA ONLY: nothing in these tables is a binary asset, and nothing here stores audio, camera images or terminal
 * bytes.
 */

type Row = Record<string, unknown>

const str = (v: unknown): string => (typeof v === 'string' ? v : String(v ?? ''))
const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? 0))

function parseJson(raw: unknown): unknown {
  if (typeof raw !== 'string') return undefined
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return undefined
  }
}

export type AssetSource = 'seed' | 'user'

export interface StoredAsset {
  manifest: unknown
  source: AssetSource
  addedAt: string
}

export interface MoodRow {
  valence: number
  arousal: number
  dominance: number
  /** Epoch ms when it was written. */
  at: number
}

export class StageStore {
  private readonly cache = new Map<string, Database.Statement>()
  readonly db: Database.Database

  constructor(private readonly store: Store) {
    this.db = store.db
  }

  private st(sql: string): Database.Statement {
    let s = this.cache.get(sql)
    if (!s) {
      s = this.db.prepare(sql)
      this.cache.set(sql, s)
    }
    return s
  }

  tx<T>(fn: () => T): T {
    return this.store.tx(fn)
  }

  // ---------------------------------------------------------------------------------------------- assets

  countAssets(): number {
    return num((this.st('SELECT COUNT(*) AS n FROM stage_assets').get() as Row).n)
  }

  hasAsset(id: string): boolean {
    return this.st('SELECT 1 AS x FROM stage_assets WHERE id = ?').get(id) !== undefined
  }

  /** Insert or replace one catalog entry. `manifest` is the validated manifest (the stage-core catalog's output). */
  upsertAsset(manifest: { id: string; kind: string; name: string; license: { id: string; personalUse: boolean; commercialUse: boolean; redistribution: boolean; adultExpression?: boolean | undefined } }, source: AssetSource, addedAt: string): void {
    const l = manifest.license
    this.st(
      `INSERT INTO stage_assets (id, kind, name, source, license_id, personal_use, commercial_use, redistribution, adult_expression, manifest_json, added_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, name = excluded.name, source = excluded.source, license_id = excluded.license_id,
         personal_use = excluded.personal_use, commercial_use = excluded.commercial_use, redistribution = excluded.redistribution,
         adult_expression = excluded.adult_expression, manifest_json = excluded.manifest_json`,
    ).run(
      manifest.id,
      manifest.kind,
      manifest.name,
      source,
      l.id,
      l.personalUse ? 1 : 0,
      l.commercialUse ? 1 : 0,
      l.redistribution ? 1 : 0,
      l.adultExpression === undefined ? null : l.adultExpression ? 1 : 0,
      JSON.stringify(manifest),
      addedAt,
    )
  }

  deleteAsset(id: string): boolean {
    return this.st('DELETE FROM stage_assets WHERE id = ?').run(id).changes > 0
  }

  /** Every stored entry, by id. The caller validates them again through the catalog (a stored manifest is not trusted). */
  listAssets(): StoredAsset[] {
    const rows = this.st('SELECT manifest_json, source, added_at FROM stage_assets ORDER BY id').all() as Row[]
    const out: StoredAsset[] = []
    for (const r of rows) {
      const manifest = parseJson(r.manifest_json)
      if (manifest !== undefined) out.push({ manifest, source: r.source === 'user' ? 'user' : 'seed', addedAt: str(r.added_at) })
    }
    return out
  }

  /** Licence columns for the audit and tests (no JSON parse). */
  assetLicense(id: string): { licenseId: string; personalUse: boolean; commercialUse: boolean; redistribution: boolean; adultExpression: boolean | null; source: AssetSource } | undefined {
    const r = this.st('SELECT license_id, personal_use, commercial_use, redistribution, adult_expression, source FROM stage_assets WHERE id = ?').get(id) as Row | undefined
    if (!r) return undefined
    return {
      licenseId: str(r.license_id),
      personalUse: num(r.personal_use) === 1,
      commercialUse: num(r.commercial_use) === 1,
      redistribution: num(r.redistribution) === 1,
      adultExpression: r.adult_expression === null || r.adult_expression === undefined ? null : num(r.adult_expression) === 1,
      source: r.source === 'user' ? 'user' : 'seed',
    }
  }

  // ---------------------------------------------------------------------------------------------- characters

  characterRepo(): CharacterRepo {
    const self = this
    const presetsOf = (id: string): OutfitPresetT[] => {
      const rows = self.st('SELECT preset_json FROM stage_outfit_presets WHERE character_id = ? ORDER BY ord').all(id) as Row[]
      const out: OutfitPresetT[] = []
      for (const r of rows) {
        const p = OutfitPreset.safeParse(parseJson(r.preset_json))
        if (p.success) out.push(p.data)
      }
      return out
    }
    const read = (r: Row): CharacterProfileT | undefined => {
      const raw = parseJson(r.profile_json)
      if (raw === null || typeof raw !== 'object') return undefined
      const parsed = CharacterProfile.safeParse({ ...(raw as object), presets: presetsOf(str(r.id)) })
      return parsed.success ? parsed.data : undefined
    }
    return {
      get(id) {
        const r = self.st('SELECT * FROM stage_characters WHERE id = ?').get(id) as Row | undefined
        return r ? read(r) : undefined
      },
      list() {
        const rows = self.st('SELECT * FROM stage_characters ORDER BY ord').all() as Row[]
        return rows.map(read).filter((c): c is CharacterProfileT => c !== undefined)
      },
      save(profile) {
        const { presets, ...rest } = profile
        self.tx(() => {
          const existing = self.st('SELECT ord FROM stage_characters WHERE id = ?').get(profile.id) as Row | undefined
          const ord = existing ? num(existing.ord) : num((self.st('SELECT COALESCE(MAX(ord), 0) + 1 AS n FROM stage_characters').get() as Row).n)
          self.st(
            `INSERT INTO stage_characters (id, ord, role, name, base_asset_id, profile_json, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET role = excluded.role, name = excluded.name, base_asset_id = excluded.base_asset_id,
               profile_json = excluded.profile_json, updated_at = excluded.updated_at`,
          ).run(profile.id, ord, profile.role, profile.name, profile.baseAssetId, JSON.stringify(rest), profile.createdAt, profile.updatedAt)
          self.st('DELETE FROM stage_outfit_presets WHERE character_id = ?').run(profile.id)
          presets.forEach((p, i) => {
            self.st('INSERT INTO stage_outfit_presets (character_id, ord, id, name, preset_json) VALUES (?, ?, ?, ?, ?)').run(profile.id, i, p.id, p.name, JSON.stringify(p))
          })
        })
      },
      delete(id) {
        return self.st('DELETE FROM stage_characters WHERE id = ?').run(id).changes > 0
      },
      getActiveId(role) {
        const r = self.st('SELECT character_id FROM stage_active WHERE role = ?').get(role) as Row | undefined
        return r ? str(r.character_id) : undefined
      },
      setActiveId(role: CharacterRole, id) {
        if (id === undefined) self.st('DELETE FROM stage_active WHERE role = ?').run(role)
        else self.st('INSERT INTO stage_active (role, character_id) VALUES (?, ?) ON CONFLICT(role) DO UPDATE SET character_id = excluded.character_id').run(role, id)
      },
    }
  }

  countCharacters(): number {
    return num((this.st('SELECT COUNT(*) AS n FROM stage_characters').get() as Row).n)
  }

  /** Names of the preset rows of a character, in order (tests and the audit). */
  presetRows(characterId: string): Array<{ id: string; name: string }> {
    return (this.st('SELECT id, name FROM stage_outfit_presets WHERE character_id = ? ORDER BY ord').all(characterId) as Row[]).map((r) => ({ id: str(r.id), name: str(r.name) }))
  }

  // ---------------------------------------------------------------------------------------------- scenes

  sceneRepo(): SceneRepo {
    const self = this
    const readScene = (raw: unknown): SceneT | undefined => {
      const p = Scene.safeParse(parseJson(raw))
      return p.success ? p.data : undefined
    }
    return {
      getActive() {
        const r = self.st('SELECT scene_json FROM stage_scene WHERE id = 1').get() as Row | undefined
        return r ? readScene(r.scene_json) : undefined
      },
      saveActive(scene) {
        self.st(
          `INSERT INTO stage_scene (id, scene_json, updated_at) VALUES (1, ?, ?)
           ON CONFLICT(id) DO UPDATE SET scene_json = excluded.scene_json, updated_at = excluded.updated_at`,
        ).run(JSON.stringify(scene), scene.updatedAt)
      },
      listPresets() {
        return (self.st('SELECT id, name FROM stage_scene_presets ORDER BY id').all() as Row[]).map((r) => ({ id: str(r.id), name: str(r.name) }))
      },
      getPreset(id) {
        const r = self.st('SELECT scene_json FROM stage_scene_presets WHERE id = ?').get(id) as Row | undefined
        return r ? readScene(r.scene_json) : undefined
      },
      savePreset(id, name, scene) {
        self.st(
          `INSERT INTO stage_scene_presets (id, name, scene_json, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET name = excluded.name, scene_json = excluded.scene_json, updated_at = excluded.updated_at`,
        ).run(id, name, JSON.stringify(scene), scene.updatedAt)
      },
      deletePreset(id) {
        return self.st('DELETE FROM stage_scene_presets WHERE id = ?').run(id).changes > 0
      },
    }
  }

  // ---------------------------------------------------------------------------------------------- memory

  memoryRepo(): MemoryRepo {
    const self = this
    const read = (r: Row): MemoryItem => {
      const tags = parseJson(r.tags_json)
      return {
        id: str(r.id),
        kind: str(r.kind) as MemoryKind,
        text: str(r.text),
        importance: num(r.importance),
        ...(typeof r.emotion === 'string' && r.emotion ? { emotion: r.emotion as MemoryItem['emotion'] } : {}),
        sensitivity: str(r.sensitivity) as MemoryItem['sensitivity'],
        tags: Array.isArray(tags) ? tags.filter((t): t is string => typeof t === 'string') : [],
        createdAt: num(r.created_at),
        updatedAt: num(r.updated_at),
        recallCount: num(r.recall_count),
        ...(r.last_recalled_at === null || r.last_recalled_at === undefined ? {} : { lastRecalledAt: num(r.last_recalled_at) }),
      }
    }
    const write = (i: MemoryItem): unknown[] => [i.kind, i.text, i.importance, i.emotion ?? null, i.sensitivity, JSON.stringify(i.tags), i.createdAt, i.updatedAt, i.recallCount, i.lastRecalledAt ?? null]
    return {
      insert(item) {
        self
          .st(
            `INSERT INTO stage_memory (id, kind, text, importance, emotion, sensitivity, tags_json, created_at, updated_at, recall_count, last_recalled_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(item.id, ...write(item))
      },
      get(id) {
        const r = self.st('SELECT * FROM stage_memory WHERE id = ?').get(id) as Row | undefined
        return r ? read(r) : undefined
      },
      update(item) {
        return (
          self
            .st(
              `UPDATE stage_memory SET kind = ?, text = ?, importance = ?, emotion = ?, sensitivity = ?, tags_json = ?, created_at = ?, updated_at = ?,
                 recall_count = ?, last_recalled_at = ? WHERE id = ?`,
            )
            .run(...write(item), item.id).changes > 0
        )
      },
      delete(id) {
        return self.st('DELETE FROM stage_memory WHERE id = ?').run(id).changes > 0
      },
      list(filter = {}) {
        const rows = (filter.kind
          ? self.st('SELECT * FROM stage_memory WHERE kind = ? ORDER BY created_at, id').all(filter.kind)
          : self.st('SELECT * FROM stage_memory ORDER BY created_at, id').all()) as Row[]
        return rows.map(read)
      },
      count() {
        return num((self.st('SELECT COUNT(*) AS n FROM stage_memory').get() as Row).n)
      },
    }
  }

  // ---------------------------------------------------------------------------------------------- mood

  loadMood(): MoodRow | undefined {
    const r = this.st('SELECT valence, arousal, dominance, at FROM stage_mood WHERE id = 1').get() as Row | undefined
    if (!r) return undefined
    const m = { valence: num(r.valence), arousal: num(r.arousal), dominance: num(r.dominance), at: num(r.at) }
    return Object.values(m).every(Number.isFinite) ? m : undefined
  }

  saveMood(m: MoodRow): void {
    if (!Object.values(m).every(Number.isFinite)) return
    this.st(
      `INSERT INTO stage_mood (id, valence, arousal, dominance, at) VALUES (1, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET valence = excluded.valence, arousal = excluded.arousal, dominance = excluded.dominance, at = excluded.at`,
    ).run(m.valence, m.arousal, m.dominance, m.at)
  }
}
