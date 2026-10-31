/**
 * The real backend: one long-lived streaming-input query on the Claude Agent SDK.
 *
 * Design (docs/ARCHITECTURE.md section 4, ADR 0001, ADR 0005):
 *  - ONE query() for the life of the session. send() feeds an AsyncIterable of SDKUserMessage; the SDK stream is
 *    mapped to BackendEvents by the pure function mapSdkMessage().
 *  - No built-in tools (tools: []). The only tools are the lane's ToolBindings, served by in-process SDK MCP servers
 *    and named mcp__<server>__<tool>. Locked tools and tools the lane may not use are never registered.
 *  - settingSources: [] and strictMcpConfig: isolation. No user hooks, CLAUDE.md, skills or claude.ai connectors.
 *  - Tools in autoAllow (default tiers T0 and T1) are pre-approved through allowedTools. Every other registered tool
 *    reaches canUseTool, which becomes a permission_request and waits for resolvePermission. An unanswered request
 *    is denied after permissionTimeoutMs so the turn can never hang forever.
 *  - Auth: api-key puts the key in the child environment (env REPLACES the child's environment in the SDK, so the
 *    parent's environment is spread in explicitly). local-login injects nothing and never reads any credential file;
 *    it only makes sure a stray ANTHROPIC_API_KEY in the daemon's environment does not override the user's login.
 *
 * Nothing in this file has been run against the live API (no key, no network where it was written). It is written
 * against the types in sdk.d.ts and covered by tests that inject a fake query function.
 */
