import { describe, expect, it } from 'vitest'
import type { AgentSession, BackendEvent, OpenSessionOptions, ToolBinding } from '@ai-assistant/shared'
import { TOOL_SURFACE } from '@ai-assistant/shared'
import { EmotionStreamParser, chunkSentence, createFakeBackend, createMockToolBindings, parseSentences } from '../src'
import type { FakeBackendOptions } from '../src'
import { NOW, collect, isTerminal } from './helpers'

function openOpts(over: Partial<OpenSessionOptions> = {}, tools?: ToolBinding[]): OpenSessionOptions {
  return {
    lane: 'secretary',
    systemPrompt: 'prompt',
    model: 'claude-sonnet-5-5',
    effort: 'medium',
    cwd: '/work',
    tools: tools ?? createMockToolBindings({ now: () => NOW }).filter((b) => b.spec.lanes.includes('secretary') && !b.spec.locked),
    authMode: 'api-key',
    ...over,
  }
}

async function start(opts: FakeBackendOptions = {}, open: Partial<OpenSessionOptions> = {}, tools?: ToolBinding[]) {
  const backend = createFakeBackend({ now: () => NOW, ...opts })
  const session = await backend.open(openOpts(open, tools))
  return { backend, session }
}

const turn = (text: string) => ({ text, modality: 'text' as const })

async function say(session: AgentSession, text: string, ms = 3000): Promise<BackendEvent[]> {
  session.send(turn(text))
  return collect(session, isTerminal, ms)
}

const deltas = (events: BackendEvent[]): string =>
  events
    .filter((e): e is Extract<BackendEvent, { type: 'text_delta' }> => e.type === 'text_delta')
    .map((e) => e.text)
    .join('')

const kinds = (events: BackendEvent[]): string[] => events.map((e) => e.type)

/** A binding that records its calls and returns a fixed text. */
function spy(name: string): { binding: ToolBinding; calls: unknown[] } {
  const spec = TOOL_SURFACE.find((s) => s.name === name)!
  const calls: unknown[] = []
  return { calls, binding: { spec, handler: async (input) => (calls.push(input), { text: `${name} ran` }) } }
}

describe('session basics', () => {
  it('announces a stable session id first, and honours resumeSessionId', async () => {
    const { session } = await start()
    expect(session.id).toBe('fake-secretary-1')
    const [first] = await collect(session, () => true)
    expect(first).toEqual({ type: 'session', sessionId: 'fake-secretary-1' })

    const backend = createFakeBackend()
    const resumed = await backend.open(openOpts({ resumeSessionId: 'abc-123' }))
    expect(resumed.id).toBe('abc-123')
    expect((await collect(resumed, () => true))[0]).toEqual({ type: 'session', sessionId: 'abc-123' })
    expect((await backend.open(openOpts())).id).toBe('fake-secretary-1')
    expect((await backend.open(openOpts())).id).toBe('fake-secretary-2')
  })

  it('records what it was opened with, for assertions', async () => {
    const { backend } = await start({}, { systemPrompt: 'hello', model: 'm' })
    expect(backend.kind).toBe('fake')
    expect(backend.opened).toHaveLength(1)
    expect(backend.opened[0]?.systemPrompt).toBe('hello')
    expect(backend.sessions).toHaveLength(1)
  })

  it('events is one iterator for the life of the session', async () => {
    const { session } = await start()
    expect(session.events[Symbol.asyncIterator]()).toBe(session.events[Symbol.asyncIterator]())
  })

  it('close ends the stream, and sending afterwards does nothing', async () => {
    const { session } = await start()
    await session.close()
    session.send(turn('hello'))
    const events = await collect(session, () => false, 200)
    expect(events.filter((e) => e.type === 'text_delta')).toEqual([])
    await session.close() // idempotent
  })

  it('processes queued turns one after another, in order', async () => {
    const { session } = await start()
    session.send(turn('hello'))
    session.send(turn('thanks'))
    let ends = 0
    const events = await collect(session, (e) => e.type === 'turn_end' && ++ends === 2)
    const text = deltas(events)
    expect(text.indexOf('offline demo mode')).toBeGreaterThan(-1)
    expect(text.indexOf('Happy to help')).toBeGreaterThan(text.indexOf('offline demo mode'))
    expect(kinds(events).filter((k) => k === 'turn_end')).toHaveLength(2)
  })
})

