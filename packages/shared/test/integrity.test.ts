import { describe, expect, it } from 'vitest'
import { buildSnapshot } from '../src/fixtures'
import { Snapshot, TOOL_SURFACE } from '../src'

const snap = buildSnapshot(new Date('2026-11-02T08:15:00'))

describe('fixtures', () => {
  it('validate against the Snapshot schema', () => {
    const r = Snapshot.safeParse(snap)
    if (!r.success) console.error(JSON.stringify(r.error.issues.slice(0, 10), null, 2))
    expect(r.success).toBe(true)
  })

  it('every cited note path exists in the vault', () => {
    const paths = new Set(snap.notes.map((n) => n.path))
    const cited: Array<[string, string]> = []
    for (const t of snap.briefing.threads) for (const c of t.cites) cited.push([`briefing:${t.id}`, c.path])
    for (const f of snap.learned) cited.push([`learned:${f.id}`, f.source.path])
    for (const n of snap.world.news) if (n.relevance.note) cited.push([`news:${n.id}`, n.relevance.note.path])
    for (const e of snap.calendar) if (e.relatedNote) cited.push([`event:${e.id}`, e.relatedNote.path])
    for (const p of snap.proposals) {
      cited.push([`proposal:${p.id}`, p.targetPath])
      for (const ev of p.evidence) cited.push([`proposal:${p.id}:evidence`, ev.path])
    }
    for (const c of snap.contacts) if (c.notePath) cited.push([`contact:${c.id}`, c.notePath])
    for (const p of snap.projects) if (p.hubNote) cited.push([`project:${p.id}`, p.hubNote])
    for (const m of snap.chat) for (const part of m.parts) if (part.type === 'note') cited.push([`chat:${m.id}`, part.note.path])
    const missing = cited.filter(([, p]) => !paths.has(p))
    expect(missing).toEqual([])
  })

  it('every [[wikilink]] in a note resolves to a note', () => {
    const keys = new Set<string>()
    for (const n of snap.notes) {
      keys.add(n.path.replace(/\.md$/, ''))
    }
    const broken: string[] = []
    for (const n of snap.notes) {
      for (const m of n.body.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)) {
        const target = (m[1] ?? '').trim().replace(/\.md$/, '')
        if (!keys.has(target)) broken.push(`${n.path} -> ${target}`)
      }
    }
    expect(broken).toEqual([])
  })

  it('ids cross-reference correctly', () => {
    const projects = new Set(snap.projects.map((p) => p.id))
    const sessions = new Set(snap.sessions.map((s) => s.id))
    const approvals = new Set(snap.approvals.map((a) => a.id))
    const mail = new Set(snap.mail.map((m) => m.id))
    expect(snap.sessions.filter((s) => !projects.has(s.projectId))).toEqual([])
    expect(snap.tasks.filter((t) => t.projectId && !projects.has(t.projectId))).toEqual([])
    expect(snap.tasks.flatMap((t) => t.sessionIds).filter((id) => !sessions.has(id))).toEqual([])
    expect(snap.approvals.filter((a) => a.sessionId && !sessions.has(a.sessionId))).toEqual([])
    expect(snap.mail.filter((m) => m.approvalId && !approvals.has(m.approvalId))).toEqual([])
    expect(snap.events.filter((e) => !sessions.has(e.sessionId))).toEqual([])
    for (const m of snap.chat) for (const p of m.parts) if (p.type === 'approval') expect(approvals.has(p.approvalId)).toBe(true)
    expect(mail.has('m-priya')).toBe(true)
  })

  it('story contract ids exist', () => {
    const must = ['s-daemon', 's-migrate', 's-contract-tests', 's-a11y', 's-certs', 's-kokoro']
    const have = new Set(snap.sessions.map((s) => s.id))
    expect(must.filter((id) => !have.has(id))).toEqual([])
    const ap = new Set(snap.approvals.map((a) => a.id))
    expect(['ap-rm-backup', 'ap-reply-priya', 'ap-q4-proposal', 'ap-focus-block'].filter((id) => !ap.has(id))).toEqual([])
  })

  it('atlas is not connected in the mockup and money is read-only', () => {
    expect(snap.finance.connected).toBe(false)
    const move = TOOL_SURFACE.find((t) => t.name === 'finance_move_money')
    expect(move?.locked).toBe(true)
    expect(move?.lanes).toEqual([])
  })

  it('tool names are unique and the reader lane has no write tools', () => {
    const names = TOOL_SURFACE.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
    const readerWrites = TOOL_SURFACE.filter((t) => t.lanes.includes('reader') && !t.readOnly)
    expect(readerWrites).toEqual([])
  })
})
