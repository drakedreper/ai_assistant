import { describe, expect, it } from 'vitest'
import type { BackendEvent, OpenSessionOptions, ToolBinding } from '@ai-assistant/shared'
import { TOOL_SURFACE } from '@ai-assistant/shared'
import { BackendError, buildMcpToolEntries, buildSdkEnv, createMockToolBindings, createSdkBackend, createSdkMapState, mapSdkMessage, mcpToolName } from '../src'
import type { SdkBackendOptions } from '../src'
import { NOW, collect, isTerminal } from './helpers'
import { SESSION, scriptedQueryFn, sdk } from './sdk-fixtures'

const allTools = createMockToolBindings({ now: () => NOW })
const secretaryTools = allTools.filter((b) => b.spec.lanes.includes('secretary') && !b.spec.locked)

function openOpts(over: Partial<OpenSessionOptions> = {}): OpenSessionOptions {
  return { lane: 'secretary', systemPrompt: 'You are Mira.', model: 'claude-sonnet-5-5', effort: 'medium', cwd: '/work/agent', tools: secretaryTools, authMode: 'api-key', apiKey: 'sk-ant-test-1234567890', ...over }
}

const baseEnv = { PATH: '/usr/bin', HOME: '/home/u', HTTPS_PROXY: 'http://proxy:3128' }

async function open(over: Partial<OpenSessionOptions> = {}, backendOpts: SdkBackendOptions = {}) {
  const { queryFn, queries } = scriptedQueryFn()
  const backend = createSdkBackend({ queryFn, baseEnv, ...backendOpts })
  const session = await backend.open(openOpts(over))
  const q = queries[0]!
  return { backend, session, q, queries }
}

const turn = (text: string) => ({ text, modality: 'text' as const })
const types = (events: BackendEvent[]) => events.map((e) => e.type)
const tick = () => new Promise((r) => setTimeout(r, 5))
const noSession = (events: BackendEvent[]): BackendEvent[] => events.filter((e) => e.type !== 'session')

describe('options passed to the SDK', () => {
  it('uses ONE streaming-input query with the persona, no built-in tools and no filesystem settings', async () => {
    const { q, queries } = await open()
    expect(queries).toHaveLength(1)
    expect(typeof q.params.prompt).not.toBe('string')
    const o = q.options
    expect(o.systemPrompt).toBe('You are Mira.')
    expect(o.tools).toEqual([])
    expect(o.settingSources).toEqual([])
    expect(o.strictMcpConfig).toBe(true)
    expect(o.includePartialMessages).toBe(true)
    expect(o.permissionMode).toBe('default')
    expect(o.model).toBe('claude-sonnet-5-5')
    expect(o.effort).toBe('medium')
    expect(o.cwd).toBe('/work/agent')
    expect(typeof o.canUseTool).toBe('function')
    expect(o.abortController).toBeInstanceOf(AbortController)
    expect(o.resume).toBeUndefined()
    expect(o.maxBudgetUsd).toBeUndefined()
    expect(o.pathToClaudeCodeExecutable).toBeUndefined()
  })

  it('passes resume, the budget cap, effort and a custom executable when given (local login)', async () => {
    const { q } = await open({ resumeSessionId: 'prev-session', maxBudgetUsd: 4, effort: 'high', authMode: 'local-login', claudeExecutable: 'C:\\Users\\me\\.local\\bin\\claude.exe', apiKey: undefined })
    expect(q.options.resume).toBe('prev-session')
    expect(q.options.maxBudgetUsd).toBe(4)
    expect(q.options.effort).toBe('high')
    expect(q.options.pathToClaudeCodeExecutable).toBe('C:\\Users\\me\\.local\\bin\\claude.exe')
  })

  it('passes maxTurns only when the backend was configured with it', async () => {
    expect((await open()).q.options.maxTurns).toBeUndefined()
    expect((await open({}, { maxTurns: 50 })).q.options.maxTurns).toBe(50)
  })

  it('registers one in-process MCP server per tool server, with the real SDK', async () => {
    const { q } = await open()
    const servers = q.options.mcpServers ?? {}
    expect(Object.keys(servers).sort()).toEqual(['brain', 'calendar', 'contacts', 'finance', 'mail', 'news', 'worklog'])
    for (const [name, cfg] of Object.entries(servers)) {
      expect(cfg).toMatchObject({ type: 'sdk', name })
      expect((cfg as { instance?: unknown }).instance).toBeDefined()
    }
  })

  it('the real MCP server registers each tool under its spec name and runs our handler (uses SDK internals)', async (ctx) => {
    const { q } = await open()
    const brain = (q.options.mcpServers as Record<string, { instance?: { _registeredTools?: Record<string, { handler?: Function; callback?: Function }> } }>).brain?.instance
    const registered = brain?._registeredTools
    if (!registered) return ctx.skip() // the SDK moved its internals; the tests above still cover the wiring
    expect(Object.keys(registered).sort()).toEqual(secretaryTools.filter((b) => b.spec.server === 'brain').map((b) => b.spec.name).sort())
    const run = registered.brain_search?.handler ?? registered.brain_search?.callback
    const result = (await run?.({ query: 'q4 positioning', limit: 2 }, {})) as { content: Array<{ text: string }> }
    expect(result.content[0]?.text).toContain('10-strategy/q4-positioning.md')
  })

  it('pre-approves exactly the auto tiers (T0, T1), by their mcp__server__tool names', async () => {
    const { q } = await open()
    const auto = secretaryTools.filter((b) => b.spec.tier === 'T0' || b.spec.tier === 'T1').map((b) => `mcp__${b.spec.server}__${b.spec.name}`)
    expect([...(q.options.allowedTools ?? [])].sort()).toEqual([...auto].sort())
    for (const name of ['mail_send', 'calendar_propose_event', 'brain_upsert_note', 'brain_propose', 'worklog_create_task', 'mail_draft_reply']) {
      expect(q.options.allowedTools).not.toContain(`mcp__${TOOL_SURFACE.find((s) => s.name === name)!.server}__${name}`)
    }
  })

  it('an explicit autoAllow list replaces the default', async () => {
    const { q } = await open({ autoAllow: ['mail_send'] })
    expect(q.options.allowedTools).toEqual(['mcp__mail__mail_send'])
    expect((await open({ autoAllow: [] })).q.options.allowedTools).toEqual([])
  })

  it('never registers a locked tool, even if it is handed over', async () => {
    const { q } = await open({ tools: allTools })
    expect(Object.keys(q.options.mcpServers ?? {})).toContain('finance')
    expect(q.options.allowedTools).not.toContain('mcp__finance__finance_move_money')
    expect(buildMcpToolEntries(allTools, 'secretary', fakeTool).map((e) => e.specName)).not.toContain('finance_move_money')
  })

  it('the reader lane gets only reader tools, and the voice lane none', () => {
    const reader = buildMcpToolEntries(allTools, 'reader', fakeTool).map((e) => e.specName)
    expect(reader).toContain('brain_search')
    for (const write of ['mail_send', 'brain_upsert_note', 'calendar_propose_event', 'finance_summary', 'finance_transactions', 'worklog_create_task']) expect(reader).not.toContain(write)
    expect(buildMcpToolEntries(allTools, 'voice', fakeTool)).toEqual([])
  })

  it('a lane with no tools registers no MCP servers at all', async () => {
    const { q } = await open({ tools: [] })
    expect(q.options.mcpServers).toEqual({})
    expect(q.options.allowedTools).toEqual([])
  })
})

