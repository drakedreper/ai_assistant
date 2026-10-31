/**
 * SEED CATALOG: metadata only. No binary ships with it; locators are placeholders a content pack fills in.
 *
 * Content rules (docs, hard rules 7): every base is an adult character with slider ranges that sit inside the adult
 * envelope; wardrobe is tasteful, professional or athletic (tailored dark pieces, structured outerwear, training
 * wear, understated metal accents); nothing revealing exists here, and the default outfit is fully clothed.
 *
 * The licence records below are PLACEHOLDERS for metadata-only entries. The third-party rig families carry
 * deliberately conservative flags pending verification of the real terms of whatever pack is installed.
 */
import type { Asset, AssetLicense, MorphParam, RigFamily, WardrobeSlot, BodyRegion } from '@ai-assistant/shared'
import { COLOR_MAX } from './manifest'
import type { AssetManifestInput } from './manifest'
import { createAssetCatalog } from './catalog'
import type { AssetCatalog, AssetCatalogOptions } from './catalog'

const RIGS: readonly RigFamily[] = ['vrm1', 'metahuman', 'cc5']

const FIRST_PARTY: AssetLicense = {
  id: 'first-party-placeholder',
  source: 'project seed metadata',
  personalUse: true,
  commercialUse: true,
  redistribution: true,
  adultExpression: false,
  notes: 'Seed metadata only, no binary ships. A real asset must carry its own licence record.',
}

const THIRD_PARTY_PENDING: AssetLicense = {
  id: 'third-party-pending',
  source: 'placeholder for the installed content pack',
  personalUse: true,
  commercialUse: false,
  redistribution: false,
  adultExpression: false,
  notes: 'Conservative placeholder: verify the real terms of the content pack before any use beyond personal.',
}

const scalar = (id: string, group: MorphParam['group'], label: string, min: number, max: number, def: number): MorphParam => ({ id, group, label, min, max, default: def, type: 'scalar' })
const color = (id: string, group: MorphParam['group'], label: string, rgb: number): MorphParam => ({ id, group, label, min: 0, max: COLOR_MAX, default: rgb, type: 'color' })

export interface BaseTraits {
  heightCm: number
  muscle: number
  shoulder: number
  jaw: number
  age: number
}

/**
 * The slider set every seed base exposes. Governed axes (see characters/adult-policy.ts) are declared with ranges that
 * are STRICTLY INSIDE the adult envelope, and the worst combination of the declared ranges stays under the combined
 * limit (checked by tests), so no slider position can produce a childlike figure.
 */
export function seedBaseParams(t: BaseTraits): MorphParam[] {
  return [
    scalar('face.apparent_age', 'face', 'Apparent age (years)', 28, 58, t.age),
    scalar('face.width', 'face', 'Face width', -0.5, 0.5, 0),
    scalar('face.jaw_definition', 'face', 'Jaw definition', 0.4, 1, t.jaw),
    scalar('face.roundness', 'face', 'Face roundness', -0.4, 0.25, -0.1),
    scalar('face.cheekbone_height', 'face', 'Cheekbone height', -0.5, 0.5, 0.15),
    scalar('face.brow_ridge', 'face', 'Brow definition', 0.15, 1, 0.55),
    scalar('face.chin_length', 'face', 'Chin length', -0.4, 0.5, 0.05),
    scalar('eyes.size', 'eyes', 'Eye size', -0.3, 0.25, -0.05),
    scalar('eyes.spacing', 'eyes', 'Eye spacing', -0.5, 0.5, 0),
    scalar('eyes.tilt', 'eyes', 'Eye tilt', -0.5, 0.5, 0.1),
    color('eyes.iris_color', 'eyes', 'Iris colour', 0x4a5a6a),
    scalar('nose.bridge_height', 'nose', 'Nose bridge height', -0.5, 0.5, 0.1),
    scalar('nose.width', 'nose', 'Nose width', -0.5, 0.5, 0),
    scalar('mouth.width', 'mouth', 'Mouth width', -0.5, 0.5, 0),
    scalar('mouth.lip_fullness', 'mouth', 'Lip fullness', -0.5, 0.6, 0.05),
    scalar('body.height_cm', 'body', 'Height (cm)', 162, 190, t.heightCm),
    scalar('body.head_scale', 'body', 'Head scale', 0.92, 0.99, 0.96),
    scalar('body.leg_length', 'body', 'Leg length', 0, 0.7, 0.3),
    scalar('body.shoulder_width', 'body', 'Shoulder width', -0.1, 0.7, t.shoulder),
    scalar('body.muscle_tone', 'body', 'Muscle tone', 0, 1, t.muscle),
    scalar('body.waist_width', 'body', 'Waist width', -0.5, 0.5, -0.05),
    scalar('body.hip_width', 'body', 'Hip width', -0.5, 0.5, 0),
    scalar('body.arm_length', 'body', 'Arm length', -0.4, 0.5, 0.05),
    scalar('body.neck_length', 'body', 'Neck length', -0.4, 0.5, 0.1),
    color('skin.tone', 'skin', 'Skin tone', 0xc89f87),
    scalar('skin.freckles', 'skin', 'Freckles', 0, 0.6, 0),
    color('hair.color', 'hair', 'Hair colour', 0x2a1e18),
    color('hair.highlight', 'hair', 'Hair highlight', 0x6b4a36),
    color('makeup.lip_color', 'makeup', 'Lip colour', 0x6a2f3a),
    scalar('makeup.eye_definition', 'makeup', 'Eye definition', 0, 1, 0.35),
  ]
}