import type { CanUseTool, Options, PermissionResult, Query, SDKMessage, SDKUserMessage, SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import type { AgentBackend, AgentSession, BackendErrorKind, BackendEvent, OpenSessionOptions, PermissionDecision, TokenUsage, ToolBinding, UserTurn } from '@ai-assistant/shared'
import { AsyncQueue, BackendError, errorText, isAutoTier, oneLine, rawShapeOf, redactSecrets, truncate } from './util'

type SdkModule = typeof import('@anthropic-ai/claude-agent-sdk')
export type SdkQueryFn = (params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) => Query
type ContentBlock = Exclude<SDKUserMessage['message']['content'], string>[number]

export interface SdkBackendOptions {
  /** Replaces the SDK's query(). Tests inject a fake async generator here. */
  queryFn?: SdkQueryFn
  /** Replaces the parts of the SDK module used to build MCP servers. Default: the real module, loaded lazily. */
  sdk?: Pick<SdkModule, 'createSdkMcpServer' | 'tool'>
  /** How long a permission_request may wait for a human before it is denied. Default 10 minutes. */
  permissionTimeoutMs?: number
  /** After interrupt(), how long to wait for the SDK's result before ending the turn ourselves. Default 4 s. */
  interruptGraceMs?: number
  /** Cap on conversation turns for the whole query. Unset by default: the session is meant to be long-lived. */
  maxTurns?: number
  /** The environment the child inherits. Default: process.env. */
  baseEnv?: Record<string, string | undefined>
}

// ------------------------------------------------------------------ tools

/** The SDK's name for a tool: mcp__<server>__<tool>. */
export const mcpToolName = (spec: Pick<ToolBinding['spec'], 'server' | 'name'>): string => `mcp__${spec.server}__${spec.name}`

export interface McpToolEntry {
  server: string
  specName: string
  sdkName: string
  definition: SdkMcpToolDefinition<any>
}

type SdkToolFn = (name: string, description: string, shape: unknown, handler: (args: unknown, extra: unknown) => Promise<unknown>, extras?: unknown) => SdkMcpToolDefinition<any>

/**
 * Bindings to SDK MCP tool definitions. Tools that must not exist for this lane are dropped here, as a second line of
 * defence behind the lane's own filter: locked tools, and tools whose spec does not list the lane.
 */
export function buildMcpToolEntries(tools: ToolBinding[], lane: OpenSessionOptions['lane'], sdkTool: SdkToolFn): McpToolEntry[] {
  const out: McpToolEntry[] = []
  for (const binding of tools) {
    const { spec } = binding
    if (spec.locked) continue
    if (!(spec.lanes as readonly string[]).includes(lane)) continue
    const shape = rawShapeOf(spec.input)
    if (!shape) throw new Error(`sdk-backend: tool "${spec.name}" needs a zod object as its input schema`)
    const definition = sdkTool(
      spec.name,
      spec.description,
      shape,
      async (args: unknown) => {
        const parsed = spec.input.safeParse(args ?? {})
        if (!parsed.success) return { content: [{ type: 'text' as const, text: `Invalid input for ${spec.name}.` }], isError: true }
        try {
          const r = await binding.handler(parsed.data)
          return { content: [{ type: 'text' as const, text: r.text }], ...(r.isError ? { isError: true } : {}) }
        } catch {
          return { content: [{ type: 'text' as const, text: `${spec.name} failed.` }], isError: true }
        }
      },
      { annotations: { readOnlyHint: spec.readOnly, openWorldHint: false } },
    )
    out.push({ server: spec.server, specName: spec.name, sdkName: mcpToolName(spec), definition })
  }
  return out
}

// ------------------------------------------------------------------ environment

export interface SdkEnvInput {
  authMode: OpenSessionOptions['authMode']
  apiKey?: string
  baseEnv: Record<string, string | undefined>
}

/**
 * The child process environment. The SDK REPLACES the child's environment with whatever `env` is, so the daemon's own
 * environment is spread in (PATH, HOME, proxy settings...).
 */
export function buildSdkEnv(input: SdkEnvInput): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...input.baseEnv }
  if (input.authMode === 'api-key') {
    if (!input.apiKey) throw new BackendError('No Anthropic API key is configured. Add one in Settings, or switch the connection to your local login.', 'auth', false)
    env.ANTHROPIC_API_KEY = input.apiKey
    // The key is the only credential this child should see.
    delete env.ANTHROPIC_AUTH_TOKEN
    delete env.CLAUDE_CODE_OAUTH_TOKEN
  } else {
    // local-login: the user's own `claude` binary uses its own login. We inject nothing and read nothing; we only make
    // sure a key that happens to be in the daemon's environment does not silently switch billing to the API.
    delete env.ANTHROPIC_API_KEY
    delete env.ANTHROPIC_AUTH_TOKEN
  }
  env.CLAUDE_AGENT_SDK_CLIENT_APP = 'ai-assistant/0.0.0'
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1' // one memory system: ours
  env.ENABLE_CLAUDEAI_MCP_SERVERS = 'false' // no claude.ai connectors
  return env
}

// ------------------------------------------------------------------ message mapping

export interface SdkMapState {
  sessionId?: string
  /** SDK tool name to ToolSpec name, so events carry the names the rest of the app uses. */
  toolNames: Map<string, string>
  /** Assistant message ids whose text already arrived as stream events (so the full message must not repeat it). */
  streamedMessages: Set<string>
  startedTools: Set<string>
  endedTools: Set<string>
  /** Cumulative total_cost_usd already attributed to earlier turns. */
  costTotal: number
  /** interrupt() was called: swallow late text and label the next result as interrupted. */
  interruptRequested: boolean
  /** The error code an assistant message carried; the turn's result turns it into the terminal error. */
  assistantError?: string
  /** The model refused and no fallback ran; the turn's result turns it into the terminal error. */
  refused?: boolean
}

export function createSdkMapState(toolNames: Iterable<[string, string]> = []): SdkMapState {
  return {
    toolNames: new Map(toolNames),
    streamedMessages: new Set(),
    startedTools: new Set(),
    endedTools: new Set(),
    costTotal: 0,
    interruptRequested: false,
  }
}

