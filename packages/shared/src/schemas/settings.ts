import { z } from 'zod'
import { Id, IsoDateTime, Sensitivity } from './common'

export const Persona = z.object({
  name: z.string(),
  /** Short tagline shown under her name. */
  tagline: z.string(),
  /** 0..100 sliders; they compile into the persona prompt (data, not code). */
  vibe: z.object({
    warmth: z.number().min(0).max(100),
    playfulness: z.number().min(0).max(100),
    directness: z.number().min(0).max(100),
    proactivity: z.number().min(0).max(100),
  }),
  /** Plain-language boundaries she must always respect. */
  boundaries: z.array(z.string()),
  quietHours: z.object({ from: z.string(), to: z.string() }),
  voice: z.object({
    provider: z.enum(['kokoro', 'elevenlabs', 'off']),
    voiceName: z.string(),
    pushToTalk: z.boolean(),
  }),
})
export type Persona = z.infer<typeof Persona>

export const ClaudeConnection = z.object({
  /** api-key = terms-safe default; local-login = drives your own logged-in binary (personal use, grey zone). */
  mode: z.enum(['api-key', 'local-login']),
  status: z.enum(['connected', 'degraded', 'disconnected']),
  daemon: z.enum(['online', 'offline']),
  sdkVersion: z.string(),
  lanes: z.array(
    z.object({
      id: z.enum(['secretary', 'reader', 'voice']),
      model: z.string(),
      effort: z.enum(['low', 'medium', 'high']),
      enabled: z.boolean(),
      dailyBudgetUsd: z.number(),
      spentTodayUsd: z.number(),
    }),
  ),
  globalDailyCapUsd: z.number(),
})
export type ClaudeConnection = z.infer<typeof ClaudeConnection>

export const IntegrationStatus = z.object({
  id: Id,
  name: z.string(),
  kind: z.enum(['claude', 'calendar', 'mail', 'contacts', 'news', 'weather', 'finance', 'brain', 'voice']),
  state: z.enum(['connected', 'mock', 'needs_auth', 'off']),
  detail: z.string(),
  /** What leaves the PC through this integration. */
  dataLeaves: z.string(),
})
export type IntegrationStatus = z.infer<typeof IntegrationStatus>

/** Autonomy tiers. T0 read freely .. T4 outward actions. Rules promote action types up the ladder over time. */
export const TrustRule = z.object({
  id: Id,
  action: z.string(),
  description: z.string(),
  tier: z.enum(['T0', 'T1', 'T2', 'T3', 'T4']),
  mode: z.enum(['ask', 'auto']),
  /** Hard limit: can never be promoted to auto. */
  locked: z.boolean(),
  /** Why it is locked, shown next to the lock. */
  lockReason: z.string().optional(),
  approvals: z.number().int(),
  rejections: z.number().int(),
  /** Offered when approvals pile up with zero rejections. */
  promotionSuggested: z.boolean(),
})
export type TrustRule = z.infer<typeof TrustRule>

export const AuditEntry = z.object({
  id: Id,
  at: IsoDateTime,
  actor: z.enum(['you', 'mira', 'agent', 'job']),
  action: z.string(),
  target: z.string(),
  outcome: z.enum(['approved', 'denied', 'auto', 'blocked']),
  /** What was sent to the cloud model, if anything. */
  sentToCloud: z.string().optional(),
  /** Why it was blocked, or any other one-line context. */
  detail: z.string().optional(),
  /** The target names private content (mail, money, intimate memory): blurred in Guest mode. */
  sensitive: z.boolean().optional(),
})
export type AuditEntry = z.infer<typeof AuditEntry>

export const PrivacyFlow = z.object({
  id: Id,
  source: z.string(),
  sensitivity: Sensitivity,
  leavesPc: z.boolean(),
  policy: z.string(),
})
export type PrivacyFlow = z.infer<typeof PrivacyFlow>

export const SettingsSnapshot = z.object({
  persona: Persona,
  claude: ClaudeConnection,
  integrations: z.array(IntegrationStatus),
  trustRules: z.array(TrustRule),
  audit: z.array(AuditEntry),
  privacy: z.array(PrivacyFlow),
  guestMode: z.boolean(),
  webcam: z.object({ enabled: z.boolean(), retention: z.literal('none') }),
  /** The second brain on disk (display only). */
  vault: z
    .object({ path: z.string(), commits: z.number().int(), lastCommitAt: IsoDateTime })
    .optional(),
})
export type SettingsSnapshot = z.infer<typeof SettingsSnapshot>
