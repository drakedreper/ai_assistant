# PC bring-up (Windows 11, RTX 5070 Ti)

Status: optional, updated 2026-11-01. Nothing the project needs next depends on it. Nothing in this document has been run on the owner's PC yet; much of it has run on a GitHub Actions Windows machine, see "Measured on a Windows runner" below.

## Quick start on Windows (5 minutes, optional, no GPU)

Only if you want to see the real thing run. You need Node.js 22.14 or newer and Git. No compiler: both native addons ship Windows binaries. The launcher enables pnpm itself and, after the install, checks that the database library opens a database on your Node (older 22.x crashes there, and the check says so in plain words).

```powershell
git clone --branch claude/determined-pasteur-klc0fw https://github.com/drakedreper/ai_assistant.git
```

Then double-click `start.cmd` in the new folder (macOS, Linux and Git Bash: `scripts/start.sh`). It installs, checks the database library, builds the web app, starts the daemon and opens the app in your browser. Settings, Stage shows her and the void; Settings, Privacy, "Embedded terminals" turns the terminal on; Work, Terminal opens a shell. Everything runs with the fake Claude (no network, no tokens) until you set `CLAUDE_BACKEND=sdk`. If something fails the window stays open: the exact error text is all that is needed. `scripts/start.sh` is tested end to end. `start.cmd` runs the same steps. Its first run on the owner's PC stopped at `pnpm install` (pnpm tried to compile better-sqlite3 with node-gyp; fixed, see Risks below). Since then it has run end to end on a GitHub Actions Windows machine (next section); it has not been run on the owner's PC since the fix. Set `OPEN_BROWSER=0` first if you do not want the browser opened.

By hand the steps are `pnpm install`, then `pnpm --filter @ai-assistant/web build` (without it the daemon says "Web UI not built"), then `pnpm --filter @ai-assistant/daemon start` and open the link it prints. The deeper terminal checks are below (T1 to T8). The GPU, voice, camera and engine checks are parked in [spikes/pc/PARKED.md](../spikes/pc/PARKED.md) until the voice milestone or an engine decision.

## Measured on a Windows runner

Not the owner's PC: a GitHub Actions `windows-latest` machine (Windows Server 2025 Datacenter, Node 22.14.0, Git for Windows with `core.autocrlf=true`, no pnpm installed beforehand, no interactive desktop), driven by `.github/workflows/windows.yml` on pushes to the working branch. Runs: [launcher and typecheck](https://github.com/drakedreper/ai_assistant/actions/runs/41303153541), [everything below](https://github.com/drakedreper/ai_assistant/actions/runs/41303802870) (2026-11-01). It is evidence about Windows, not about the owner's machine.

