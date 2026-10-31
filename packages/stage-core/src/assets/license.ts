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

const isUnknownLicence = (l: AssetLicense): boolean => {
  const id = l.id.trim().toLowerCase()
  return id === '' || id === 'unknown' || id === 'unlicensed' || id === 'none'
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
  if (l.id.trim() === '') out.push('licence id is empty (use "unknown" if it is not known)')
  if ((l.commercialUse || l.redistribution) && !l.personalUse) out.push('a licence that permits commercial use or redistribution must also permit personal use')
  return out
}
