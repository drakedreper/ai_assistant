# Research digest: claude-integration

Status: digest of one researcher's structured output from the eight-agent sweep, with later corrections from the critic. Date: 2026-10-31. Tags: [verified] means the researcher confirmed it against the cited page; [unverified] means it was not confirmed. Where the critic later settled or refuted a point, a "Resolved since" section says so.

## Question

How should the app integrate with Claude Code and the Claude Agent SDK to (a) host the assistant's brain, (b) monitor sessions it does and does not own, and (c) stay inside Anthropic's terms, on Windows 11?

## Key findings

1. [verified] SDK packages: TypeScript `@anthropic-ai/claude-agent-sdk` and Python `claude-agent-sdk`. Streaming-input mode supports queued messages, interrupts and image blocks mid-session; single-message mode supports neither. `system_prompt` accepts a string or `{type:'preset', preset:'claude_code', append}`; a full replacement drops Claude Code's default prompt and git snapshot. `setting_sources=[]` disables filesystem settings (`CLAUDE.md`, settings, on-disk hooks). Other options: `max_turns`, `max_budget_usd` (client-side estimate), `cwd`, `env`, `model`, `include_partial_messages`, `mcp_servers`, `agents`, `hooks`, `can_use_tool`. Sources: https://code.claude.com/docs/en/agent-sdk/python, https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode, https://code.claude.com/docs/en/headless
2. [verified] Headless CLI: `claude -p` with `--output-format text|json|stream-json`; `--input-format stream-json`; `--bare` skips hooks, skills, plugins, MCP, auto memory and `CLAUDE.md` and never reads OAuth or the keychain (needs `ANTHROPIC_API_KEY`). SIGTERM exits 143 and leaves the turn unfinished; send SIGINT or call `interrupt()` first. Sources: https://code.claude.com/docs/en/headless, https://code.claude.com/docs/en/cli-reference
3. [verified] Sessions: `session_id` on the init and result messages; resume, continue and fork are supported. SDK and `-p` sessions are hidden from the `/resume` picker but can be resumed by id. `listSessions`, `getSessionMessages`, `getSessionInfo`, `renameSession`, `tagSession` let a dashboard read history without parsing files. TypeScript-only `persistSession:false` keeps a session in memory. Sources: https://code.claude.com/docs/en/agent-sdk/sessions, https://code.claude.com/docs/en/sessions
4. [verified] Permission order: hooks, deny rules, ask rules, permission mode, allow rules, then `canUseTool`, which runs only if nothing earlier decided. A `-p` run with no permission mode set starts in Manual mode (since v2.1.302), so calls needing approval are denied unless a `PermissionRequest` hook, a permission-prompt MCP tool or an allow rule approves them. `bypassPermissions` refuses to start as root outside a recognised sandbox. Sources: https://code.claude.com/docs/en/agent-sdk/permissions, https://code.claude.com/docs/en/headless
5. [verified] Custom tools: TypeScript `tool()` plus `createSdkMcpServer()` (zod), Python `@tool` plus `create_sdk_mcp_server`. Tools are named `mcp__<server>__<tool>` and must be in `allowedTools` to skip prompts. Tool search is on by default; MCP output over 25,000 tokens is saved to a file; `MCP_TIMEOUT` defaults to 30 s. The SDK does not run OAuth flows: servers needing sign-in report `needs-auth`, so Calendar and Gmail tokens must be handled by the app. Sources: https://code.claude.com/docs/en/agent-sdk/custom-tools, https://code.claude.com/docs/en/agent-sdk/mcp
6. [verified] Hooks: 33 documented events; handler types command, http, mcp_tool, prompt, agent. Common input: `session_id`, `prompt_id`, `transcript_path`, `cwd`, `permission_mode`, `effort`, `hook_event_name`; subagent events add `agent_id` and `agent_type`. Exit 2 blocks (`PermissionRequest` ignores it); `onFailure:'block'` is opt-in from v2.1.295. Default timeouts 600 s (command, http, mcp_tool), 30 s (prompt), 60 s (agent). A timed-out `PreToolUse` blocks the tool call; a timed-out `PostToolUse` keeps the result. The Python SDK has no `SessionStart` or `SessionEnd` callbacks. Sources: https://code.claude.com/docs/en/hooks, https://code.claude.com/docs/en/agent-sdk/hooks
7. [verified] Transcripts are JSONL under `~/.claude/projects/<project>/<session-id>.jsonl` (project is the cwd with non-alphanumerics replaced by `-`); `CLAUDE_CONFIG_DIR` relocates the tree; subagent transcripts live under `<session>/subagents/`; default retention 30 days (`cleanupPeriodDays`). Anthropic states the format is internal and changes between versions. Transcripts are plaintext and include secrets. Sources: https://code.claude.com/docs/en/sessions, https://code.claude.com/docs/en/claude-directory
8. [verified] Live state: `claude agents --json [--all] [--cwd]` prints a roster; entries include `cwd`, `kind`, `startedAt`, `id`, `state`, `pid`, `status`, `waitingFor`, `sessionId`, `name`. Anthropic calls it the supported way to read state from outside and says not to parse `~/.claude/jobs/`. Agent View is a research preview. The statusline command receives per-session JSON (cost, context percent, prompt cache; `rate_limits` for subscribers only). Sources: https://code.claude.com/docs/en/agent-view, https://code.claude.com/docs/en/statusline
9. [verified] OpenTelemetry: `CLAUDE_CODE_ENABLE_TELEMETRY=1` plus OTLP exporter variables; metrics include `claude_code.cost.usage` and `token.usage`; events include `api_request` (with `cost_usd`), `tool_result`, `tool_decision`; prompt text and tool parameters off by default; every event carries `user.email` and `organization.id`. SDK `total_cost_usd` is a client-side estimate; `result.usage` excludes subagents (use `modelUsage`); after a crash the final error result may zero the cost. Sources: https://code.claude.com/docs/en/monitoring-usage, https://code.claude.com/docs/en/agent-sdk/cost-tracking
10. [verified] Subagents: programmatic `AgentDefinition`; fresh context; messages carry `parent_tool_use_id` so the stream rebuilds as a tree; delegation is detected from `tool_use` blocks named `Agent` (older builds `Task`). Caps: `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` (default 3), `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` (default 20). Source: https://code.claude.com/docs/en/agent-sdk/subagents
11. [verified] Auth and terms: third-party developers may not offer claude.ai login or its rate limits in Agent SDK products unless previously approved and should use API keys; developers may not collect, store or intermediate Claude.ai credentials; this does not stop an end user signing in to the unmodified binary. The SDK is under the Commercial Terms. "Claude Code" may not be used in a third-party product's name. Sources: https://code.claude.com/docs/en/agent-sdk/overview, https://code.claude.com/docs/en/legal-and-compliance, https://code.claude.com/docs/en/setup
12. [verified] Windows 11: native install by PowerShell script or `winget install Anthropic.ClaudeCode` (no auto-update). Git for Windows is recommended (otherwise the PowerShell tool is used). Sandboxing is not supported on native Windows (WSL 2 only). Node 22 or later is needed to install the npm package; the installed binary does not run on Node. Source: https://code.claude.com/docs/en/setup

