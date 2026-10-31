# Research digest: prior-art-dashboards

Status: digest of one researcher's structured output, as of 2026-10-31. Tags: [verified] or [unverified] as reported by the researcher. Star counts and "latest release" values are snapshots from rendered GitHub pages; the GitHub API was blocked in the research sandbox.

## Question

Which open-source Claude Code monitors and agent dashboards exist, how do they collect data, what UI patterns and data model do they use, and should the app build, fork or reuse?

## Key findings

1. [verified] Closest match: hoangsonww/Claude-Code-Agent-Monitor ("CCAM"). MIT, about 1.1k stars, 1,201 commits, v2.4.5 on 2026-10-23. Sessions, agent activity, tool usage, subagent tree, Kanban status board, cost analytics, notifications and webhooks, config explorer. Collects by combining native hooks with transcript import. Stack: Node 22, Express, better-sqlite3 (WAL), WebSocket or SSE, React, Vite, Tailwind, D3, plus an Electron app (macOS and Windows installer). Schema: sessions, agents (self-referencing parent), tool_executions, events, notifications, model_pricing, remote_sources. Many same-named forks exist. Sources: https://github.com/hoangsonww/Claude-Code-Agent-Monitor, https://github.com/hoangsonww/Claude-Code-Agent-Monitor/blob/master/docs/DATABASE.md
2. [verified] disler/claude-code-hooks-multi-agent-observability is the reference hooks pipeline: hook scripts, HTTP POST, Bun server, SQLite, WebSocket, Vue 3. 12 hook event types in its README. Live timeline, filters, a pulse chart with 1, 3 and 5-minute windows. About 1.6k stars; quiet since 2026-02-08. No LICENSE file found, so study only. Source: https://github.com/disler/claude-code-hooks-multi-agent-observability
3. [verified] tombelieber/claude-view: MIT, about 121 stars, very active (v0.46.2 on 2026-10-26). Session cards, context gauge, prompt-cache countdown, cost, sub-agent tree, Grid, List, Kanban and Monitor views, ripgrep search over JSONL, and a plugin exposing 85 MCP tools so Claude can query the dashboard. Rust (Axum) plus React; Windows x64 only "Planned"; official builds send anonymous telemetry by default (`CLAUDE_VIEW_TELEMETRY=0` opts out). Source: https://github.com/tombelieber/claude-view
4. [verified] opcode (winfunc, formerly Claudia): Tauri 2 desktop GUI, AGPL-3.0, about 22.4k stars, effectively stalled (last code commit 2025-10-16). Project and session browser, custom agents, usage dashboard, checkpoints. Source: https://github.com/winfunc/opcode
5. [verified] BloopAI/vibe-kanban: Apache-2.0, about 28.5k stars; per-issue git workspace, diff review with inline comments sent back to the agent, PR creation. The README says it is sunsetting (bloop closing, post dated 2026-04-10 per a search summary; host unreachable); community-maintained. A pattern source, not a dependency. Sources: https://github.com/BloopAI/vibe-kanban, https://vibekanban.com/blog/shutdown
6. [verified] ccusage (ryoppippi): MIT, about 19.3k stars, very active. Daily, weekly, monthly and session reports, 5-hour billing blocks, per-model breakdown, cache read and creation tracked separately, LiteLLM pricing. The de-facto standard for cost accuracy. Source: https://github.com/ryoppippi/ccusage
7. [verified] Lower fit: claude-squad (AGPL-3.0, Go TUI, tmux, no native Windows); bjornjee/agent-dashboard (MIT, 26 stars, macOS and Linux, groups by state, approve or reject from a phone); AgentOps (MIT, does not mention Claude Code); stargx/claude-code-dashboard (MIT, 17 stars, polls JSONL every 2 s, proves tailing is enough for a v0). Sources: https://github.com/smtg-ai/claude-squad, https://github.com/bjornjee/agent-dashboard, https://github.com/AgentOps-AI/agentops, https://github.com/stargx/claude-code-dashboard
8. [verified] Official hooks are the best live channel: 33 events, every one carries `session_id`, `transcript_path`, `cwd`, `hook_event_name`; `PostToolUse` includes `tool_use_id` and `duration_ms`; `SubagentStop` includes `agent_id`, `agent_type`, `agent_transcript_path`, `last_assistant_message`; `TaskCreated` includes `task_id` and `task_subject`. An http hook can feed a daemon directly. The researcher did not read the `SessionEnd`, `TaskCompleted`, `PermissionRequest` or `Notification` field tables. Source: https://code.claude.com/docs/en/hooks
9. [verified] Built-in OpenTelemetry provides cost and tokens without parsing transcripts (`claude_code.cost.usage`, `token.usage`, `api_request` events); repo-level settings cannot set exporter variables. Source: https://code.claude.com/docs/en/monitoring-usage
10. [verified] The Agent SDK is how to drive Claude from the app (spawn and control, `canUseTool`, `listSessions`, `getSessionMessages`). Terms: no claude.ai login in third-party products unless approved; no "Claude Code" branding. Sources: https://code.claude.com/docs/en/agent-sdk/overview, https://code.claude.com/docs/en/agent-sdk/typescript
11. [unverified] Transcript JSONL is a fragile backfill source. Third-party reverse-engineered docs say each line has `uuid`, `parentUuid`, `sessionId`, `timestamp`, `cwd`, `version`, `gitBranch`, and that one API response can span several lines repeating the same `message.id` and usage, so naive summing double-counts (not checked against a real file). Windows issues cited: an open report (July 2026) of no transcript when HOME or USERPROFILE is redirected, and a December 2025 report (closed as resolved) of hooks failing silently on Windows 11. Sources: https://docs.rs/crate/txcript/0.11.0/source/docs/formats/claude-code.md, https://claudeissues.com/issue/80683-interactive-mode-never-writes-conversation-transcript-jsonl-when-home-userprofil, https://claudeissues.com/issue/14219-bug-windows-11-all-hooks-fail-silently-sessionstart-precompact-userpromptsubmit

