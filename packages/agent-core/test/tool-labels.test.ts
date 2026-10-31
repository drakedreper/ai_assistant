import { describe, expect, it } from 'vitest'
import { TOOL_SURFACE } from '@ai-assistant/shared'
import { cloudNote, toolLabel } from '../src'

describe('toolLabel', () => {
  it('is present tense while running and past tense when done', () => {
    expect(toolLabel('calendar_agenda', {}, 'running')).toBe('checking your calendar')
    expect(toolLabel('calendar_agenda', {})).toBe('checked your calendar')
    expect(toolLabel('mail_send', {}, 'running')).toBe('sending the email')
    expect(toolLabel('mail_send', {}, 'done')).toBe('sent the email')
  })

  it('mentions the query or path, truncated', () => {
    expect(toolLabel('brain_search', { query: 'q4 positioning' })).toBe('searched your notes for "q4 positioning"')
    expect(toolLabel('brain_read', { path: '10-strategy/q4-positioning.md' }, 'running')).toBe('reading 10-strategy/q4-positioning.md')
    expect(toolLabel('brain_search', { query: 'x'.repeat(200) }).length).toBeLessThan(80)
    expect(toolLabel('contacts_find', { query: 'dana' })).toBe('looked up dana')
  })

  it('never prints anything but a string for odd input', () => {
    for (const input of [undefined, null, 5, 'str', [], { query: 5 }]) {
      for (const spec of TOOL_SURFACE) {
        expect(typeof toolLabel(spec.name, input, 'running')).toBe('string')
        expect(toolLabel(spec.name, input, 'done').length).toBeGreaterThan(0)
      }
    }
  })

  it('has a label for every tool on the surface, and a generic one for strangers', () => {
    for (const spec of TOOL_SURFACE) expect(toolLabel(spec.name, {})).not.toMatch(/^used /)
    expect(toolLabel('Bash', {})).toBe('used Bash')
  })

  it('collapses newlines in what it echoes', () => {
    expect(toolLabel('brain_search', { query: 'a\nb\n\nc' })).toBe('searched your notes for "a b c"')
  })
})

describe('cloudNote', () => {
  it('describes what a read tool sends to the model, and nothing for tools that return nothing', () => {
    expect(cloudNote('finance_summary')).toMatch(/Aggregates only/)
    expect(cloudNote('mail_search')).toMatch(/no full bodies/)
    expect(cloudNote('mail_send')).toBeUndefined()
  })
})
