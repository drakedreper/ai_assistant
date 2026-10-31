import { beforeAll, describe, expect, it } from 'vitest'
import { TOOL_SURFACE } from '@ai-assistant/shared'
import type { Snapshot, ToolBinding } from '@ai-assistant/shared'
import { buildSnapshot } from '@ai-assistant/shared/fixtures'
import { createMockToolBindings } from '../src'
import { NOW } from './helpers'

let bindings: ToolBinding[]
let by: Record<string, ToolBinding>
let snap: Snapshot

beforeAll(() => {
  snap = buildSnapshot(NOW)
  bindings = createMockToolBindings({ now: () => NOW, snapshot: snap })
  by = Object.fromEntries(bindings.map((b) => [b.spec.name, b]))
})

const call = async (name: string, input: unknown = {}) => by[name]!.handler(input)

describe('surface coverage', () => {
  it('has exactly one binding per TOOL_SURFACE entry, with the same spec', () => {
    expect(bindings.map((b) => b.spec.name)).toEqual(TOOL_SURFACE.map((s) => s.name))
    for (const b of bindings) expect(b.spec).toBe(TOOL_SURFACE.find((s) => s.name === b.spec.name))
  })

  it('every non-locked tool answers a valid minimal input without an error', async () => {
    const minimal: Record<string, unknown> = {
      brain_search: { query: 'positioning' },
      brain_read: { path: '10-strategy/q4-positioning.md' },
      brain_list: {},
      brain_today: {},
      brain_journal_append: { text: 'hello' },
      brain_capture: { text: 'idea' },
      brain_upsert_note: { path: '30-knowledge/x.md', bodyPatch: 'x' },
      brain_propose: { targetPath: '10-strategy/q4-positioning.md', rationale: 'because', diff: ['+x'] },
      calendar_agenda: { from: '2026-11-02', to: '2026-11-02' },
      calendar_propose_event: { title: 'Focus', start: '2026-11-05T09:00:00', end: '2026-11-05T11:00:00' },
      mail_search: { query: 'priya' },
      mail_draft_reply: { threadId: 'm-priya', body: 'Hi Priya' },
      mail_send: { draftId: 'd-1' },
      contacts_find: { query: 'dana' },
      finance_summary: {},
      finance_transactions: {},
      worklog_status: {},
      worklog_create_task: { title: 'Do the thing' },
      news_briefing: {},
    }
    for (const spec of TOOL_SURFACE.filter((s) => !s.locked)) {
      const r = await by[spec.name]!.handler(minimal[spec.name])
      expect(r.isError, `${spec.name}: ${r.text}`).toBeFalsy()
      expect(r.text.length).toBeGreaterThan(0)
    }
  })

  it('invalid input is rejected with a short, non-throwing error', async () => {
    const r = await call('brain_search', { limit: 3 })
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/Invalid input for brain_search/)
    expect((await call('calendar_agenda', { from: 5, to: 'x' })).isError).toBe(true)
    expect((await call('brain_search', { query: 'x', limit: 99 })).isError).toBe(true)
  })

  it('handlers never throw, whatever they are given', async () => {
    for (const b of bindings) {
      for (const junk of [undefined, null, 'str', 42, [], { weird: { deep: true } }]) {
        await expect(b.handler(junk)).resolves.toBeDefined()
      }
    }
  })
})

describe('finance_move_money', () => {
  it('is locked and always an error, whatever the input', async () => {
    for (const input of [{}, { amount: 1000, to: 'acct' }, undefined]) {
      const r = await call('finance_move_money', input)
      expect(r.isError).toBe(true)
      expect(r.text).toMatch(/^Locked/)
    }
  })
})

describe('calendar', () => {
  it('lists the events of the day in order', async () => {
    const r = await call('calendar_agenda', { from: '2026-11-02', to: '2026-11-02' })
    expect(r.text).toMatch(/^4 events between 2026-11-02 and 2026-11-02/)
    const lines = r.text.split('\n').filter((l) => l.startsWith('- '))
    expect(lines.map((l) => /\d\d:\d\d-\d\d:\d\d/.exec(l)?.[0])).toEqual(['08:30-09:00', '09:30-11:30', '14:00-14:45', '17:30-18:30'])
    expect(r.text).toContain('Call with Dana Reyes')
  })

  it('a range with no events says so', async () => {
    expect((await call('calendar_agenda', { from: '2030-01-01', to: '2030-01-02' })).text).toMatch(/^No events between/)
  })

  it('rejects a reversed or malformed range', async () => {
    expect((await call('calendar_agenda', { from: '2026-11-05', to: '2026-11-01' })).isError).toBe(true)
    expect((await call('calendar_agenda', { from: 'soon', to: 'later' })).isError).toBe(true)
  })

  it('marks Mira\'s proposed hold as tentative', async () => {
    const r = await call('calendar_agenda', { from: '2026-11-05', to: '2026-11-05' })
    expect(r.text).toMatch(/tentative, waiting for your approval/)
  })

  it('propose_event is mock and says nothing was created', async () => {
    const r = await call('calendar_propose_event', { title: 'Focus', start: '2026-11-05T09:00:00', end: '2026-11-05T11:00:00' })
    expect(r.text).toMatch(/Mock mode: nothing was saved/)
    expect(r.text).toMatch(/NOT added/)
    expect((await call('calendar_propose_event', { title: 'x', start: '2026-11-05T11:00:00', end: '2026-11-05T09:00:00' })).isError).toBe(true)
  })
})

