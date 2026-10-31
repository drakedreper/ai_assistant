# @ai-assistant/daemon

The local daemon of the assistant (Phase 1). One Node process on `127.0.0.1` that

- serves the web app (`apps/web/dist`) and a REST + WebSocket API that implements the `ApiClient` contract of `packages/shared`;
- hosts the **Secretary lane** (`@ai-assistant/agent-core`): chat with Claude through the Agent SDK, tool permissions as approval cards, spend budgets;
- receives **Claude Code http hooks** and projects them into a live monitor of terminal and IDE sessions (the Work screen);
- keeps operations state in SQLite (sessions, events, tasks, approvals, chat, audit, usage) and settings in a small key-value table.

Everything else (brain, calendar, mail, finance, world, briefing) is still fixture data behind the same snapshot, see [What is real and what is mock](#what-is-real-and-what-is-mock).

The default backend is the **zero-token fake**. It never contacts Anthropic. Real Claude needs `CLAUDE_BACKEND=sdk` (see [Unverified](#unverified-and-known-limits): that path has not been exercised against the live API).

## Run it

```
pnpm install                                   # once, from the repo root
pnpm --filter @ai-assistant/web build          # optional: lets the daemon serve the UI
pnpm --filter @ai-assistant/daemon start       # tsx src/main.ts
```

The startup banner prints the one-time sign-in link and says loudly when the fake backend is active:

```
Mira daemon 0.0.0
  Listening   http://127.0.0.1:7421  (loopback only)
  Sign in     http://127.0.0.1:7421/?code=...
              open this once; it works for 15 minutes and only one time
  Data dir    C:\Users\you\AppData\Roaming\ai-assistant
  Backend     FAKE: scripted replies, zero tokens, no network. Nothing here talks to Claude.
```

Open the link in the browser you will use (use the same host name, `127.0.0.1` or `localhost`, afterwards: cookies are per host). The web app must read `?code=`, `POST /api/auth/exchange` it, then remove it from the URL (`history.replaceState`) so it does not stay in the history. Restart the daemon for a new link; the browser session itself lasts 30 days and survives restarts.

`Ctrl+C` (SIGINT, SIGTERM, and SIGBREAK on Windows) shuts down gracefully: interrupt and stop the lane, stop the timers, close the WebSocket clients (code 1001), drain pending hook events, close the database. A second signal forces exit.

### Environment

All read once at startup by `src/config.ts` (a pure function of the environment, unit-tested). Invalid values stop the daemon with a clear message that never echoes secrets.

| Variable | Default | Meaning |
|---|---|---|
| `DAEMON_PORT` | `7421` | Port on `127.0.0.1`. There is deliberately no way to bind another interface. Fails fast if taken. |
| `DATA_DIR` | Windows `%APPDATA%\ai-assistant`; otherwise `$XDG_DATA_HOME` or `~/.local/share` + `/ai-assistant` | Database, secrets, agent scratch folder. |
| `CLAUDE_BACKEND` | `fake` | `fake` (scripted, zero tokens) or `sdk` (real Agent SDK). |
| `CLAUDE_AUTH_MODE` | `api-key` | `api-key` or `local-login` ([ADR 0001](../../docs/adr/0001-claude-auth-modes.md)). Changeable in Settings; takes effect for the next lane session (restart). |
| `ANTHROPIC_API_KEY` | none | Read only in `config.ts`, kept non-enumerable (never in JSON or logs), passed to the SDK backend in `api-key` mode. |
| `CLAUDE_EXECUTABLE` | SDK-bundled binary | Path to your own `claude` for `local-login`. The daemon never reads or proxies OAuth tokens. |
| `DEMO` | off | `1` keeps the fixture sessions, tasks, approvals and events so the Work screen is populated. Runs on a separate, disposable `demo.db` that is recreated at every start. |
| `WEB_DIST` | `apps/web/dist` | Static files to serve (used only if `index.html` exists there). |
| `DEV_ORIGINS` | `http://127.0.0.1:5173,http://localhost:5173` | Extra allowed `Origin`s (the Vite dev server). |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`, `silent`. Every line is secret-masked. |
| `BUDGET_SECRETARY_USD`, `BUDGET_READER_USD`, `BUDGET_VOICE_USD`, `BUDGET_GLOBAL_USD` | 4, 1, 1, 10 | Daily budgets (API-equivalent estimates). Spend is persisted, so a restart does not reset the day. |
| `STALE_RUNNING_MINUTES` | `10` | A `running` hook session with no event for this long becomes `stale`. |
| `STALE_IDLE_MINUTES` | `360` | Same for `idle`, `waiting_input` and `blocked_permission` sessions. |
| `RETENTION_DAYS` | `30` | Finished hook sessions and raw events older than this are deleted. |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Used only by the hook installer CLI. |

### Developing the web app against the daemon

The daemon sends no CORS headers, so the browser must see one origin. Proxy through Vite (this config now lives in `apps/web/vite.config.ts`, target from `DAEMON_URL`):

```ts
server: {
  host: '127.0.0.1', port: 5173,
  proxy: {
    '/api': { target: 'http://127.0.0.1:7421', changeOrigin: true },
    '/ws':  { target: 'ws://127.0.0.1:7421', ws: true, changeOrigin: true },
  },
},
```

`changeOrigin: true` is required: the daemon rejects any `Host` other than `127.0.0.1:PORT` or `localhost:PORT`. The `Origin` the browser sends (`http://127.0.0.1:5173`) is in the dev allowlist.

## Security model

Threats: any web page can reach `127.0.0.1` (DNS rebinding, CSRF, cross-site WebSocket hijacking); other local software; secrets inside hook payloads. See [ARCHITECTURE section 10](../../docs/ARCHITECTURE.md). Implemented in `src/security.ts` and `src/http/guards.ts`, tested in `test/security.test.ts`, `test/ws.test.ts`, `test/static.test.ts`.

**Order of checks, on every request:**

1. `Host` must be exactly `127.0.0.1:PORT` or `localhost:PORT` (case-insensitive), else `403 forbidden_host`. Applies to static files and hooks too.
2. `Origin`: required and allowlisted on every non-GET browser request and on WebSocket upgrades; on GET it may be absent but, if present, must be allowlisted; on the hook route it may be absent (not a browser) but, if present, must be allowlisted. Allowlist = `http://127.0.0.1:PORT`, `http://localhost:PORT`, plus the dev origins. Else `403 forbidden_origin`.
3. Mutating routes (POST, PUT, PATCH, DELETE) need `Content-Type: application/json` (a body-less request without a type passes), else `415`. The hook route is exempt: its auth is a bearer token, and the headers Claude Code really sends were not verified, so it parses leniently and fails open.
4. Authentication: browser routes need the session cookie (`401`); the hook route accepts **only** `Authorization: Bearer <hook token>` (a cookie does nothing there, and the hook token does nothing on browser routes). Tokens in query strings are never read. `POST /api/auth/exchange` is the only open API route and is rate limited (10 failures per minute, then `429` even for a valid code).

**Secrets** live in `DATA_DIR/secrets.json` (mode `0600` where the OS honours it): a 256-bit random hook token, and the SHA-256 of each browser session token (never the token itself). All comparisons are constant time (both sides hashed to equal-length digests, `crypto.timingSafeEqual`). A running daemon notices a hook token rotated on disk (`hooks token --rotate`). On Windows the file is protected only by the user profile ACLs; **Windows Credential Manager via `@napi-rs/keyring` is the planned upgrade** and is not implemented.

**Browser session:** the printed link carries a single-use exchange code (256-bit, expires in 15 minutes). `POST /api/auth/exchange {code}` swaps it for an opaque cookie `aia_sid_<port>`: `HttpOnly; SameSite=Strict; Path=/; Max-Age=30 days`. `Secure` is not set because the daemon is plain http on loopback.

**Headers:** no CORS headers at all, on any response. Every response gets `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy`, `Cross-Origin-Resource-Policy: same-origin`, a `Permissions-Policy`, and `Cache-Control: no-store` on API responses. HTML gets the CSP:

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
connect-src 'self' ws://127.0.0.1:PORT ws://localhost:PORT; img-src 'self' data: blob:;
worker-src 'self' blob:; media-src 'self' blob:; font-src 'self' data:; object-src 'none';
form-action 'self'; frame-ancestors 'none'; base-uri 'none'
```

(MediaPipe or any WebAssembly later needs `'wasm-unsafe-eval'` in `script-src`: add it when that lands.)

**Privacy:** hook payloads are redacted before they are stored or logged (`src/store/redact.ts`): `tool_response` becomes a 300-character masked preview plus its size, `tool_input` keeps its structure with strings cut to 300 characters, prompts to 200, whole payloads capped at 16 KB; strings are masked for `sk-ant-...`, other API keys, GitHub and Slack tokens, AWS keys, JWTs, `Bearer`/`Basic` credentials, PEM private keys, `key=value` pairs whose key looks secret, plus the daemon's own hook token and API key verbatim. Masking runs before truncation so a secret cannot leak as a prefix. Logs carry no payloads, prompts or message text; the audit log records that a chat message was sent, never its text. The static handler never serves outside `dist` (decoded, backslashes treated as separators, resolved, re-checked after symlinks).

Not covered: other software running as the same Windows user can read `secrets.json` and the database (rely on BitLocker and profile permissions); the SQLite file is not encrypted.

## API

All routes except `/api/auth/exchange`, static files and `/hooks/*` need the session cookie. Errors are `{ "error": "<code>", "message": "...", "details"?: [...] }`. Request bodies are validated with the zod schemas in `packages/shared/src/daemon.ts` (`400 invalid_request` / `invalid_json`, `413` above 512 KB).

| Route | Purpose |
|---|---|
| `GET /api/health` | `DaemonHealth`: version, epoch, uptime, backend, lane state, hooks received, last hook time, session count, data dir. `hooksReceived` counts since process start. |
| `GET /api/snapshot` | A full `Snapshot` (validates against the shared schema) with `seq` = the bus's latest seq. Header `X-Daemon-Epoch` carries the epoch for `/ws`. |
| `POST /api/auth/exchange` | `{code}` -> sets the session cookie (open, rate limited). |
| `POST /api/chat` | `{text, modality}` -> `202 {accepted}` after `lane.send`. `503` if the lane is down, `502` if the lane refuses. |
| `POST /api/chat/interrupt` | Barge-in. `202`. |
| `POST /api/approvals/:id/decision` | `{decision: approved \| denied \| rejected}` (`rejected` = `denied`). Lane approvals go to `lane.decideApproval`; fixture-backed ones (demo, proposals) resolve like `FixtureClient`. **`409 not_answerable_here`** for approvals seen through hooks: hooks are non-blocking, so such a permission can only be answered in that terminal. `409 already_resolved`, `409 stale_approval` (the turn is gone, the card is closed as denied), `404`. |
| `POST /api/proposals/:id/decision` | Fixture-backed (the real vault is Phase 2). Updates the proposal, resolves the linked approval, no commit is invented. |
| `GET/POST /api/tasks`, `PATCH or PUT /api/tasks/:id`, `DELETE /api/tasks/:id` | Persisted kanban. PATCH takes `{column?, title?, description?, priority?}`. DELETE has no incremental event in the contract, so it publishes a `snapshot.reset`. |
| `PUT /api/settings/trust/:ruleId` | `{mode: ask \| auto}`. `409 locked` for locked rules (money, strategy, persona). |
| `PUT /api/settings/claude-mode`, `/guest`, `/webcam`, `/persona` | Persisted in `kv`. POST is accepted as an alias for PUT. Persona edits apply immediately and are audited (the lock on "change her own persona" is about Mira editing herself). |
| `DELETE /api/learned/:id` | Forget a learned fact (persisted). |
| `GET /ws` | WebSocket, see below. |
| `POST /hooks/:event` | Claude Code hooks. Bearer hook token only. Always answers `200 {}` first, processes afterwards. |
| `GET *` | Static files from `apps/web/dist` with SPA fallback (HTML navigations only) and the CSP. Without a build, `/` shows a placeholder page. |

Every mutation writes an audit entry and publishes the matching `ServerEvent` (`chat.*`, `avatar`, `session.update`, `agent.event`, `approval.new/resolved`, `task.update`, `proposal.update`, `settings.update`, `learned.update`, `snapshot.reset`).

### WebSocket

`/ws?since=<seq>&epoch=<epoch>`: needs the session cookie, an allowlisted `Origin` (required: every browser sends it) and a valid `Host`; nothing is read from the query string except `since` and `epoch`. Limits: 8 clients (`503` beyond), 64 KB messages, ping every 30 s (a client that misses a pong is dropped), a client whose unsent buffer passes 4 MB is dropped (slow consumer). Clients are read-only (`{type:"ping"}` is answered with `{type:"pong"}`).

The first message is the shared `WsHello` plus a local flag: `{type:"hello", seq, epoch, backend, version, resync, reason?}`.

**Resume rule.** `seq` is monotonic per process; the ring buffer holds the last 2000 events.

| Request | Result |
|---|---|
| no `since` | live events only, `resync:false` |
| `since` + same `epoch`, inside the buffer | the missed events are replayed right after the hello, `resync:false` |
| different `epoch` (daemon restarted) | `resync:true, reason:"epoch"`, nothing replayed |
| `since` older than the buffer | `resync:true, reason:"gap"` |
| `since` newer than the latest | `resync:true, reason:"future"` |
| `since` without `epoch` | `resync:true, reason:"unknown_epoch"` (it cannot be verified) |

On `resync:true` the client refetches `GET /api/snapshot`, replaces its state, and ignores live events with `seq <= snapshot.seq`. Flow for a normal connect: `GET /api/snapshot` (take `seq` and the `X-Daemon-Epoch` header), then open `/ws?since=<seq>&epoch=<epoch>`; nothing published in between is lost.

## What is real and what is mock

| Snapshot part | Source |
|---|---|
| `sessions`, `events`, `projects` | **Real** (Claude Code hooks). Empty on a fresh install. Demo mode: fixtures. |
| `tasks`, `approvals` | **Real** (REST and the lane). Empty on a fresh install. Demo mode: fixtures. |
| `chat` | **Real**, restored from SQLite; one persona greeting is seeded when empty. |
| `costDays`, `usageBlock` | **Real, from lane spend** (API-equivalent estimate). 14 zero days on a fresh install. The usage block is a placeholder (`usedPct` 0, window at the top of the hour) because the plan's real 5-hour window is invisible to the daemon. Hook sessions carry no cost (see below). |
| `settings.claude` | **Real**: mode, status, lane budgets and spend from the `BudgetGuard`, SDK version. The `int-claude` integration row says `mock` for the fake backend, `needs_auth` for sdk without a key. |
| `settings.persona`, `trustRules` (modes, counts), `guestMode`, `webcam`, `audit` | **Real**, persisted. Fresh installs start with zero trust counters; promotion is suggested after 10 approvals without a rejection. |
| `learned`, `proposals` decisions | Fixture content, **decisions persisted**. |
| `briefing`, `notes`, `memory`, `calendar`, `mail`, `contacts`, `finance`, `world`, other `integrations`, `privacy`, `vault` | **Mock fixtures** from `@ai-assistant/shared/fixtures`. |

## Claude Code monitoring (hooks)

Install the hooks (opt-in, reversible; the daemon never edits your Claude config by itself):

```
pnpm --filter @ai-assistant/daemon hooks print                     # the "hooks" block, no side effects
pnpm --filter @ai-assistant/daemon hooks install                   # dry run: shows the diff
pnpm --filter @ai-assistant/daemon hooks install --apply           # backup + non-destructive merge
pnpm --filter @ai-assistant/daemon hooks uninstall --apply         # removes only entries pointing at our URL
pnpm --filter @ai-assistant/daemon hooks token [--rotate]
```

Options: `--port`, `--skip <Event>` (repeatable), `--embed-token`, `--config-dir`, `--settings <file>`.

1. Start the daemon once (it creates `secrets.json`).
2. `hooks install --apply`. It resolves `CLAUDE_CONFIG_DIR` or `~/.claude`, writes `settings.json.bak-<UTC timestamp>` first, keeps every other setting and hook, appends our handlers as separate groups, and is idempotent (a second run changes nothing, never duplicates). A settings file it cannot parse, or a `hooks` value of the wrong shape, is left untouched with an error. CRLF and indentation are preserved.
3. Make the token available to Claude Code: by default the header is `Authorization: Bearer $AI_ASSISTANT_HOOK_TOKEN` with `allowedEnvVars`, so no secret sits in `settings.json`. Set that variable where you start `claude`: `setx AI_ASSISTANT_HOOK_TOKEN <token>` on Windows (then open a new terminal), `$env:AI_ASSISTANT_HOOK_TOKEN = '<token>'` for one PowerShell session; `hooks token` prints the value. Or use `--embed-token` to write the literal token (then treat `settings.json` as a secret).

Each handler is `{type:"http", url:"http://127.0.0.1:PORT/hooks/<Event>", timeout: 2, onFailure:"continue", headers, allowedEnvVars}` (`timeout: 1` for `SessionEnd`, which only gets a 1.5 s budget) for `NON_BLOCKING_HOOK_EVENTS`. `PreToolUse` is deliberately never hooked. **These field names come from the research notes and `spikes/hooks/settings.snippet.json`, not from a live read of the Claude Code hooks reference**; if Claude Code reports a settings validation error, check https://code.claude.com/docs/en/hooks. `PermissionRequest` is in the default set (as `NON_BLOCKING_HOOK_EVENTS` has it), but [ADR 0003](../../docs/adr/0003-monitoring-hooks-and-roster.md) says to observe it only if spike (b) shows that an empty `200 {}` reply does not auto-decide the prompt: until you have checked that on your PC, install with `--skip PermissionRequest`.

### What the projection does

`POST /hooks/:event` validates leniently (a zod `HookPayload` with passthrough; wrongly typed optional fields are dropped, not fatal), answers `200 {}` immediately and projects afterwards through a bounded FIFO queue. Garbage (bad JSON, arrays, missing `session_id`) is counted and ignored. Events of unknown names are stored raw and ignored by the projections. The raw `events` table is append-only, redacted, deduplicated on `session_id + tool_use_id + event` (or `agent_id` for subagent events) and pruned per session.

| Event | Effect on the session |
|---|---|
| `SessionStart` | `idle` (after `compact`: `running`) |
| `UserPromptSubmit` | `running`; title from the first line of the first prompt |
| `PostToolUse`, `PostToolUseFailure` | `running`, current tool, an `AgentEvent` (failures at level `error`); attributed to the subagent when `agent_id` is present |
| `PermissionRequest` | `blocked_permission` + a pending approval that the app cannot answer; it resolves as approved when the tool then runs, denied when the turn or session ends |
| `Notification` | `permission_prompt` -> `blocked_permission`; `idle_prompt`, `agent_needs_input`, `elicitation_*` -> `waiting_input`; others only logged |
| `SubagentStart`, `SubagentStop` | agent nodes with parent links (main agent id `main`; a parent is taken from `parent_agent_id` when present, else `main`) |
| `Stop` | `idle`, summary from the last assistant message |
| `StopFailure` | `error` with the reason |
| `SessionEnd` | `done` |

Sessions are tied to projects by `cwd` (the git root when it can be found on disk, else the folder; stable id from name plus a hash of the normalised path, colour from a palette; Windows paths are case and separator insensitive). Sessions from hooks have `source: "hook"`, `kind: "interactive"` (background only when the payload says so explicitly), and **cost 0: hook sessions carry no cost yet; transcript or OpenTelemetry cost is a later phase.** A brand-new project has no event in the contract, so the daemon pushes a `snapshot.reset` once.

**Staleness:** `SessionEnd` is often never delivered, so a `running` session with no event for 10 minutes becomes `stale` (idle or waiting sessions after 6 hours), with the reason in `error`; the next event revives it. A sweep runs every 30 s with an injectable clock and scheduler.

**Deduplication against the lane:** user-level hooks also fire for sessions the daemon starts. When the lane reports its backend session id, that id is recorded; hook events for it are dropped (counted as `ownedDropped`, nothing stored). A session projected a moment before the lane reported its id is removed again and clients receive a `snapshot.reset`.

## Data

`DATA_DIR`: `app.db` (+ `-wal`, `-shm`; or `demo.db`), `secrets.json`, `agent/` (the lane's scratch working directory). SQLite runs in WAL mode with foreign keys on and a 5 s busy timeout; the schema is versioned with `PRAGMA user_version` (idempotent migrations, a newer database is refused). Tables: `events`, `projects`, `sessions`, `agents`, `agent_events`, `tasks`, `approvals`, `chat_messages`, `audit`, `kv`, `usage`, `lane_sessions`. SQL exists only under `src/store`. `Store.backup(dest)` uses the SQLite backup API (never copy the file under WAL); there is no scheduled backup yet. Lane approvals left pending by a previous run are closed as denied at boot, since their turn no longer exists.

## Windows notes

- Paths use `node:path` and `node:os`; the data dir is `%APPDATA%\ai-assistant`. Hook payloads carry backslash paths; the project resolver understands them on any OS.
- The daemon is a user-session app, not a service (camera and audio live in the browser). No installer.
- It listens on IPv4 loopback only. `localhost` can resolve to `::1` first; browsers fall back to `127.0.0.1`, but `Host: [::1]:PORT` is rejected on purpose.
- Windows Defender real-time scanning can slow SQLite and the web build; exclude the data dir if it matters. Loopback-only listeners normally do not trigger a firewall prompt.
- better-sqlite3 is a native addon: it needs a prebuilt binary for your Node, or build tools.
- `chmod 0600` has no effect on Windows; the profile ACLs protect `secrets.json`.

## Tests

`pnpm --filter @ai-assistant/daemon typecheck` and `... test` (vitest, no network, sockets only on `127.0.0.1` ephemeral ports, temp directories). Files in `test/`: `config`, `redact`, `store` (migrations from empty and from an older version, repositories, backup), `security` (every rejection path), `hooks` (lifecycle, permission, notification, subagent tree, garbage, dedupe, staleness with an injected clock, redaction, retention), `bus` and `ws` (resume, epoch change, gap, slow client, heartbeat, limits, shutdown), `api` (snapshot validity in empty and demo modes, chat, approvals, proposals, tasks, settings, learned facts, costs, restarts), `static` (CSP, SPA fallback, traversal), `cli` (print, install, uninstall, idempotency), and `integration.agent-core` (the real Secretary lane with the fake backend and real SQLite through the daemon).

## Unverified and known limits

Nothing here has run against the live Claude API or on Windows.

- **The SDK backend** (`CLAUDE_BACKEND=sdk`): the daemon wires it, but only the fake backend was exercised.
- **Real hook payloads and delivery on Windows 11:** the projection is built from the field names in the research notes and tested with synthetic payloads. Whether Claude Code sends exactly these fields, whether `PermissionRequest`, `Notification` types, `SubagentStart` fields (`agent_id`, `agent_type`, a parent) and `last_assistant_message` look like this, and whether delivery works on Windows are all unconfirmed (spike (b) in `spikes/hooks`). Whether an empty `200 {}` leaves `PermissionRequest` undecided is unconfirmed.
- Whether `settingSources` without `'user'` keeps user-level hooks from firing for lane sessions: not verified; the dedupe is the safety net.
- Windows behaviour (`%APPDATA%` resolution, `setx`, file modes, symlink checks, EBUSY on the demo db) is reasoned about, and path logic is unit-tested with Windows-style strings on Linux, but none of it ran on Windows.
- Secrets are in `secrets.json`, not Windows Credential Manager.
- The hook installer's field names (`timeout` in seconds, `onFailure`, `allowedEnvVars`) were not checked against a live Claude Code.
- Hook sessions carry no cost; the usage block is a placeholder; `hooksReceived` resets at restart.
- Stale detection does not consult `claude agents --json` (the roster poll is not built).
- A hook-observed permission cannot be answered from the app by design.
- The lane's approvals from before a restart are closed, not resumed.
