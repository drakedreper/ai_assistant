import { z } from 'zod'

/**
 * The assistant's tool surface, i.e. the in-process MCP servers the daemon will expose to Claude.
 * Defined now (with mock backends) so the persona chat, the trust ladder and the audit log are
 * designed around the real surface from day one.
 *
 * lane: which Claude lane may call it (Reader lane never gets write/send tools).
 * tier: autonomy tier of the action (T0 read freely .. T4 outward action, always an approval card until promoted).
 */
export interface ToolSpec {
  name: string
  server: 'brain' | 'calendar' | 'mail' | 'contacts' | 'finance' | 'worklog' | 'news' | 'stage'
  description: string
  lanes: ReadonlyArray<'secretary' | 'reader'>
  tier: 'T0' | 'T1' | 'T2' | 'T3' | 'T4'
  readOnly: boolean
  /** Never promotable to auto, whatever the trust history. */
  locked?: boolean
  input: z.ZodType
}

const q = z.object({ query: z.string(), limit: z.number().int().min(1).max(20).default(8) })

export const TOOL_SURFACE: ToolSpec[] = [
  // --- brain (second brain) ---
  { name: 'brain_search', server: 'brain', description: 'Hybrid search over the vault; returns cited snippets.', lanes: ['secretary', 'reader'], tier: 'T0', readOnly: true, input: q },
  { name: 'brain_read', server: 'brain', description: 'Read a note (optionally one section).', lanes: ['secretary', 'reader'], tier: 'T0', readOnly: true, input: z.object({ path: z.string(), section: z.string().optional() }) },
  { name: 'brain_list', server: 'brain', description: 'List notes by layer/type/status.', lanes: ['secretary', 'reader'], tier: 'T0', readOnly: true, input: z.object({ layer: z.string().optional(), type: z.string().optional(), status: z.string().optional() }) },
  { name: 'brain_today', server: 'brain', description: "Today's journal note and open loops.", lanes: ['secretary', 'reader'], tier: 'T0', readOnly: true, input: z.object({}) },
  { name: 'brain_journal_append', server: 'brain', description: 'Append to the daily journal (append-only).', lanes: ['secretary'], tier: 'T1', readOnly: false, input: z.object({ text: z.string() }) },
  { name: 'brain_capture', server: 'brain', description: 'Drop a raw capture into the inbox layer.', lanes: ['secretary'], tier: 'T1', readOnly: false, input: z.object({ text: z.string(), source: z.string().optional() }) },
  { name: 'brain_upsert_note', server: 'brain', description: 'Create/patch a knowledge or project note (str_replace semantics, git commit per write).', lanes: ['secretary'], tier: 'T2', readOnly: false, input: z.object({ path: z.string(), frontmatterPatch: z.record(z.string(), z.unknown()).optional(), bodyPatch: z.string().optional() }) },
  { name: 'brain_propose', server: 'brain', description: 'Propose a change to a core/strategy note. Never writes directly; you review the diff.', lanes: ['secretary'], tier: 'T3', readOnly: false, input: z.object({ targetPath: z.string(), rationale: z.string(), diff: z.array(z.string()) }) },
  // --- calendar / mail / contacts ---
  { name: 'calendar_agenda', server: 'calendar', description: 'Events in a date range.', lanes: ['secretary', 'reader'], tier: 'T0', readOnly: true, input: z.object({ from: z.string(), to: z.string() }) },
  { name: 'calendar_propose_event', server: 'calendar', description: 'Propose creating an event. Needs your approval.', lanes: ['secretary'], tier: 'T4', readOnly: false, input: z.object({ title: z.string(), start: z.string(), end: z.string() }) },
  { name: 'mail_search', server: 'mail', description: 'Search mail (snippets by default; full bodies on demand).', lanes: ['secretary', 'reader'], tier: 'T0', readOnly: true, input: q },
  { name: 'mail_draft_reply', server: 'mail', description: 'Create a draft reply. Sending is a separate approval.', lanes: ['secretary'], tier: 'T4', readOnly: false, input: z.object({ threadId: z.string(), body: z.string() }) },
  { name: 'mail_send', server: 'mail', description: 'Send a drafted email.', lanes: ['secretary'], tier: 'T4', readOnly: false, input: z.object({ draftId: z.string() }) },
  { name: 'contacts_find', server: 'contacts', description: 'Find people.', lanes: ['secretary', 'reader'], tier: 'T0', readOnly: true, input: z.object({ query: z.string() }) },
  // --- finance (Atlas), read-only ---
  { name: 'finance_summary', server: 'finance', description: 'Aggregates only: balances, category totals, upcoming bills, net worth.', lanes: ['secretary'], tier: 'T0', readOnly: true, input: z.object({ period: z.string().optional() }) },
  { name: 'finance_transactions', server: 'finance', description: 'Raw transactions, on demand and logged to the audit trail.', lanes: ['secretary'], tier: 'T1', readOnly: true, input: z.object({ since: z.string().optional(), accountId: z.string().optional(), limit: z.number().int().max(100).default(25) }) },
  { name: 'finance_move_money', server: 'finance', description: 'Not implemented in v0.x. Money movement is permanently locked.', lanes: [], tier: 'T4', readOnly: false, locked: true, input: z.object({}) },
  // --- worklog (agent dashboard) ---
  { name: 'worklog_status', server: 'worklog', description: 'Which Claude sessions are running / blocked / done, per project.', lanes: ['secretary', 'reader'], tier: 'T0', readOnly: true, input: z.object({ projectId: z.string().optional() }) },
  { name: 'worklog_create_task', server: 'worklog', description: 'Add a kanban card.', lanes: ['secretary'], tier: 'T2', readOnly: false, input: z.object({ title: z.string(), projectId: z.string().optional() }) },
  // --- news ---
  { name: 'news_briefing', server: 'news', description: 'Latest stored briefing items, re-ranked for you.', lanes: ['secretary', 'reader'], tier: 'T0', readOnly: true, input: z.object({ topic: z.string().optional() }) },
]

