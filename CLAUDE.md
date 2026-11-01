# Mira: project memory for Claude Code

Read this first; it saves re-reading the history. Details live in `docs/` (links below).

## What this is

A local, TypeScript, browser-first "life OS" with a live 3D assistant (placeholder name Mira): a warm, playful partner and a sharp secretary. A loopback-only Node **daemon** owns the data and talks to Claude; the React **web app** is the UI; a replaceable **stage** renders her (a three.js draft room today; **Unity is the first engine stage, chosen by the owner on 2026-11-01**, Unreal and MetaHuman stay the later realism route). Long-term interface: an empty "cerebral space" with the user and their second brain in it, connected to the terminal ([docs/CEREBRAL-SPACE.md](docs/CEREBRAL-SPACE.md)). Owner: Windows PC, NVIDIA RTX 5070 Ti, English only.

Work only on branch `claude/determined-pasteur-klc0fw`. Never open a PR unless asked. Commit trailers: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` and the `Claude-Session:` line.

## Status

Built and verified in a Linux sandbox: the mockup (an accepted draft), daemon, web client, Claude lanes (zero-token fake backend and the real Agent SDK backend), hook monitor, embedded terminal, the stage backend (characters, wardrobe, scene, mood, speech, memory) with a simulator stage, and two adversarial reviews with all findings closed ([docs/reviews/](docs/reviews/)).

**Verified on a GitHub Actions Windows runner, not the owner's PC:** `start.cmd` end to end, typecheck, smoke 26 and e2e-daemon 37 ([docs/PC-BRINGUP.md](docs/PC-BRINGUP.md), "Measured on a Windows runner", which also lists what failed there: a daemon test harness that fakes `platform: 'linux'`, one slow stage-core test, four terminal e2e checks, and the stage e2e aborting on a tsx error; none blocks the launcher). **Docker** ([docs/DOCKER.md](docs/DOCKER.md), ADR 0009): verified on a Linux Docker runner only, not on Docker Desktop for Windows. **Unity prep** ([docs/UNITY.md](docs/UNITY.md)): the C# stage client `unity/Packages/com.mira.stage` (engine-free core) is built and tested without Unity, with golden fixtures shared with the TypeScript contract and live tests against the real daemon, in the sandbox, on a Linux runner (`.github/workflows/unity-stage.yml`) and on a GitHub Windows runner (an information step of `windows.yml`: 165 of 165 passed). **The Unity project itself does not exist yet**: it is built on the owner's PC with `spikes/unity/KICKOFF-PROMPT.md`. **Not verified: the owner's PC, a live Claude, real Claude Code hook payloads, Unity itself (the runtime was only ever compiled by `dotnet`, never by Unity), any GPU.** Say so plainly in reports. The Windows/GPU check is optional and parked ([docs/PC-BRINGUP.md](docs/PC-BRINGUP.md)): never make it a gate or end a report with it.

## Layout

- `apps/web` (Vite, React 19, Tailwind 4, zustand, react-three-fiber), `apps/daemon` (Hono, better-sqlite3, ws, node-pty)
- `packages/shared` (zod contracts: `daemon.ts` routes, `stage.ts` protocol `mira-stage/1`, `tools.ts`, schemas), `packages/agent-core` (Claude lanes, permission broker, fake and SDK backends), `packages/stage-core` (stage backend and the simulator stage)
- `unity/Packages/com.mira.stage`: the Unity package (C# 9, no UnityEngine in `Runtime/*.cs`; `Tests~/` holds the .NET test projects and the golden fixtures; the Unity layer, `Runtime/Unity`, is added on the PC). `unity/.gitignore` blocks Unity output and every binary model.
- `docs/`: `PLAN`, `ARCHITECTURE`, `PRIVACY`, `PERSONA`, `CEREBRAL-SPACE`, `DOCKER`, `UNITY`, `PC-BRINGUP`, `adr/0001-0009`, `reviews/`, `research/`. `spikes/` is parked hardware experiments and the PC kickoff prompts (`spikes/pc`, `spikes/unity`).
- Each package has a README with its details (`apps/daemon/README.md` is the long one: security model, terminal, stage).

## Commands (pnpm 10, Node 22.14+)

- `scripts/verify.sh` runs everything (typecheck, unit tests, the C# client when `dotnet` exists, build, smoke, three e2e scripts, orphan check) and prints a short table; `scripts/verify.sh quick` is typecheck + unit tests + C# (about 1 to 2 minutes). Details go to `.verify.log`.
- C# (needs the .NET 8 SDK; `apt install dotnet-sdk-8.0` here): `dotnet test unity/Packages/com.mira.stage/Tests~/Tests/Mira.Stage.Tests.csproj` (165 tests; 4 start the real daemon, so `pnpm install` first). Fixtures: `pnpm --filter @ai-assistant/daemon exec tsx ../../scripts/record-stage-golden.ts` (recorded real traffic) and `UPDATE_GOLDEN=1 pnpm --filter @ai-assistant/stage-core exec vitest run test/locator.golden.test.ts` (locator corpus); each has a TypeScript test that fails when the fixture is stale.
- Run the app: `start.cmd` (Windows) or `scripts/start.sh` (install, build, start, open the browser). By hand it is install, `pnpm --filter @ai-assistant/web build` (the daemon serves the built UI; without it it says "Web UI not built"), then the daemon start below.
- One suite: `pnpm --filter @ai-assistant/daemon exec vitest run test/<file>` (same for `agent-core`, `stage-core`, `shared`).
- E2E: `node apps/web/scripts/e2e-stage.mjs` (also `e2e-daemon`, `e2e-terminal`, `smoke`). Run them one at a time.
- Docker: `start-docker.cmd` or `scripts/start-docker.sh` (builds, starts, prints the sign-in link); `docker compose up -d --build`; `docker compose exec daemon node --import tsx src/stage/cli.ts token` prints the stage token. There is no Docker daemon in this sandbox: the image is verified only by `.github/workflows/docker.yml` (builds it, runs it, `scripts/docker-smoke.ts`). Details: `docs/DOCKER.md`.
- Run the daemon: `pnpm --filter @ai-assistant/daemon start` (prints a sign-in link). Env: `CLAUDE_BACKEND=fake|sdk`, `CLAUDE_AUTH_MODE`, `CLAUDE_CONVERSATION=fresh-daily|resume`, `DATA_DIR`, `DAEMON_PORT` (7421).

## Invariants (do not break)

- Loopback only (the one exception is container mode, `MIRA_CONTAINER=1`, set by the Dockerfile alone: the daemon listens on the container's interface and `docker-compose.yml` publishes the port on `127.0.0.1` only; ADR 0009); Host, Origin and cookie on every route; separate hook and stage tokens; terminals need tickets and a pairing proof and are never reachable by any Claude lane or tool.
- No secrets, tokens, keystrokes or terminal output in logs or the database. No API key in a file. The daemon never reads or proxies Claude OAuth tokens.
- Finance is read-only; money movement is permanently locked. All characters are adults; the wardrobe keeps a clothed baseline; the seed catalog is metadata only (no binary assets committed).
- Shared contracts change additively (optional fields). The web client and the daemon both import them.
- What she writes with `character_remember` must exist nowhere but the memory table: `ToolSpec.privateInput`, no copy in approvals, audit, snapshots or logs, and Forget ends the Claude conversation (`SecretaryLane.startFresh`).
- Conversations with Claude are short-lived by default (memory-first, saves tokens): do not go back to resuming one for ever.

## How to work here

- Every fix gets a test that fails without it: remove the fix, watch the test fail, restore the file byte for byte (copy to the scratchpad first). Two of my tests once passed with the feature removed.
- Test through the real path (real lane, broker, SQLite, browser), not only the unit. The fake Claude has triggers: "remember that ...", "send ...", "delete ...", "spend ...", "!error", "!crash".
- Report what was verified and what was not, with numbers. Do not hedge things that were verified.
- Gotchas: a `cd` in one Bash call carries into the next, so use absolute paths. Never `pkill -f` or `pgrep -f` with text that is in your own command line (it kills your shell). One `pnpm install` at a time (parallel installs corrupt `node_modules`). Zod 4 `z.record(enum, ...)` is exhaustive. The sandbox has Chromium with software WebGL only, and Desktop Commander here runs in the sandbox, not on the user's PC.
- Native addons: better-sqlite3 ships prebuilt binaries and must never be in `onlyBuiltDependencies` (pnpm runs `node-gyp rebuild` for any allowed package with a `binding.gyp`; that failed on the owner's first Windows install, a PC with no C++ toolchain). Its binary is Node-API 10: Node 22.12 and 22.13 load it and then segfault on the first `new Database()`, so the minimum is 22.14. `apps/daemon/test/native-addons.test.ts` and `checkNative.test.ts` guard both, and the launchers run `pnpm --filter @ai-assistant/daemon check-native` after the install. node-pty has no Linux prebuilds, so it must stay allowed to build.
- Unity and C# gotchas: `.gitignore` has `*~` for editor backups, which also matches Unity's `Tests~` (re-included with `!Tests~/`; after adding a `~` folder check that `git status` lists it). A stage must SUCCEED `character.load` whenever the base model loads: a failed one makes the daemon treat her as not loaded (`session.ts` settle), so she never performs. Never type `\uXXXX` escapes for invisible characters in an Edit or Write call (a tool path once turned them into literal characters, and U+2028 inside a C# literal is a newline to the compiler): build such strings from code points, keep fixtures pure ASCII, and scan for stray characters. When mutation-testing C#, restore the file with a NEW mtime (`cp` then `touch`): `cp -p` keeps the old one and MSBuild reuses the mutated DLL.
- Independent reviews are worth their cost for security-sensitive changes (the last one found a real leak); keep their briefs narrow and tell the reviewer not to run e2e while verification runs.

## Where decisions live

`docs/adr/` (auth modes, hooks, memory model, privacy tiers, avatar, finance, stage protocol and engine choice, container mode), `docs/reviews/` (what each review found and how it was closed), `docs/PRIVACY.md` (data flows, forget semantics, open items 6 to 9), `docs/PLAN.md` (phases and progress).

## The owner

Terse and direct. Wants visible progress over ceremony and hates being blocked on the PC/GPU check. Cares about tokens (hence memory-first conversations and this file). Wants an athletic, intelligent, authoritative adult character in a dark "cerebral void" space, with real persistent memory, character and clothing selection, and eventually AION 2-level realism (Unreal later). A VRM character is fine for now. Next milestone: the Unity stage (chosen 2026-11-01: "a model and an environment built in Unity, in the assistant's room", the backend in Docker), built on the PC from `spikes/unity/KICKOFF-PROMPT.md`. A living character in the browser and the integrations hub (Gmail, Calendar, Secondbrain) remain options.
