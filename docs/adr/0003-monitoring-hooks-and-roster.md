# ADR 0003: Monitoring Claude sessions through hooks, the roster and SDK history

Status: Accepted; the Windows delivery assumption is a release gate (spike (b)). Date: 2026-10-31.

## Context

Work screens need one session list covering sessions the daemon starts (through the Agent SDK) and sessions the user starts in a terminal or IDE. Research reviewed the open-source monitors and the official interfaces (see [research/prior-art-dashboards.md](../research/prior-art-dashboards.md), [research/claude-integration.md](../research/claude-integration.md), [research/critic.md](../research/critic.md)).

Verified facts that shape the design:

- Claude Code documents 33 hook events (older READMEs cite 12). Handler types are command, http, mcp_tool, prompt and agent. An `http` handler POSTs the event JSON to a URL with optional `headers` and `allowedEnvVars`. A non-2xx response or a connection failure is a non-blocking error (`onFailure` defaults to `continue`; `block` is opt-in from v2.1.295).
- Default hook timeouts are 600 s for command, http and mcp_tool, 30 s for prompt and `UserPromptSubmit`, 60 s for agent. A timed-out `PreToolUse` callback blocks the tool call. `SessionEnd` hooks get only a 1.5 s budget.
- User-level hooks fire for daemon-spawned sessions when the SDK loads user settings (default `settingSources` is `["user","project","local"]`), so the same call can be seen twice.
- `claude agents --json [--all]` is documented as the supported way to read session state from outside. It is a research preview. Fields: `cwd`, `kind`, `startedAt` always; `id` and `state` (working, blocked, done, failed, stopped) for background sessions only; `pid` and `status` (busy, waiting, idle) only while alive; `waitingFor` when waiting; `sessionId` and `name` when set. The claim that every session carries `id` and `state` was refuted.
- Transcripts at `~/.claude/projects/<project>/<session-id>.jsonl` have an internal, changing format, plaintext content (secrets included) and 30-day default retention. The SDK offers `listSessions` and `getSessionMessages` instead.
- SDK `total_cost_usd` is a client-side estimate. OpenTelemetry is off by default, carries `user.email` on every event, and its behaviour under subscription login is unknown.
- GitHub issues cited by one researcher report hooks failing silently on Windows 11 (December 2025, reported resolved) and transcripts not written when HOME or USERPROFILE is redirected (July 2026, open). Not verified.

## Decision

1. Build our own ingest, data model and UI (the prior-art "Option B"), using CCAM, claude-view and ccusage (all MIT) as design and pricing references with attribution. Do not copy opcode or claude-squad (AGPL-3.0) or the disler repo (no licence file).
2. Ingestion channels, each degrading gracefully:
   - SDK stream: authoritative for sessions the daemon owns, including the subagent tree through `parent_tool_use_id` and `canUseTool` for "blocked".
   - User-level `http` hooks to `127.0.0.1` with a bearer token for external sessions.
   - `claude agents --json --all` for roster and liveness. Interactive sessions expose only busy, waiting or idle, so their status is derived from hooks.
   - SDK `listSessions` and `getSessionMessages` for history and backfill.
   - A defensive transcript parser only for the cost of external sessions, deduped by `message.id`, priced from a LiteLLM-style table.
3. Hooks are non-blocking and fail-open. Register only non-blocking events (`SessionStart`, `UserPromptSubmit`, `PostToolUse`, `PostToolUseFailure`, `Notification`, `SubagentStart`, `SubagentStop`, `Stop`, `SessionEnd`), never `PreToolUse`, with short timeouts. `PermissionRequest` only if spike (b) shows an empty 200 does not auto-decide.
4. The hook installer is opt-in and reversible: it backs up `~/.claude/settings.json`, adds only its own entries, and an uninstall removes exactly those entries. The hook receiver uses its own token, separate from the UI token.
5. A staleness timer marks sessions `stale` when events stop and the roster no longer lists the process, because `SessionEnd` often does not arrive in time.
6. Deduplicate by `session_id` plus `tool_use_id` plus event name. Daemon sessions load settings without `'user'` so user-level hooks should not fire for them; the dedupe is the second defence.
7. Persist an append-only raw events table with `claude_code_version` and redacted payloads; derive projections from it so format changes can be replayed.
8. Cost is `total_cost_usd` and `modelUsage` for owned sessions and the defensive estimate for external ones, labelled "API-equivalent estimate". OpenTelemetry, the statusline receiver and transcript tailing as a live feed are deferred.

## Consequences

- Hook delivery on Windows must be proven on the user's PC before hooks are trusted as the primary feed. If spike (b) fails, external sessions fall back to roster polling and SDK history (coarser status), and daemon-owned sessions are unaffected.
- Status mapping for interactive sessions is a state machine with thresholds to tune against recorded payloads (see ARCHITECTURE section 5).
- Hook payloads, `tool_input` and transcripts contain secrets and file contents in plaintext; redact before persisting and keep the receiver on loopback.
- The installer touches the user's global Claude settings, which is why it is opt-in with a visible uninstall.
- Hooks went from 12 to 33 events in under a year; version-gate on `claude_code_version` and keep the raw table.
- Agent View is a research preview; its JSON may change, so roster parsing is defensive and recorded in contract fixtures.

## Alternatives considered

| Option | Verdict |
|---|---|
| Fork Claude-Code-Agent-Monitor (MIT, about 1.1k stars, v2.4.5, Electron app, sessions, subagent tree, kanban, cost) | Fastest start, but dashboard-first architecture fights an assistant-first UI; its schema has inconsistencies; fork drift once tasks, brain and Atlas are added. Kept as a reference. A one to two day fork spike on the user's PC could still test its Windows hook handling |
| Embed claude-view or CCAM next to the app | No unified data model; claude-view has no Windows build ("Planned") and default-on telemetry; a second server and database to babysit |
| Transcript tailing only (ccusage style) | Simplest, retroactive, but not live, no permission or idle signal, internal format, double-counting of `message.usage` across lines |
| OpenTelemetry as the primary cost source | Needs an OTLP receiver; `user.email` on every event; unknown under subscription; not a live state feed |
| Statusline command posting JSON | Per-session cost and context percent, but spawns a shell per update and headless behaviour is unconfirmed |
| Hooks on `PreToolUse` for approvals | A hung receiver stalls the tool until the timeout; approvals use `canUseTool` for owned sessions instead |

## Sources

- https://code.claude.com/docs/en/hooks
- https://code.claude.com/docs/en/agent-sdk/hooks
- https://code.claude.com/docs/en/agent-view
- https://code.claude.com/docs/en/sessions
- https://code.claude.com/docs/en/agent-sdk/claude-code-features
- https://code.claude.com/docs/en/monitoring-usage
- https://code.claude.com/docs/en/agent-sdk/cost-tracking
- https://github.com/hoangsonww/Claude-Code-Agent-Monitor
- https://github.com/tombelieber/claude-view
- https://github.com/ryoppippi/ccusage
- https://claudeissues.com/issue/14219-bug-windows-11-all-hooks-fail-silently-sessionstart-precompact-userpromptsubmit (unverified)
- https://claudeissues.com/issue/80683-interactive-mode-never-writes-conversation-transcript-jsonl-when-home-userprofil (unverified)
