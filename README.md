# ai_assistant

A local-first personal AI assistant for a Windows 11 PC. A small 3D room on the left holds "Mira" (placeholder name), a warm and playful partner who is also a sharp secretary, and who says plainly that she is an AI. Under the room is a live chat. The rest of the screen is the stage: a daily briefing, mission control for Claude Code sessions, a second brain (an Obsidian-compatible markdown vault with Mira as its interface), life admin, finance from the user's own app "Atlas", and a re-ranked world overview. What separates it from another calendar overview is that every proactive item cites the user's own strategy or knowledge notes ("this touches your Q4 positioning").

Status (2026-11-01): the mockup screens are an accepted **draft**. Built and tested in a Linux sandbox: a local daemon (loopback server, SQLite, Claude Code hook monitor, Secretary lane with a zero-token fake Claude and an Agent SDK backend), a web client, an **embedded terminal** (your own `claude` or a shell in a PTY, off until you enable it), and the **stage backend** for a live 3D assistant (characters, wardrobe, the "cerebral void" scene, mood and behaviour, speech pipeline, an engine-agnostic protocol with a simulator stage). An adversarial review of the terminal and the stage found no critical flaw and all 74 findings are closed ([docs/reviews](docs/reviews/2026-11-01-terminal-and-stage.md)). After that review I added a way to inspect and forget what she remembers (Settings, Stage), and made the database overwrite deleted rows; those are tested but were not part of the review. **Not verified:** Windows, live Claude, real Claude Code hook payloads, any game engine or GPU. Nothing here needs your GPU. Running it on Windows is optional: double-click `start.cmd` (macOS and Linux: `scripts/start.sh`) to install, build, run and open it, and see [docs/PC-BRINGUP.md](docs/PC-BRINGUP.md) for the short check prompt; the GPU, voice and engine checks are parked. Conversations with Claude are short-lived by default and carried by her stored memory, which saves tokens (`CLAUDE_CONVERSATION`). `CLAUDE.md` is the short project memory for Claude Code sessions, and `scripts/verify.sh` checks everything in one command. The long-term direction is described in [docs/CEREBRAL-SPACE.md](docs/CEREBRAL-SPACE.md).

## Quick start

Requirements: Node >= 22.14 (the bundled SQLite library crashes on older 22.x) and pnpm 10 (the repo pins `pnpm@10.28.0`). No C++ compiler is needed on Windows or macOS: both native addons ship prebuilt binaries.

```
pnpm install
pnpm dev
```

Open http://127.0.0.1:5173.