/**
 * Tools that let the assistant act on her own body and space. Kept apart from TOOL_SURFACE: the daemon merges the two
 * when it wires the Secretary lane. All are cosmetic and reversible (low tiers) and never touch the outside world.
 */
export const STAGE_TOOL_SURFACE: ToolSpec[] = [
  { name: 'stage_set_outfit', server: 'stage', description: 'Change what the assistant wears: a saved preset or specific items. The user can always override.', lanes: ['secretary'], tier: 'T1', readOnly: false, input: z.object({ presetId: z.string().optional(), slot: z.string().optional(), assetId: z.string().nullable().optional(), reason: z.string().optional() }) },
  { name: 'stage_set_scene', server: 'stage', description: 'Switch to a saved scene preset or place/move/remove an object in the space.', lanes: ['secretary'], tier: 'T1', readOnly: false, input: z.object({ presetId: z.string().optional(), op: z.enum(['add', 'update', 'remove']).optional(), objectId: z.string().optional(), assetId: z.string().optional() }) },
  { name: 'stage_gesture', server: 'stage', description: 'Perform a gesture from the animation library, shaped by her presence style.', lanes: ['secretary'], tier: 'T1', readOnly: false, input: z.object({ clip: z.string(), intensity: z.number().min(0).max(1).default(0.7) }) },
  { name: 'stage_camera', server: 'stage', description: 'Move the camera to a named shot (wide, medium, closeup, profile, back, over_shoulder).', lanes: ['secretary'], tier: 'T1', readOnly: false, input: z.object({ shot: z.string() }) },
  { name: 'character_remember', server: 'stage', description: 'Write a fact or moment to her persistent character memory (relationship, preference, episode).', lanes: ['secretary'], tier: 'T2', readOnly: false, input: z.object({ kind: z.enum(['episode', 'relationship', 'preference']), text: z.string().max(500), importance: z.number().int().min(1).max(5).default(2) }) },
  { name: 'stage_state', server: 'stage', description: 'Read her current look, mood, posture and the scene.', lanes: ['secretary', 'reader'], tier: 'T0', readOnly: true, input: z.object({}) },
]