describe('mail: snippets only', () => {
  it('returns snippets with a data banner and never any body or draft text', async () => {
    const r = await call('mail_search', { query: 'priya' })
    expect(r.text).toMatch(/^Untrusted content below/)
    expect(r.text).toContain('could you send the revised homepage before Thursday')
    for (const m of snap.mail) {
      if (m.suggestedDraft) expect(r.text).not.toContain(m.suggestedDraft.slice(0, 30))
      if (m.miraNote) expect(r.text).not.toContain(m.miraNote.slice(0, 30))
    }
  })

  it('withholds the snippet of a sensitive sender', async () => {
    const r = await call('mail_search', { query: 'tax' })
    expect(r.text).toContain('Q3 estimated tax')
    expect(r.text).toContain('snippet withheld')
    expect(r.text).not.toContain('Numbers attached')
  })

  it('respects the limit', async () => {
    const r = await call('mail_search', { query: '', limit: 2 })
    expect(r.text.split('\n').filter((l) => l.startsWith('- [')).length).toBe(2)
  })

  it('draft_reply needs a real thread and stores nothing', async () => {
    expect((await call('mail_draft_reply', { threadId: 'nope', body: 'x' })).isError).toBe(true)
    expect((await call('mail_draft_reply', { threadId: 'm-priya', body: 'Hi' })).text).toMatch(/Mock mode/)
  })

  it('mail_send is mock: nothing is sent', async () => {
    const r = await call('mail_send', { draftId: 'd-1' })
    expect(r.text).toMatch(/NOT sent/)
  })
})

describe('contacts', () => {
  it('finds people by name, org or tag', async () => {
    expect((await call('contacts_find', { query: 'dana' })).text).toContain('Dana Reyes')
    expect((await call('contacts_find', { query: 'beta' })).text).toContain('Sam Ortiz')
    expect((await call('contacts_find', { query: 'zzzz' })).text).toMatch(/^Nobody matched/)
    expect((await call('contacts_find', { query: '   ' })).isError).toBe(true)
  })
})

describe('brain', () => {
  it('search ranks the matching note first and cites paths', async () => {
    const r = await call('brain_search', { query: 'q4 positioning', limit: 3 })
    const first = r.text.split('\n')[1] ?? ''
    expect(first).toMatch(/^1\. 10-strategy\/q4-positioning\.md \|/)
    expect(r.text).toMatch(/Cite a note by its path/)
  })

  it('search, list and read never expose a note marked sensitive', async () => {
    const custom = structuredClone(snap)
    const target = custom.notes.find((n) => n.path === '30-knowledge/envelope-budgeting.md') ?? custom.notes[0]!
    target.sensitivity = 'sensitive'
    const local = Object.fromEntries(createMockToolBindings({ now: () => NOW, snapshot: custom }).map((b) => [b.spec.name, b]))
    const search = await local.brain_search!.handler({ query: target.title, limit: 20 })
    expect(search.text).not.toContain(target.path)
    const list = await local.brain_list!.handler({})
    expect(list.text).not.toContain(target.path)
    const read = await local.brain_read!.handler({ path: target.path })
    expect(read.isError).toBe(true)
    expect(read.text).toMatch(/sensitive/)
    // the same note is readable when it is not marked sensitive
    expect((await call('brain_read', { path: target.path })).isError).toBeFalsy()
  })

  it('search with only stopwords asks for a keyword', async () => {
    expect((await call('brain_search', { query: 'the and of' })).isError).toBe(true)
  })

  it('read returns the note, or one section of it', async () => {
    const whole = await call('brain_read', { path: '10-strategy/q4-positioning.md' })
    expect(whole.text).toContain('## Why this, why now')
    const part = await call('brain_read', { path: '10-strategy/q4-positioning', section: 'why' })
    expect(part.text).toContain('## Why this, why now')
    expect(part.text).not.toContain('## Positioning')
    expect((await call('brain_read', { path: '10-strategy/q4-positioning.md', section: 'nonexistent' })).isError).toBe(true)
  })

  it('read of a missing note suggests alternatives', async () => {
    const r = await call('brain_read', { path: '10-strategy/q4-position' })
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/No note at/)
  })

  it('list filters by layer and skips sensitive notes', async () => {
    const r = await call('brain_list', { layer: 'strategy' })
    expect(r.text).toMatch(/^6 notes/)
    expect(r.text).toContain('10-strategy/q4-positioning.md')
    expect((await call('brain_list', { layer: 'nope' })).text).toMatch(/No notes match/)
  })

  it('today returns the journal note and its open loops', async () => {
    const r = await call('brain_today')
    expect(r.text).toContain("Today's journal: 20-journal/2026/2026-11-02.md")
    expect(r.text).toMatch(/Open loops \(\d+\)/)
    expect(r.text).toContain('- [ ] Approve or deny the migration delete')
  })

  it('writes acknowledge but say they are mock and not persisted', async () => {
    for (const [name, input] of [
      ['brain_journal_append', { text: 'went well' }],
      ['brain_capture', { text: 'idea' }],
      ['brain_upsert_note', { path: '30-knowledge/new.md', bodyPatch: 'x' }],
      ['brain_propose', { targetPath: '10-strategy/q4-positioning.md', rationale: 'r', diff: ['-a', '+b'] }],
    ] as const) {
      const r = await call(name, input)
      expect(r.isError, name).toBeFalsy()
      expect(r.text, name).toMatch(/Mock mode: nothing was saved/)
    }
  })

  it('writes strip emotion tags from what they would store', async () => {
    const r = await call('brain_journal_append', { text: '[happy] Shipped it.' })
    expect(r.text).toContain(`${'Shipped it.'.length} characters`)
  })

  it('upsert with nothing to change is an error', async () => {
    expect((await call('brain_upsert_note', { path: 'x.md' })).isError).toBe(true)
  })
})

