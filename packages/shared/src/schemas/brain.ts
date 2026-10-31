import { z } from 'zod'
import { Id, IsoDate, IsoDateTime, Provenance, Sensitivity } from './common'

/** Folder = layer. Layer 1 (core) is always in context; the rest is retrieved. */
export const BrainLayer = z.enum(['core', 'strategy', 'episodic', 'semantic', 'project', 'inbox'])
export type BrainLayer = z.infer<typeof BrainLayer>

export const NoteType = z.enum([
  'core',
  'strategy',
  'decision',
  'journal',
  'concept',
  'person',
  'org',
  'project',
  'source',
  'review',
  'reflection',
])
export type NoteType = z.infer<typeof NoteType>

/** Flat, Obsidian-Properties-safe frontmatter plus the markdown body. */
export const Note = z.object({
  id: Id,
  /** Vault-relative path, e.g. 10-strategy/q4-positioning.md */
  path: z.string(),
  title: z.string(),
  layer: BrainLayer,
  type: NoteType,
  status: z.enum(['draft', 'active', 'superseded', 'archived']),
  importance: z.number().int().min(1).max(5),
  confidence: z.enum(['low', 'medium', 'high']),
  provenance: Provenance,
  sensitivity: Sensitivity.default('normal'),
  tags: z.array(z.string()),
  created: IsoDateTime,
  updated: IsoDateTime,
  /** Where the note physically lives: our vault, or the federated Secondbrain app (read-only). */
  source: z.enum(['vault', 'secondbrain']).default('vault'),
  reviewAfter: IsoDate.optional(),
  /** Markdown with [[wikilinks]]. */
  body: z.string(),
})
export type Note = z.infer<typeof Note>

/** A requested change to a protected note (core/strategy). The assistant can only propose; you approve. */
export const Proposal = z.object({
  id: Id,
  targetPath: z.string(),
  title: z.string(),
  rationale: z.string(),
  /** Unified-diff-ish lines: prefix '+', '-' or ' '. */
  diff: z.array(z.string()),
  status: z.enum(['pending', 'approved', 'rejected']),
  createdAt: IsoDateTime,
  provenance: Provenance,
  evidence: z.array(z.object({ path: z.string(), title: z.string() })),
})
export type Proposal = z.infer<typeof Proposal>

/** One entry on the memory timeline: a nightly "dream", a weekly review, a triage run... */
export const MemoryEntry = z.object({
  id: Id,
  kind: z.enum(['dream', 'weekly_review', 'triage', 'capture', 'lint']),
  at: IsoDateTime,
  title: z.string(),
  summary: z.string(),
  /** Counts shown as chips, e.g. { created: 3, updated: 5, proposals: 1 } */
  stats: z.record(z.string(), z.number()),
  costUsd: z.number(),
  /** git commit that makes the job reversible. */
  commit: z.string().optional(),
})
export type MemoryEntry = z.infer<typeof MemoryEntry>