| Check | Result |
|---|---|
| `start.cmd` run the way a double-click runs it | **Passed.** It enabled pnpm itself; `pnpm install` took 12.8 s with no compiler (better-sqlite3 not built, node-pty found `prebuilds/win32-x64` and skipped node-gyp); the preflight printed `Database library OK: SQLite 3.53.4 (Node 22.14.0, win32 x64)`; the web app built in 1.6 s; the daemon started; the sign-in code exchange gave 200, `/api/snapshot` 200 (157,115 characters) and `/` served the built app |
| Browser opening (`OPEN_BROWSER=1`, the default) | Edge was started with the sign-in link (first run). It used the one-time code before the check could, which is why the workflow now sets `OPEN_BROWSER=0` |
| `pnpm -r typecheck` | **Passed**, all five projects |
| Unit tests: shared, agent-core | **Passed** |
| Unit tests: stage-core | 1,404 of 1,405 pass (commit ea3dbe6, which adds 5 locator-corpus tests: they pass). The failure is a timeout, not an assertion: the 400-iteration property test in `wardrobe.hardening.test.ts` ("many runs of random catalog damage then restore") exceeded the 5 s default on the slower machine |
| Unit tests: daemon | **506 failures in 22 files, not product bugs as far as seen.** The first failure, and the only error text read, is the same in every sampled test: the test harness (`test/helpers.ts`, `testConfig`) pretends the platform is `linux`, so `config.ts` resolves the temporary data directory with POSIX path rules and `C:\Users\...\Temp\daemon-test-x` becomes `D:\a\...\apps\daemon\C:\Users\...` (ENOENT in `writeSecretsFile`). The real daemon uses its real platform and ran fine in the launcher check. Whether other causes hide behind this one is not known |
| smoke (Chromium 153, Playwright 1.63.0) | **26 of 26** |
| e2e-daemon | **37 of 37** (sign-in, cookie, WebSocket, memory panel in a real browser) |
| e2e-terminal | 31 passed, 5 not run on Windows by design (see "What the end-to-end scripts skip on Windows" below), **5 failed**: "New shell opens a terminal and connects", "Open Claude here starts in the project folder", the environment-scrub check (timed out waiting for `NODE_PATH` in the shell), the OSC 8 link confirmation (0 dialogs for the first click), and the link-rules check (a tsx "Cannot find module" error). Not diagnosed. The runner has no interactive console, which may be why the ConPTY ones fail; a real desktop may differ |
| e2e-stage | **Did not run**: aborted at the start with a tsx "Cannot find module ... tsx/dist/esm/api/esm/index.mjs" error (the same error as the link-rules check above). Not diagnosed |
| C# stage client tests (`dotnet test`, SDK 8.0.427 installed by `setup-dotnet`; the image's own SDK is 10.0.402) | **165 of 165 passed, 0 skipped** (2026-11-01, commit 97d71ba): the golden fixtures, the 3,069-case locator corpus, the expression mapper, and the 4 live tests that start the real daemon with node and connect over a real WebSocket on Windows. The daemon's Windows failure count stayed at the 506 above after the 8 new daemon tests were added, so they pass there |
| Node 22.12.0 with the bundled Windows better-sqlite3 binary | Opening a database exits with `0xC0000005` (access violation), the crash seen on Linux; `check-native` prints the plain "too old" message; `pnpm install` on 22.12.0 succeeds with no compiler. Node 22.13 was measured on Linux only |

Not run anywhere on Windows: the manual terminal checks T1 to T8 below, the optional hooks step, and anything needing a real desktop, GPU or the owner's own PC.

## Why this exists

Everything so far was built and tested in a Linux cloud sandbox: 2,799 unit tests and 142 end-to-end checks (a real daemon process, a real Chromium, real PTYs), with a scripted fake Claude and a simulated stage. That proves the logic and the wiring. It cannot prove the parts that depend on the user's machine: Windows paths and signals, native addons, ConPTY, real Claude Code hook payloads, the GPU, the camera, the microphone, or any game engine. This page says how to close that gap and what each step decides.

Two ways to run it. Paste: the user runs Claude Code **on their own PC**, in a clone of this repo, using [spikes/pc/KICKOFF-PROMPT.md](../spikes/pc/KICKOFF-PROMPT.md), and pastes the results back. Zero-paste: the user enables Remote Control for a folder in the Claude desktop app (Settings, Claude Code, Remote Control), and the cloud session runs the checks itself while the user only approves prompts. Without one of the two the cloud session cannot reach the PC (it listed no computer, and the Desktop Commander available there runs inside the sandbox).

## What each step verifies

