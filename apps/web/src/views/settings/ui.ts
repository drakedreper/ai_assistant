import { create } from 'zustand'

/**
 * View-local UI state for Settings. It lives in a module-level store because the shell re-mounts a view whenever you
 * leave and come back, and the chosen section, lane switches and snoozed promotions should survive that.
 * Domain data (persona, trust rules, privacy switches) stays in the snapshot and changes through the ApiClient.
 */
export type SettingsSection = 'persona' | 'claude' | 'integrations' | 'trust' | 'privacy' | 'audit' | 'memory'

export const SECTIONS: SettingsSection[] = ['persona', 'claude', 'integrations', 'trust', 'privacy', 'audit', 'memory']

/** Deep links from other screens may use friendlier names. */
const ALIASES: Record<string, SettingsSection> = {
  persona: 'persona',
  claude: 'claude',
  'claude-connection': 'claude',
  connection: 'claude',
  lanes: 'claude',
  integrations: 'integrations',
  trust: 'trust',
  'trust-ladder': 'trust',
  approvals: 'trust',
  privacy: 'privacy',
  audit: 'audit',
  'audit-log': 'audit',
  memory: 'memory',
}
export const toSection = (v: string | undefined): SettingsSection | undefined => (v ? ALIASES[v] : undefined)

interface SettingsUi {
  section: SettingsSection
  setSection: (s: SettingsSection) => void

  /** Lane enable switches are local in the mockup (the schema has no lane toggle call). */
  laneEnabled: Record<string, boolean>
  setLane: (id: string, on: boolean) => void

  /** Promotion banners the user answered "Not yet" to. */
  snoozedPromos: string[]
  snoozePromo: (ruleId: string) => void
}

export const useSettingsUi = create<SettingsUi>((set) => ({
  section: 'persona',
  setSection: (section) => set({ section }),

  laneEnabled: {},
  setLane: (id, on) => set((s) => ({ laneEnabled: { ...s.laneEnabled, [id]: on } })),

  snoozedPromos: [],
  snoozePromo: (ruleId) => set((s) => (s.snoozedPromos.includes(ruleId) ? s : { snoozedPromos: [...s.snoozedPromos, ruleId] })),
}))