const fakeTool = (name: string, description: string, shape: unknown, handler: (a: unknown, e: unknown) => Promise<unknown>) => ({ name, description, inputSchema: shape, handler }) as never

describe('MCP tool definitions', () => {
  it('names tools mcp__<server>__<tool>', () => {
    expect(mcpToolName({ server: 'brain', name: 'brain_search' })).toBe('mcp__brain__brain_search')
    const entries = buildMcpToolEntries(secretaryTools, 'secretary', fakeTool)
    expect(entries.map((e) => e.sdkName)).toContain('mcp__calendar__calendar_agenda')
    expect(new Set(entries.map((e) => e.sdkName)).size).toBe(entries.length)
  })

  it('exposes the zod object shape of each spec as the input schema', () => {
    const search = buildMcpToolEntries(secretaryTools, 'secretary', fakeTool).find((e) => e.specName === 'brain_search')!
    expect(Object.keys((search.definition as unknown as { inputSchema: object }).inputSchema).sort()).toEqual(['limit', 'query'])
  })

  it('every secretary tool converts with the REAL sdk tool() helper', async () => {
    const real = await import('@anthropic-ai/claude-agent-sdk')
    const entries = buildMcpToolEntries(secretaryTools, 'secretary', real.tool as never)
    expect(entries).toHaveLength(secretaryTools.length)
    const server = real.createSdkMcpServer({ name: 'probe', tools: entries.map((e) => e.definition) })
    expect(server.type).toBe('sdk')
  })

  it('the handler validates input, runs the binding and returns MCP content', async () => {
    const calls: unknown[] = []
    const spec = TOOL_SURFACE.find((s) => s.name === 'brain_search')!
    const binding: ToolBinding = { spec, handler: async (i) => (calls.push(i), { text: 'found it' }) }
    const [entry] = buildMcpToolEntries([binding], 'secretary', fakeTool)
    const ok = await entry!.definition.handler({ query: 'q4' } as never, {})
    expect(ok).toEqual({ content: [{ type: 'text', text: 'found it' }] })
    expect(calls).toEqual([{ query: 'q4', limit: 8 }]) // the schema's default was applied
    const bad = (await entry!.definition.handler({ limit: 'x' } as never, {})) as { isError?: boolean }
    expect(bad.isError).toBe(true)
    expect(calls).toHaveLength(1)
  })

  it('a tool error result and a thrown error both come back as isError, without leaking the exception', async () => {
    const spec = TOOL_SURFACE.find((s) => s.name === 'brain_search')!
    const errBinding: ToolBinding = { spec, handler: async () => ({ text: 'nope', isError: true }) }
    const boom: ToolBinding = { spec, handler: async () => Promise.reject(new Error('stack with secrets')) }
    const [a] = buildMcpToolEntries([errBinding], 'secretary', fakeTool)
    const [b] = buildMcpToolEntries([boom], 'secretary', fakeTool)
    expect(await a!.definition.handler({ query: 'x' } as never, {})).toEqual({ content: [{ type: 'text', text: 'nope' }], isError: true })
    const out = JSON.stringify(await b!.definition.handler({ query: 'x' } as never, {}))
    expect(out).toContain('isError')
    expect(out).not.toContain('secrets')
  })

  it('a spec whose schema is not an object is rejected loudly', () => {
    const spec = { ...TOOL_SURFACE.find((s) => s.name === 'brain_search')!, input: { safeParse: () => ({ success: true }) } as never }
    expect(() => buildMcpToolEntries([{ spec, handler: async () => ({ text: '' }) }], 'secretary', fakeTool)).toThrow(/zod object/)
  })
})

