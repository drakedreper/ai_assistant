import type { Scene } from '@ai-assistant/shared'

/** Persistence seam, implemented by the daemon (SQLite). Synchronous; copy-safe like the other repos. */
export interface SceneRepo {
  /** The scene currently shown (the working copy). */
  getActive(): Scene | undefined
  saveActive(scene: Scene): void
  listPresets(): Array<{ id: string; name: string }>
  getPreset(id: string): Scene | undefined
  /** Insert or replace a saved scene preset. */
  savePreset(id: string, name: string, scene: Scene): void
  deletePreset(id: string): boolean
}

export class InMemorySceneRepo implements SceneRepo {
  private active: Scene | undefined
  private readonly presets = new Map<string, { name: string; scene: Scene }>()

  getActive(): Scene | undefined {
    return this.active ? structuredClone(this.active) : undefined
  }
  saveActive(scene: Scene): void {
    this.active = structuredClone(scene)
  }
  listPresets(): Array<{ id: string; name: string }> {
    return [...this.presets.entries()].map(([id, p]) => ({ id, name: p.name })).sort((a, b) => (a.id < b.id ? -1 : 1))
  }
  getPreset(id: string): Scene | undefined {
    const p = this.presets.get(id)
    return p ? structuredClone(p.scene) : undefined
  }
  savePreset(id: string, name: string, scene: Scene): void {
    this.presets.set(id, { name, scene: structuredClone(scene) })
  }
  deletePreset(id: string): boolean {
    return this.presets.delete(id)
  }
}
