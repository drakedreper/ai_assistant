# Plan and roadmap

Status: approved plan, Phase 0a in progress. Date: 2026-10-31.

This is the project's roadmap. It condenses the approved plan and the findings of the eight-agent research sweep (see [research/](research/)). Where a number or exit criterion is not in the approved plan, it is marked "proposed" and should be treated as a suggestion to confirm, not a commitment.

## Product in one paragraph

A local-first assistant on the user's Windows 11 PC that fuses four things: a living assistant (secretary, life manager, partner) in a 3D room window taking about a quarter of the screen with live chat, voice and optional webcam; a Claude Code mission control (sessions, subagents, kanban, cost, approvals); personal data (calendar, email, contacts, finance from the user's local "Atlas" app, news and world overview); and a second brain, an Obsidian-compatible vault with the assistant as its embodiment. The differentiator is the second brain: every proactive item must cite a strategy or knowledge note. If the product ever becomes "another calendar overview", it has failed.

## Decisions locked

"User" means the user decided it. "Plan" means it was resolved in the approved plan from research and can be changed through a new ADR.

| # | Topic | Decision | By | Record |
|---|---|---|---|---|
| 1 | Mockup form | Vite + React + TypeScript app that becomes the real frontend; no throwaway | User | this plan |
| 2 | Avatar | 3D anime character (VRM) in a 3D room, Three.js with `@pixiv/three-vrm`; Live2D is out | User | [ADR 0006](adr/0006-avatar-vrm-and-voice-stack.md) |
| 3 | Runtime | TypeScript end to end; browser-first (local Node daemon plus a browser tab or `--app` window); native shell later | User | [ADR 0002](adr/0002-browser-first-then-electron.md) |
| 4 | OS and hardware | Windows 11 native (PowerShell or Git Bash), NVIDIA GPU, so local Whisper and Kokoro are viable. GPU model and VRAM are not yet known | User | ADR 0006 |
| 5 | Language | English only for speech and notes; local STT, TTS and embeddings are fine | User | ADR 0004, 0006 |
| 6 | First real slice | Chat plus agent monitor, with seams for the living assistant, brain, personal data and finance from day one | User | this plan |
| 7 | Claude auth | "Both / not sure": a config switch, `api-key` versus `local-login`. Default is `api-key` for everything the daemon launches | User, default by Plan | [ADR 0001](adr/0001-claude-auth-modes.md) |
| 8 | Atlas (finance) | A local app with its own database and files, so a read-only adapter behind a contract; mock now | User | [ADR 0007](adr/0007-finance-contract-and-atlas.md) |
| 9 | Existing brain | Federate the Secondbrain app through its tool interface; the new vault otherwise starts fresh | User | [ADR 0004](adr/0004-memory-model-and-vault.md) |
| 10 | Persona | Warm, playful partner plus sharp secretary; placeholder name "Mira", editable in Settings | User | [PERSONA.md](PERSONA.md) |
| 11 | Autonomy | Start strict and widen after a trust period: a per-action-type trust ladder with an audit log | User | [ADR 0005](adr/0005-privacy-tiers-and-autonomy.md) |
| 12 | Claude interfaces | Official interfaces only: the Agent SDK for sessions the daemon owns; hooks and `claude agents --json` for sessions it does not; SDK history APIs instead of parsing transcripts. Cost is labelled "API-equivalent estimate"; OpenTelemetry is deferred | Plan | [ADR 0003](adr/0003-monitoring-hooks-and-roster.md) |
| 13 | Hooks | Non-blocking and fail-open; never hook `PreToolUse`; run a staleness timer | Plan | ADR 0003 |
| 14 | Stores | Files are truth for knowledge (the vault); SQLite is truth for operations; the derived index can always be rebuilt | Plan | ADR 0004 |
| 15 | Shell | Browser-first now; a thin Electron shell at Phase 4 rather than Tauri, confirmed or reversed by a Windows spike | Plan | ADR 0002 |
| 16 | Money | No money movement in v0.x; Atlas access is read-only; the move-money tool is permanently locked | Plan | ADR 0005, 0007 |
| 17 | Untrusted content | Mail and news are read only in tool-less or read-only lanes; memory-writing jobs over inbox-derived text may only propose or quarantine | Plan | ADR 0005 |
| 18 | Branding | Never name the app or persona "Claude" or "Claude Code"; "Powered by Claude" is fine | Plan | ADR 0001 |
| 19 | Naming | UI says "Money (Atlas)" for finance and never uses "Atlas" for graphs (Secondbrain has its own Atlas knowledge graph) | Plan | ADR 0007 |
| 20 | Do not copy | opcode, claude-squad, SillyTavern, Utsuwa, Mate-Engine (all AGPL), disler/claude-code-hooks-multi-agent-observability (no licence), Open-LLM-VTuber frontend (commercial-restricted). Safe references with attribution: Claude-Code-Agent-Monitor, claude-view, ccusage, AIRI, Amica, `@pixiv/three-vrm`, vibe-kanban | Plan | [research/prior-art-dashboards.md](research/prior-art-dashboards.md), [research/prior-art-companions.md](research/prior-art-companions.md) |
| 21 | Daemon stack | Node 24 LTS (Node 26 LTS is the alternative), TypeScript, Hono, better-sqlite3 with Drizzle 0.45, croner, `@napi-rs/keyring` | Plan | [ARCHITECTURE.md](ARCHITECTURE.md) |