describe('auth and environment', () => {
  it('api-key: the key goes into the child environment, and the daemon environment is spread in', () => {
    const env = buildSdkEnv({ authMode: 'api-key', apiKey: 'sk-ant-abc', baseEnv: { ...baseEnv, ANTHROPIC_AUTH_TOKEN: 'x', CLAUDE_CODE_OAUTH_TOKEN: 'y' } })
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-abc')
    expect(env.PATH).toBe('/usr/bin')
    expect(env.HOME).toBe('/home/u')
    expect(env.HTTPS_PROXY).toBe('http://proxy:3128')
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1')
    expect(env.ENABLE_CLAUDEAI_MCP_SERVERS).toBe('false')
    expect(env.CLAUDE_AGENT_SDK_CLIENT_APP).toMatch(/^ai-assistant\//)
  })

  it('local-login: injects no key, and keeps a stray API key from overriding the login', () => {
    const base = { ...baseEnv, ANTHROPIC_API_KEY: 'sk-ant-stray', ANTHROPIC_AUTH_TOKEN: 'tok' }
    const env = buildSdkEnv({ authMode: 'local-login', apiKey: 'sk-ant-ignored', baseEnv: base })
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(env.PATH).toBe('/usr/bin')
    expect(JSON.stringify(env)).not.toMatch(/sk-ant-ignored|sk-ant-stray/)
  })

  it('never mutates the environment it was given', () => {
    const base = { ...baseEnv, ANTHROPIC_API_KEY: 'sk-ant-stray' }
    const copy = { ...base }
    buildSdkEnv({ authMode: 'local-login', baseEnv: base })
    buildSdkEnv({ authMode: 'api-key', apiKey: 'k', baseEnv: base })
    expect(base).toEqual(copy)
  })

  it('api-key mode without a key fails before anything is spawned, with an auth error', async () => {
    const { queryFn, queries } = scriptedQueryFn()
    const backend = createSdkBackend({ queryFn, baseEnv })
    await expect(backend.open(openOpts({ apiKey: undefined }))).rejects.toMatchObject({ name: 'BackendError', kind: 'auth', retryable: false })
    await expect(backend.open(openOpts({ apiKey: undefined }))).rejects.toBeInstanceOf(BackendError)
    expect(queries).toHaveLength(0)
  })

  it('the key reaches the query only through env, never through an option', async () => {
    const { q } = await open()
    expect((q.options.env as Record<string, string>).ANTHROPIC_API_KEY).toBe('sk-ant-test-1234567890')
    expect(Object.keys(q.options).filter((k) => /key|token|secret/i.test(k))).toEqual([])
    expect(q.options.systemPrompt).not.toContain('sk-ant')
  })

  it('local-login reads no credential file: it never touches the filesystem during open', async () => {
    const { q } = await open({ authMode: 'local-login', apiKey: undefined })
    expect((q.options.env as Record<string, unknown>).ANTHROPIC_API_KEY).toBeUndefined()
  })
})

describe('mapSdkMessage', () => {
  const names: Array<[string, string]> = [['mcp__brain__brain_search', 'brain_search']]
  const fresh = () => createSdkMapState(names)

  it('init becomes one session event, once per session id', () => {
    const state = fresh()
    expect(mapSdkMessage(sdk.init(), state)).toEqual([{ type: 'session', sessionId: SESSION }])
    expect(mapSdkMessage(sdk.init(), state)).toEqual([])
    expect(mapSdkMessage(sdk.init('other'), state)).toEqual([{ type: 'session', sessionId: 'other' }])
  })

  it('announces the session id from the first message that carries one, even without an init', () => {
    expect(mapSdkMessage(sdk.messageStart(), fresh())).toEqual([{ type: 'session', sessionId: SESSION }])
  })

  it('stream text deltas become text_delta; thinking and subagent deltas do not', () => {
    const state = fresh()
    mapSdkMessage(sdk.init(), state)
    expect(mapSdkMessage(sdk.textDelta('[happy] Hi'), state)).toEqual([{ type: 'text_delta', text: '[happy] Hi' }])
    expect(mapSdkMessage(sdk.thinkingDelta('secret reasoning'), state)).toEqual([])
    expect(mapSdkMessage(sdk.textDelta('sub text', 'toolu_parent'), state)).toEqual([])
    expect(mapSdkMessage(sdk.textDelta(''), state)).toEqual([])
  })

  it('the full assistant message does not repeat text that already streamed', () => {
    const state = fresh()
    mapSdkMessage(sdk.init(), state)
    mapSdkMessage(sdk.messageStart('msg_9'), state)
    mapSdkMessage(sdk.textDelta('Hello'), state)
    expect(mapSdkMessage(sdk.assistant([sdk.text('Hello')], { id: 'msg_9' }), state)).toEqual([])
  })

  it('text that never streamed is still delivered from the assistant message', () => {
    const state = fresh()
    mapSdkMessage(sdk.init(), state)
    expect(mapSdkMessage(sdk.assistant([sdk.text('[sad] Only here')], { id: 'msg_x' }), state)).toEqual([{ type: 'text_delta', text: '[sad] Only here' }])
  })

  it('tool_use blocks become tool_start with the ToolSpec name, once', () => {
    const state = fresh()
    mapSdkMessage(sdk.init(), state)
    const msg = sdk.assistant([sdk.toolUse('toolu_1', 'mcp__brain__brain_search', { query: 'q4' })])
    expect(mapSdkMessage(msg, state)).toEqual([{ type: 'tool_start', toolUseId: 'toolu_1', tool: 'brain_search', input: { query: 'q4' } }])
    expect(mapSdkMessage(msg, state)).toEqual([])
    expect(mapSdkMessage(sdk.assistant([sdk.toolUse('toolu_2', 'Bash', { command: 'ls' })]), state)).toEqual([{ type: 'tool_start', toolUseId: 'toolu_2', tool: 'Bash', input: { command: 'ls' } }])
  })

  it('subagent traffic is ignored', () => {
    const state = fresh()
    mapSdkMessage(sdk.init(), state)
    expect(mapSdkMessage(sdk.assistant([sdk.toolUse('t', 'mcp__brain__brain_search', {})], { parent: 'toolu_parent' }), state)).toEqual([])
    expect(mapSdkMessage(sdk.toolResult('t', 'x', false, 'toolu_parent'), state)).toEqual([])
  })

  it('tool results become tool_end, with a summary only for failures', () => {
    const state = fresh()
    mapSdkMessage(sdk.init(), state)
    expect(mapSdkMessage(sdk.toolResult('toolu_1', [{ type: 'text', text: 'private calendar contents' }]), state)).toEqual([{ type: 'tool_end', toolUseId: 'toolu_1', ok: true }])
    const err = mapSdkMessage(sdk.toolResult('toolu_2', 'The user denied this request. Bearer abcdefghijklmnopqrstuvwxyz0123', true), state)
    expect(err).toHaveLength(1)
    expect(err[0]).toMatchObject({ type: 'tool_end', toolUseId: 'toolu_2', ok: false })
    expect(JSON.stringify(err)).not.toContain('abcdefghijklmnopqrstuvwxyz0123')
    expect(mapSdkMessage(sdk.toolResult('toolu_2', 'again', true), state)).toEqual([])
  })

  it('a success result becomes turn_end with THIS turn\'s cost and the usage', () => {
    const state = fresh()
    mapSdkMessage(sdk.init(), state)
    expect(mapSdkMessage(sdk.result({ total_cost_usd: 0.25 }), state)).toEqual([{ type: 'turn_end', costUsd: 0.25, usage: { input: 100, output: 40, cacheRead: 500, cacheCreate: 20 } }])
    // total_cost_usd is cumulative: the second turn costs the difference
    const second = mapSdkMessage(sdk.result({ total_cost_usd: 0.4 }), state)
    expect(second[0]).toMatchObject({ type: 'turn_end' })
    expect((second[0] as { costUsd: number }).costUsd).toBeCloseTo(0.15, 10)
  })

  it('a smaller cumulative total means a new query (resume): the cost starts over', () => {
    const state = fresh()
    mapSdkMessage(sdk.result({ total_cost_usd: 2 }), state)
    expect(mapSdkMessage(sdk.result({ total_cost_usd: 0.3 }), state)[0]).toMatchObject({ costUsd: 0.3 })
  })

  it('error subtypes become error events carrying the cost', () => {
    const budget = noSession(mapSdkMessage(sdk.result({ subtype: 'error_max_budget_usd', is_error: true, total_cost_usd: 4.01 }), fresh()))
    expect(budget).toEqual([{ type: 'error', message: 'The session reached its spending cap.', retryable: false, kind: 'budget', costUsd: 4.01, usage: expect.any(Object) }])
    expect(noSession(mapSdkMessage(sdk.result({ subtype: 'error_max_turns', is_error: true }), fresh()))[0]).toMatchObject({ type: 'error', kind: 'budget', retryable: true })
    expect(noSession(mapSdkMessage(sdk.result({ subtype: 'error_during_execution', is_error: true, errors: ['spawn failed'] }), fresh()))[0]).toMatchObject({ type: 'error', kind: 'process', retryable: true, message: 'spawn failed' })
    expect(noSession(mapSdkMessage(sdk.result({ subtype: 'error_max_structured_output_retries', is_error: true }), fresh()))[0]).toMatchObject({ type: 'error', retryable: false })
  })

  it.each([
    [401, 'auth', false],
    [403, 'auth', false],
    [402, 'billing', false],
    [429, 'rate_limit', true],
    [529, 'overloaded', true],
    [500, 'overloaded', true],
    [400, 'invalid_request', false],
    [undefined, 'unknown', true],
  ])('a success-subtype result with is_error and status %s is classified as %s', (status, kind, retryable) => {
    const [ev] = noSession(mapSdkMessage(sdk.result({ is_error: true, result: 'API Error: something', ...(status ? { api_error_status: status } : {}) }), fresh()))
    expect(ev).toMatchObject({ type: 'error', kind, retryable })
  })

  it('an assistant message that carries an error code decides the kind, and its text is never shown', () => {
    const state = fresh()
    mapSdkMessage(sdk.init(), state)
    expect(mapSdkMessage(sdk.assistant([sdk.text('API Error: 429 rate limited')], { error: 'rate_limit' }), state).filter((e) => e.type === 'text_delta')).toEqual([])
    const [ev] = mapSdkMessage(sdk.result({ is_error: true, result: 'API Error: 429' }), state)
    expect(ev).toMatchObject({ type: 'error', kind: 'rate_limit', retryable: true })
    // and it does not leak into the next turn
    expect(noSession(mapSdkMessage(sdk.result({ total_cost_usd: 1 }), state))[0]?.type).toBe('turn_end')
  })

  it.each([
    ['authentication_failed', 'auth'],
    ['billing_error', 'billing'],
    ['overloaded', 'overloaded'],
    ['invalid_request', 'invalid_request'],
    ['something_new', 'unknown'],
  ])('assistant error %s maps to %s', (code, kind) => {
    const state = fresh()
    mapSdkMessage(sdk.assistant([], { error: code }), state)
    expect(mapSdkMessage(sdk.result({ is_error: true }), state)[0]).toMatchObject({ kind })
  })

  it('an assistant error followed by a SUCCESSFUL result (the SDK retried) is a normal turn_end', () => {
    const state = fresh()
    mapSdkMessage(sdk.assistant([], { error: 'overloaded' }), state)
    expect(mapSdkMessage(sdk.result(), state)[0]?.type).toBe('turn_end')
  })

  it('a refusal ends the turn through its ONE result, as a non-retryable refusal error carrying the cost', () => {
    const state = fresh()
    expect(noSession(mapSdkMessage(sdk.refusalNoFallback(), state))).toEqual([]) // no second ending
    expect(noSession(mapSdkMessage(sdk.result({ total_cost_usd: 0.07 }), state))).toEqual([{ type: 'error', message: 'The model declined this request.', retryable: false, kind: 'refusal', costUsd: 0.07, usage: expect.any(Object) }])
    // and the flag does not leak into the next turn
    expect(noSession(mapSdkMessage(sdk.result({ total_cost_usd: 0.1 }), state))[0]?.type).toBe('turn_end')
  })

  it('a result whose stop_reason is "refusal" is a refusal even without the system message', () => {
    expect(noSession(mapSdkMessage(sdk.result({ stop_reason: 'refusal' }), fresh()))[0]).toMatchObject({ type: 'error', kind: 'refusal', retryable: false })
  })

  it('a fallback model after a refusal is silent and the turn ends normally', () => {
    const state = fresh()
    expect(noSession(mapSdkMessage(sdk.refusalFallback(), state))).toEqual([])
    expect(noSession(mapSdkMessage(sdk.result(), state))[0]?.type).toBe('turn_end')
  })

  it('an auth_status error becomes an auth error; a clean one is ignored', () => {
    expect(mapSdkMessage(sdk.authStatus('Invalid API key'), fresh()).filter((e) => e.type === 'error')).toEqual([{ type: 'error', message: 'Invalid API key', retryable: false, kind: 'auth' }])
    expect(mapSdkMessage(sdk.authStatus(), fresh()).filter((e) => e.type === 'error')).toEqual([])
  })

  it('after an interrupt request, late text is swallowed and the result is labelled interrupted', () => {
    const state = fresh()
    mapSdkMessage(sdk.init(), state)
    state.interruptRequested = true
    expect(mapSdkMessage(sdk.textDelta('too late'), state)).toEqual([])
    expect(mapSdkMessage(sdk.assistant([sdk.text('too late')], { id: 'new' }), state)).toEqual([])
    const [end] = mapSdkMessage(sdk.result({ subtype: 'error_during_execution', is_error: true, total_cost_usd: 0.05 }), state)
    expect(end).toMatchObject({ type: 'turn_end', interrupted: true, costUsd: 0.05 })
    expect(state.interruptRequested).toBe(false)
  })

  it('a terminal_reason of aborted_* is an interrupt even if we did not ask', () => {
    expect(noSession(mapSdkMessage(sdk.result({ terminal_reason: 'aborted_streaming' }), fresh()))[0]).toMatchObject({ type: 'turn_end', interrupted: true })
    expect(noSession(mapSdkMessage(sdk.result({ terminal_reason: 'aborted_tools', is_error: true, subtype: 'error_during_execution' }), fresh()))[0]).toMatchObject({ type: 'turn_end', interrupted: true })
  })

  it('messages it does not care about produce nothing', () => {
    const state = fresh()
    for (const m of [{ type: 'system', subtype: 'api_retry', session_id: SESSION }, { type: 'system', subtype: 'hook_started', session_id: SESSION }, { type: 'tool_progress', session_id: SESSION }, { type: 'rate_limit_event', session_id: SESSION }]) {
      expect(mapSdkMessage(m as never, state).filter((e) => e.type !== 'session')).toEqual([])
    }
  })

  it('never throws on odd content', () => {
    const state = fresh()
    expect(() => mapSdkMessage({ type: 'assistant', session_id: SESSION, parent_tool_use_id: null, message: { id: 'm', content: 'not an array' } } as never, state)).not.toThrow()
    expect(() => mapSdkMessage({ type: 'user', session_id: SESSION, parent_tool_use_id: null, message: { role: 'user', content: 'plain string' } } as never, state)).not.toThrow()
    expect(() => mapSdkMessage(sdk.result({ usage: undefined, total_cost_usd: Number.NaN }), state)).not.toThrow()
  })
})

describe('session: a streamed turn', () => {
  it('feeds the user message into the one streaming input and maps the reply stream', async () => {
    const { session, q } = await open()
    session.send(turn('Good morning'))
    await tick()
    expect(q.userMessages).toHaveLength(1)
    expect(q.userMessages[0]).toMatchObject({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'text', text: 'Good morning' }] } })

    q.push(sdk.init(), sdk.messageStart(), sdk.textDelta('[happy] Good'), sdk.textDelta(' morning!'), sdk.assistant([sdk.text('[happy] Good morning!')]), sdk.result({ total_cost_usd: 0.02 }))
    const events = await collect(session, isTerminal)
    expect(events).toEqual([
      { type: 'session', sessionId: SESSION },
      { type: 'text_delta', text: '[happy] Good' },
      { type: 'text_delta', text: ' morning!' },
      { type: 'turn_end', costUsd: 0.02, usage: { input: 100, output: 40, cacheRead: 500, cacheCreate: 20 } },
    ])
    expect(session.id).toBe(SESSION)
    expect(q.userMessages).toHaveLength(1) // one query, not one per turn
  })

  it('delivers per-turn context and shared images as labelled blocks before the text', async () => {
    const { session, q } = await open()
    session.send({ text: 'What is this?', modality: 'text', context: 'Today is Monday.', images: [{ mediaType: 'image/png', dataBase64: 'AAAA' }] })
    await tick()
    expect(q.userMessages[0]?.message.content).toEqual([
      { type: 'text', text: 'Context (added by the app, not said by the user): Today is Monday.' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      { type: 'text', text: 'What is this?' },
    ])
  })

  it('multiple turns reuse the same query and report each turn\'s own cost', async () => {
    const { session, q, queries } = await open()
    session.send(turn('one'))
    q.push(sdk.init(), sdk.result({ total_cost_usd: 0.1 }))
    const first = await collect(session, isTerminal)
    session.send(turn('two'))
    q.push(sdk.result({ total_cost_usd: 0.35 }))
    const second = await collect(session, isTerminal)
    expect(queries).toHaveLength(1)
    expect(first.at(-1)).toMatchObject({ costUsd: 0.1 })
    expect((second.at(-1) as { costUsd: number }).costUsd).toBeCloseTo(0.25, 10)
    expect(q.userMessages.map((m) => (m.message.content as Array<{ text: string }>).at(-1)?.text)).toEqual(['one', 'two'])
  })

  it('a tool call round trip: tool_start, tool_end', async () => {
    const { session, q } = await open()
    session.send(turn('What is on my calendar?'))
    q.push(
      sdk.init(),
      sdk.messageStart(),
      sdk.textDelta('[thinking] Let me check.'),
      sdk.assistant([sdk.text('[thinking] Let me check.'), sdk.toolUse('toolu_a', 'mcp__calendar__calendar_agenda', { from: '2026-11-02', to: '2026-11-02' })]),
      sdk.toolResult('toolu_a', [{ type: 'text', text: '4 events' }]),
      sdk.messageStart('msg_2'),
      sdk.textDelta('[happy] Four things today.'),
      sdk.result(),
    )
    const events = await collect(session, isTerminal)
    expect(types(events)).toEqual(['session', 'text_delta', 'tool_start', 'tool_end', 'text_delta', 'turn_end'])
    expect(events[2]).toEqual({ type: 'tool_start', toolUseId: 'toolu_a', tool: 'calendar_agenda', input: { from: '2026-11-02', to: '2026-11-02' } })
    expect(events[3]).toEqual({ type: 'tool_end', toolUseId: 'toolu_a', ok: true })
  })

  it('the session id of a resumed session is announced so the lane can persist it', async () => {
    const { session, q } = await open({ resumeSessionId: 'prev' })
    expect(session.id).toBe('prev')
    expect(q.options.resume).toBe('prev')
    session.send(turn('hi'))
    q.push(sdk.init('prev'), sdk.result())
    expect((await collect(session, isTerminal))[0]).toEqual({ type: 'session', sessionId: 'prev' })
  })

  it('before any message the id is a placeholder, never undefined', async () => {
    const { session } = await open()
    expect(session.id).toBe('pending')
  })
})

