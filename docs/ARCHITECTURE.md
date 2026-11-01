# Architecture

Status: target architecture; the Phase 0a mockup implements the UI side and the contracts only. Date: 2026-10-31.

Sources: the approved plan, the research digests in [research/](research/) (especially [critic.md](research/critic.md), which resolves their contradictions), and the contracts in `packages/shared/src`. Statements marked "proposed" are design choices not yet validated; statements marked "unverified" rest on research that could not be confirmed.

## 1. Principles

1. Local-first. The daemon, the vault and the operations database live on the user's PC. Only what a Claude call needs leaves it (see [PRIVACY.md](PRIVACY.md)).
2. Official interfaces only for Claude: the Agent SDK for sessions the daemon owns; hooks and `claude agents --json` for sessions it does not; SDK history APIs rather than parsing transcript files.
3. Files are truth for knowledge; SQLite is truth for operations. The derived index can always be rebuilt.
4. The UI is a pure client of the daemon through one interface (`ApiClient`). The mockup's `FixtureClient` and the future daemon client are interchangeable.
5. Capability tiers, not good intentions. Safety lives in code (lanes, tool tiers, `canUseTool`, path jails), never only in the persona prompt.
6. Every integration sits behind a provider or tool interface with a mock. Real providers arrive one at a time.

## 2. System diagram

```
  Browser tab / Edge --app window (React 19: Room canvas, chat, dashboards, brain)
        |
        |  one authenticated WebSocket (event envelope with seq) + REST (snapshot, commands)
        v
  +---------------------------------------------------------------------------+
  | Daemon (Node, TypeScript, Hono)  binds 127.0.0.1 only; token + Host/Origin |
  |                                                                           |
  |  Gateway --> auth guards --> REST routes + WS hub (ring buffer, seq)      |
  |                                                                           |
  |  Agent host (@anthropic-ai/claude-agent-sdk, pinned, wrapped in one module)|
  |    Secretary lane  long-lived streaming session, in-process MCP tools,    |
  |                    canUseTool -> approval cards, interrupt() -> barge-in  |
  |    Reader lane     tool-less, schema-constrained summaries                |
  |    Voice lane      direct Messages API, ONLY if the TTFT gate fails       |
  |                                                                           |
  |  Monitor   POST /hooks/:event | roster poll | SDK history | stale timer   |
  |  Scheduler (croner, catch-up)     Connectors (providers + mocks)          |
  |  Vault service (chokidar, FTS5, links)   Ops SQLite (WAL, append-only log)|
  |  Budget service    Audit log    Secrets (Windows Credential Manager)      |
  +---------------------------------------------------------------------------+
        |                     |                          |
        v                     v                          v
  claude subprocesses    <vault>\*.md  (git)       %APPDATA%\ai-assistant\
  (one per live session)  + .brain\index.sqlite      {app.db, logs}
        |                                          ~\.claude\projects (read-only)
        v
  api.anthropic.com
```

## 3. Daemon components

| Component | Responsibility | Notes |
|---|---|---|
| Gateway | Hono HTTP plus one WebSocket; auth, Host and Origin guards, CSP headers | `@hono/node-ws`; loopback only |
| Agent host | Owns Claude sessions through the Agent SDK; one module wraps the SDK so pre-1.0 churn is contained | SDK 0.3.x ships the native `claude` binary as a per-platform optional dependency (win32-x64 included), pinned to the SDK version |
| Monitor | Ingests state of sessions: SDK stream (owned), hooks (external), roster poll, history | Section 5 |
| Scheduler | croner jobs (morning briefing, inbox triage, calendar prep, news digest, nightly dream, weekly review) with catch-up after sleep | A PC sleeps; on start and resume compute missed runs and apply a per-job policy (run once, skip, run all) |
| Connectors | Provider implementations (mock now; RSS, HN, Open-Meteo, Google, Atlas later) | Normalise and cache into SQLite; the UI reads only from the cache |
| Vault service | Watches the vault, builds the derived index (FTS5, links), enforces the write policy and path jail, commits to git per write | [ADR 0004](adr/0004-memory-model-and-vault.md) |
| Ops store | SQLite (WAL) through better-sqlite3 and Drizzle 0.45 | Keep access behind a repository layer so a later switch to `node:sqlite` is cheap |
| Budget service | Per-lane and per-job caps, global daily cap, kill switch | Section 15 |
| Audit log | Append-only record of approvals, tool calls, and what was sent to the cloud | [ADR 0005](adr/0005-privacy-tiers-and-autonomy.md) |
| Secrets | `@napi-rs/keyring` (Windows Credential Manager) for third-party tokens | Small secrets only (a per-item size limit of roughly 2.5 KB is unverified). Anthropic and claude.ai credentials are never stored: the `claude` binary owns them |

