import { rmSync } from 'node:fs'
import { buildSnapshot } from '@ai-assistant/shared/fixtures'
import { KV } from './snapshot'
import type { Store } from './store'

/** Delete the demo database and its WAL files. The demo runs on a disposable database so fixtures never mix with real data. */
export function resetDemoDb(file: string): void {
  if (file === ':memory:') return
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      rmSync(`${file}${suffix}`, { force: true })
    } catch {
      // A file still held open (Windows, a stale process) is not fatal: an already seeded database is simply reused.
    }
  }
}

/**
 * DEMO=1: load the fixture projects, sessions, tasks, approvals and events into the demo database, so the Work
 * screen is populated. Returns the fixture session ids (the staleness sweep leaves those alone).
 */
export function seedDemo(store: Store, now: Date): Set<string> {
  const fx = buildSnapshot(now)
  const ids = new Set(fx.sessions.map((s) => s.id))
  if (store.kvGet<boolean>(KV.demoSeeded)) return ids
  const at = now.toISOString()
  store.tx(() => {
    for (const p of fx.projects) store.upsertProject(p)
    for (const s of fx.sessions) store.upsertSession(s)
    for (const t of fx.tasks) store.insertTask(t, at)
    for (const a of fx.approvals) store.upsertApproval(a, 'demo')
    // Fixture events are newest first; insert oldest first so the store's order matches.
    for (const e of [...fx.events].reverse()) store.insertAgentEvent(e)
    store.kvSet(KV.demoSeeded, true, at)
  })
  return ids
}