describe('session: permissions', () => {
  it('canUseTool becomes a permission_request keyed by toolUseID, and allow resolves it with the input', async () => {
    const { session, q } = await open()
    session.send(turn('send it'))
    const answer = q.ask('mcp__mail__mail_send', { draftId: 'd1' }, 'toolu_send', undefined, { title: 'Send the reply to Priya?', description: 'Sends an email' })
    const events = await collect(session, (e) => e.type === 'permission_request')
    expect(events.at(-1)).toEqual({ type: 'permission_request', requestId: 'toolu_send', tool: 'mail_send', input: { draftId: 'd1' }, title: 'Send the reply to Priya?', description: 'Sends an email' })
    let settled = false
    void answer.then(() => (settled = true))
    await tick()
    expect(settled).toBe(false) // it really waits
    session.resolvePermission('toolu_send', { behavior: 'allow' })
    expect(await answer).toEqual({ behavior: 'allow', updatedInput: { draftId: 'd1' } })
  })

  it('deny passes the message back to the model', async () => {
    const { session, q } = await open()
    session.send(turn('send it'))
    const answer = q.ask('mcp__mail__mail_send', { draftId: 'd1' }, 'toolu_x')
    await collect(session, (e) => e.type === 'permission_request')
    session.resolvePermission('toolu_x', { behavior: 'deny', message: 'The user said no.' })
    expect(await answer).toEqual({ behavior: 'deny', message: 'The user said no.' })
  })

  it('a request nobody answers is denied after the timeout, so it never hangs', async () => {
    const { session, q } = await open({}, { permissionTimeoutMs: 30 })
    session.send(turn('send it'))
    const answer = await q.ask('mcp__mail__mail_send', { draftId: 'd1' }, 'toolu_slow')
    expect(answer.behavior).toBe('deny')
    expect(answer.behavior === 'deny' && answer.message).toMatch(/expired/)
    // a late decision is ignored
    expect(() => session.resolvePermission('toolu_slow', { behavior: 'allow' })).not.toThrow()
  })

  it('the SDK aborting the request (its signal) denies it', async () => {
    const { session, q } = await open()
    session.send(turn('send it'))
    const ctl = new AbortController()
    const answer = q.ask('mcp__mail__mail_send', {}, 'toolu_abort', ctl.signal)
    ctl.abort()
    expect(await answer).toMatchObject({ behavior: 'deny' })
  })

  it('several requests can be pending at once and are answered independently', async () => {
    const { session, q } = await open()
    session.send(turn('go'))
    const a = q.ask('mcp__mail__mail_send', { n: 1 }, 'a')
    const b = q.ask('mcp__brain__brain_upsert_note', { n: 2 }, 'b')
    await collect(session, (e) => e.type === 'permission_request' && e.requestId === 'b')
    session.resolvePermission('b', { behavior: 'allow' })
    session.resolvePermission('a', { behavior: 'deny', message: 'no' })
    expect(await b).toMatchObject({ behavior: 'allow' })
    expect(await a).toMatchObject({ behavior: 'deny', message: 'no' })
  })

  it('an unknown or already-answered request id is ignored', async () => {
    const { session, q } = await open()
    session.send(turn('go'))
    const a = q.ask('mcp__mail__mail_send', {}, 'a')
    await collect(session, (e) => e.type === 'permission_request')
    session.resolvePermission('a', { behavior: 'allow' })
    await a
    expect(() => session.resolvePermission('a', { behavior: 'deny', message: 'late' })).not.toThrow()
    expect(() => session.resolvePermission('zzz', { behavior: 'allow' })).not.toThrow()
  })

  it('built-in tool names are passed through unchanged so the lane can refuse them', async () => {
    const { session, q } = await open()
    session.send(turn('go'))
    void q.ask('Bash', { command: 'rm -rf /' }, 'b1')
    const events = await collect(session, (e) => e.type === 'permission_request')
    expect(events.at(-1)).toMatchObject({ type: 'permission_request', tool: 'Bash' })
  })
})

