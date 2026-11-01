import type { Asset, AssetLicense } from '@ai-assistant/shared'

export type UseIntent = 'personal' | 'commercial' | 'redistribute'

export interface UseOptions {
  /**
   * The use involves sexual or violent expression with this asset (a romantic persona mode, for example). The
   * author's `adultExpression` flag must then be explicitly true: false or unknown refuses. The default (ordinary
   * professional use) does not need it.
   */
  adultExpression?: boolean
}

export interface UseDecision {
  ok: boolean
  /** Why it was refused (empty when ok). Written for the user. */
  reasons: string[]
  /** Not blocking, but worth showing (e.g. a licence with revenue thresholds in its notes). */
  warnings: string[]
}

/**
 * Licence ids that say nothing: "unknown" and its synonyms, placeholders ("tbd", "n/a", "?"), and descriptions that are
 * not a licence ("proprietary", "all rights reserved", "no licence", "other", "custom"). Compared after normalisation.
 */
const UNKNOWN_LICENCE_IDS: ReadonlySet<string> = new Set([
  'unknown', 'unlicensed', 'unlicenced', 'none', 'na', 'nil', 'null', 'undefined', 'tbd', 'tba', 'todo', 'unspecified', 'unstated', 'notspecified', 'notstated', 'notapplicable', 'other', 'custom', 'proprietary',
  'allrightsreserved', 'nolicense', 'nolicence', 'nolicenseincluded', 'nolicenceincluded', 'unlicensedcontent',
])

/**
 * The licence id as it is compared: NFKC (a fullwidth "ｕｎｋｎｏｗｎ" becomes "unknown"), invisible and control characters
 * (zero-width spaces, BOM, NUL, bidi marks) and all whitespace removed, lower-cased, punctuation dropped. Exported for tests.
 */
export function normaliseLicenceId(id: unknown): string {
  if (typeof id !== 'string') return ''
  return id
    .normalize('NFKC')
    .replace(/[\p{Cc}\p{Cf}\p{Z}]+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}?]+/gu, '')
}

const isUnknownLicence = (l: AssetLicense): boolean => {
  const id = normaliseLicenceId(l.id)
  // empty after normalisation ("", "-", "/", "..."), nothing but question marks, or one of the words above
  return id === '' || /^\?+$/.test(id) || UNKNOWN_LICENCE_IDS.has(id)
}

/**
 * Licence enforcement. The backend calls this before it equips, places, publishes or shares an asset.
 * - An unknown or unlicensed record refuses EVERY intent.
 * - Each intent needs its own explicit `true` flag; there is no inheritance between them.
 */
export function canUse(asset: Pick<Asset, 'id' | 'name' | 'license'>, intent: UseIntent, options: UseOptions = {}): UseDecision {
  const l = asset.license
  const reasons: string[] = []
  const warnings: string[] = []
  const label = asset.name || asset.id

  if (isUnknownLicence(l)) {
    reasons.push(`"${label}" has an unknown licence, so it is refused for ${intent} use`)
  } else {
    const flag = intent === 'personal' ? l.personalUse : intent === 'commercial' ? l.commercialUse : l.redistribution
    if (flag !== true) {
      const what = intent === 'personal' ? 'personal use' : intent === 'commercial' ? 'commercial use' : 'redistribution'
      reasons.push(`The licence (${l.id}) of "${label}" does not permit ${what}`)
    }
  }

  if (options.adultExpression) {
    if (l.adultExpression !== true) {
      reasons.push(
        l.adultExpression === false
          ? `The author of "${label}" forbids sexual or violent expression with this model`
          : `"${label}" does not state that sexual or violent expression is permitted, so it is refused for that use`,
      )
    }
  }

  if (reasons.length === 0 && l.notes) warnings.push(l.notes)
  return { ok: reasons.length === 0, reasons, warnings }
}

/** True when the licence record is internally coherent (commercial or redistribution without personal use is not). */
export function licenceIssues(l: AssetLicense): string[] {
  const out: string[] = []
  if (typeof l.id !== 'string' || l.id.trim() === '') out.push('licence id is empty (use "unknown" if it is not known)')
  if ((l.commercialUse || l.redistribution) && !l.personalUse) out.push('a licence that permits commercial use or redistribution must also permit personal use')
  return out
}