## Roadmap

```
Phase 0a  Mockup and concept lock        (this turn)
Phase 0b  Windows spikes, four gates     (1-2 days, on the user's PC)
Phase 1   Chat + monitor + seams
Phase 2   Second brain + read-only personal data
Phase 3   Living assistant (VRM, voice, webcam snapshot)
Phase 4   Money + World + shell
Later
```

### Phase 0a: Mockup and concept lock

Scope
- Scaffold the pnpm workspace, the shared contracts (zod schemas, provider interfaces, tool surface) and seeded fixtures with a story bible.
- All screens on fixture data: Today, Work, Brain, Life, Money (Atlas), World, Settings, plus the Room, chat, command palette, room-size modes and layout presets.
- A `FixtureClient` that implements the same `ApiClient` the daemon client will, and pushes live events.
- This documentation set and the Phase 0b spike scaffolds.

Exit criteria
- The user signs off the screens, the Room placement and the Today layout.
- Typecheck, the shared integrity test and the Playwright smoke test are green; screenshots reviewed at 1920x1080 and 1366x768 with no console errors.

Risks
- The avatar crowding out the second brain, which is the real differentiator. Mitigation: the Room is a placeholder here, and the Brain screen gets equal effort.
- The mockup drifting from the contracts. Mitigation: the fixtures are validated against the zod schemas in a test.

### Phase 0b: Windows spikes (release gates)

One to two days on the user's own PC, using the scaffolds in [spikes/](../spikes/README.md). Each spike is a gate for a specific later decision.

| Spike | Question | Gate | Decides |
|---|---|---|---|
| (a) TTFT | Time to first token, persistent Agent SDK session versus a direct Messages call (Haiku 5.5, low effort) | About 1.2 s at p50 through the SDK session. Over it, add the Voice lane | Whether the Voice lane exists in Phase 1 or Phase 3 |
| (b) Hooks | Do Windows user-level `http` hooks reach a local receiver, including daemon-down fail-open? What does `claude agents --json --all` actually return? | All non-blocking events delivered; a stopped receiver adds no visible delay or error; roster fields captured | Whether hooks can be the primary live feed for external sessions |
| (c) Browser and speech | Chromium WebGL2 and `getUserMedia`; whisper.cpp (CUDA) and Kokoro latency on the user's RTX | WebGL2 and camera OK; voice stages within the latency budget | The Phase 3 voice order, and whether Electron is confirmed for Phase 4 |
| (d) ToS email | May a self-built local app drive the user's own logged-in Claude Code binary for personal use? | The email is sent. An answer is not required to proceed, because the default is `api-key` | Whether `local-login` is ever enabled for scheduled jobs |

Exit criteria: all four gates recorded in `spikes/results/` (not committed if it contains payloads) with a pass or fail and the raw numbers; ADRs updated where a gate fails.

Risks
- Hook delivery on Windows is the least verified assumption. Researchers cited issues for hooks failing silently on Windows 11 (December 2025, reported resolved) and for transcripts not written when HOME or USERPROFILE is redirected (July 2026, open). Neither was verified. Fallback if the gate fails: roster polling plus SDK history for external sessions, with daemon-owned sessions unaffected.

### Phase 1: Foundation, chat and monitor, with seams

