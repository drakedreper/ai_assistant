import { z } from 'zod'
import { Asset, WardrobeSlot } from '@ai-assistant/shared'
import { licenceIssues } from './license'
import { isSafeId, isSafeKey } from '../util/safe'
import { checkParamDeclarations } from '../characters/adult-policy'
import { WEARABLE_KINDS } from '../core/equipped'

export const ASSET_MANIFEST_SCHEMA = 'mira-asset/1' as const

const PARAM_ID = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/
const TAG = /^[a-z0-9][a-z0-9:_-]{0,31}$/
export const COLOR_MAX = 0xffffff
/** Largest manifest (as JSON text) the catalog stores: room for a 256 KiB thumbnail data URI plus the metadata. */
export const MAX_MANIFEST_CHARS = 400_000
/** Slots that make up the clothed baseline: only an outfit may occupy them. */
export const BASELINE_SLOTS: readonly string[] = ['top', 'bottom', 'fullBody']
const PARAM_VALUE_LIMIT = 1e9

/**
 * asset.json: the shared `Asset` plus manifest-only fields. Conventions the schema enforces:
 *  - ids are short and path-safe; parameter ids are lowercase dotted names ("body.height_cm");
 *  - a colour parameter is declared with min 0, max 16777215 and the default as a 24-bit integer (0xRRGGBB);
 *  - wearables (hair, outfit, accessory) occupy at least one slot, everything else occupies none; the slots that make
 *    up the clothed baseline (top, bottom, fullBody) belong to outfits only, so an accessory cannot stand in for clothes;
 *  - a character_base fits at least one rig and carries the attestation `adult: true`, and its declared slider
 *    ranges must sit inside the adult envelope (characters/adult-policy.ts);
 *  - the adult envelope's parameter rules hold for EVERY kind: only a base declares a governed id, nobody declares an
 *    alias of one (the catalog adds the rules that depend on whether the owner vetted the asset);
 *  - sizes are bounded: at most 256 parameters, licence text and ids as in the shared schema, numbers within 1e9, and
 *    the whole manifest within MAX_MANIFEST_CHARS (a 40 MB manifest cannot be stored and resent in every snapshot).
 */
export const AssetManifest = Asset.extend({
  schema: z.literal(ASSET_MANIFEST_SCHEMA).default(ASSET_MANIFEST_SCHEMA),
  version: z.string().min(1).max(32).default('1.0.0'),
  description: z.string().max(400).optional(),
  author: z.string().max(120).optional(),
  /** Required (true) on character bases: every character in this system is an adult. */
  adult: z.boolean().optional(),
}).superRefine((a, ctx) => {
  const issue = (message: string, path: (string | number)[] = []): void => {
    ctx.addIssue({ code: 'custom', message, path })
  }
  if (!isSafeId(a.id)) issue('id must be 1-96 chars of letters, digits and "._:-", starting alphanumeric', ['id'])
  if (a.name.trim().length === 0 || a.name.length > 80) issue('name must be 1-80 characters', ['name'])
  if (a.tags.length > 24) issue('at most 24 tags', ['tags'])
  a.tags.forEach((t, i) => {
    if (!TAG.test(t)) issue(`tag "${t}" must be lowercase letters, digits, ":_-" (max 32)`, ['tags', i])
  })
  if (new Set(a.slots).size !== a.slots.length) issue('duplicate slots', ['slots'])
  if (new Set(a.hides).size !== a.hides.length) issue('duplicate hidden regions', ['hides'])
  if (new Set(a.rigFamilies).size !== a.rigFamilies.length) issue('duplicate rig families', ['rigFamilies'])
  if (a.variantOf !== undefined && (a.variantOf === a.id || !isSafeId(a.variantOf))) issue('variantOf must be a different, valid asset id', ['variantOf'])

  const wearable = (WEARABLE_KINDS as readonly string[]).includes(a.kind)
  if (wearable && a.slots.length === 0) issue(`a ${a.kind} must occupy at least one slot`, ['slots'])
  if (!wearable && a.slots.length > 0) issue(`a ${a.kind} cannot occupy wardrobe slots`, ['slots'])
  if (a.kind === 'hair' && !a.slots.every((s) => s === 'hair')) issue('hair assets occupy only the hair slot', ['slots'])
  if (a.kind !== 'outfit' && a.slots.some((s) => BASELINE_SLOTS.includes(s))) issue(`only an outfit can occupy the top, bottom or fullBody slot (a ${a.kind} cannot stand in for clothes)`, ['slots'])
  if (!wearable && a.hides.length > 0) issue(`a ${a.kind} cannot hide body regions`, ['hides'])
  if (a.slots.includes(WardrobeSlot.enum.fullBody) && a.slots.some((s) => s === 'top' || s === 'bottom')) {
    issue('a fullBody item replaces top and bottom; it does not also list them', ['slots'])
  }

  if (a.kind === 'character_base') {
    if (a.rigFamilies.length === 0) issue('a character base must declare the rig family it uses', ['rigFamilies'])
    if (a.adult !== true) issue('a character base must carry the attestation adult: true', ['adult'])
  }
  for (const v of checkParamDeclarations(a.kind, a.params)) issue(v, ['params'])

  const seen = new Set<string>()
  a.params.forEach((p, i) => {
    const at = ['params', i]
    if (!PARAM_ID.test(p.id) || !isSafeKey(p.id)) issue(`parameter id "${p.id}" must be lowercase dotted words`, [...at, 'id'])
    if (seen.has(p.id)) issue(`duplicate parameter id "${p.id}"`, [...at, 'id'])
    seen.add(p.id)
    if (![p.min, p.max, p.default].every(Number.isFinite)) issue('min, max and default must be finite numbers', at)
    else if ([p.min, p.max, p.default].some((v) => Math.abs(v) > PARAM_VALUE_LIMIT)) issue(`min, max and default must be within +-${PARAM_VALUE_LIMIT}`, at)
    else if (p.min > p.max) issue('min is greater than max', at)
    else if (p.default < p.min || p.default > p.max) issue('default is outside min..max', at)
    if (p.type === 'color') {
      if (p.min !== 0 || p.max !== COLOR_MAX || !Number.isInteger(p.default)) issue('a colour parameter uses min 0, max 16777215 and an integer default (0xRRGGBB)', at)
    }
  })

  for (const m of licenceIssues(a.license)) issue(m, ['license'])
})
export type AssetManifest = z.output<typeof AssetManifest>
export type AssetManifestInput = z.input<typeof AssetManifest>