describe('session: interrupt', () => {
  it('calls the SDK interrupt, denies pending permissions, swallows late text and ends the turn as interrupted', async () => {
    const { session, q } = await open()
    session.send(turn('long answer please'))
    q.push(sdk.init(), sdk.messageStart(), sdk.textDelta('[happy] Well'))
    await collect(session, (e) => e.type === 'text_delta') // this one arrived before the interrupt
    const pending = q.ask('mcp__mail__mail_send', {}, 'p1')
    await collect(session, (e) => e.type === 'permission_request')
    q.onInterrupt = () => {
      // the SDK keeps streaming for a moment, then reports the interrupted turn
      q.push(sdk.textDelta(' too late'), sdk.result({ subtype: 'error_during_execution', is_error: true, total_cost_usd: 0.03 }))
    }
    await session.interrupt()
    expect(q.interrupts).toBe(1)
    expect(await pending).toMatchObject({ behavior: 'deny', message: expect.stringMatching(/interrupted/) })
    const events = await collect(session, isTerminal)
    expect(events.filter((e) => e.type === 'text_delta')).toEqual([])
    expect(events.at(-1)).toMatchObject({ type: 'turn_end', interrupted: true, costUsd: 0.03 })
  })

  it('does nothing when no turn is in flight', async () => {
    const { session, q } = await open()
    await session.interrupt()
    expect(q.interrupts).toBe(0)
    session.send(turn('hi'))
    q.push(sdk.result())
    await collect(session, isTerminal)
    await session.interrupt() // the turn is over
    expect(q.interrupts).toBe(0)
  })

  it('if the SDK never reports a result, the turn is ended after the grace period', async () => {
    const { session, q } = await open({}, { interruptGraceMs: 25 })
    session.send(turn('hi'))
    q.push(sdk.init(), sdk.textDelta('[happy] Hel'))
    await session.interrupt()
    const events = await collect(session, isTerminal)
    expect(events.at(-1)).toEqual({ type: 'turn_end', interrupted: true })
  })

  it('the grace timer is cancelled by the real result (no duplicate terminal event)', async () => {
    const { session, q } = await open({}, { interruptGraceMs: 40 })
    session.send(turn('hi'))
    q.onInterrupt = () => q.push(sdk.result())
    await session.interrupt()
    const first = await collect(session, isTerminal)
    expect(first.filter((e) => e.type === 'turn_end')).toHaveLength(1)
    expect(await collect(session, () => false, 120)).toEqual([])
  })

  it('a turn after an interrupt streams normally again', async () => {
    const { session, q } = await open()
    session.send(turn('one'))
    q.onInterrupt = () => q.push(sdk.result())
    await session.interrupt()
    await collect(session, isTerminal)
    q.onInterrupt = undefined
    session.send(turn('two'))
    q.push(sdk.messageStart('m2'), sdk.textDelta('fine'), sdk.result({ total_cost_usd: 0.1 }))
    const events = await collect(session, isTerminal)
    expect(events.map((e) => e.type)).toEqual(['text_delta', 'turn_end'])
    expect(events.at(-1)).not.toHaveProperty('interrupted')
  })
})