const BASE_TRAITS: ReadonlyArray<{ key: string; name: string; traits: BaseTraits; tags: string[] }> = [
  { key: 'composed', name: 'Composed athletic', traits: { heightCm: 177, muscle: 0.6, shoulder: 0.4, jaw: 0.72, age: 34 }, tags: ['athletic', 'composed'] },
  { key: 'poised', name: 'Poised lean', traits: { heightCm: 170, muscle: 0.4, shoulder: 0.25, jaw: 0.65, age: 37 }, tags: ['lean', 'poised'] },
]

const RIG_LOCATOR: Record<string, (key: string) => string> = {
  vrm1: (k) => `bases/vrm1/${k}.vrm`,
  metahuman: (k) => `bases/metahuman/${k}`,
  cc5: (k) => `bases/cc5/${k}`,
}

function bases(): Asset[] {
  const out: Asset[] = []
  for (const rig of RIGS) {
    for (const b of BASE_TRAITS) {
      out.push({
        id: `base.${rig}.${b.key}`,
        kind: 'character_base',
        name: `${b.name} (${rig})`,
        tags: ['adult', ...b.tags],
        rigFamilies: [rig],
        locator: RIG_LOCATOR[rig]!(b.key),
        slots: [],
        hides: [],
        params: seedBaseParams(b.traits),
        license: rig === 'vrm1' ? FIRST_PARTY : THIRD_PARTY_PENDING,
        // manifest-only attestation, carried through the catalog
        ...({ adult: true } as object),
      } as Asset)
    }
  }
  return out
}

const HAIR_STYLES: ReadonlyArray<{ key: string; name: string }> = [
  { key: 'low-braid', name: 'Low braid' },
  { key: 'sleek-tail', name: 'Sleek low ponytail' },
  { key: 'short-crop', name: 'Short textured crop' },
]

function hair(): Asset[] {
  const out: Asset[] = []
  for (const rig of RIGS) {
    for (const h of HAIR_STYLES) {
      out.push({
        id: `hair.${rig}.${h.key}`,
        kind: 'hair',
        name: `${h.name} (${rig})`,
        tags: ['hair', h.key],
        rigFamilies: [rig],
        locator: `hair/${rig}/${h.key}`,
        slots: ['hair'],
        hides: [],
        params: [scalar('hair.shine', 'hair', 'Shine', 0, 1, 0.5), color('hair.tint', 'hair', 'Tint', 0x2a1e18)],
        license: rig === 'vrm1' ? FIRST_PARTY : THIRD_PARTY_PENDING,
      })
    }
  }
  return out
}

interface WearSpec {
  id: string
  kind: 'outfit' | 'accessory'
  name: string
  slots: WardrobeSlot[]
  hides: BodyRegion[]
  tags: string[]
  colorDefault?: number
}