const toTokenUsage = (usage: unknown): TokenUsage | undefined => {
  if (typeof usage !== 'object' || usage === null) return undefined
  const u = usage as Record<string, unknown>
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const out: TokenUsage = { input: n(u.input_tokens), output: n(u.output_tokens) }
  if (u.cache_read_input_tokens !== undefined) out.cacheRead = n(u.cache_read_input_tokens)
  if (u.cache_creation_input_tokens !== undefined) out.cacheCreate = n(u.cache_creation_input_tokens)
  return out
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((b) => (typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'text' ? String((b as { text?: unknown }).text ?? '') : ''))
    .join(' ')
}

interface Classified {
  kind: BackendErrorKind
  retryable: boolean
}

/** SDKAssistantMessageError codes to our kinds. */
function classifyAssistantError(code: string): Classified {
  switch (code) {
    case 'authentication_failed':
    case 'oauth_org_not_allowed':
    case 'verification_required':
    case 'cloud_credential_error':
      return { kind: 'auth', retryable: false }
    case 'billing_error':
    case 'account_on_hold':
      return { kind: 'billing', retryable: false }
    case 'rate_limit':
      return { kind: 'rate_limit', retryable: true }
    case 'overloaded':
    case 'server_error':
      return { kind: 'overloaded', retryable: true }
    case 'invalid_request':
    case 'model_not_found':
    case 'max_output_tokens':
      return { kind: 'invalid_request', retryable: false }
    default:
      return { kind: 'unknown', retryable: true }
  }
}

function classifyStatus(status: number | null | undefined): Classified | undefined {
  if (typeof status !== 'number') return undefined
  if (status === 401 || status === 403) return { kind: 'auth', retryable: false }
  if (status === 402) return { kind: 'billing', retryable: false }
  if (status === 429) return { kind: 'rate_limit', retryable: true }
  if (status >= 500) return { kind: 'overloaded', retryable: true }
  if (status >= 400) return { kind: 'invalid_request', retryable: false }
  return undefined
}

function errorText200(text: string): string {
  return truncate(redactSecrets(oneLine(text)), 200)
}

/**
 * Map one SDK message to zero or more BackendEvents. Pure apart from `state`, which carries what has to be
 * remembered across messages (dedupe sets, the cumulative cost, the interrupt flag).
 *
 *   system init            -> session
 *   stream_event text      -> text_delta        (thinking is never surfaced; subagent traffic is ignored)
 *   assistant tool_use     -> tool_start
 *   user tool_result       -> tool_end          (a summary only for failures: results may hold private content)
 *   result                 -> turn_end with this turn's cost and usage, or error
 *   refusal (via the result), auth failure -> error
 *
 * Every turn ends with exactly one terminal event (turn_end or error).
 */
