/**
 * Builders for SDKMessage-shaped objects and a scripted stand-in for the SDK's query(). The real SDK needs a key and
 * the network; these follow the shapes in sdk.d.ts (SDKSystemMessage, SDKPartialAssistantMessage, SDKAssistantMessage,
 * SDKUserMessage, SDKResultMessage) closely enough for the mapper and the session to be exercised for real.
 */
import type { CanUseTool, Options, PermissionResult, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { AsyncQueue } from '../src/util'

let uuidCounter = 0
const uuid = (): `${string}-${string}-${string}-${string}-${string}` => `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, '0')}` as never

export const SESSION = 'sess-0001'

const asMsg = (m: unknown): SDKMessage => m as SDKMessage

export const sdk = {
  init: (sessionId = SESSION): SDKMessage =>
    asMsg({ type: 'system', subtype: 'init', session_id: sessionId, uuid: uuid(), apiKeySource: 'ANTHROPIC_API_KEY', claude_code_version: '2.1.300', cwd: '/work', tools: [], mcp_servers: [], model: 'claude-sonnet-5-5', permissionMode: 'default', slash_commands: [], output_style: 'default', skills: [], plugins: [] }),

  messageStart: (id = 'msg_1'): SDKMessage =>
    asMsg({ type: 'stream_event', session_id: SESSION, uuid: uuid(), parent_tool_use_id: null, event: { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } } }),

  textDelta: (text: string, parent: string | null = null): SDKMessage =>
    asMsg({ type: 'stream_event', session_id: SESSION, uuid: uuid(), parent_tool_use_id: parent, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } }),

  thinkingDelta: (thinking: string): SDKMessage =>
    asMsg({ type: 'stream_event', session_id: SESSION, uuid: uuid(), parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking } } }),

  assistant: (content: unknown[], opts: { id?: string; error?: string; parent?: string | null } = {}): SDKMessage =>
    asMsg({ type: 'assistant', session_id: SESSION, uuid: uuid(), parent_tool_use_id: opts.parent ?? null, ...(opts.error ? { error: opts.error } : {}), message: { id: opts.id ?? 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content, stop_reason: null, usage: { input_tokens: 10, output_tokens: 5 } } }),

  toolUse: (id: string, name: string, input: unknown) => ({ type: 'tool_use', id, name, input }),
  text: (text: string) => ({ type: 'text', text }),

  toolResult: (toolUseId: string, content: unknown, isError = false, parent: string | null = null): SDKMessage =>
    asMsg({ type: 'user', session_id: SESSION, uuid: uuid(), parent_tool_use_id: parent, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content, ...(isError ? { is_error: true } : {}) }] } }),

  result: (over: Record<string, unknown> = {}): SDKMessage =>
    asMsg({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1200, duration_api_ms: 1000, num_turns: 1, result: 'ok', stop_reason: 'end_turn', total_cost_usd: 0.01, usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 500, cache_creation_input_tokens: 20 }, modelUsage: {}, permission_denials: [], uuid: uuid(), session_id: SESSION, ...over }),

  refusalNoFallback: (): SDKMessage => asMsg({ type: 'system', subtype: 'model_refusal_no_fallback', original_model: 'claude-sonnet-5-5', request_id: null, content: 'refused', uuid: uuid(), session_id: SESSION }),
  refusalFallback: (): SDKMessage => asMsg({ type: 'system', subtype: 'model_refusal_fallback', trigger: 'refusal', direction: 'retry', original_model: 'a', fallback_model: 'b', request_id: null, content: 'x', uuid: uuid(), session_id: SESSION }),
  authStatus: (error?: string): SDKMessage => asMsg({ type: 'auth_status', isAuthenticating: false, output: [], ...(error ? { error } : {}), uuid: uuid(), session_id: SESSION }),
}

/** A stand-in for Query: the test pushes SDK messages, and records what the backend asked of it. */
export class ScriptedQuery {
  readonly out = new AsyncQueue<SDKMessage>()
  readonly userMessages: SDKUserMessage[] = []
  interrupts = 0
  closed = false
  /** Called when interrupt() is invoked; tests use it to script the SDK's reaction. */
  onInterrupt: (() => void) | undefined
  canUseTool: CanUseTool | undefined
  abortController: AbortController | undefined

  constructor(readonly params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) {
    this.canUseTool = params.options?.canUseTool
    this.abortController = params.options?.abortController
    if (typeof params.prompt !== 'string') {
      void (async () => {
        for await (const m of params.prompt as AsyncIterable<SDKUserMessage>) this.userMessages.push(m)
      })()
    }
  }

  get options(): Options {
    return this.params.options ?? {}
  }

  push(...msgs: SDKMessage[]): void {
    for (const m of msgs) this.out.push(m)
  }
  end(): void {
    this.out.end()
  }
  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return this.out[Symbol.asyncIterator]()
  }
  async interrupt(): Promise<undefined> {
    this.interrupts++
    this.onInterrupt?.()
    return undefined
  }
  close(): void {
    this.closed = true
    this.out.end()
  }
  /** Ask the backend whether a tool may run, the way the SDK's CLI does. */
  ask(toolName: string, input: Record<string, unknown>, toolUseID: string, signal: AbortSignal = new AbortController().signal, extra: Record<string, unknown> = {}): Promise<PermissionResult> {
    if (!this.canUseTool) throw new Error('no canUseTool was passed')
    return this.canUseTool(toolName, input, { signal, toolUseID, requestId: `ctl-${toolUseID}`, ...extra }) as Promise<PermissionResult>
  }
}

export function scriptedQueryFn(): { queryFn: (p: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) => Query; queries: ScriptedQuery[] } {
  const queries: ScriptedQuery[] = []
  return {
    queries,
    queryFn: (params) => {
      const q = new ScriptedQuery(params)
      queries.push(q)
      return q as unknown as Query
    },
  }
}