## Options considered

| Option | Pros | Cons |
|---|---|---|
| A. Agent SDK long-lived streaming session | Full harness, queued messages, interrupts, images, typed results | You host it; terms for distribution; Python lacks some hooks; cost fields are estimates |
| B. Headless CLI subprocess | Language-neutral, same engine | You implement the stdio protocol (stdin schema unconfirmed); no in-process approvals |
| C. Hooks to a local receiver | Push-based, rich payloads | A hung receiver stalls `PreToolUse`; hooks do not run under `--bare` |
| D. Poll `claude agents --json --all` | Documented external read interface | Polling latency; no cost fields; research preview |
| E. Statusline command to a local receiver | Per-session cost and context | Interactive UI feature; headless behaviour unconfirmed; one shell per update |
| F. OpenTelemetry to a local collector | Standard time series | Off by default; `user.email` on every event; not a live state feed |
| G. Tail transcript JSONL | Complete record | Internal format, plaintext, retention, Windows file handling |

## Recommendation

Use the Agent SDK as the brain: one long-lived streaming-input session per assistant, persona through `system_prompt` preset plus append, second-brain, calendar, mail and finance adapters as an in-process SDK MCP server, `can_use_tool` approvals routed into the UI, `session_id` persisted for resume. Choose TypeScript if the shell is JavaScript (broader hook set, `permission_policy`). Keep `claude -p` stream-json as a language-neutral fallback. For monitoring make hooks the primary live feed (`SessionStart`, `UserPromptSubmit`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `Notification`, `SubagentStart`, `SubagentStop`, `Stop`, `SessionEnd`) to a `127.0.0.1` receiver, never letting `PreToolUse` wait on the UI; poll `claude agents --json --all` for the roster; use SDK session APIs for history; add OTel only for usage charts; transcript tailing last. Map animation: tool use means working; `PermissionRequest` or an input-needed Notification means needs you; `Stop` means idle; `SessionEnd` means done.

