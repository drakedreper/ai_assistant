import type { BrainLayer, MemoryEntry, Note, NoteType, Proposal } from '../index'
import { ago, journalPath } from './time'

type Seed = {
  path: string
  title: string
  layer: BrainLayer
  type: NoteType
  importance: 1 | 2 | 3 | 4 | 5
  tags?: string[]
  source?: 'vault' | 'secondbrain'
  body: string
}

/** SEED. The Brain screen owner enriches bodies and adds links; paths below are contracts (see STORY.md). */
function seeds(now: Date): Seed[] {
  return [
    { path: '00-core/persona.md', title: 'Mira: persona', layer: 'core', type: 'core', importance: 5, tags: ['persona'], body: '# Mira\nWarm, playful partner and sharp secretary. See [[00-core/values]] and [[00-core/operating-rules]].' },
    { path: '00-core/values.md', title: 'Values and principles', layer: 'core', type: 'core', importance: 5, tags: ['values'], body: '# Values\n1. Build things that last.\n2. Protect deep work. See [[10-strategy/deep-work-system]].' },
    { path: '00-core/user-profile.md', title: 'About me', layer: 'core', type: 'core', importance: 5, body: '# About me\nIndependent builder. Working on [[40-projects/atlas/README]] and [[40-projects/assistant/README]].' },
    { path: '00-core/operating-rules.md', title: 'Operating rules', layer: 'core', type: 'core', importance: 5, body: '# Operating rules\nNever send, spend or delete without approval. Affection never authorises an action.' },
    { path: '10-strategy/q4-positioning.md', title: 'Q4 positioning: tools for independent builders', layer: 'strategy', type: 'strategy', importance: 5, tags: ['strategy', 'positioning'], body: '# Q4 positioning\nBe the local-first toolmaker. See [[30-knowledge/local-first-software]] and [[10-strategy/decision-atlas-beta]].' },
    { path: '10-strategy/financial-independence.md', title: 'Financial independence plan', layer: 'strategy', type: 'strategy', importance: 4, tags: ['money'], body: '# Financial independence\nTarget runway and savings rate. Tracked in [[40-projects/atlas/README]].' },
    { path: '10-strategy/deep-work-system.md', title: 'Deep-work system', layer: 'strategy', type: 'strategy', importance: 4, tags: ['focus'], body: '# Deep-work system\nTwo protected blocks per day, mornings first.' },
    { path: '10-strategy/decision-atlas-beta.md', title: 'Decision: ship the Atlas beta before December', layer: 'strategy', type: 'decision', importance: 5, tags: ['decision', 'atlas'], body: '# Decision\nShip the beta before December. Scope cut list lives in [[40-projects/atlas/README]].' },
    { path: journalPath(now, 0), title: 'Journal (today)', layer: 'episodic', type: 'journal', importance: 2, body: '# Today\n- Morning briefing read.\n- Blocked: [[40-projects/atlas/README]] migration needs approval.' },
    { path: journalPath(now, -1), title: 'Journal (yesterday)', layer: 'episodic', type: 'journal', importance: 2, body: '# Yesterday\nFinished the contract tests outline. Talked with [[30-knowledge/people/dana-reyes]].' },
    { path: journalPath(now, -2), title: 'Journal (two days ago)', layer: 'episodic', type: 'journal', importance: 2, body: '# Two days ago\nBenchmarked Kokoro on the RTX. See [[40-projects/assistant/README]].' },
    { path: '30-knowledge/local-first-software.md', title: 'Local-first software', layer: 'semantic', type: 'concept', importance: 4, tags: ['concept'], body: '# Local-first software\nData lives on the user\'s device. Related: [[30-knowledge/sqlite-wal]].' },
    { path: '30-knowledge/plaid-sync-pattern.md', title: 'Cursor-based transaction sync', layer: 'semantic', type: 'concept', importance: 3, tags: ['finance'], body: '# Cursor-based sync\nadded/modified/removed plus a cursor. Used by [[40-projects/atlas/README]].' },
    { path: '30-knowledge/sqlite-wal.md', title: 'SQLite WAL mode', layer: 'semantic', type: 'concept', importance: 3, tags: ['sqlite'], body: '# SQLite WAL\nReaders do not block the writer.' },
    { path: '30-knowledge/people/dana-reyes.md', title: 'Dana Reyes', layer: 'semantic', type: 'person', importance: 4, tags: ['person', 'mentor'], body: '# Dana Reyes\nMentor, ex-founder. Possible seed intro. Relevant to [[10-strategy/q4-positioning]].' },
    { path: '30-knowledge/people/leo-park.md', title: 'Leo Park', layer: 'semantic', type: 'person', importance: 3, tags: ['person'], body: '# Leo Park\nDesigner friend; helps with UI polish.' },
    { path: '30-knowledge/people/priya-nair.md', title: 'Priya Nair', layer: 'semantic', type: 'person', importance: 3, tags: ['person', 'client'], body: '# Priya Nair\nClient for [[40-projects/site/README]].' },
    { path: '40-projects/atlas/README.md', title: 'Project: Atlas (finance app)', layer: 'project', type: 'project', importance: 5, tags: ['project'], body: '# Atlas\nLocal personal-finance app. Beta goal: [[10-strategy/decision-atlas-beta]].' },
    { path: '40-projects/assistant/README.md', title: 'Project: ai_assistant', layer: 'project', type: 'project', importance: 5, tags: ['project'], body: '# ai_assistant\nThis app. Strategy: [[10-strategy/q4-positioning]].' },
    { path: '40-projects/site/README.md', title: 'Project: portfolio-site', layer: 'project', type: 'project', importance: 3, tags: ['project'], body: '# portfolio-site\nClient work for [[30-knowledge/people/priya-nair]].' },
    { path: '40-projects/homelab/README.md', title: 'Project: home-lab', layer: 'project', type: 'project', importance: 2, tags: ['project'], body: '# home-lab\nCerts, backups, self-hosted services.' },
    { path: '50-inbox/idea-voice-capture.md', title: 'Idea: voice "remember this" capture', layer: 'inbox', type: 'source', importance: 2, body: 'Say "remember this" and she files it into the inbox. Related: [[40-projects/assistant/README]].' },
    { path: 'secondbrain/atlas-planning-recap.md', title: 'Atlas planning meeting recap (Secondbrain)', layer: 'semantic', type: 'review', importance: 3, source: 'secondbrain', tags: ['federated'], body: '# Recap\nFederated, read-only. Action items feed [[10-strategy/decision-atlas-beta]].' },
    { path: 'secondbrain/weekly-tasks.md', title: 'Weekly tasks (Secondbrain)', layer: 'semantic', type: 'review', importance: 2, source: 'secondbrain', tags: ['federated'], body: '# Weekly tasks\nFederated, read-only.' },
  ]
}