Scope
- Daemon `apps/daemon`: Hono, one authenticated WebSocket with `seq` and a replay buffer, token plus Host and Origin guards, strict CSP.
- Ops SQLite with Drizzle and an append-only raw events table.
- Secretary lane: streamed chat with the persona prompt; approval cards through `canUseTool`; barge-in through `interrupt()`.
- Monitor: hook installer and receiver, roster poll, SDK history; session grid, timeline, subagent tree, manual kanban linked to sessions; cost chip.
- Seams stubbed but wired from day one: the full MCP tool surface backed by mock providers, the `AvatarEvent` bus and emotion-tag parsing, the vault folder layout, the finance contract with a contract-test suite, the audit log, and the budget service (per-lane caps, global daily cap, kill switch).
- Quality gates: a fake-Claude transport for zero-token tests, recorded hook payloads as fixtures, a Windows CI runner for native addons.

Not in Phase 1: OTel, statusline receiver, config explorer, cost per commit, activity heatmap, git worktree workspaces, transcript parsing beyond a defensive cost estimate for external sessions, auto-binding kanban to `TaskCreated`.

Exit criteria (proposed)
- Daemon runs on Windows 11 and the UI switches from `FixtureClient` to the daemon client in one line.
- A chat turn streams end to end; a `canUseTool` approval round-trips through the UI.
- A terminal Claude Code session started outside the app appears in the grid and changes state from hook events.
- Killing the daemon never stalls or errors a terminal Claude session.
- CI is green on `windows-latest`, including native addons; the budget kill switch is tested with the fake transport.

Risks
- The Agent SDK is 0.3.x and hooks grew from 12 to 33 events in under a year. Mitigation: pin versions, wrap the SDK in one module, keep contract tests.
- About 1 GiB of RAM per live Claude subprocess; cap concurrency and set `maxTurns` on every session.
- Native addons (better-sqlite3, keyring) must be built per platform and Node ABI.

### Phase 2: Second brain and read-only personal data

Scope
- Brain: vault skeleton with `_system/CLAUDE.md` schema; indexer with FTS5; `brain_*` tools (search, read, list, today, journal_append, capture, upsert, propose) with a path jail and layer-based write policy, one git commit per write; core and strategy changes only as proposals; CodeMirror 6 editor, backlinks, proposals queue; nightly digest and weekly review jobs with budget caps.
- Secondbrain federation through its tool interface. First task: check how a local daemon authenticates to it (unverified).
- Personal data, in this order: RSS plus Hacker News plus Open-Meteo (no OAuth); Google Calendar read-only; Gmail read plus drafts; Contacts. Google uses the desktop OAuth flow with PKCE and a loopback redirect. Then the daily briefing job on the Reader lane.

Not in Phase 2: embeddings and sqlite-vec (only after the retrieval eval shows FTS misses), sigma graph beyond basic, JSON Canvas, `.base` parsing, bi-temporal facts table, WYSIWYG block editing, Microsoft Graph, CalDAV and IMAP, write actions such as sending mail or creating events.

Exit criteria (proposed)
- The vault opens in Obsidian unchanged; every assistant write is a git commit; core and strategy edits only arrive as proposals.
- Path-jail tests pass for `..`, `%2e`, absolute paths and Windows backslash forms.
- A 30 to 50 query retrieval eval set exists with a recorded recall@5 baseline.
- The briefing job produces schema-valid output in which every thread cites at least one note.
- Google Calendar sync survives a 410 resync and a revoked token shows a visible "reconnect" state.
- Consolidation jobs that read inbox-derived text can only call `brain_propose` or write to quarantine.

Risks
- Google OAuth fragility: Testing mode expires refresh tokens after 7 days; production-unverified is fine for one user, but Gmail scopes are restricted so the app can never be shared without verification and an annual security assessment (CASA).
- Memory poisoning and prompt injection through inbox-derived content.
- Dual writers (user in Obsidian, assistant through tools) and Windows file locking; keep the vault out of OneDrive-style folders.
- Secondbrain access method unverified.

### Phase 3: Living assistant

Scope
- A real VRM Room: a licence-checked VRM 1.0 model, three to five VRMA clips (idle, listening, thinking, typing, sleeping), procedural blink and look-at, the five VRM emotion presets, amplitude lip-sync (AnalyserNode RMS to the `aa` preset), capped at 30 fps and paused when hidden.
- Voice in this order: text, then TTS (Kokoro behind a `TtsProvider`), then push-to-talk STT (whisper.cpp), then VAD (`@ricky0123/vad-web`) with headphones first.
- Webcam is an explicit "look at this" snapshot to Claude; local MediaPipe presence comes later.

Not in Phase 3: wake word, hands-free barge-in without headphones (needs echo cancellation), Smart Turn, viseme lip-sync, speech-to-speech, Live2D, custom or commissioned models, outfits, weather particles, camera parallax, continuous webcam frames, mood inference.

