# Research digest: shell-architecture

Status: digest of one researcher's structured output, as of 2026-10-31, with the critic's corrections noted. Tags: [verified] or [unverified] as reported. Unreachable from the research sandbox: v2.tauri.app, tauri.app, releases.electronjs.org, developer.mozilla.org and the GitHub REST API. Versions come from the npm registry and crates.io, which are the authority (web-search snippets showed stale versions).

## Question

What local-first desktop shell, daemon runtime, frontend stack, persistence, security model, packaging and monorepo layout suit a Node daemon hosting the Claude Agent SDK plus a React UI on Windows 11?

## Key findings

1. [verified] `@anthropic-ai/claude-agent-sdk` is at 0.3.316 (npm latest, 2026-10), Node 18.14 or later, no runtime dependencies, peer dependencies zod 4, `@anthropic-ai/sdk` 0.93 or later and `@modelcontextprotocol/sdk` 1.29 or later. It ships the native `claude` binary as per-platform optional dependencies (win32-x64 and win32-arm64 included) pinned to the SDK version; `--omit=optional` installs get none (fix: `pathToClaudeCodeExecutable`). Governed by the Commercial Terms. Windows 10 1809 or later is supported; Git for Windows is optional; no sandbox on native Windows. Sources: https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/latest, https://code.claude.com/docs/en/agent-sdk/quickstart.md, https://code.claude.com/docs/en/setup.md
2. [verified] Hosting model: `query()` spawns one `claude` subprocess per session over stdio; it never listens on the network. For a long-lived daemon the docs name the long-running pattern (`streamInput()`, `startup()` or `prewarm()`). Anthropic's starting size is about 1 GiB RAM, 5 GiB disk and 1 CPU per agent, growing over a session; no session timeout (set `maxTurns`). A `SessionStore` adapter can mirror transcripts to a database. Source: https://code.claude.com/docs/en/agent-sdk/hosting.md
3. [verified] SDK surface for the daemon: `cwd`, `settingSources` (`[]` skips user, project and local settings), `permissionMode`, `canUseTool` (called only when the flow falls through to a prompt), `hooks`, `resume`, `includePartialMessages`, `abortController`, `mcpServers`; `env` replaces the subprocess environment, so spread `process.env`. `Query` has `interrupt()`, `setPermissionMode()`, `setModel()`, `getContextUsage()`. `createSdkMcpServer()` and `tool()` run in-process MCP servers. `bun build --compile` is supported (SDK 0.3.144 or later). Source: https://code.claude.com/docs/en/agent-sdk/typescript.md
4. [verified] Hooks are the dashboard feed for sessions the daemon did not start: 33 events; the `http` type POSTs the event JSON with `headers` and `allowedEnvVars`; a non-2xx response or connection failure is non-blocking; default timeout 600 s. SDK callback hooks cover only sessions started by that SDK process. Sources: https://code.claude.com/docs/en/hooks, https://code.claude.com/docs/en/agent-sdk/hooks.md
5. [verified] Session discovery: transcripts under `~/.claude/projects/...`, 30-day retention, format internal, so prefer `listSessions()` and `getSessionMessages()` and mirror what you need into SQLite. `claude agents --json` exists as a native agent list. Sources: https://code.claude.com/docs/en/sessions.md, https://code.claude.com/docs/en/headless.md
6. [verified] Auth and terms: no claude.ai login or plan-credential routing by third parties; the daemon must not collect or proxy credentials; the same page says an end user may sign in to the unmodified binary. A single-user personal app launching the user's own logged-in binary "sits on the permitted side" in the researcher's reading, but the critic classed this as unclear. Plan limits assume ordinary individual usage. Sources: https://code.claude.com/docs/en/legal-and-compliance.md, https://code.claude.com/docs/en/agent-sdk/overview.md
7. [verified] Tauri 2: `tauri` 2.12.5 stable (2026-10-21), a 3.0.0-alpha exists. Sidecars need target-triple suffixes and capabilities. The official Node sidecar guide uses `@yao-pkg/pkg` but only demos a short-lived command. Issues #1896, #2464 and #3605 report sidecars surviving app exit, a known Windows pain. Sources: https://crates.io/api/v1/crates/tauri, https://raw.githubusercontent.com/tauri-apps/tauri-docs/v2/src/content/docs/develop/sidecar.mdx, https://github.com/tauri-apps/tauri/issues/1896
8. [verified] Tauri packaging on Windows: NSIS `currentUser` needs no admin; WebView2 ships with Windows 10 and 11; the updater signature cannot be disabled (a lost private key strands installs); tray needs the `tray-icon` feature; CSP is only active if set; `tauri-plugin-localhost` is discouraged. Sources: https://raw.githubusercontent.com/tauri-apps/tauri-docs/v2/src/content/docs/distribute/windows-installer.mdx, https://raw.githubusercontent.com/tauri-apps/tauri-docs/v2/src/content/docs/plugin/updater.mdx
9. [verified] Electron: npm latest 45.2.1 (MIT, Node 22.12 or later); the main-branch docs already describe Electron 46, where synchronous `safeStorage` was removed. On Windows `safeStorage` uses DPAPI, which does not protect against other apps in the same user session. Updates need a Squirrel.Windows feed, `update.electronjs.org` (public GitHub repo) or electron-updater. The official security checklist is work you own. Exact bundled Chromium and Node versions were not verified. Sources: https://registry.npmjs.org/electron/latest, https://raw.githubusercontent.com/electron/electron/main/docs/tutorial/security.md
10. [verified] Frontend library versions (npm, 2026-10): react 19.3.1, vite 8.3.5, dockview-react 8.8.3 (MIT; avoid the proprietary dockview-enterprise), react-grid-layout 2.3.0, flexlayout-react 0.11.1, `@dnd-kit/core` 6.3.1 (stable) versus `@dnd-kit/react` 0.5.3, recharts 3.10.1, zustand 5.0.16, `@tanstack/react-query` 5.105.0, tailwindcss 4.3.3, `@xterm/xterm` 6.0.0, node-pty 1.1.0. Sources: https://registry.npmjs.org/dockview-react/latest, https://registry.npmjs.org/vite/latest, https://registry.npmjs.org/@dnd-kit/core/latest
11. [verified] Daemon libraries: Node v26.13.0 "Lithium" LTS, v24.22.2 "Krypton" LTS, v22 "Jod" still LTS; better-sqlite3 13.0.3 (Node 22 or later); `node:sqlite` is a release candidate and its FTS5 and WAL support is not confirmed in the docs; drizzle-orm 0.45.4 stable (v1 only rc); `@napi-rs/keyring` 2.1.2 (prebuilt win32-x64); croner 11.0.0; hono 4.13.14 with `@hono/node-ws` 1.3.1. Node SEA cannot load `.node` addons from its embedded filesystem. MCP's transport guidance (validate Origin, bind 127.0.0.1, authenticate) applies to any localhost daemon. Sources: https://nodejs.org/dist/index.json, https://registry.npmjs.org/better-sqlite3/latest, https://nodejs.org/api/sqlite.html, https://registry.npmjs.org/@napi-rs/keyring/latest, https://registry.npmjs.org/croner/latest, https://registry.npmjs.org/hono/latest, https://nodejs.org/api/single-executable-applications.html, https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/specification/2025-06-18/basic/transports.mdx
12. [unverified] From memory, no fetchable source: `localhost` and `127.0.0.1` are secure contexts so `getUserMedia` works over http; keytar is archived (hence keyring); a Credential Manager blob is limited to roughly 2.5 KB; WebView2 camera permission persistence in Tauri 2 is unconfirmed; a Windows Job Object with `KILL_ON_JOB_CLOSE` is the robust way to make the daemon die with the shell; Tauri on Linux uses WebKitGTK; `--app=<url>` gives a chrome-less Chromium window; SmartScreen mainly affects downloaded unsigned installers. Source: memory.