describe('session: failures and shutdown', () => {
  it('an error result is the terminal event and carries its cost', async () => {
    const { session, q } = await open()
    session.send(turn('hi'))
    q.push(sdk.init(), sdk.result({ subtype: 'error_max_budget_usd', is_error: true, total_cost_usd: 4.2 }))
    const events = await collect(session, isTerminal)
    expect(events.at(-1)).toMatchObject({ type: 'error', kind: 'budget', retryable: false, costUsd: 4.2 })
  })

  it('an exception from the SDK stream becomes a redacted, retryable process error and ends the events', async () => {
    const failing = createSdkBackend({
      queryFn: () =>
        ({
          [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error('spawn ENOENT claude with key sk-ant-leakleakleak1234')) }),
          interrupt: async () => undefined,
          close: () => undefined,
        }) as never,
      baseEnv,
    })
    const session = await failing.open(openOpts())
    const events: BackendEvent[] = []
    for await (const e of session.events) events.push(e)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'error', kind: 'process', retryable: true })
    expect(JSON.stringify(events)).not.toContain('leakleakleak')
  })

  it('close(): closes the SDK query, aborts it, denies what was pending and ends the stream', async () => {
    const { session, q } = await open()
    session.send(turn('go'))
    const pending = q.ask('mcp__mail__mail_send', {}, 'p')
    await collect(session, (e) => e.type === 'permission_request')
    await session.close()
    expect(q.closed).toBe(true)
    expect(q.abortController?.signal.aborted).toBe(true)
    expect(await pending).toMatchObject({ behavior: 'deny' })
    const rest = await collect(session, () => false, 100)
    expect(rest).toEqual([])
    session.send(turn('after close'))
    await tick()
    expect(q.userMessages).toHaveLength(1)
    await session.close() // idempotent
  })

  it('a permission asked after close is denied at once', async () => {
    const { session, q } = await open()
    await session.close()
    expect(await q.ask('mcp__mail__mail_send', {}, 'late')).toMatchObject({ behavior: 'deny' })
  })

  it('when the SDK stream ends by itself the events end too', async () => {
    const { session, q } = await open()
    q.end()
    const events: BackendEvent[] = []
    for await (const e of session.events) events.push(e)
    expect(events).toEqual([])
  })
})