## MVP versus later

MVP (Phase 1): one SDK streaming session with text and image input, `canUseTool` approvals, persisted `session_id`; a `127.0.0.1` hook receiver with a local event store; roster polling. Phase 2: in-process MCP tools for brain (read first, writes behind approvals), calendar and email once the app has its own OAuth, finance when its API lands; subagent specialists; SDK history cards; a statusline receiver for cost and context. Phase 3: OTel dashboards, WSL 2 for sandboxed commands, multi-machine.

## Risks

- Terms for distribution; use API keys beyond personal use and confirm the personal-use position.
- Silent denials when no approval handler is wired.
- A hung receiver stalls `PreToolUse` up to 600 s; hooks do not run under `--bare`.
- SIGTERM leaves a turn unfinished.
- The transcript format is internal; plaintext secrets in transcripts and hook payloads.
- Agent View is a research preview; SDK sessions are hidden from the normal resume picker.
- `total_cost_usd` is a list-price estimate, not a bill.
- The SDK does not do MCP OAuth.
- The dev sandbox runs as root, so `bypassPermissions` will not start there.
- OTel attaches `user.email`; native Windows has no sandbox.

## Open questions and what happened to them

| Question | Resolved since |
|---|---|
| Does the npm SDK bundle the binary? | Yes. Version 0.3.316 ships per-platform optional dependencies including win32-x64 and win32-arm64 (critic spot check 5). `pathToClaudeCodeExecutable` overrides it |
| Default `settingSources`? Do user hooks fire for SDK sessions? | Omitting it equals `["user","project","local"]`, so user-level hooks do fire unless `'user'` is excluded (critic spot check 4) |
| Does `claude agents --json` include interactive sessions with `id` and `state`? | Refuted: `id` and `state` are background-only (critic spot check 6) |
| Does an http hook fail open? | Yes: non-2xx and connection failure are non-blocking by default (critic spot check 2) |
| Personal use of subscription login from a self-built app | Still open: email Anthropic (spike (d)) |
| `canUseTool` signature, `--input-format stream-json` stdin schema, hooks field tables after `SessionStart`, statusline and OTel behaviour under `-p` or subscription login, attaching Secondbrain through `mcp_servers` | Still open; verify when the relevant phase starts |

## Decisions that followed

[ADR 0001](../adr/0001-claude-auth-modes.md), [ADR 0003](../adr/0003-monitoring-hooks-and-roster.md), [ARCHITECTURE.md](../ARCHITECTURE.md) sections 4 and 5.