## Options considered

| Option | Verdict |
|---|---|
| Tauri 2 shell around a separate Node daemon | The researcher's pick for Phase 3; the critic overturned it (see below) |
| Electron, daemon as a separate child process | Chromium parity everywhere; the critic's pick |
| Local Node daemon plus browser tab first, native shell later | Chosen for Phases 0 to 3 |

## Recommendation (the researcher's) and how the critic changed it

The researcher recommended "daemon plus SPA" browser-first, then a Tauri 2 shell in Phase 3 with Electron as a fallback, because the UI and daemon boundary makes the shell swappable. The critic kept the browser-first path but replaced Tauri with Electron for the shell: renderer parity between the Linux dev box and Windows (Tauri uses WebKitGTK on Linux), no Rust toolchain, no Job Object work, and AIRI shows Electron works on Windows. The approved plan follows the critic and places the shell in Phase 4. See [ADR 0002](../adr/0002-browser-first-then-electron.md).

Other parts of the recommendation that stand:
- Runtime split: daemon on Node 24 or 26 LTS (not Bun), Hono with a typed WebSocket envelope `{type, topic, seq, ts, payload}`, zod schemas shared with the UI, an agent host wrapping `query()` in streaming-input mode (companion session, worker sessions, `canUseTool` bridged to approval cards, unattended runs with explicit allowlists, `maxTurns` and a concurrency cap). Default to the SDK-bundled binary; offer "use my installed claude" through `pathToClaudeCodeExecutable`; never read or proxy OAuth tokens.
- Monitor feeds in three layers: SDK stream, installed http hooks, SDK history plus optional OTLP; mirror everything into SQLite.
- Frontend: React 19, Vite, Tailwind 4 with shadcn, Zustand for UI state, TanStack Query fed by the WebSocket, `@dnd-kit/core`, Recharts; dockview-react (MIT only) later for presets.
- Persistence: files are truth for knowledge, SQLite (WAL) for operations; paths `%APPDATA%\ai-assistant` plus a user-chosen vault; `~/.claude` untouched.
- Scheduler: croner plus a jobs table with per-job catch-up after sleep.
- Secrets: `@napi-rs/keyring`; never store Anthropic credentials; Google OAuth through loopback plus PKCE.
- Security model: bind 127.0.0.1 and ::1 only; a 256-bit install token; Host and Origin validation; strict CSP; DOMPurify and sandboxed iframes; reader versus actor capability tiers; deny rules and hooks for filesystem paths; webcam off by default; redacted logs; pinned SDK.
- Monorepo: `apps/web`, `apps/daemon`, later `apps/desktop`; `packages/shared` plus (the critic says add others only when a second consumer exists) `db`, `agent-core`, `vault`, `integrations`, `ui`.