| Step | Verifies | Why it matters |
|---|---|---|
| (Parked) System inventory (`collect-system-info.ps1`) | GPU, driver, CUDA, VRAM, Unreal and Unity installs, build tools, Node, pnpm, claude | Picks the engine spike setup and flags missing prerequisites |
| `pnpm install`, typecheck, tests | `better-sqlite3` and `node-pty` native addons on Windows; every package's tests on Windows. Expected: 2,799 tests pass (shared 9, agent-core 464, stage-core 1,400, daemon 926). A different count is a finding | The daemon and terminal depend on native code; paths and file locking behave differently |
| End-to-end scripts | Sign-in cookie flow, WebSocket reconnect, the embedded terminal (ConPTY, `claude.exe` lookup), the stage simulator, the memory panel. Expected: smoke 26, daemon 37, terminal 41, stage 38 (142 checks), but **five terminal checks are skipped on Windows by design** (next section) | The terminal is the highest-risk and most Windows-sensitive feature |
| Manual terminal checks (PowerShell, below) | Process-tree kill, what happens to a terminal when the daemon is killed or its window is closed, loopback-only binding, secrets file permissions, environment scrub | These are exactly the behaviours the scripts cannot see on Windows. They decide whether the terminal is safe to leave enabled |
| (Optional) Hooks with a real session | The real field names and delivery of Claude Code hooks; fail-open behaviour; PermissionRequest side effects | The hook monitor is built on assumptions taken from documentation (ADR 0003) |
| (Parked) Time to first token | Whether a persistent SDK session is fast enough for voice | Decides whether a separate voice lane exists |
| (Parked) whisper.cpp (CUDA) and Kokoro | Latency and VRAM on the 5070 Ti, in English | Decides the voice stack and the GPU budget shared with the 3D stage |
| (Parked) WebGL and camera page | Hardware WebGL2, camera, microphone, audio latency | Decides the browser stage options |

## Risks specific to this machine

(The GPU risks, Blackwell and the shared 16 GB of VRAM, moved to [spikes/pc/PARKED.md](../spikes/pc/PARKED.md) with the GPU checks.)

