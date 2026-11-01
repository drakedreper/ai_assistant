/**
 * createStageToolBindings: the tools that let the assistant act on her own body and space (STAGE_TOOL_SURFACE):
 * stage_set_outfit, stage_set_scene, stage_gesture, stage_camera, character_remember, stage_state.
 *
 * They act through the services, validate their input with the spec's zod schema, answer with concise text for the
 * model and NEVER throw (failures come back as isError results). Stage commands they produce are handed to
 * `deps.perform`, which the daemon wires to the StageSession. Wire `wardrobe.onChange` to the OutfitDirector so tool
 * changes count for its cooldown (the tools do not call the director themselves, to avoid counting a change twice).
 * All of it is cosmetic and reversible; nothing here touches the outside world.
 */
import { STAGE_TOOL_SURFACE, WardrobeSlot } from '@ai-assistant/shared'
import type { Affect, ToolBinding, ToolResult, ToolSpec } from '@ai-assistant/shared'
import type { CharacterService } from '../characters/service'
import type { WardrobeService } from '../wardrobe/service'
import type { SceneService } from '../scene/service'
import type { CharacterMemory } from './memory'
import type { CommandDraft } from '../util/commands'
import type { Result } from '../util/result'

export interface StageToolDeps {
  characters: CharacterService
  wardrobe: WardrobeService
  scenes: SceneService
  memory: CharacterMemory
  /** Receives the stage commands a tool produced (the daemon sends them to the stage). */
  perform: (commands: CommandDraft[]) => void
  /** BehaviorDirector.requestGesture */
  requestGesture: (clip: string, intensity?: number) => Result<CommandDraft>
  /** CameraDirector.request */
  requestShot: (shot: string) => Result<CommandDraft>
  mood?: () => Affect | null | undefined
  posture?: () => string | undefined
  stage?: () => { connected: boolean; engine?: string }
}

const text = (t: string, isError = false): ToolResult => (isError ? { text: t, isError: true } : { text: t })
const num = (n: number): string => (Math.round(n * 100) / 100).toString()

