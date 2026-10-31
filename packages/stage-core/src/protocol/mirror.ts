/**
 * StageMirror: what the stage SHOULD currently show, built from the commands the stage acknowledged. After a reconnect
 * the backend replays it (`replay()`): character.load for each character, scene.load with everything placed in it,
 * the data of each construct, and the current look (affect, idle profile, posture, gaze).
 * Transient commands (speak, cancel, gestures, terminal bytes) are not mirrored: there is nothing to restore.
 * The terminal's scrollback is not replayed either; the owner re-sends it from the PTY buffer if it wants it.
 */
import type { Affect, Asset, CharacterProfile, GazeTarget, Posture, Scene, StageCommand } from '@ai-assistant/shared'
import type { CommandDraft } from '../util/commands'
import { applyPresetToEquipped, equippedAssetIds } from '../core/equipped'
import { applySceneData, emptyConstructData } from '../constructs/data-state'
import type { ConstructData } from '../constructs/data-state'
import { replaceCommands } from '../constructs/diff'

export interface MirrorLook {
  affect?: Affect
  idle?: 'attentive' | 'relaxed' | 'busy' | 'sleepy' | 'asleep'
  posture?: { posture: Posture; anchorObjectId?: string; anchorId?: string }
  gaze?: { target: GazeTarget; speed: number; saccades: boolean }
}

export interface MirrorState {
  characters: CharacterProfile[]
  scene: Scene | null
  constructData: Record<string, ConstructData>
  look: MirrorLook
}

export class StageMirror {
  private characters = new Map<string, CharacterProfile>()
  private tweaks = new Map<string, Record<string, Record<string, number | string>>>()
  private assets = new Map<string, Asset>()
  private scene: Scene | null = null
  private data = new Map<string, ConstructData>()
  private look: MirrorLook = {}
  private defaultCharacterId: string | undefined

  hasContent(): boolean {
    return this.characters.size > 0 || this.scene !== null
  }

  reset(): void {
    this.characters.clear()
    this.tweaks.clear()
    this.assets.clear()
    this.scene = null
    this.data.clear()
    this.look = {}
    this.defaultCharacterId = undefined
  }

  private remember(assets: readonly Asset[] | undefined): void {
    for (const a of assets ?? []) this.assets.set(a.id, structuredClone(a))
  }

  /** The id that commands without characterId refer to: the assistant. */
  assistantId(): string | undefined {
    return this.defaultCharacterId
  }

  character(id?: string): CharacterProfile | undefined {
    const c = this.characters.get(id ?? this.defaultCharacterId ?? '')
    return c ? structuredClone(c) : undefined
  }

  sceneState(): Scene | null {
    return this.scene ? structuredClone(this.scene) : null
  }

  constructData(id: string): ConstructData | undefined {
    const d = this.data.get(id)
    return d ? structuredClone(d) : undefined
  }

  currentLook(): MirrorLook {
    return structuredClone(this.look)
  }

  state(): MirrorState {
    return {
      characters: [...this.characters.values()].map((c) => structuredClone(c)),
      scene: this.sceneState(),
      constructData: Object.fromEntries([...this.data.entries()].map(([k, v]) => [k, structuredClone(v)])),
      look: this.currentLook(),
    }
  }