Exit criteria (proposed)
- Measured end-to-end latency (end of speech to first audible syllable) of about 2.5 s or better for a plain reply in local-first mode, on the user's PC.
- The camera indicator is always visible while the camera is on; no frame is persisted.
- The persona golden-conversation suite passes on the pinned model ids.

Risks
- An uncanny or poorly animated avatar harms the product; animation polish is a hidden time sink.
- GPU contention between rendering, STT, TTS and MediaPipe on one GPU.
- VRM model licences vary per model, including a sexual-expression flag; check each (from memory, unverified).

### Phase 4: Money, World and shell

Scope
- A real `AtlasFinanceProvider` once Atlas's local database or API is readable, read-only, passing the same contract tests as the mock; market data for holdings.
- A thin Electron shell: tray, autostart, single-instance, daemon supervision with an orphan check; the daemon stays a separate process. dockview layout presets (`dockview-react`, MIT only), backup and restore drill, installer.

Exit criteria (proposed)
- The restore drill succeeds from an offsite backup on a clean profile.
- Closing or force-killing the shell leaves no orphaned daemon or `claude` processes.
- Atlas passes the finance contract-test suite.

Risks
- Atlas's API is not final; keep the anti-corruption layer and capability flags.
- Electron versions move quickly (45.x current, docs already describe 46); you own its security checklist.
- Code signing and updaters matter only if the installer is shared.

### Later

Embeddings (sqlite-vec behind a `VectorStore`, only after a 30 to 50 query eval shows FTS misses), graph time slider, Microsoft Graph, write actions (send, create) through the trust ladder, remote or phone access, OpenTelemetry, Live2D only if the licence review passes, WSL2-sandboxed autonomous agents.

## Cross-cutting risks

| Risk | Mitigation | Where |
|---|---|---|
| Claude auth and terms | `api-key` default; the daemon never reads or proxies OAuth tokens; ToS email | ADR 0001 |
| Prompt injection through mail, news, invites | Reader and actor lanes, approval cards, proposals queue, quarantine | ADR 0005, ARCHITECTURE |
| Windows reality: no Claude Code sandbox on native Windows | Deny rules and hooks are the only guard; consider WSL2 for risky autonomous agents later | ARCHITECTURE |
| Pre-1.0 churn | Pin versions, one SDK wrapper module, contract tests | ARCHITECTURE |
| Scope creep: each pillar is a product | Mock-first, phase gates, hard scope cuts above | this plan |
| Unverified research facts | Re-check at the phase that needs each one | below |

Unverified in research (the sandbox could not reach several hosts): Google OAuth and Gmail scope details, Live2D terms, Windows hook-failure GitHub issues, Secondbrain's token-based access, Microsoft Graph token lifetimes, GDELT rate limits, Consumer versus Commercial terms data-use differences, VRM model licence flags. Each is re-checked at the phase that needs it.

## Open items that need the user

| # | Item | Why it matters | When |
|---|---|---|---|
| 1 | Send the ToS email ([spikes/tos-email.md](../spikes/tos-email.md)) | Settles whether `local-login` may drive scheduled jobs; a 24/7 daemon is a grey zone under "ordinary, individual usage" | Phase 0b |
| 2 | Run the four spikes on the Windows PC | Hooks, WebGL, camera, audio and GPU behaviour can only be proven there | Phase 0b |
| 3 | GPU model and VRAM, RAM, Windows build | Decides local Whisper and Kokoro feasibility and GPU contention with the Room | Phase 0b |
| 4 | Google account type (consumer Gmail or Workspace) and any Outlook account | Workspace "Internal" apps avoid the 7-day expiry and the 100-user cap | Phase 2 |
| 5 | Will the app ever be shared with other people? | If yes, Gmail restricted-scope verification and an annual security assessment must be budgeted up front | Phase 2 |
| 6 | Privacy appetite: may raw email bodies and raw transactions go to Claude, or aggregates and snippets only? | Defaults in docs/PRIVACY.md assume aggregates and snippets | Phase 1 |
| 7 | How will the daemon reach Atlas (HTTP API, database file, MCP) and with what auth? | The adapter and the contract-test fixtures | Phase 4 |
| 8 | How does a local daemon authenticate to Secondbrain? | The federation design | Phase 2 |
| 9 | Existing Obsidian vault to import? Size, plugins such as Dataview? | Import path and syntax tolerance | Phase 2 |
| 10 | Vault location; must not be a OneDrive-style synced folder | File-watcher and sync conflicts | Phase 2 |
| 11 | Monthly budget for nightly and weekly jobs, and the global daily cap | Budget service defaults (mockup shows 4, 1, 1 and a 10 USD global daily cap) | Phase 1 |
| 12 | Art direction and budget: licence-checked VRoid or Booth VRM, or commission an original; sexual-expression flag on the chosen model | Persona and licence safety | Phase 3 |
| 13 | EU or Nordic residence? GDPR position for webcam frames of other people and contacts' data sent to a US API | A question to settle, not an assumption | Phase 1 |
| 14 | Remote or phone access needed? | Changes the binding and auth design from loopback-only | Later |
| 15 | Confirm Windows native is the only runtime target and whether risky agents may run in WSL2 later | Native Windows has no Claude Code sandbox | Phase 1 |
| 16 | Is Rust and Visual Studio Build Tools installed? | Needed for some native addons; irrelevant to Electron | Phase 1 |
| 17 | Who owns edits to `persona.md` and `values.md`? Proposed: the user only, with Mira proposing | Autonomy tiers | Phase 1 |