export function createStageToolBindings(deps: StageToolDeps): ToolBinding[] {
  const spec = (name: string): ToolSpec => {
    const s = STAGE_TOOL_SURFACE.find((x) => x.name === name)
    if (!s) throw new Error(`no such stage tool: ${name}`)
    return s
  }

  const assistant = (): { id: string; name: string } | undefined => {
    const a = deps.characters.getActive('assistant')
    return a ? { id: a.id, name: a.name } : undefined
  }

  const bind = (name: string, run: (input: Record<string, unknown>) => ToolResult | Promise<ToolResult>): ToolBinding => {
    const s = spec(name)
    return {
      spec: s,
      handler: async (raw: unknown): Promise<ToolResult> => {
        try {
          const parsed = s.input.safeParse(raw ?? {})
          if (!parsed.success) {
            const i = parsed.error.issues[0]
            return text(`Invalid input for ${name}: ${i ? `${i.path.join('.') || 'input'} ${i.message}` : 'invalid'}`.slice(0, 240), true)
          }
          return await run(parsed.data as Record<string, unknown>)
        } catch (e) {
          return text(`${name} failed: ${(e as Error).message}`.slice(0, 240), true)
        }
      },
    }
  }

  const needAssistant = (): ToolResult | { id: string; name: string } => assistant() ?? text('There is no assistant character yet.', true)
  const isErr = (v: ToolResult | { id: string; name: string }): v is ToolResult => 'text' in v

  return [
    bind('stage_set_outfit', (input) => {
      const a = needAssistant()
      if (isErr(a)) return a
      const presetId = input.presetId as string | undefined
      const slot = input.slot as string | undefined
      if (presetId !== undefined) {
        const r = deps.wardrobe.applyPreset(a.id, presetId, { source: 'assistant' })
        if (!r.ok) {
          if (r.code === 'preset_not_found') {
            const names = deps.wardrobe.listPresets(a.id).map((p) => `${p.id} (${p.name})`).join(', ')
            return text(`${r.error}. Available: ${names || 'none'}.`, true)
          }
          return text(r.error, true)
        }
        deps.perform(r.value.commands)
        return text(`Now wearing "${deps.characters.get(a.id)?.presets.find((p) => p.id === presetId)?.name ?? presetId}": ${deps.wardrobe.describeLook(a.id)}.`)
      }
      if (slot !== undefined) {
        const s = WardrobeSlot.safeParse(slot)
        if (!s.success) return text(`Unknown slot "${slot}". Slots: ${WardrobeSlot.options.join(', ')}.`, true)
        const assetId = input.assetId as string | null | undefined
        if (assetId === undefined) return text('Give an assetId to wear, or null to take the slot off.', true)
        const r = assetId === null ? deps.wardrobe.unequip(a.id, s.data, { source: 'assistant' }) : deps.wardrobe.equip(a.id, assetId, { slot: s.data, source: 'assistant' })
        if (!r.ok) return text(r.error, true)
        if (r.value.unchanged) return text('Already like that.')
        deps.perform(r.value.commands)
        return text(`Done. Now wearing: ${deps.wardrobe.describeLook(a.id)}.`)
      }
      return text('Give a presetId, or a slot with an assetId (null takes it off).', true)
    }),

    bind('stage_set_scene', (input) => {
      const presetId = input.presetId as string | undefined
      const op = input.op as 'add' | 'update' | 'remove' | undefined
      const objectId = input.objectId as string | undefined
      const assetId = input.assetId as string | undefined
      if (presetId !== undefined) {
        const r = deps.scenes.applyPreset(presetId)
        if (!r.ok) return text(r.code === 'preset_not_found' ? `${r.error}. Available: ${deps.scenes.listPresets().map((p) => p.id).join(', ') || 'none'}.` : r.error, true)
        deps.perform(r.value.commands)
        return text(`Scene set to "${r.value.value.name}".`)
      }
      if (op === 'add') {
        if (!assetId) return text('Adding an object needs an assetId.', true)
        const r = deps.scenes.addObject({ ...(objectId ? { id: objectId } : {}), assetId, transform: deps.scenes.suggestPlacement(), role: 'furniture' })
        if (!r.ok) return text(r.error, true)
        deps.perform(r.value.commands)
        return text(`Placed ${assetId} as "${r.value.value.id}".`)
      }
      if (op === 'update') {
        if (!objectId || !assetId) return text('Updating needs an objectId and the assetId to swap in.', true)
        const r = deps.scenes.updateObject(objectId, { assetId })
        if (!r.ok) return text(r.error, true)
        deps.perform(r.value.commands)
        return text(`Swapped "${objectId}" for ${assetId}.`)
      }
      if (op === 'remove') {
        if (!objectId) return text('Removing needs an objectId.', true)
        const r = deps.scenes.removeObject(objectId)
        if (!r.ok) return text(r.error, true)
        deps.perform(r.value.commands)
        return text(`Removed "${objectId}".`)
      }
      return text('Give a presetId, or op add/update/remove with an objectId and assetId.', true)
    }),

    bind('stage_gesture', (input) => {
      const r = deps.requestGesture(input.clip as string, input.intensity as number | undefined)
      if (!r.ok) return text(r.error, true)
      deps.perform([r.value])
      return text(`Gesture "${input.clip as string}".`)
    }),

    bind('stage_camera', (input) => {
      const shot = input.shot as string
      const r = deps.requestShot(shot)
      if (!r.ok) return text(r.error, true)
      const blend = (r.value as { blendMs?: number }).blendMs ?? 600
      const sc = deps.scenes.setActiveCamera(shot, blend)
      if (!sc.ok) return text(sc.error, true)
      deps.perform(sc.value.commands)
      return text(`Camera: ${shot}.`)
    }),

    bind('character_remember', (input) => {
      const r = deps.memory.remember({ kind: input.kind as 'episode' | 'relationship' | 'preference', text: input.text as string, importance: input.importance as number })
      if (!r.ok) return text(r.error, true)
      const { item, deduped, importanceCapped } = r.value
      const kept = item.sensitivity === 'normal' ? '' : ` Kept ${item.sensitivity}: it stays out of anything sent to the cloud.`
      const capped = importanceCapped ? ' Importance 5 is kept for the few most essential notes, so this one is kept at 4.' : ''
      return text(deduped ? `Already remembered; importance is now ${item.importance}.${capped}${kept}` : `Remembered (${item.kind}, importance ${item.importance}).${capped}${kept}`)
    }),

    bind('stage_state', () => {
      const a = assistant()
      if (!a) return text('There is no assistant character yet.')
      const lines: string[] = []
      lines.push(`Look: ${deps.wardrobe.describeLook(a.id)}`)
      const m = deps.mood?.()
      if (m) lines.push(`Mood: ${m.label} (valence ${num(m.valence)}, arousal ${num(m.arousal)}, dominance ${num(m.dominance)})`)
      const p = deps.posture?.()
      if (p) lines.push(`Posture: ${p}`)
      const s = deps.scenes.getScene()
      lines.push(s ? `Scene: ${s.name}, camera ${s.activeCameraId}, ${s.objects.length} object(s), ${s.constructs.length} construct(s)` : 'Scene: none')
      const st = deps.stage?.()
      if (st) lines.push(`Stage: ${st.connected ? `connected${st.engine ? ` (${st.engine})` : ''}` : 'not connected'}`)
      return text(lines.join('\n'))
    }),
  ]
}