  /** Apply an ACKNOWLEDGED command. Commands that do not fit the current state (unknown ids) are ignored. */
  apply(cmd: StageCommand): void {
    switch (cmd.type) {
      case 'character.load': {
        this.remember(cmd.assets)
        this.characters.set(cmd.character.id, structuredClone(cmd.character))
        this.tweaks.delete(cmd.character.id)
        // the latest assistant loaded is the one that commands without a characterId refer to
        if (cmd.character.role === 'assistant' || !this.defaultCharacterId || !this.characters.has(this.defaultCharacterId)) this.defaultCharacterId = cmd.character.id
        break
      }
      case 'character.params': {
        const c = this.characters.get(cmd.characterId)
        if (c) c.params = { ...c.params, ...cmd.params }
        break
      }
      case 'character.equip': {
        const c = this.characters.get(cmd.characterId)
        if (!c) break
        if (cmd.asset) this.remember([cmd.asset])
        c.equipped = { ...c.equipped, [cmd.slot]: cmd.assetId }
        break
      }
      case 'character.outfit': {
        const c = this.characters.get(cmd.characterId)
        if (!c) break
        this.remember(cmd.assets)
        c.equipped = applyPresetToEquipped(c.equipped, cmd.preset)
        if (Object.keys(cmd.preset.tweaks).length > 0) this.tweaks.set(c.id, structuredClone(cmd.preset.tweaks))
        else this.tweaks.delete(c.id)
        break
      }
      case 'scene.load': {
        this.remember(cmd.assets)
        this.scene = structuredClone(cmd.scene)
        this.data.clear()
        break
      }
      case 'scene.object': {
        if (!this.scene) break
        if (cmd.asset) this.remember([cmd.asset])
        const objs = this.scene.objects
        if (cmd.op === 'add') {
          if (!objs.some((o) => o.id === cmd.object.id)) objs.push(structuredClone(cmd.object))
        } else if (cmd.op === 'update') {
          this.scene.objects = objs.map((o) => (o.id === cmd.object.id ? structuredClone(cmd.object) : o))
        } else {
          this.scene.objects = objs.filter((o) => o.id !== cmd.object.id)
        }
        break
      }
      case 'scene.construct': {
        if (!this.scene) break
        const cs = this.scene.constructs
        if (cmd.op === 'add') {
          if (!cs.some((c) => c.id === cmd.construct.id)) cs.push(structuredClone(cmd.construct))
        } else if (cmd.op === 'update') {
          this.scene.constructs = cs.map((c) => (c.id === cmd.construct.id ? structuredClone(cmd.construct) : c))
        } else {
          this.scene.constructs = cs.filter((c) => c.id !== cmd.construct.id)
          this.data.delete(cmd.construct.id)
        }
        break
      }
      case 'scene.data': {
        if (!this.scene?.constructs.some((c) => c.id === cmd.constructId)) break
        const r = applySceneData(this.data.get(cmd.constructId) ?? emptyConstructData(), cmd)
        if (r.ok) this.data.set(cmd.constructId, r.state)
        break
      }
      case 'scene.camera':
        if (this.scene && this.scene.cameras.some((c) => c.id === cmd.cameraId)) this.scene.activeCameraId = cmd.cameraId
        break
      case 'scene.lighting':
        if (this.scene) this.scene.lighting = structuredClone(cmd.lighting)
        break
      case 'perform.affect':
        this.look.affect = structuredClone(cmd.affect)
        break
      case 'perform.idle':
        this.look.idle = cmd.profile
        break
      case 'perform.posture':
        this.look.posture = { posture: cmd.posture, ...(cmd.anchorObjectId ? { anchorObjectId: cmd.anchorObjectId } : {}), ...(cmd.anchorId ? { anchorId: cmd.anchorId } : {}) }
        break
      case 'perform.gaze':
        this.look.gaze = { target: structuredClone(cmd.target), speed: cmd.speed, saccades: cmd.saccades }
        break
      default:
        break
    }
  }

  /** Only the current look (affect, idle profile, posture, gaze), for owners that rebuild characters and scene from their own services. */
  replayLook(): CommandDraft[] {
    const out: CommandDraft[] = []
    const a = this.defaultCharacterId
    const base = a ? { characterId: a } : {}
    if (this.look.affect) out.push({ type: 'perform.affect', ...base, affect: structuredClone(this.look.affect), blendMs: 0 })
    if (this.look.idle) out.push({ type: 'perform.idle', ...base, profile: this.look.idle })
    if (this.look.posture) out.push({ type: 'perform.posture', ...base, ...structuredClone(this.look.posture) })
    if (this.look.gaze) out.push({ type: 'perform.gaze', ...base, target: structuredClone(this.look.gaze.target), speed: this.look.gaze.speed, saccades: this.look.gaze.saccades })
    return out
  }

  private assetsFor(ids: readonly string[]): Asset[] {
    return [...new Set(ids)].sort().map((id) => this.assets.get(id)).filter((a): a is Asset => !!a).map((a) => structuredClone(a))
  }

  /** The commands that bring a fresh stage to the state this mirror holds. Empty when there is nothing to show. */
  replay(): CommandDraft[] {
    const out: CommandDraft[] = []
    const ordered = [...this.characters.values()].sort((a, b) => (a.id === this.defaultCharacterId ? -1 : b.id === this.defaultCharacterId ? 1 : a.id < b.id ? -1 : 1))
    for (const c of ordered) {
      out.push({ type: 'character.load', characterId: c.id, character: structuredClone(c), assets: this.assetsFor([c.baseAssetId, ...equippedAssetIds(c.equipped)]) })
      const tw = this.tweaks.get(c.id)
      if (tw) out.push({ type: 'character.outfit', characterId: c.id, preset: { id: 'current', name: 'Current look', equipped: structuredClone(c.equipped), tweaks: structuredClone(tw), context: {} }, assets: this.assetsFor(equippedAssetIds(c.equipped)) })
    }
    if (this.scene) {
      const scene = structuredClone(this.scene)
      out.push({ type: 'scene.load', scene, assets: this.assetsFor([scene.environmentAssetId, ...scene.objects.map((o) => o.assetId)]) })
      for (const con of scene.constructs) {
        const d = this.data.get(con.id)
        if (d && (d.nodes.length > 0 || d.edges.length > 0 || d.items.length > 0)) out.push(...replaceCommands(con.id, d))
      }
    }
    out.push(...this.replayLook())
    return out
  }
}

export function createStageMirror(): StageMirror {
  return new StageMirror()
}