- Add `?static` to the URL (http://127.0.0.1:5173/?static) to freeze the live simulator. Without it the fake daemon pushes agent ticks every 5 s, a new approval about 40 s in, and streams chat replies. `?static` is what the screenshots and the smoke test use.
- Nothing in the mockup needs a `.env`. `.env.example` documents the settings the daemon will use from Phase 1.

### Run it against the real daemon (zero tokens, fake Claude)

```
pnpm --filter @ai-assistant/web build
pnpm --filter @ai-assistant/daemon start
```

The daemon prints a one-time sign-in link (`http://127.0.0.1:7421/?code=...`); open it. Chat, Work and approvals are then live; Today, Brain, Life, Money and World still show sample data and say so. `pnpm --filter @ai-assistant/daemon hooks print` shows the Claude Code hook configuration (it changes nothing). See [apps/daemon/README.md](apps/daemon/README.md).

## Scripts

| Command | What it does |
|---|---|
| `pnpm dev` | Vite dev server for `apps/web` on 127.0.0.1:5173 |
| `pnpm typecheck` | `tsc` in every workspace package |
| `pnpm test` | Vitest in `packages/shared` (contracts), `packages/agent-core` (lane, backends, parser), `packages/stage-core` (stage backend and conformance suite) and `apps/daemon` (security, hooks, store, WebSocket, terminal, stage) |
| `scripts/verify.sh` | Everything in one command: typecheck, unit tests, build, mockup smoke test, the three end-to-end scripts and an orphan-process check, printed as a short table (`scripts/verify.sh quick` skips the browser parts) |
| `start.cmd` / `scripts/start.sh` | Run the app from a clone in one step: install, build the web app, start the daemon (fake Claude), open the sign-in link in your browser (`OPEN_BROWSER=0` skips that) |
| `pnpm --filter @ai-assistant/web e2e` | End-to-end: a real daemon process and a real browser (sign-in, live hooks, chat, approvals, reconnect, restart) |
| `node apps/web/scripts/e2e-terminal.mjs` | End-to-end for the embedded terminal (gate, real PTY, reattach, tickets, cross-origin refusals, process cleanup) |
| `node apps/web/scripts/e2e-stage.mjs` | End-to-end for the stage backend with the simulator stage over the stage socket (outfit, speech frames, camera, refusals, restart resume, inspecting and forgetting what she remembers) |
| `pnpm build` | Typecheck and production build of `apps/web` into `apps/web/dist` |
| `pnpm --filter @ai-assistant/web preview` | Serve the production build on 127.0.0.1:4173 |
| `node apps/web/scripts/smoke.mjs` | Playwright smoke test through every screen (needs Playwright with Chromium; see the header of the script) |
| `pnpm --filter @ai-assistant/web build:single` | One self-contained `index.html` in `apps/web/dist-single` (`vite build --mode single`, so it works in PowerShell and cmd), for sharing a clickable copy |

## Repo map

```
apps/
  web/                    Vite + React 19 + Tailwind 4 + Zustand (the real frontend, not a throwaway)
    src/layout/           Shell, rail, top bar, "her space" column, command palette
    src/room/             The 3D Room (three + react-three-fiber), procedural placeholder character
    src/chat/             Chat panel, composer, push-to-talk UI
    src/views/            One folder per screen: today, work, brain, life, money, world, settings
    src/state/store.ts    Zustand store; the only place the UI holds app state
    src/api/              ApiClient wiring (index.ts) and the in-memory FixtureClient
    src/components/       Shared UI: Panel, Badge, Gauge, ApprovalCard, NoteChip, SessionMini ...
apps/
  daemon/                 Local daemon: loopback Hono + WebSocket, SQLite store, hook receiver, lane wiring, hook installer CLI
packages/
  stage-core/             Stage backend: characters, wardrobe, scene, mood, behaviour, speech, protocol, simulator
  agent-core/             Claude lanes: fake and Agent SDK backends, Secretary lane, emotion tags, permissions, budgets
  shared/                 Contracts shared by the UI and, later, the daemon
    src/schemas/          zod schemas and types (Session, Approval, Note, Proposal, Briefing, Snapshot ...)
    src/providers.ts      Provider interfaces (Finance, Calendar, Mail, Contacts, News, Weather)
    src/tools.ts          The assistant's tool surface with lane and autonomy tier per tool
    src/fixtures/         Seeded mock data; read STORY.md first (ids and note paths there are contracts)
    test/                 Integrity tests for the fixtures
docs/                     Plan, architecture, ADRs, persona and privacy specs, research digests
spikes/                   Phase 0b scripts, to be run later on the user's own Windows PC
```


## How the mockup is structured

The UI talks to exactly one interface, `ApiClient` (defined in `packages/shared/src/schemas/api.ts`):

- `getSnapshot()` returns a `Snapshot`, everything the UI needs to render (briefing, sessions, notes, mail, finance, settings and so on). This is the shape the daemon's `GET /snapshot` will return.
- `subscribe(handler)` delivers `ServerEvent`s (chat tokens, agent events, approvals, avatar events), each with a monotonic `seq` so the client can detect gaps and resync.
- A handful of commands: `sendChat`, `interruptChat`, `decideApproval`, `decideProposal`, `moveTask`, `createTask`, `setTrustMode`, `setClaudeMode`, `setGuestMode`, `setWebcam`, `updatePersona`, `forgetFact`.

The mockup implements it with `FixtureClient` (`apps/web/src/api/fixtureClient.ts`), which builds the fixture snapshot relative to the real clock and then behaves like the future daemon by pushing events. In Phase 1 a WebSocket and REST client replaces it in `apps/web/src/api/index.ts`, and nothing else in the UI changes. The same fixtures and zod schemas become the daemon's test data, and `packages/shared/test/integrity.test.ts` keeps the mockup from drifting from the contracts.

## Documentation

| Document | Contents |
|---|---|
| [docs/PLAN.md](docs/PLAN.md) | Roadmap by phase, locked decisions, open items that need the user |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Daemon, Claude lanes, monitoring ingestion, stores, event envelope, security, testing |
| [docs/PERSONA.md](docs/PERSONA.md) | Mira's persona spec: honesty, boundaries, emotion tags, AvatarEvent contract |
| [docs/PRIVACY.md](docs/PRIVACY.md) | What leaves the PC, sensitivity labels, webcam rules, "forget" semantics |
| [docs/adr/](docs/adr/) | Architecture decision records 0001 to 0007 |
| [docs/research/](docs/research/) | Digests of the eight-agent research sweep, with source URLs |
| [spikes/README.md](spikes/README.md) | The four Phase 0b release gates and how to run them on Windows |

## Ground rules

- Never name the app or the persona "Claude" or "Claude Code". "Powered by Claude" is fine.
- The finance app is "Atlas"; the UI says "Money (Atlas)". Atlas is never used as a name for a graph.
- No money movement exists in v0.x, and Atlas access is read-only.
- Copy no code from AGPL or unlicensed projects (see docs/PLAN.md, "Decisions locked").