export function buildNotes(now: Date): Note[] {
  return seeds(now).map((s, i) => ({
    id: `note-${i + 1}`,
    path: s.path,
    title: s.title,
    layer: s.layer,
    type: s.type,
    status: 'active',
    importance: s.importance,
    confidence: 'high',
    provenance: s.source === 'secondbrain' ? 'federated' : s.layer === 'episodic' ? 'assistant' : 'user',
    sensitivity: 'normal',
    tags: s.tags ?? [],
    created: ago(now, 60 * 24 * (30 - i)),
    updated: ago(now, 60 * 3 * (i + 1)),
    source: s.source ?? 'vault',
    body: s.body,
  }))
}

export function buildProposals(now: Date): Proposal[] {
  return [
    {
      id: 'pr-q4',
      targetPath: '10-strategy/q4-positioning.md',
      title: 'Narrow the Q4 positioning to "local-first tools for independent builders"',
      rationale: 'Three weeks of journal entries and the Dana call point to a tighter wedge than the current wording.',
      diff: ['@@ Positioning', '-Be a general productivity toolmaker.', '+Be the local-first toolmaker for independent builders.', ' Keep shipping weekly.'],
      status: 'pending',
      createdAt: ago(now, 55),
      provenance: 'dream',
      evidence: [
        { path: journalPath(now, -1), title: 'Journal (yesterday)' },
        { path: '30-knowledge/people/dana-reyes.md', title: 'Dana Reyes' },
      ],
    },
  ]
}

export function buildMemory(now: Date): MemoryEntry[] {
  return [
    { id: 'mem-dream', kind: 'dream', at: ago(now, 60 * 5), title: 'Nightly dream', summary: 'Compressed yesterday, merged 2 duplicate concept notes, proposed 1 strategy edit.', stats: { created: 1, updated: 4, proposals: 1 }, costUsd: 0.08, commit: 'a1b2c3d' },
    { id: 'mem-weekly', kind: 'weekly_review', at: ago(now, 60 * 24 * 5), title: 'Weekly review', summary: 'Progress against Q4 positioning, two stale projects surfaced.', stats: { reflections: 3, openLoops: 6 }, costUsd: 0.21, commit: 'e4f5a6b' },
  ]
}
