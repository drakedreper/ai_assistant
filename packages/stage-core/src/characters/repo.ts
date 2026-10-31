import type { CharacterProfile } from '@ai-assistant/shared'

export type CharacterRole = 'assistant' | 'user'

/**
 * Persistence seam, implemented by the daemon over SQLite. Synchronous (better-sqlite3 is) and copy-safe: the
 * service never mutates what the repo returns and the repo must not hand out its internal objects.
 */
export interface CharacterRepo {
  get(id: string): CharacterProfile | undefined
  /** All characters, oldest first. */
  list(): CharacterProfile[]
  /** Insert or replace by id. */
  save(profile: CharacterProfile): void
  delete(id: string): boolean
  getActiveId(role: CharacterRole): string | undefined
  setActiveId(role: CharacterRole, id: string | undefined): void
}

export class InMemoryCharacterRepo implements CharacterRepo {
  private readonly items = new Map<string, CharacterProfile>()
  private readonly active = new Map<CharacterRole, string>()

  get(id: string): CharacterProfile | undefined {
    const c = this.items.get(id)
    return c ? structuredClone(c) : undefined
  }
  list(): CharacterProfile[] {
    return [...this.items.values()].map((c) => structuredClone(c))
  }
  save(profile: CharacterProfile): void {
    this.items.set(profile.id, structuredClone(profile))
  }
  delete(id: string): boolean {
    for (const [role, a] of this.active) if (a === id) this.active.delete(role)
    return this.items.delete(id)
  }
  getActiveId(role: CharacterRole): string | undefined {
    return this.active.get(role)
  }
  setActiveId(role: CharacterRole, id: string | undefined): void {
    if (id === undefined) this.active.delete(role)
    else this.active.set(role, id)
  }
}