describe('streaming replies', () => {
  it('streams an emotion-tagged reply whose tags parse into sentences', async () => {
    const { session } = await start()
    const events = await say(session, 'hello')
    const text = deltas(events)
    expect(text).toMatch(/^\[happy\] Good morning!/)
    const sentences = parseSentences(text)
    expect(sentences[0]).toEqual({ emotion: 'happy', text: 'Good morning!' })
    expect(sentences.length).toBeGreaterThanOrEqual(3)
    expect(events.at(-1)?.type).toBe('turn_end')
  })

  it('cuts the first chunk of every sentence inside its tag, on purpose', async () => {
    const { session } = await start()
    const events = await say(session, 'hello')
    const chunks = events.filter((e): e is Extract<BackendEvent, { type: 'text_delta' }> => e.type === 'text_delta').map((e) => e.text)
    expect(chunks[0]).toBe('[ha')
    const splitTags = chunks.filter((c) => /^\s*\[[a-z]{0,3}$/.test(c))
    expect(splitTags.length).toBeGreaterThanOrEqual(3)
    // ...and the parser reassembles them regardless
    const p = new EmotionStreamParser()
    const out = [...chunks.flatMap((c) => p.push(c)), ...p.flush()]
    expect(out.some((e) => e.type === 'emotion' && e.emotion === 'happy')).toBe(true)
    expect(out.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('')).not.toContain('[')
  })

  it('chunkSize controls the delta size', async () => {
    const { session } = await start({ chunkSize: 3 })
    const events = await say(session, 'thanks')
    const chunks = events.filter((e): e is Extract<BackendEvent, { type: 'text_delta' }> => e.type === 'text_delta').map((e) => e.text)
    expect(Math.max(...chunks.slice(1).map((c) => c.length))).toBeLessThanOrEqual(3)
  })

  it('chunkSentence splits inside the tag, then by size', () => {
    expect(chunkSentence('[happy] Hello there', 5)).toEqual(['[ha', 'ppy] ', 'Hello', ' ther', 'e'])
    expect(chunkSentence(' [sad] Oh', 4)).toEqual([' [sa', 'd] O', 'h'])
    expect(chunkSentence('plain text', 4)).toEqual(['plai', 'n te', 'xt'])
    expect(chunkSentence('[x]', 2)).toEqual(['[x]'.slice(0, 2), ']'])
  })

  it('the offline demo answers an "are you human" question honestly', async () => {
    const { session } = await start()
    const text = deltas(await say(session, 'Are you human?'))
    expect(text).toMatch(/I am an AI/)
  })

  it('goodnight gets a goodnight and no hook', async () => {
    const { session } = await start()
    const text = deltas(await say(session, 'goodnight Mira'))
    expect(text).toMatch(/Goodnight/)
    expect(text).not.toMatch(/\?/)
  })

  it('an unknown request gets an honest "demo mode" answer', async () => {
    const { session } = await start()
    expect(deltas(await say(session, 'write me a sonnet about turnips'))).toMatch(/offline demo mode/)
  })
})

describe('tools', () => {
  it('a calendar question runs the calendar tool for real and speaks about the result', async () => {
    const { session } = await start()
    const events = await say(session, "What's on my calendar today?")
    expect(kinds(events).filter((k) => k !== 'text_delta')).toEqual(['session', 'tool_start', 'tool_end', 'turn_end'])
    const start_ = events.find((e) => e.type === 'tool_start')
    expect(start_).toMatchObject({ type: 'tool_start', tool: 'calendar_agenda', input: { from: '2026-11-02', to: '2026-11-02' } })
    const end = events.find((e) => e.type === 'tool_end')
    expect(end).toMatchObject({ type: 'tool_end', ok: true })
    expect(end && 'toolUseId' in end && start_ && 'toolUseId' in start_ && end.toolUseId === start_.toolUseId).toBe(true)
    const text = deltas(events)
    expect(text).toMatch(/^\[thinking\] Let me check your calendar\./)
    expect(text).toContain('4 events between 2026-11-02')
  })

  it('invokes the provided handler with the intent\'s input', async () => {
    const s = spy('calendar_agenda')
    const { session } = await start({}, {}, [s.binding])
    await say(session, 'calendar please')
    expect(s.calls).toEqual([{ from: '2026-11-02', to: '2026-11-02' }])
  })

  it.each([
    ['what needs me right now', 'worklog_status'],
    ['any blocked agents?', 'worklog_status'],
    ['what do my notes say about strategy', 'brain_search'],
    ['how is my runway looking', 'finance_summary'],
    ['check my inbox', 'mail_search'],
    ['any news today? no calendar please', 'news_briefing'],
  ])('"%s" uses %s', async (text, tool) => {
    const { session } = await start()
    const events = await say(session, text)
    expect(events.filter((e) => e.type === 'tool_start').map((e) => (e as { tool: string }).tool)).toContain(tool)
  })

  it('tomorrow and "this week" widen or shift the range', async () => {
    const s = spy('calendar_agenda')
    const { session } = await start({}, {}, [s.binding])
    await say(session, 'what is on tomorrow?')
    await say(session, 'what is on this week?')
    expect(s.calls).toEqual([
      { from: '2026-11-03', to: '2026-11-03' },
      { from: '2026-11-02', to: '2026-11-08' },
    ])
  })

  it('several intents in one message run several tools, in a fixed order', async () => {
    const { session } = await start()
    const events = await say(session, 'check my calendar, what needs me, and my runway')
    expect(events.filter((e) => e.type === 'tool_start').map((e) => (e as { tool: string }).tool)).toEqual(['calendar_agenda', 'worklog_status', 'finance_summary'])
    expect(deltas(events)).toMatch(/Let me check your calendar and your sessions and your finances\./)
  })

  it('only ever calls tools it was given', async () => {
    const { session } = await start({}, {}, [])
    const events = await say(session, 'calendar and runway and what needs me')
    expect(kinds(events)).not.toContain('tool_start')
    expect(deltas(events)).toMatch(/I do not have a tool for your calendar right now/)
    expect(events.at(-1)?.type).toBe('turn_end')
  })

  it('a tool error is reported honestly and does not kill the turn', async () => {
    const spec = TOOL_SURFACE.find((s) => s.name === 'calendar_agenda')!
    const failing: ToolBinding = { spec, handler: async () => ({ text: 'Calendar offline', isError: true }) }
    const { session } = await start({}, {}, [failing])
    const events = await say(session, 'calendar')
    expect(events.find((e) => e.type === 'tool_end')).toMatchObject({ ok: false, summary: 'Calendar offline' })
    expect(deltas(events)).toMatch(/I could not do that: Calendar offline/)
    expect(events.at(-1)?.type).toBe('turn_end')
  })

  it('a tool that throws becomes an error result, not a crash', async () => {
    const spec = TOOL_SURFACE.find((s) => s.name === 'calendar_agenda')!
    const boom: ToolBinding = { spec, handler: async () => Promise.reject(new Error('secret internals')) }
    const { session } = await start({}, {}, [boom])
    const events = await say(session, 'calendar')
    const end = events.find((e) => e.type === 'tool_end')
    expect(end).toMatchObject({ ok: false })
    expect(JSON.stringify(events)).not.toContain('secret internals')
  })
})

describe('permission requests', () => {
  async function untilRequest(session: AgentSession): Promise<{ events: BackendEvent[]; request: Extract<BackendEvent, { type: 'permission_request' }> }> {
    const events = await collect(session, (e) => e.type === 'permission_request')
    const request = events.at(-1)
    if (request?.type !== 'permission_request') throw new Error(`no permission request in ${kinds(events).join(',')}`)
    return { events, request }
  }

  it('"send" asks for permission to send mail and waits for the decision', async () => {
    const s = spy('mail_send')
    const { session } = await start({}, {}, [s.binding])
    session.send(turn('please send the reply to Priya'))
    const { events, request } = await untilRequest(session)
    expect(request).toMatchObject({ tool: 'mail_send', input: { draftId: 'draft-priya-reply' }, title: 'Send the reply to Priya' })
    const startEv = events.find((e) => e.type === 'tool_start')
    expect(startEv && 'toolUseId' in startEv && startEv.toolUseId).toBe(request.requestId)
    expect(s.calls).toEqual([]) // nothing ran yet
    // it really waits
    expect(await collect(session, () => false, 60)).toEqual([])
    expect(s.calls).toEqual([])
  })

  it('approved: the tool runs and the reply says so', async () => {
    const s = spy('mail_send')
    const { session } = await start({}, {}, [s.binding])
    session.send(turn('send it'))
    const { request } = await untilRequest(session)
    session.resolvePermission(request.requestId, { behavior: 'allow' })
    const rest = await collect(session, isTerminal)
    expect(s.calls).toEqual([{ draftId: 'draft-priya-reply' }])
    expect(rest.find((e) => e.type === 'tool_end')).toMatchObject({ ok: true, toolUseId: request.requestId })
    expect(deltas(rest)).toMatch(/Done\./)
  })

  it('denied: the tool never runs and the reply declines', async () => {
    const s = spy('mail_send')
    const { session } = await start({}, {}, [s.binding])
    session.send(turn('send it'))
    const { request } = await untilRequest(session)
    session.resolvePermission(request.requestId, { behavior: 'deny', message: 'The user said no.' })
    const rest = await collect(session, isTerminal)
    expect(s.calls).toEqual([])
    expect(rest.find((e) => e.type === 'tool_end')).toMatchObject({ ok: false, summary: 'The user said no.' })
    expect(deltas(rest)).toMatch(/I will not do that/)
    expect(rest.at(-1)?.type).toBe('turn_end')
  })

  it('"delete" and "remove" and "rm" ask to edit a note', async () => {
    for (const word of ['delete', 'remove', 'rm']) {
      const { session } = await start()
      session.send(turn(`${word} the scratch note`))
      const { request } = await untilRequest(session)
      expect(request.tool, word).toBe('brain_upsert_note')
    }
  })

  it('"spend" and "pay" attempt the locked money tool, which is not even bound', async () => {
    for (const word of ['spend $50 on a monitor', 'pay the electricity bill']) {
      const { session } = await start()
      session.send(turn(word))
      const { request } = await untilRequest(session)
      expect(request.tool).toBe('finance_move_money')
      session.resolvePermission(request.requestId, { behavior: 'deny', message: 'locked' })
      const rest = await collect(session, isTerminal)
      expect(rest.find((e) => e.type === 'tool_end')).toMatchObject({ ok: false })
    }
  })

  it('if a decision allows a tool that is not bound, it reports that honestly instead of inventing a result', async () => {
    const { session } = await start()
    session.send(turn('pay the bill'))
    const { request } = await untilRequest(session)
    session.resolvePermission(request.requestId, { behavior: 'allow' })
    const rest = await collect(session, isTerminal)
    expect(rest.find((e) => e.type === 'tool_end')).toMatchObject({ ok: false, summary: 'tool not available in this lane' })
  })

  it('reads run first, then the permission question', async () => {
    const { session } = await start()
    session.send(turn('check my calendar and then send the email'))
    const events = await collect(session, (e) => e.type === 'permission_request')
    const order = events.filter((e) => e.type === 'tool_start' || e.type === 'tool_end' || e.type === 'permission_request').map((e) => `${e.type}:${'tool' in e ? e.tool : ''}`)
    expect(order).toEqual(['tool_start:calendar_agenda', 'tool_end:', 'tool_start:mail_send', 'permission_request:mail_send'])
  })

  it('an autoAllow list decides which tools need permission (default: tiers T0 and T1 run free)', async () => {
    const { session } = await start({}, { autoAllow: [] })
    session.send(turn('calendar'))
    const { request } = await untilRequest(session)
    expect(request.tool).toBe('calendar_agenda')

    const { session: free } = await start({}, { autoAllow: ['mail_send'] })
    free.send(turn('send it'))
    const events = await collect(free, isTerminal)
    expect(kinds(events)).not.toContain('permission_request')
  })

  it('resolving an unknown request id is ignored', async () => {
    const { session } = await start()
    expect(() => session.resolvePermission('nope', { behavior: 'allow' })).not.toThrow()
  })
})

describe('interrupt', () => {
  it('stops mid-stream: turn_end interrupted:true and no deltas afterwards', async () => {
    const { session } = await start({ latencyMs: 15, chunkSize: 4 })
    session.send(turn('hello'))
    const before = await collect(session, (e) => e.type === 'text_delta')
    expect(before.some((e) => e.type === 'text_delta')).toBe(true)
    await session.interrupt()
    const after = await collect(session, isTerminal, 500)
    const end = after.at(-1)
    expect(end).toMatchObject({ type: 'turn_end', interrupted: true })
    // after interrupt() resolved nothing but the terminal event may still be queued
    expect(after.filter((e) => e.type === 'text_delta')).toEqual([])
    expect(await collect(session, () => false, 100)).toEqual([])
  })

  it('does nothing when no turn is running', async () => {
    const { session } = await start()
    await session.interrupt()
    expect(await collect(session, () => false, 50)).toEqual([{ type: 'session', sessionId: 'fake-secretary-1' }])
  })

  it('also ends a turn that is waiting for a permission decision', async () => {
    const s = spy('mail_send')
    const { session } = await start({}, {}, [s.binding])
    session.send(turn('send it'))
    await collect(session, (e) => e.type === 'permission_request')
    await session.interrupt()
    const rest = await collect(session, isTerminal, 500)
    expect(rest.at(-1)).toMatchObject({ type: 'turn_end', interrupted: true })
    expect(s.calls).toEqual([])
  })

  it('a new turn works after an interrupt', async () => {
    const { session } = await start({ latencyMs: 10, chunkSize: 4 })
    session.send(turn('hello'))
    await collect(session, (e) => e.type === 'text_delta')
    await session.interrupt()
    await collect(session, isTerminal, 500)
    const events = await say(session, 'thanks')
    expect(deltas(events)).toMatch(/Happy to help/)
    expect(events.at(-1)).toMatchObject({ type: 'turn_end' })
    expect(events.at(-1)).not.toHaveProperty('interrupted')
  })

  it('close() during a turn ends it', async () => {
    const { session } = await start({ latencyMs: 10, chunkSize: 4 })
    session.send(turn('hello'))
    await collect(session, (e) => e.type === 'text_delta')
    await session.close()
    const rest = await collect(session, () => false, 200)
    expect(rest.some((e) => e.type === 'text_delta')).toBe(false)
  })
})

describe('usage, cost and failure modes', () => {
  it('reports deterministic fake usage and a tiny cost, never zero tokens claimed', async () => {
    const { session } = await start()
    const end = (await say(session, 'hello')).at(-1)
    expect(end?.type).toBe('turn_end')
    if (end?.type !== 'turn_end') return
    expect(end.costUsd).toBeGreaterThan(0)
    expect(end.costUsd).toBeLessThan(0.05)
    expect(end.usage).toMatchObject({ input: expect.any(Number), output: expect.any(Number) })
    expect(end.usage?.cacheCreate).toBe(900) // first turn writes the cache
    const second = (await say(session, 'hello')).at(-1)
    expect(second?.type === 'turn_end' && second.usage?.cacheRead).toBe(900)
  })

  it('costPerTurnUsd overrides the estimate', async () => {
    const { session } = await start({ costPerTurnUsd: 3.5 })
    expect((await say(session, 'hello')).at(-1)).toMatchObject({ type: 'turn_end', costUsd: 3.5 })
  })

  it('"!error" produces a retryable error event as the terminal event', async () => {
    const { session } = await start()
    const events = await say(session, 'please !error now')
    expect(events.at(-1)).toMatchObject({ type: 'error', retryable: true, kind: 'process' })
    expect(kinds(events)).not.toContain('turn_end')
    // the session is still usable
    expect((await say(session, 'thanks')).at(-1)?.type).toBe('turn_end')
  })

  it('"!crash" ends the event stream without a terminal event', async () => {
    const { session } = await start()
    session.send(turn('!crash'))
    const events: BackendEvent[] = []
    for await (const e of session.events) events.push(e)
    expect(kinds(events)).toEqual(['session'])
  })

  it('zero network: the backend works with no environment at all', async () => {
    const saved = { ...process.env }
    for (const k of Object.keys(process.env)) if (/proxy|anthropic/i.test(k)) delete process.env[k]
    try {
      const { session } = await start()
      expect((await say(session, 'hello')).at(-1)?.type).toBe('turn_end')
    } finally {
      Object.assign(process.env, saved)
    }
  })
})