## Verification for Phase 0a

1. `pnpm install`, `pnpm typecheck` and `pnpm build` are clean.
2. `pnpm dev` and a Playwright run at 1920x1080 and 1366x768: no console errors; the Her-space column is about 25% of the width; room modes and presets switch; approval cards update the queue; kanban drag works; wikilink navigation works.
3. `pnpm test` validates fixtures against the zod schemas and checks cross-references.
4. The lead commits and pushes; no pull request unless the user asks. A private single-file copy of the mockup can be offered for clicking through without installing anything.

## Direction update (2026-10-31, after the user reviewed the mockup)

User feedback, in their words summarised: the mockup screens are good and stay as a **draft**; stop investing in environment visuals; put the effort into a **backend for a live 3D assistant** with persistent memory, character selection, clothing selection and a scene the user can furnish ("VTube Studio, but in 3D"); the human must feel maximally alive; the final target is on the level of the AION 2 character creator; Unity or Unreal for the 3D; VTuber-class models are fine for the draft; reference material will follow. Also: use the Claude subscription **or** an API key; embed terminal access in the app, or control the PC through something like Desktop Commander; Google plugins (Calendar, Gmail) and the Secondbrain app via plugins or Google login. The user has a Windows PC with an RTX 5070 Ti and is willing to have tests run there.

Revised order of work:

| Phase | Scope |
|---|---|
| 1 (done or in progress) | Local daemon, Secretary lane (fake + Agent SDK backends), hook monitor, web DaemonClient, e2e test |
| 1.5 | Embedded terminal (the user's own `claude` binary in a PTY, signed in by the user, observed by our hooks); integrations hub: external tool servers (Desktop Commander for PC control, Google Calendar and Gmail via claude.ai connectors under subscription login or direct OAuth under an API key, the Secondbrain app) with every outward action on an approval card |
| 2 | **Stage backend** (`docs/adr/0008`): character store, asset catalog with licences, wardrobe and outfit director, scene objects, mood engine, behaviour director, speech pipeline, persistent character memory tied to the second brain; headless simulator stage and conformance tests; the web room becomes the first (draft) stage |
| 3 | Engine reference stage on the RTX 5070 Ti (Unreal or Unity, decided after references and a spike): live lip sync, outfit swap, scene editor, embedded or windowed |
| 4 | Realism: character-creation pipeline (MetaHuman / Character Creator class), strand hair, cloth, Audio2Face-3D, expressive voice |

What the user must do for tests on their PC: connect it through Remote Control (Claude Desktop app, Settings, Claude Code, Remote Control, or `claude remote-control` in a terminal in the repo folder). Then the spikes in `spikes/` and the GPU/engine measurements can run on the RTX 5070 Ti.

The long-term interface is the cerebral space described in [CEREBRAL-SPACE.md](CEREBRAL-SPACE.md): an empty void where the user's representation and the second brain live, with the knowledge graph, Claude sessions and an interactive terminal as objects in it.

Decision (2026-10-31): Windows and GPU testing runs through Claude Code on the user's own PC, using [PC-BRINGUP.md](PC-BRINGUP.md) and `spikes/pc/KICKOFF-PROMPT.md`. The cloud session cannot reach that machine.

Progress (2026-11-01): Phase 1 and the first half of Phase 2 are built. The terminal (Phase 1.5) and the stage backend (Phase 2a) are done and reviewed adversarially ([review record](reviews/2026-11-01-terminal-and-stage.md)). Next: the integrations hub (Desktop Commander, Google, Secondbrain), the Windows and GPU bring-up on the user's PC, then the engine reference stage once the references and the engine decision are in.