export function mapSdkMessage(msg: SDKMessage, state: SdkMapState): BackendEvent[] {
  const out: BackendEvent[] = []
  const sid = (msg as { session_id?: unknown }).session_id
  if (typeof sid === 'string' && sid && sid !== state.sessionId) {
    state.sessionId = sid
    out.push({ type: 'session', sessionId: sid })
  }

  switch (msg.type) {
    case 'system': {
      // A refusal does not end the turn by itself: the CLI still sends this turn's result, and that one result is
      // the terminal event. Emitting an error here as well would give one turn two endings, and the late second one
      // could end the NEXT turn.
      if (msg.subtype === 'model_refusal_no_fallback') state.refused = true
      return out
    }

    case 'auth_status': {
      if (msg.error) out.push({ type: 'error', message: errorText200(msg.error), retryable: false, kind: 'auth' })
      return out
    }

    case 'stream_event': {
      if (msg.parent_tool_use_id) return out
      const ev = msg.event
      if (ev.type === 'message_start') {
        state.streamedMessages.add(ev.message.id)
      } else if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta' && ev.delta.text && !state.interruptRequested) {
        out.push({ type: 'text_delta', text: ev.delta.text })
      }
      return out
    }

    case 'assistant': {
      if (msg.parent_tool_use_id) return out
      if (msg.error) state.assistantError = msg.error
      const content = Array.isArray(msg.message.content) ? msg.message.content : []
      for (const block of content) {
        if (block.type === 'text') {
          // Fallback for text that never streamed (the partial-message events can be absent). An assistant message
          // that carries an error holds an API error string, not something she said.
          if (!msg.error && block.text && !state.streamedMessages.has(msg.message.id) && !state.interruptRequested) out.push({ type: 'text_delta', text: block.text })
        } else if (block.type === 'tool_use') {
          if (state.startedTools.has(block.id)) continue
          state.startedTools.add(block.id)
          out.push({ type: 'tool_start', toolUseId: block.id, tool: state.toolNames.get(block.name) ?? block.name, input: block.input })
        }
      }
      return out
    }

    case 'user': {
      if (msg.parent_tool_use_id) return out
      const content = msg.message.content
      if (!Array.isArray(content)) return out
      for (const block of content) {
        if (typeof block !== 'object' || block === null || block.type !== 'tool_result') continue
        if (state.endedTools.has(block.tool_use_id)) continue
        state.endedTools.add(block.tool_use_id)
        const ok = block.is_error !== true
        const summary = ok ? undefined : truncate(redactSecrets(oneLine(toolResultText(block.content))), 160)
        out.push({ type: 'tool_end', toolUseId: block.tool_use_id, ok, ...(summary ? { summary } : {}) })
      }
      return out
    }

    case 'result': {
      const total = Number.isFinite(msg.total_cost_usd) ? msg.total_cost_usd : state.costTotal
      // total_cost_usd is cumulative for the query() call; a smaller number means a new query (resume), so start over.
      const costUsd = Math.max(0, total >= state.costTotal ? total - state.costTotal : total)
      state.costTotal = total
      const usage = toTokenUsage(msg.usage)
      const interrupted = state.interruptRequested || msg.terminal_reason === 'aborted_streaming' || msg.terminal_reason === 'aborted_tools'
      state.interruptRequested = false
      const assistantError = state.assistantError
      state.assistantError = undefined
      const refused = state.refused === true || msg.stop_reason === 'refusal'
      state.refused = false

      if (interrupted) {
        out.push({ type: 'turn_end', costUsd, ...(usage ? { usage } : {}), interrupted: true })
        return out
      }
      if (refused) {
        out.push({ type: 'error', message: 'The model declined this request.', retryable: false, kind: 'refusal', costUsd, ...(usage ? { usage } : {}) })
        return out
      }
      if (msg.subtype === 'success' && !msg.is_error) {
        out.push({ type: 'turn_end', costUsd, ...(usage ? { usage } : {}) })
        return out
      }

      let cls: Classified
      let message: string
      switch (msg.subtype) {
        case 'error_max_budget_usd':
          cls = { kind: 'budget', retryable: false }
          message = 'The session reached its spending cap.'
          break
        case 'error_max_turns':
          cls = { kind: 'budget', retryable: true }
          message = 'The session reached its turn limit.'
          break
        case 'error_max_structured_output_retries':
          cls = { kind: 'unknown', retryable: false }
          message = 'The model could not produce the requested structured output.'
          break
        case 'error_during_execution':
          cls = assistantError ? classifyAssistantError(assistantError) : { kind: 'process', retryable: true }
          message = errorText200(msg.errors?.[0] ?? 'The Claude session failed while running.')
          break
        default: {
          // The success subtype with is_error set: an API error surfaced as the result text.
          cls = (assistantError ? classifyAssistantError(assistantError) : undefined) ?? classifyStatus(msg.api_error_status) ?? { kind: 'unknown', retryable: true }
          message = errorText200(msg.result || 'The model call failed.')
        }
      }
      out.push({ type: 'error', message, retryable: cls.retryable, kind: cls.kind, costUsd, ...(usage ? { usage } : {}) })
      return out
    }

    default:
      return out
  }
}

// ------------------------------------------------------------------ the session

interface PendingPermission {
  resolve(result: PermissionResult): void
  timer: ReturnType<typeof setTimeout>
  input: Record<string, unknown>
  signal: AbortSignal
  onAbort(): void
}