Runtime: Node 24 LTS (Node 26 LTS is the alternative; v22 is still LTS), not Bun, because the Agent SDK, better-sqlite3 13 (Node >= 22), node-pty and keyring are Node-native and best tested there. Node SEA cannot load native addons from its embedded filesystem, so the daemon ships as `node.exe` plus bundled JS plus `node_modules`.

## 4. Claude lanes

Three lanes, with different tools, models and trust. One session must never combine reading untrusted content with send, write or finance tools.

| Lane | Purpose | Model and effort (mockup defaults) | Tools | Session |
|---|---|---|---|---|
| Secretary | Chat, planning, tool work, approvals | `claude-sonnet-5-5`, medium | In-process MCP servers `brain`, `calendar`, `mail` (read plus drafts), `contacts`, `finance` (read), `worklog`, `news`, all listed in `allowedTools`; `canUseTool` feeds approval cards | One long-lived streaming-input session |
| Reader | Briefing, news and mail summaries | `claude-haiku-5-5`, low | None. Schema-constrained output (`outputFormat: json_schema`, zod converted with `z.toJSONSchema(schema, { target: 'draft-7' })`) | Short calls; no write, send or finance tools anywhere in the lane |
| Voice | Fast spoken turns | `claude-haiku-5-5`, low | None; hands tool work to the Secretary | Direct Messages API call with a cached persona and digest prefix. Disabled by default; introduced only if the Phase 0b TTFT gate fails |