## MVP versus later

Phase 0: the clickable mockup as the real web scaffold in fixtures mode (no daemon). Phase 1: daemon with Hono, WebSocket and guards; SQLite and Drizzle; chat through the SDK with partial messages; approvals; hook installer and sessions panel; kanban; a Windows CI job for native addons. Phase 2: vault service and MCP brain tools; scheduler jobs; read-only Calendar, Gmail, Contacts and News connectors with reader-tier agents; keychain; optional xterm panel. Phase 3 (the researcher's numbering): shell with go or no-go spike. Later: signed auto-update, voice and webcam pipeline, Atlas connector, embeddings, WSL 2-sandboxed agents, remote access, encrypted storage, Bun-compiled daemon, `node:sqlite`.

## Risks

- Prompt injection through mail, calendar, web and news; mitigate with reader and actor tiers, approval cards, deny rules, audit log, read-only finance.
- Localhost abuse (DNS rebinding, CSRF, cross-site WebSocket hijacking); mitigate with loopback bind, Host and Origin validation, token.
- No Claude Code sandbox on native Windows; bash writes bypass Write and Edit matchers.
- Orphaned daemon or `claude` processes after shell crashes.
- Resource load: about 1 GiB per live agent; no built-in session timeout.
- Terms and limits for subscription use of always-on agents.
- Upstream churn: Agent SDK 0.3.x, hook events, transcript formats, Tauri 3 alpha, Drizzle 1.0, dnd-kit 0.x.
- Native addons per platform and ABI; the Linux sandbox cannot validate Windows behaviour.
- Sleep and hibernate break timers and sockets.
- Webcam and mic privacy; scope creep.

## Open questions

- Auth model and budget; whether Windows native is the only target (WSL 2 later for risky agents?).
- Remote access need; Rust and Visual Studio Build Tools availability.
- WebView2 camera and WebGL behaviour (moot if Electron).
- Atlas access method and auth.
- Code signing only if distributed.
- Vault location and sync with Obsidian; conflict policy.
- Drizzle 1.0 and `node:sqlite` adoption timing.

## Decisions that followed

[ADR 0002](../adr/0002-browser-first-then-electron.md), [ADR 0003](../adr/0003-monitoring-hooks-and-roster.md), [ARCHITECTURE.md](../ARCHITECTURE.md).