## Options considered

| Option | Verdict |
|---|---|
| A. Fork CCAM as the Work module | Fastest start, but inherits its architecture and schema quirks; dashboard-first design fights the room-centric UI; fork drift |
| B. Build own collector, model and UI from official interfaces | Recommended: data model built around projects, tasks, brain links and the assistant |
| C. Run an existing monitor beside the app | No unified data model; claude-view has no Windows build; second server to babysit |
| D. Transcript tailing only | Simplest, but not live, no approvals, internal format |

## Recommendation

Option B, seeded from CCAM's ideas, with layered ingestion: (1) live http hooks to a loopback daemon with a shared secret, non-blocking and fail-open; for sessions the app launches use the SDK with `canUseTool`; (2) cost from OTel as the authoritative source, falling back to transcript usage deduped by `message.id` priced from a LiteLLM-style table (note: the critic later corrected "authoritative"; see [critic.md](critic.md)); (3) backfill by tailing `~/.claude/projects/**/*.jsonl` (the critic prefers SDK history APIs); (4) SQLite with an append-only raw events table.

Proposed core data model: `project`, `session` (status running, waiting_input, blocked_permission, idle, done, error, stale), `agent` (parent link), `event` (append-only, with dedupe key), `tool_call`, `task` plus `task_session`, `usage` and `price_table`, `approval` and `notification`, and `session_summary` as the bridge to the second brain.

UI patterns to reproduce: session card grid sorted "needs you" first; subagent tree; live timeline and pulse chart; kanban linked to sessions and branches; cost by day, model and project with 5-hour block bars; approve or deny from the UI; resume, fork and a config explorer later; and the differentiator, the assistant narrating the dashboard and querying the work log through MCP tools.

Reuse: the Agent SDK, hooks, LiteLLM prices, CCAM and ccusage ideas (MIT). Do not copy: opcode and claude-squad (AGPL-3.0), the disler repo (no licence). Build: ingest, dedupe, status state machine, schema, kanban binding, approval relay, summary-to-brain pipeline, all UI.

## MVP versus later

MVP: mockup with fake data for the session grid, subagent tree, timeline, kanban and cost panel; then a daemon, SQLite and hook receiver for the non-blocking events, a session grid with status and a basic timeline; cost from transcripts or SDK data; manual kanban linked to sessions. Later: OTLP receiver, SDK-launched sessions with approvals from the UI or phone, git worktree workspaces with diff review, checkpoints, config explorer, session summaries into the brain, MCP tools over the work log, other agents' adapters, remote sync, mobile PWA.

## Risks

- Internal, unversioned transcript format; parse defensively; transcripts are backfill, not the live feed.
- Hook surface moves fast (12 events in a 2025 README, 33 now): version-gate and keep the raw table.
- Windows reliability of hooks and transcripts (issues unverified).
- Licence contamination (AGPL, no licence file).
- Project longevity (vibe-kanban sunsetting, opcode stalled, disler quiet, claude-view young).
- Cost double counting; subscription versus API billing means dollar figures are estimates.
- Privacy: transcripts and prompts are sensitive; keep OTel prompt logging off.

## Open questions

- vibekanban.com and the GitHub API were unreachable, so the sunset timeline, licences and release dates rest on rendered pages and search summaries.
- Hooks field tables for `SessionEnd`, `TaskCompleted`, `PermissionRequest`, `Notification` were not read; verify against real payloads (spike (b) records them).
- Does the user run Claude Code on a subscription or an API key? (Decides cost labelling and SDK versus CLI.)
- Claude only, or also Codex, Cursor and Gemini agents? (v1: Claude only.)
- Fork CCAM or build fresh? A one to two day fork spike on the user's PC could confirm its Windows handling.
- Can `TaskCreated` and `TaskCompleted` populate kanban cards, or are cards always created by us and linked by `session_id`? (v1: manual cards.)

## Decisions that followed

[ADR 0003](../adr/0003-monitoring-hooks-and-roster.md); the Work screen in the mockup (session grid, subagent tree, timeline, kanban, cost, approvals).