Secretary session configuration (proposed, from the critic's integrated stack):

- TypeScript SDK, pinned. `settingSources: ['project']` with `cwd` set to an agent directory inside the vault that holds `.claude/skills` and the `CLAUDE.md` schema. Omitting `settingSources` is equivalent to `['user','project','local']`, so user hooks, `CLAUDE.md`, skills and agents would all load by default.
- Settings not controlled by `settingSources`: managed policy, `~/.claude.json`, auto memory, and claude.ai MCP connectors under a subscription login. Turn auto memory off (`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, or `autoMemoryEnabled: false`) so there is exactly one memory system, and disable connectors (`strictMcpConfig`, `disableClaudeAiConnectors`, or `ENABLE_CLAUDEAI_MCP_SERVERS=false`).
- Inject the core files with a programmatic `SessionStart` hook (TypeScript only; the Python SDK has no `SessionStart` or `SessionEnd` callbacks). Persona and the digest sit in a stable cached prefix; keep their ordering stable so frequent digest changes do not bust the prompt cache.
- Set `maxTurns` and a per-session budget on every launched session. `env` replaces the subprocess environment, so spread `process.env`. Never `SIGTERM` a session mid-turn; call `interrupt()` first.
- Permission order, for reference: hooks, deny rules, ask rules, permission mode, allow rules, then `canUseTool`. Auto-approved calls never reach `canUseTool`. A `-p` or SDK run with nothing to approve a call silently denies it, which looks like the assistant refusing tools; the approval handler must always be wired.
- Persona is injected as `systemPrompt` preset `claude_code` plus `append`, or as a replacement string (which drops Claude Code's default prompt and git snapshot). The TTFT spike measures both; the choice follows the numbers.
- Sonnet 5.5 cannot turn thinking off (adaptive only), so it is a poor model for a voice loop; that is why a Haiku Voice lane exists as a fallback.

Consolidation jobs (nightly dream, triage) that touch inbox-derived text run as restricted job sessions, not as the Secretary: read tools plus `brain_propose` plus writes to a quarantine folder, and nothing else. Note: `tools.ts` currently lists `brain_propose` for the Secretary lane only, so Phase 1 must add a job profile or extend the lane type (open item).

Subscription use: the default is `api-key` for everything the daemon launches. `local-login` is an optional switch that points `pathToClaudeCodeExecutable` at the user's own installed binary; it is gated on the ToS answer and on the budget caveats in [ADR 0001](adr/0001-claude-auth-modes.md).

## 5. Monitoring ingestion

Goal: one session list covering sessions the daemon starts and sessions the user starts in a terminal or IDE.

| Channel | Covers | Role | Caveats |
|---|---|---|---|
| SDK message stream | Sessions the daemon owns | Authoritative for those sessions (status, tools, cost, subagent tree through `parent_tool_use_id`) | `total_cost_usd` is a client-side estimate; `result.usage` excludes subagents, so use `modelUsage` for whole-tree totals |
| User-level `http` hooks to `127.0.0.1` | Any session that loads user settings | Primary live feed for external sessions | Non-blocking events only; Windows delivery unproven until spike (b) |
| `claude agents --json --all` | Live and completed background sessions | Roster and liveness cross-check | Research preview; see the field table below |
| SDK `listSessions` and `getSessionMessages` | History | Backfill and history cards | Replaces parsing transcript JSONL |
| Transcript JSONL | External sessions only | Last-resort defensive cost estimate, deduped by `message.id`, priced from a LiteLLM-style table | Format is internal and unversioned; plaintext may contain secrets; 30-day default retention (`cleanupPeriodDays`) |

Not used in v1: `PreToolUse` hooks (a timed-out `PreToolUse` callback blocks the tool call); OpenTelemetry (off by default, every event carries `user.email` and `organization.id`, behaviour under subscription login unknown); the statusline receiver (behaviour under `-p` or SDK runs unconfirmed); transcript tailing as a live feed.

Hook events to register: `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `PostToolUseFailure`, `Notification`, `SubagentStart`, `SubagentStop`, `Stop`, `SessionEnd`. `PermissionRequest` is observed only if spike (b) shows an empty 200 reply does not auto-decide. Handlers use short timeouts and fail open: a non-2xx response or connection failure is non-blocking by default (`onFailure: 'continue'`), so a dead daemon never breaks a terminal session. `SessionEnd` hooks get only a 1.5 s budget, so a missed "session ended" is normal and handled by the staleness timer.

### What the critic refuted, and the consequence

| Claim | Verdict | Consequence |
|---|---|---|
| `claude agents --json` returns every session with `id` and a five-value `state` (working, blocked, done, failed, stopped) | Refuted. `id` and `state` exist for background sessions only. `cwd`, `kind`, `startedAt` are always present; `pid` and `status` (busy, waiting, idle) only while the process is alive; `waitingFor` only when status is `waiting`; `sessionId` and `name` when set | Interactive sessions expose only busy, waiting or idle from the roster. The Room and the grid derive status for interactive sessions from hooks |
| The `agent_needs_input` Notification signals a blocked session | It is an Agent View signal. In SDK sessions only `permission_prompt`, `elicitation_*` and `plugin_notification` Notifications fire; `idle_prompt` does not | For daemon-owned sessions "blocked" comes from `canUseTool`, not from Notification |
| OpenTelemetry is the authoritative cost source | Not on a subscription: both OTel and SDK numbers are API-equivalent estimates, and OTel carries `user.email` | One labelled "API-equivalent estimate"; OTel deferred |
| Transcript backfill belongs in the MVP | Contradicts Anthropic's statement that the format is internal | SDK history APIs first; a defensive parser only for external-session cost |
| Hooks are a reliable primary feed on Windows | Unproven; cited issues unverified; `SessionEnd` budget is 1.5 s | Phase 0b spike (b) and a staleness state machine before relying on hooks |

Roster fields (verified by the critic against the Agent View page, read to about 100,000 of 148,002 characters): `cwd`, `kind` (interactive or background), `startedAt` (Unix ms), `id`, `state`, `pid`, `status`, `waitingFor`, `sessionId`, `name`. No cost, token or last-updated fields are documented.

### Deduplication and status

- User-level hooks also fire for daemon-spawned sessions when the SDK loads user settings, so the same tool call could be ingested twice. Primary defence: daemon sessions use `settingSources` without `'user'`, so user-level hooks should not fire for them (expected, to be confirmed in Phase 1). Second defence: drop or merge by `dedupe_key = session_id + tool_use_id + hook_event_name`, and ignore hook events whose `session_id` belongs to a daemon-owned session.
- Proposed mapping to the `Session.status` values in `packages/shared`:

| Signal | Status |
|---|---|
| `SessionStart`, `UserPromptSubmit`, `PostToolUse` | `running` |
| `canUseTool` pending (owned) or `PermissionRequest` (external, if observed) | `blocked_permission` |
| Roster `status: waiting` or a `Notification` asking for input | `waiting_input` |
| `Stop` | `idle` |
| `SessionEnd`, roster `state: done` | `done` |
| `StopFailure`, roster `state: failed` | `error` |
| No event for a threshold (proposed: 10 minutes) and the roster no longer lists the pid | `stale` |

Thresholds are proposals to tune against recorded payloads from Phase 0b.

### Event store

An append-only `raw_events` table (id, received_at, source in {hook, sdk, roster, import}, session_id, hook_event_name, tool_use_id, dedupe_key, redacted payload JSON, `claude_code_version`). Projections (`sessions`, `agents` with a parent link, `tool_calls`, `approvals`, `tasks`, `usage`) are rebuildable from it, which is what survives hook and format changes (hooks grew from 12 to 33 events in under a year). Redact `tool_input`, `tool_response` and transcript text before persisting; they hold file contents and secrets in plaintext.

## 6. Data stores

| Store | Location | Truth for | Notes |
|---|---|---|---|
| Vault | A user-chosen folder, git-versioned, never inside OneDrive-style synced folders | Knowledge: core, strategy, journal, knowledge, projects, inbox | Obsidian-compatible markdown with flat YAML frontmatter and `[[wikilinks]]`. Layout in [ADR 0004](adr/0004-memory-model-and-vault.md) |
| Derived index | `<vault>\.brain\index.sqlite` (gitignored) | Nothing; rebuildable | FTS5 first; sqlite-vec later behind a `VectorStore` interface; `embed_meta` records model id and dimension from day one |
| Ops DB | `%APPDATA%\ai-assistant\app.db` (SQLite, WAL) | Operations: sessions, events, tasks, jobs, approvals, audit, connector cursors, layouts | Back up with the SQLite backup API or `VACUUM INTO`, never a file copy under WAL |
| Logs | `%APPDATA%\ai-assistant\logs` | Diagnostics | Structured, redacted (no email bodies or finance figures) |
| Claude transcripts | `~\.claude\projects` | Claude Code's own | Read-only for us; 30-day default retention |
| Secrets | Windows Credential Manager | Third-party tokens | Not Anthropic credentials |

## 7. Event envelope and resync

Target wire format (from the plan): `{ type, topic, seq, ts, payload }` over one authenticated WebSocket, with REST for commands and the snapshot.

The mockup's `ServerEvent` (`packages/shared/src/schemas/api.ts`) is a discriminated union on `type` where `seq` and `ts` sit on every variant and the event fields are inline: `chat.message`, `chat.delta`, `chat.done`, `avatar`, `session.update`, `agent.event`, `approval.new`, `approval.resolved`, `task.update`, `proposal.update`, `settings.update`, `learned.update`. Phase 1 reconciles the two. Proposal (open): keep the flat variants in `shared` (simpler zod unions) and have the gateway derive `topic` from `type`, rather than nesting a `payload`.

| Topic | Event types |
|---|---|
| chat | `chat.message`, `chat.delta`, `chat.done` |
| avatar | `avatar` |
| work | `session.update`, `agent.event`, `task.update` |
| approvals | `approval.new`, `approval.resolved` |
| brain | `proposal.update`, `learned.update` |
| settings | `settings.update` |

Sequence and resync (proposed):

- `seq` is monotonic per daemon run and stamped on every event. The client tracks the last `seq` it applied.
- The daemon keeps a bounded ring buffer of recent events. On reconnect, or on detecting a gap, the client sends `resume { lastSeq }`. If the buffer still holds `lastSeq + 1`, the daemon replays; otherwise it answers `resync_required` and the client refetches `GET /snapshot` and restarts from the snapshot's `seq`.
- `Snapshot` should gain an optional `seq` field (additive) so a refetch lines up with the stream. Not in the schema yet.
- After PC sleep or hibernate the socket is usually dead; the same path handles it. Browser background tabs throttle timers, so nothing time-critical lives in the UI.
- Chat tokens are `chat.delta` events appended to the last text part of a message and closed by `chat.done`; `interruptChat()` is barge-in.

## 8. ApiClient contract

`ApiClient` is the only surface the UI uses:

| Method | Purpose | Daemon mapping (proposed) |
|---|---|---|
| `getSnapshot()` | Everything the UI renders, as one `Snapshot` | `GET /snapshot` |
| `subscribe(handler)` | `ServerEvent` stream | `WS /ws` |
| `sendChat(text, modality)` | User turn, text or voice transcript | `POST /chat` |
| `interruptChat()` | Barge-in | `POST /chat/interrupt` |
| `decideApproval(id, decision)` | Approve or deny a pending approval | `POST /approvals/:id/decision` |
| `decideProposal(id, decision)` | Approve or reject a brain proposal; approval creates a git commit | `POST /proposals/:id/decision` |
| `moveTask`, `createTask` | Kanban | `POST /tasks`, `PATCH /tasks/:id` |
| `setTrustMode(ruleId, mode)` | Trust ladder; locked rules refuse | `PUT /trust/:ruleId` |
| `setClaudeMode(mode)` | `api-key` or `local-login` | `PUT /settings/claude-mode` |
| `setGuestMode`, `setWebcam` | Privacy switches | `PUT /settings/...` |
| `updatePersona(patch)` | Persona edits; in the daemon these become proposals, see [PERSONA.md](PERSONA.md) | `POST /persona/proposals` |
| `forgetFact(id)` | Remove a learned fact | `DELETE /learned/:id` |

Route names are proposals. The contract is the TypeScript interface and the zod schemas; the daemon must validate every request body against them.

## 9. Tool surface

`packages/shared/src/tools.ts` defines the assistant's tools, each with a lane list and an autonomy tier (T0 read freely, T1 journal and inbox appends, T2 knowledge and project notes plus git commit, T3 core and strategy through proposals, T4 outward actions, always an approval card until promoted on the trust ladder). Servers: `brain`, `calendar`, `mail`, `contacts`, `finance`, `worklog`, `news`. Rules enforced by the integrity test: tool names are unique, the Reader lane has no write tools, and `finance_move_money` is `locked` with no lane. In-process SDK MCP servers are named `mcp__<server>__<tool>` and pre-approved through `allowedTools` only for tiers the user has promoted.

## 10. Security model

Threats: any web page can talk to `127.0.0.1` (DNS rebinding, CSRF, cross-site WebSocket hijacking); prompt injection through mail, news and invites; a tool-equipped subprocess running with the user's full rights.

Network and authentication
- Bind only `127.0.0.1` and `::1`, never `0.0.0.0`. Fixed port with fail-fast if taken (the mockup's `.env.example` reserves 7421).
- A 256-bit random install token generated at first run, stored in the keychain. Browser mode: a one-time URL fragment exchanged for an `HttpOnly`, `SameSite=Strict` cookie. The WebSocket authenticates by cookie or first message, never by query string. The Electron shell later injects the token through a preload script.
- The hook receiver uses a separate bearer token, delivered through the hook's headers (`allowedEnvVars` supplies the value). Rotate on demand.
- Reject any request whose `Host` is not `127.0.0.1:PORT` or `localhost:PORT`. Validate `Origin` on all HTTP and WebSocket upgrades against an allowlist. No permissive CORS. Reject non-JSON content types on mutating routes. The MCP transport spec requires Origin validation for the same reason.
- CSP: `default-src 'self'; script-src 'self'` (no eval, no CDN); `connect-src 'self' ws://127.0.0.1:PORT http://127.0.0.1:PORT`; `img-src 'self' data: blob:`; `style-src 'self'`; `frame-ancestors 'none'`. All fonts and assets bundled locally; the MediaPipe assets are self-hosted.

Untrusted content
- The UI renders model-generated markdown, email HTML and news. Sanitise with DOMPurify, render email HTML in a sandboxed iframe with scripts and remote content blocked, and never use `dangerouslySetInnerHTML` on raw input.
- Reader and actor tiers (below). Untrusted text is passed as clearly delimited data. Anthropic advises against piping untrusted content directly into Claude.

Prompt-injection blast radius

| Tier | May do | May not do |
|---|---|---|
| Reader (email, news, web, calendar summaries) | Read-only tools or no tools; schema-constrained output | Bash, write, send, network, finance |
| Actor (send mail, edit files, finance reads, project work) | Tools behind `canUseTool` approval cards, one audit row per decision | Read raw untrusted content in the same session |
| Consolidation jobs over inbox-derived text | `brain_propose`, quarantine writes | Any direct write to knowledge, core or strategy notes. Promotion needs a second pass or user approval |

Hard limits regardless of trust: no money movement in v0.x; untrusted content is never read in a session that holds send, write or finance tools. Memory poisoning is a real path (a consolidation agent with write tools over the memory it feeds), which is why jobs can only propose or quarantine and `raw/` is immutable.

Filesystem and platform
- The `claude` subprocess runs with full user rights. Native Windows has no Claude Code sandbox (WSL2 only), so per-project `cwd`, deny rules and hooks are the only guard. Bash-based file writes bypass Write and Edit matchers. Protect `~/.ssh`, browser profiles, `.env` and keychain paths; deny rules must cover Windows backslash forms (the SDK docs warn a `.env` example misses `C:\project\.env`).
- Webcam and microphone: `getUserMedia` only in the UI process, off by default, explicit "camera on" with an always-visible indicator, frames and audio not persisted.
- At rest: SQLite and the vault are unencrypted by default; rely on BitLocker, keep secrets in the keychain, redact logs.
- Supply chain: pnpm lockfile, `pnpm audit`, a minimal daemon dependency set, a pinned Agent SDK (it pins the CLI binary), dependency and licence scanning in CI.

## 11. Windows specifics

| Area | Item |
|---|---|
| Process model | Run as a user-session app, not a service, so camera and audio work. Watch for orphaned daemon or `claude` processes holding the port or RAM; check at start. About 1 GiB of RAM per live Claude subprocess, growing over a long session; cap concurrency |
| Files | Defender real-time scanning slows the watcher and indexing of the vault and `node_modules`. File locking and case-insensitive paths when Obsidian has the same vault open. Path length limits (keep vault paths short); NFC filenames. Backslash paths in hook payloads and deny rules |
| Claude Code | Git for Windows is recommended; without it Claude Code uses the PowerShell tool instead of Bash (`CLAUDE_CODE_GIT_BASH_PATH` overrides). Native installer: the PowerShell script at `https://claude.ai/install.ps1` (fetched with `irm` and piped to `iex`), or `winget install Anthropic.ClaudeCode` (WinGet does not auto-update). No sandbox on native Windows |
| Power | Sleep and hibernate break timers and sockets: catch-up for jobs, `resume` for the WebSocket |
| Media | Camera exclusivity with Teams or Zoom; audio device selection; speaker echo (AEC) for barge-in, hence headphones or push-to-talk first |
| GPU | Vendor and VRAM unknown beyond "NVIDIA". 3D render, STT, TTS, embeddings and MediaPipe share it; cap the Room at 30 fps and pause when hidden |
| Native addons | better-sqlite3 and keyring need per-platform builds; build on a Windows CI runner from day one. node-pty uses ConPTY. The terminal is built (`apps/daemon/src/terminal`) and runs node-pty in one host process per terminal, never in the daemon. Neither addon has been built or run on Windows yet |
| Distribution | SmartScreen and code signing matter only if an installer is shared |
| Secure context | `http://localhost` and `http://127.0.0.1` count as secure contexts, so `getUserMedia` works over plain http in the browser-first build (from memory; the MDN page was unreachable) |

## 12. Testing strategy

The sandbox that builds this project is Linux and the target is Windows; the strategy exists to close that gap.

| Layer | What | Notes |
|---|---|---|
| Fixture integrity | Fixtures validate against zod; every cited note exists; every wikilink resolves; story ids exist | Exists now: `packages/shared/test/integrity.test.ts` |
| Fake-Claude transport | A stub SDK transport or recorded message streams so the daemon, approvals, hook ingest and budget logic run with zero tokens | Phase 1 |
| Recorded hook fixtures | Real hook payloads and `claude agents --json` outputs captured in Phase 0b, pinned per Claude Code version | Replayed against the receiver and state machine |
| Provider contract tests | One suite every provider (Mock, Google, Atlas, optionally Actual or Firefly) must pass | The finance contract suite is a Phase 1 seam |
| UI end to end | Playwright against the SPA in fixtures mode (`?static`); later against the daemon | `apps/web/scripts/smoke.mjs` today |
| Windows CI | GitHub Actions `windows-latest` builds native addons and runs the daemon tests from the first daemon commit | Phase 1 |
| Retrieval eval | 30 to 50 real questions with expected notes; gate every retrieval upgrade on recall@5 | Before any embeddings |
| Latency harness | Per-stage timers for the voice loop: endpointing, STT, TTFT, first sentence, TTS first audio, playback | Spikes first, then permanent |
| Persona golden conversations | Scripted dialogues re-run on every model or persona change | [PERSONA.md](PERSONA.md) |
| Security tests | Path-jail cases, Host and Origin rejection, token checks, sanitiser cases, reader-lane tool-list assertions | Phase 1 and 2 |
| Real-machine spikes | Hook delivery, WebGL, `getUserMedia` and audio latency can only be proven on the user's PC | [spikes/](../spikes/README.md) |

## 13. Backup and recovery

A local git vault and one SQLite file are one disk failure from total loss.

- Scheduled encrypted offsite backup (restic, Kopia or equivalent) of the vault and the ops database; the database through the SQLite backup API or `VACUUM INTO`.
- An export of non-keychain configuration; a documented recovery path for keychain loss and re-authentication.
- A restore drill on a clean profile before the shell ships (Phase 4 exit).
- Migration and versioning for vault frontmatter and the database schema (a `schema_version` in `_system` and in the DB).
- Forgotten data lingers in backups until rotation; see [PRIVACY.md](PRIVACY.md).

## 14. Offline and degraded behaviour

| Situation | Behaviour (proposed) |
|---|---|
| No internet or Anthropic outage | Dashboards render from the SQLite cache; vault editing and local search keep working; local STT and TTS keep working; chat queues the message and the Room shows an explicit offline state; optional local small-model fallback for small talk is a later question |
| 429 or usage-limit error | Graceful degradation in the UI; the budget service reports the lane as limited |
| Google or Microsoft token failure | A visible "reconnect" state; cached data stays visible |
| Sleep and resume | WebSocket `resume`; scheduler catch-up policy per job |
| Daemon down | The browser shows a disconnected state; terminal Claude sessions are unaffected because hooks fail open |

## 15. Cost control

- One daemon-level budget service: per-lane and per-job caps, a global daily and monthly cap, `maxTurns` and a budget on every launched session, and a kill switch. The mockup's Settings shows 4, 1 and 1 USD per lane and a 10 USD global daily cap as placeholders.
- Cost shown to the user is always "API-equivalent estimate": the SDK's `total_cost_usd` is a client-side estimate from a bundled price table, not a bill. Use `modelUsage` for whole-tree totals; after a crash the final error result may zero the cost fields. Use the Console or the Usage and Cost API for billing truth.
- Image tokens: a frame costs about `ceil(w/28) * ceil(h/28)` visual tokens (a 640x480 frame is about 414); base64 images are re-sent every turn unless the Files API is used, so downscale before sending and send only on explicit request.
- Prompt-cache hygiene: stable prefix ordering. Minimum cacheable prefix is 512 tokens on Haiku and Sonnet 5.5.
- Model facts as read by the critic from the models overview page: Haiku 5.5 is the fastest tier (from 0.10 USD input and 0.50 USD output per million tokens), Sonnet 5.5 is fast (2 and 10), Opus 5.5 is moderate (4 and 20), all with 1M-token context; retirement is not sooner than 2027 (Haiku 5.5: 2027-10-07).
- A visible "spent today" chip in the top bar, per lane.

## 16. Repository layout

Now: `apps/web`, `apps/daemon`, `packages/shared`, `packages/agent-core` (the Claude lanes), `packages/stage-core` (the stage backend), `docs`, `spikes`. Add `vault`, `integrations` or `db` packages only when a second consumer exists. One mock mechanism only (in-app fixtures), no TypeSpec, Prism or MSW stack. Phase 4 adds `apps/desktop` for the Electron shell.

## 17. Open architectural questions

1. Reconcile the flat `ServerEvent` with the `{type, topic, seq, ts, payload}` envelope (section 7).
2. Add an optional `seq` to `Snapshot` and define the ring-buffer size.
3. Add a job profile (or extend the lane type) for consolidation jobs that may call `brain_propose`.
4. Confirm that `settingSources` without `'user'` stops user-level hooks firing for daemon sessions.
5. Which persona-injection mode wins after the TTFT spike (preset plus append, or replacement)?
6. Who is the single writer to the vault when Obsidian is open (proposed: hash and mtime checks, `str_replace`-style edits, append-only journals, a self-write guard in the watcher)?
7. How do session summaries become vault notes (the `session_summary` bridge is described in research but not specified)?

## 18. Stage backend and embedded terminal (built 2026-11-01)

Two parts were added after the first design of this document. Both are built and were reviewed adversarially ([review record](reviews/2026-11-01-terminal-and-stage.md)); neither has run on Windows or against a real engine.

- **Stage backend** (`packages/stage-core`, wired into the daemon in `apps/daemon/src/stage`). The daemon owns the live 3D assistant: characters, wardrobe, scene, mood, behaviour, speech and her character memory. An engine is a replaceable "stage": it connects to `/ws/stage` with its own bearer token and speaks `mira-stage/1` (`packages/shared/src/stage.ts`), JSON commands and events plus binary audio and ARKit-52 face frames on one clock. A headless `SimulatorStage` and a reusable conformance suite (`runStageConformance`) stand in until an engine exists. Decisions: [ADR 0008](adr/0008-stage-protocol-and-engine-choice.md). Concept: [CEREBRAL-SPACE.md](CEREBRAL-SPACE.md). Details: `packages/stage-core/README.md` and the Stage section of `apps/daemon/README.md`.
- **Embedded terminal** (`apps/daemon/src/terminal`). node-pty (ConPTY on Windows) runs in one host process per terminal, off until enabled in Settings, reachable only through single-use terminal-bound tickets plus a pairing proof, and never by any Claude lane or tool. It runs the user's own `claude` (the documented end-user subscription case) or a shell. The Terminal section of `apps/daemon/README.md` holds the threat model and its stated residuals.
- Both share the daemon's request gate (Host, Origin, cookie), redaction, audit log and loopback-only binding. They add two further secrets (the stage token, and the terminal tickets with the pairing) that no other route accepts.
- What she remembers is stored in the ops database and can be inspected and forgotten at any time, with the stage switched off too (see [PRIVACY.md](PRIVACY.md) sections 3 and 10).