describe('finance: aggregates only', () => {
  it('summary gives balances by kind, budget totals, bills and runway', async () => {
    const r = await call('finance_summary')
    expect(r.text).toContain('aggregates only')
    expect(r.text).toMatch(/Checking: \$3,846\.20/)
    expect(r.text).toMatch(/Credit cards: -\$1,284\.30/)
    expect(r.text).toMatch(/Budget 2026-11: planned \$2,650\.00, spent \$2,424\.00, remaining \$226\.00/)
    expect(r.text).toMatch(/Upcoming bills:/)
    expect(r.text).toMatch(/Runway: /)
  })

  it('summary never carries raw transactions', async () => {
    const r = await call('finance_summary')
    for (const t of snap.finance.recentTransactions) {
      if (t.merchant && !snap.finance.upcomingBills.some((b) => b.payee.includes(t.merchant!))) expect(r.text).not.toContain(t.merchant)
      expect(r.text).not.toContain(t.description)
      expect(r.text).not.toContain(t.id)
    }
  })

  it('transactions are a small redacted sample, marked as audited', async () => {
    const r = await call('finance_transactions', { limit: 100 })
    expect(r.text).toMatch(/^AUDITED READ/)
    const rows = r.text.split('\n').filter((l) => l.startsWith('- '))
    expect(rows.length).toBeLessThanOrEqual(10)
    for (const t of snap.finance.recentTransactions) {
      expect(r.text).not.toContain(t.description)
      expect(r.text).not.toContain(t.accountId)
      expect(r.text).not.toContain(t.id)
    }
    expect(rows[0]).toMatch(/\| Cloud Host \| Tools and cloud \| -\$12\.00 \| checking$/)
  })

  it('transactions can be filtered by account and date', async () => {
    const card = await call('finance_transactions', { accountId: 'acc-card' })
    expect(card.text.split('\n').filter((l) => l.startsWith('- ')).every((l) => l.includes('credit'))).toBe(true)
    expect((await call('finance_transactions', { since: 'garbage' })).isError).toBe(true)
  })
})

describe('worklog and news', () => {
  it('worklog_status summarises the sessions and who needs you', async () => {
    const r = await call('worklog_status')
    expect(r.text).toMatch(/^10 sessions: /)
    expect(r.text).toMatch(/2 need you/)
    expect(r.text).toContain('Migrate transactions table')
    expect(r.text).toMatch(/API-equivalent estimates/)
  })

  it('worklog_status can be limited to one project', async () => {
    const r = await call('worklog_status', { projectId: 'homelab' })
    expect(r.text).toContain('home-lab')
    expect(r.text).not.toContain('Atlas')
    expect((await call('worklog_status', { projectId: 'nope' })).text).toMatch(/No sessions/)
  })

  it('worklog_create_task is mock', async () => {
    expect((await call('worklog_create_task', { title: 'Fix it', projectId: 'atlas' })).text).toMatch(/Mock mode/)
    expect((await call('worklog_create_task', { title: 'Fix it', projectId: 'nope' })).isError).toBe(true)
  })

  it('news is labelled as untrusted data and ranked by relevance', async () => {
    const r = await call('news_briefing')
    expect(r.text).toMatch(/^Untrusted content below/)
    expect(r.text).toContain('1. Local-first sync engines hit a tipping point')
    expect((await call('news_briefing', { topic: 'science' })).text).toContain('Study: protected morning blocks')
  })
})
