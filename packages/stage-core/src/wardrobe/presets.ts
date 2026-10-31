/** Seed outfit presets: tailored, structured or athletic; always a full clothed baseline. Metadata only. */
import type { Equipped, OutfitPreset } from '@ai-assistant/shared'
import { emptyEquipped } from '../core/equipped'
import { SEED_IDS as S } from '../assets/seed'

const eq = (items: Partial<Equipped>): Equipped => ({ ...emptyEquipped(), ...items })

export const SEED_OUTFIT_PRESETS: readonly OutfitPreset[] = [
  {
    id: 'preset.work',
    name: 'Work',
    equipped: eq({ top: S.shirt, bottom: S.trousers, footwear: S.boots, earrings: S.earrings }),
    tweaks: {},
    context: { activity: ['work'], timeOfDay: ['morning', 'day'] },
  },
  {
    id: 'preset.meeting',
    name: 'Meeting',
    equipped: eq({ top: S.shirt, bottom: S.trousers, outerwear: S.blazer, footwear: S.boots, earrings: S.earrings }),
    tweaks: {},
    context: { activity: ['meeting'] },
  },
  {
    id: 'preset.training',
    name: 'Training',
    equipped: eq({ top: S.trainingTop, bottom: S.leggings, footwear: S.boots, wristwear: S.bracers }),
    tweaks: {},
    context: { activity: ['relax'], timeOfDay: ['morning', 'evening'] },
  },
  {
    id: 'preset.out',
    name: 'Out',
    equipped: eq({ top: S.shirt, bottom: S.trousers, outerwear: S.coat, footwear: S.boots, gloves: S.gloves }),
    tweaks: {},
    context: { activity: ['out'], weather: ['cold', 'snow', 'rain'] },
  },
  {
    id: 'preset.evening',
    name: 'Evening',
    equipped: eq({ fullBody: S.jumpsuit, footwear: S.boots, wristwear: S.bracers, earrings: S.earrings }),
    tweaks: {},
    context: { activity: ['relax', 'out'], timeOfDay: ['evening', 'night'] },
  },
  {
    id: 'preset.restful',
    name: 'Restful',
    equipped: eq({ top: S.trainingTop, bottom: S.leggings }),
    tweaks: {},
    context: { activity: ['sleep', 'relax'], timeOfDay: ['night'] },
  },
]