- **Native addons need no compiler on Windows**: better-sqlite3 and node-pty ship Windows binaries, and `apps/daemon/test/native-addons.test.ts` fails if a dependency bump stops shipping them. The first real run failed because `pnpm-workspace.yaml` let pnpm run `node-gyp rebuild` for better-sqlite3 (node-gyp was not on that PC's PATH); it is now excluded from builds. Its binary needs Node 22.14 or newer: measured in the Linux sandbox, Node 22.12 and 22.13 load it and then segfault on the first database, so the launcher checks the version and `check-native` opens a test database. The Visual Studio Build Tools are only a fallback if a future bump drops a bundled binary; the fallback for the terminal is a prebuilt-binaries fork of node-pty.
- **ConPTY and the PTY host.** Every terminal runs in its own host process (`apps/daemon/src/terminal/ptyHost.ts`). On Windows the host is started without `detached`. Whether it survives the daemon's death long enough to end the terminal's process tree with `taskkill /T`, or dies together with the daemon and leaves ConPTY closing the console as the only cleanup, is unverified (apps/daemon/README.md, "Windows notes"). The manual checks T3 and T4 below answer it.
- **Claude Code on native Windows has no sandbox** and uses Git Bash or PowerShell for its tools; the embedded terminal inherits whatever the user runs there.

## What the end-to-end scripts skip on Windows

`apps/web/scripts/e2e-terminal.mjs` has Windows branches. Five of its checks print `PASS` on Windows although they did not run: their names end with "(skipped on Windows: not verified there)". **They are not passes. Count them as not verified and do them by hand (T2 to T4).**

1. every terminal runs in its own PTY host (a POSIX descriptor check),
2. closing a terminal ends its whole process tree,
3. a hard-killed daemon leaves no terminal process behind,
4. a hard-killed daemon with several terminals leaves none behind,
5. SIGHUP stops the daemon gracefully (Windows has no SIGHUP; a closed console arrives as one, see T4).

The other 36 terminal checks have Windows branches too (PowerShell one-liners instead of `sh`), and those branches have never run. If one of them fails, first decide whether the script's own one-liner is wrong or the product is, and say which.

## Manual terminal checks (PowerShell)

Start the daemon with the default (fake Claude, no network): `pnpm --filter @ai-assistant/daemon start`. Open the sign-in link it prints in the browser, then Settings, Privacy, switch on "Embedded terminals". Work, Terminal, "New shell" opens a terminal. The daemon listens on port 7421 unless `DAEMON_PORT` says otherwise. Each check needs a long-running child: type `ping -t 127.0.0.1` in the terminal.

**T1. Which processes belong to a terminal** (baseline; one `ptyHost` per open terminal):

```powershell
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'ptyHost' } | Select-Object ProcessId, ParentProcessId, Name
```

**T2. Closing a terminal ends its whole tree.** With `ping -t` running, check that `ping` exists, press Close on the terminal (or switch "Embedded terminals" off), and check again. Within about 5 seconds `ping` and the host for that terminal should be gone.

```powershell
Get-Process ping -ErrorAction SilentlyContinue | Select-Object Id, StartTime
```

**T3. A hard-killed daemon.** This stops the daemon without any chance to clean up. With `ping -t` running in an app terminal:

```powershell
$daemon = (Get-NetTCPConnection -LocalPort 7421 -State Listen).OwningProcess
Stop-Process -Id $daemon -Force
```

Wait 15 seconds, then run T1 and `Get-Process ping`. Expected: nothing left. Report exactly what remains (a `ptyHost`, the shell, `ping`, `conhost.exe` or `OpenConsole.exe`) and after how long it went. Repeat with two terminals open, one running `ping -t`.

**T4. The window that runs the daemon is closed.** Start the daemon from a PowerShell window, open a terminal in the app with `ping -t` running, close the PowerShell window with its X button, then run T1 and `Get-Process ping` from another window. (A closed console reaches the daemon as SIGHUP, which the daemon handles like SIGTERM.)

**T5. Loopback only.** Expected: `127.0.0.1` only, never `0.0.0.0` or `::`.

```powershell
Get-NetTCPConnection -State Listen -LocalPort 7421 | Select-Object LocalAddress, LocalPort, OwningProcess
```

**T6. The secrets file.** The permission bits do nothing on Windows, so this relies on the profile folder's default access rules. Expected: only your account, SYSTEM and Administrators.

```powershell
icacls "$env:APPDATA\ai-assistant\secrets.json"
```

**T7. Environment scrub.** In an app shell terminal. Expected: nothing that belongs to the daemon (`NODE_PATH` may be yours).

```powershell
Get-ChildItem Env: | Where-Object { $_.Name -match 'DAEMON|AIA_|MIRA_|STAGE|HOOK|ANTHROPIC_API_KEY|NODE_PATH' }
```

**T8. Launching.** "New Claude terminal" starts your own `claude` (or shows the `claude_not_found` help, which names `CLAUDE_EXECUTABLE`); "New shell" starts Windows PowerShell; "Open Claude here" on a project folder on `C:\` works; a UNC path such as `\\server\share` is refused with a plain message.

Report each as pass or fail with the actual output, and say what you could not do.

## Steps that change the machine (always need the user's yes)

Installing Node, pnpm, Build Tools, CUDA, whisper.cpp or models; installing Playwright's Chromium; registering hooks in `%USERPROFILE%\.claude\settings.json` (backed up first, undo command provided); setting `ANTHROPIC_API_KEY` in a shell session; opening the camera or microphone; stopping the daemon with `Stop-Process -Force` (T3) or by closing its window (T4).

## After the run

1. The user pastes `spikes\pc\results\RESULTS.md` back to the cloud session, with the list of checks that were skipped or not verified kept separate from the passes.
2. Real hook payloads become Phase 1 test fixtures; differences from the assumed shape change `HookPayload` and the projection.
3. Failed gates change [docs/PLAN.md](PLAN.md) and the ADRs they affect (0001, 0002, 0003, 0006). The T3 and T4 results decide whether the terminal needs a Windows Job Object (not built) before it is safe to leave enabled.
4. The engine spike (Unreal or Unity, measured on the 5070 Ti) is planned next, after the user's reference material and the engine decision: frame time with strand hair on and off, VRAM, outfit-swap time, audio-to-lip latency, and Audio2Face-3D throughput if its licence suits. Proposed gates: 60 fps at 1440p with one character and a small scene, outfit swap under 1 s, audio-to-lip latency under about 120 ms. See [ADR 0008](adr/0008-stage-protocol-and-engine-choice.md).