function toUserMessage(turn: UserTurn): SDKUserMessage {
  const content: ContentBlock[] = []
  if (turn.context) content.push({ type: 'text', text: `Context (added by the app, not said by the user): ${turn.context}` })
  for (const img of turn.images ?? []) content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.dataBase64 } })
  content.push({ type: 'text', text: turn.text })
  return { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null }
}

class SdkSession implements AgentSession {
  readonly events: AsyncIterable<BackendEvent>
  private readonly out = new AsyncQueue<BackendEvent>()
  private readonly input = new AsyncQueue<SDKUserMessage>()
  private readonly pending = new Map<string, PendingPermission>()
  private readonly abort = new AbortController()
  private query!: Query
  private closing = false
  private inFlight = 0
  private graceTimer: ReturnType<typeof setTimeout> | undefined
  private seq = 0
  private pumpDone: Promise<void> = Promise.resolve()

  constructor(
    private readonly state: SdkMapState,
    private readonly cfg: { permissionTimeoutMs: number; interruptGraceMs: number },
    private readonly fallbackId: string,
  ) {
    this.events = this.out
  }

  get id(): string {
    return this.state.sessionId ?? this.fallbackId
  }

  start(queryFn: SdkQueryFn, options: Options): void {
    this.query = queryFn({ prompt: this.input, options: { ...options, canUseTool: this.canUseTool, abortController: this.abort } })
    this.pumpDone = this.pump()
  }

  readonly canUseTool: CanUseTool = (toolName, input, ctx) => {
    const requestId = ctx.toolUseID || `perm-${++this.seq}`
    if (this.closing) return Promise.resolve({ behavior: 'deny', message: 'The session is closing.' })
    return new Promise<PermissionResult>((resolve) => {
      const onAbort = () => this.settle(requestId, { behavior: 'deny', message: 'The request was cancelled.' })
      const timer = setTimeout(() => this.settle(requestId, { behavior: 'deny', message: 'Nobody answered in time, so the request expired. Do not retry it; tell the user it timed out.' }), this.cfg.permissionTimeoutMs)
      timer.unref?.()
      ctx.signal.addEventListener('abort', onAbort, { once: true })
      this.pending.set(requestId, { resolve, timer, input, signal: ctx.signal, onAbort })
      this.out.push({
        type: 'permission_request',
        requestId,
        tool: this.state.toolNames.get(toolName) ?? toolName,
        input,
        ...(ctx.title ? { title: ctx.title } : {}),
        ...(ctx.description ? { description: ctx.description } : {}),
      })
    })
  }

  private settle(requestId: string, result: PermissionResult): boolean {
    const p = this.pending.get(requestId)
    if (!p) return false
    this.pending.delete(requestId)
    clearTimeout(p.timer)
    p.signal.removeEventListener('abort', p.onAbort)
    p.resolve(result)
    return true
  }

  private denyAll(message: string): void {
    for (const id of [...this.pending.keys()]) this.settle(id, { behavior: 'deny', message })
  }

  private async pump(): Promise<void> {
    try {
      for await (const msg of this.query) {
        for (const ev of mapSdkMessage(msg, this.state)) this.emit(ev)
      }
    } catch (e) {
      if (!this.closing) this.emit({ type: 'error', message: errorText200(errorText(e)), retryable: true, kind: 'process' })
    } finally {
      this.denyAll('The session ended.')
      this.clearGrace()
      this.out.end()
    }
  }

  private emit(ev: BackendEvent): void {
    if (ev.type === 'turn_end' || ev.type === 'error') {
      this.inFlight = Math.max(0, this.inFlight - 1)
      this.clearGrace()
    }
    this.out.push(ev)
  }

  private clearGrace(): void {
    if (this.graceTimer) clearTimeout(this.graceTimer)
    this.graceTimer = undefined
  }

  send(turn: UserTurn): void {
    if (this.closing) return
    this.inFlight++
    this.input.push(toUserMessage(turn))
  }