const WEAR: readonly WearSpec[] = [
  { id: 'outfit.tailored-blazer', kind: 'outfit', name: 'Tailored blazer', slots: ['outerwear'], hides: ['torso', 'arms'], tags: ['tailored', 'dark', 'formal', 'work', 'meeting'], colorDefault: 0x1c2230 },
  { id: 'outfit.structured-coat', kind: 'outfit', name: 'Structured long coat', slots: ['outerwear'], hides: ['torso', 'arms', 'legs'], tags: ['structured', 'dark', 'outerwear', 'cold', 'out'], colorDefault: 0x161a22 },
  { id: 'outfit.training-top', kind: 'outfit', name: 'Athletic training top', slots: ['top'], hides: ['torso', 'arms'], tags: ['athletic', 'training', 'relax'], colorDefault: 0x20242c },
  { id: 'outfit.training-leggings', kind: 'outfit', name: 'Athletic training leggings', slots: ['bottom'], hides: ['legs'], tags: ['athletic', 'training', 'relax'], colorDefault: 0x1a1d24 },
  { id: 'outfit.crisp-shirt', kind: 'outfit', name: 'Crisp shirt', slots: ['top'], hides: ['torso', 'arms', 'neck'], tags: ['tailored', 'shirt', 'work', 'baseline'], colorDefault: 0xd9dde6 },
  { id: 'outfit.tailored-trousers', kind: 'outfit', name: 'Tailored trousers', slots: ['bottom'], hides: ['legs'], tags: ['tailored', 'dark', 'work', 'baseline'], colorDefault: 0x1a1e29 },
  { id: 'outfit.ankle-boots', kind: 'outfit', name: 'Ankle boots', slots: ['footwear'], hides: ['feet'], tags: ['boots', 'dark', 'baseline'], colorDefault: 0x15171c },
  { id: 'outfit.utility-jumpsuit', kind: 'outfit', name: 'Structured utility jumpsuit', slots: ['fullBody'], hides: ['torso', 'arms', 'legs'], tags: ['structured', 'dark', 'athletic', 'evening'], colorDefault: 0x1b1f27 },
  { id: 'accessory.metal-bracers', kind: 'accessory', name: 'Understated metal bracers', slots: ['wristwear'], hides: [], tags: ['metal', 'understated', 'athletic'] },
  { id: 'accessory.leather-gloves', kind: 'accessory', name: 'Fitted leather gloves', slots: ['gloves'], hides: ['hands'], tags: ['leather', 'dark', 'out'], colorDefault: 0x14161b },
  { id: 'accessory.simple-earrings', kind: 'accessory', name: 'Simple metal earrings', slots: ['earrings'], hides: [], tags: ['metal', 'understated'] },
]

function wardrobe(): Asset[] {
  return WEAR.map((w) => ({
    id: w.id,
    kind: w.kind,
    name: w.name,
    tags: w.tags,
    rigFamilies: [...RIGS],
    locator: `wardrobe/${w.id.split('.')[1]}`,
    slots: w.slots,
    hides: w.hides,
    params: w.colorDefault !== undefined ? [color('color', 'other', 'Colour', w.colorDefault), scalar('fit', 'other', 'Fit', -0.3, 0.3, 0)] : [scalar('polish', 'other', 'Polish', 0, 1, 0.5)],
    license: FIRST_PARTY,
  }))
}

function world(): Asset[] {
  return [
    {
      id: 'env.cerebral-void',
      kind: 'environment',
      name: 'Cerebral void',
      tags: ['void', 'dark', 'default'],
      rigFamilies: [],
      locator: 'environments/cerebral-void',
      slots: [],
      hides: [],
      params: [],
      license: FIRST_PARTY,
    },
    {
      id: 'prop.lounge-chair',
      kind: 'prop',
      name: 'Lounge chair',
      tags: ['furniture', 'seat'],
      rigFamilies: [],
      locator: 'props/lounge-chair',
      slots: [],
      hides: [],
      params: [],
      license: FIRST_PARTY,
    },
    {
      id: 'prop.data-plinth',
      kind: 'prop',
      name: 'Data plinth',
      tags: ['furniture', 'display'],
      rigFamilies: [],
      locator: 'props/data-plinth',
      slots: [],
      hides: [],
      params: [],
      license: FIRST_PARTY,
    },
  ]
}

/** All seed entries (raw manifests: validate through AssetCatalog.add). */
export const SEED_ASSETS: readonly Asset[] = [...bases(), ...hair(), ...wardrobe(), ...world()]

export const SEED_IDS = {
  void: 'env.cerebral-void',
  chair: 'prop.lounge-chair',
  plinth: 'prop.data-plinth',
  blazer: 'outfit.tailored-blazer',
  coat: 'outfit.structured-coat',
  trainingTop: 'outfit.training-top',
  leggings: 'outfit.training-leggings',
  shirt: 'outfit.crisp-shirt',
  trousers: 'outfit.tailored-trousers',
  boots: 'outfit.ankle-boots',
  jumpsuit: 'outfit.utility-jumpsuit',
  bracers: 'accessory.metal-bracers',
  gloves: 'accessory.leather-gloves',
  earrings: 'accessory.simple-earrings',
} as const

export function seedBaseId(rig: RigFamily, key: 'composed' | 'poised' = 'composed'): string {
  return `base.${rig}.${key}`
}

/** A catalog preloaded with the seed entries. Throws if a seed entry is invalid (a bug in this file, covered by tests). */
export function createSeedCatalog(options: AssetCatalogOptions = {}): AssetCatalog {
  return createAssetCatalog(options, SEED_ASSETS as unknown as AssetManifestInput[])
}