  async interrupt(): Promise<void> {
    if (this.closing || this.inFlight === 0) return
    this.state.interruptRequested = true
    this.denyAll('The turn was interrupted.')
    try {
      await this.query.interrupt()
    } catch {
      // The process may already be gone; the grace timer below still ends the turn.
    }
    this.clearGrace()
    // If the SDK never reports a result for the interrupted turn, end it ourselves rather than stay busy forever.
    this.graceTimer = setTimeout(() => {
      this.graceTimer = undefined
      if (this.inFlight > 0 && this.state.interruptRequested) {
        this.state.interruptRequested = false
        this.inFlight--
        this.out.push({ type: 'turn_end', interrupted: true })
      }
    }, this.cfg.interruptGraceMs)
    this.graceTimer.unref?.()
  }

  resolvePermission(requestId: string, decision: PermissionDecision): void {
    const p = this.pending.get(requestId)
    if (!p) return
    this.settle(requestId, decision.behavior === 'allow' ? { behavior: 'allow', updatedInput: p.input } : { behavior: 'deny', message: decision.message })
  }

  async close(): Promise<void> {
    if (this.closing) return
    this.closing = true
    this.clearGrace()
    this.denyAll('The session closed.')
    this.input.end()
    try {
      this.query?.close()
    } catch {
      // already closed
    }
    this.abort.abort()
    // The pump ends when the SDK's iterator does; do not wait forever for a misbehaving one.
    await Promise.race([this.pumpDone, new Promise<void>((r) => setTimeout(r, 1500).unref?.())])
    this.out.end()
  }
}

// ------------------------------------------------------------------ the backend

export function createSdkBackend(opts: SdkBackendOptions = {}): AgentBackend {
  const permissionTimeoutMs = opts.permissionTimeoutMs ?? 10 * 60_000
  const interruptGraceMs = opts.interruptGraceMs ?? 4000
  return {
    kind: 'sdk',
    async open(open: OpenSessionOptions): Promise<AgentSession> {
      // Fails before anything is spawned when the auth setup is incomplete.
      const env = buildSdkEnv({ authMode: open.authMode, ...(open.apiKey ? { apiKey: open.apiKey } : {}), baseEnv: opts.baseEnv ?? process.env })

      const loaded = opts.queryFn && opts.sdk ? undefined : await import('@anthropic-ai/claude-agent-sdk')
      const queryFn: SdkQueryFn = opts.queryFn ?? (loaded!.query as SdkQueryFn)
      const sdk = opts.sdk ?? loaded!

      const entries = buildMcpToolEntries(open.tools, open.lane, sdk.tool as unknown as SdkToolFn)
      const mcpServers: NonNullable<Options['mcpServers']> = {}
      for (const server of [...new Set(entries.map((e) => e.server))]) {
        mcpServers[server] = sdk.createSdkMcpServer({ name: server, tools: entries.filter((e) => e.server === server).map((e) => e.definition) })
      }
      const auto = new Set(open.autoAllow ?? open.tools.filter((b) => isAutoTier(b.spec.tier)).map((b) => b.spec.name))

      const options: Options = {
        systemPrompt: open.systemPrompt,
        model: open.model,
        effort: open.effort,
        cwd: open.cwd,
        tools: [], // no built-in tools at all
        allowedTools: entries.filter((e) => auto.has(e.specName)).map((e) => e.sdkName),
        mcpServers,
        strictMcpConfig: true,
        settingSources: [],
        permissionMode: 'default',
        includePartialMessages: true,
        env,
        ...(open.resumeSessionId ? { resume: open.resumeSessionId } : {}),
        ...(open.maxBudgetUsd !== undefined ? { maxBudgetUsd: open.maxBudgetUsd } : {}),
        ...(open.claudeExecutable ? { pathToClaudeCodeExecutable: open.claudeExecutable } : {}),
        ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
      }

      const state = createSdkMapState(entries.map((e) => [e.sdkName, e.specName] as [string, string]))
      const session = new SdkSession(state, { permissionTimeoutMs, interruptGraceMs }, open.resumeSessionId ?? 'pending')
      session.start(queryFn, options)
      return session
    },
  }
}
