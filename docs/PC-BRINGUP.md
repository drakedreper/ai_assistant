# PC bring-up (Windows 11, RTX 5070 Ti)

Status: draft, updated 2026-11-01. Nothing in this document has been run on the PC yet.

## Why this exists

Everything so far was built and tested in a Linux cloud sandbox: 2,748 unit tests and 142 end-to-end checks (a real daemon process, a real Chromium, real PTYs), with a scripted fake Claude and a simulated stage. That proves the logic and the wiring. It cannot prove the parts that depend on the user's machine: Windows paths and signals, native addons, ConPTY, real Claude Code hook payloads, the GPU, the camera, the microphone, or any game engine. This page says how to close that gap and what each step decides.

The agreed route (2026-10-31): the user runs Claude Code **on their own PC**, in a clone of this repo, using [spikes/pc/KICKOFF-PROMPT.md](../spikes/pc/KICKOFF-PROMPT.md). The cloud session cannot reach the PC (Remote Control lists no computer, and the Desktop Commander available in the cloud session runs inside the sandbox, not on the user's machine). Results are pasted back and folded into the docs.

## What each step verifies

| Step | Verifies | Why it matters |
|---|---|---|
| System inventory (`collect-system-info.ps1`) | GPU, driver, CUDA, VRAM, Unreal and Unity installs, build tools, Node, pnpm, claude | Picks the engine spike setup and flags missing prerequisites |
| `pnpm install`, typecheck, tests | `better-sqlite3` and `node-pty` native addons on Windows; every package's tests on Windows. Expected: 2,748 tests pass (shared 9, agent-core 457, stage-core 1,400, daemon 882). A different count is a finding | The daemon and terminal depend on native code; paths and file locking behave differently |
| End-to-end scripts | Sign-in cookie flow, WebSocket reconnect, the embedded terminal (ConPTY, `claude.exe` lookup), the stage simulator, the memory panel. Expected: smoke 26, daemon 37, terminal 41, stage 38 (142 checks), but **five terminal checks are skipped on Windows by design** (next section) | The terminal is the highest-risk and most Windows-sensitive feature |
| Manual terminal checks (PowerShell, below) | Process-tree kill, what happens to a terminal when the daemon is killed or its window is closed, loopback-only binding, secrets file permissions, environment scrub | These are exactly the behaviours the scripts cannot see on Windows. They decide whether the terminal is safe to leave enabled |
| Hooks with a real session | The real field names and delivery of Claude Code hooks; fail-open behaviour; PermissionRequest side effects | The hook monitor is built on assumptions taken from documentation (ADR 0003) |
| Time to first token | Whether a persistent SDK session is fast enough for voice | Decides whether a separate voice lane exists |
| whisper.cpp (CUDA) and Kokoro | Latency and VRAM on the 5070 Ti, in English | Decides the voice stack and the GPU budget shared with the 3D stage |
| WebGL and camera page | Hardware WebGL2, camera, microphone, audio latency | Decides the browser stage options |

## Risks specific to this machine

- **Blackwell consumer GPU (compute capability 12.0).** From general knowledge it needs a recent driver and CUDA 12.8 or newer, and some prebuilt ML wheels only support it from builds made for that CUDA. Verify against the actual tools; do not assume a benchmark transfers from other cards. (Unverified here.)
- **16 GB of VRAM is shared** by the 3D stage, local speech models and anything else running. Always record VRAM with the stage and each model loaded.
- **Native addons need a compiler on Windows** unless a prebuilt binary matches. If `node-pty` or `better-sqlite3` fails to install, the usual fix is the Visual Studio Build Tools C++ workload; the fallback for the terminal is a prebuilt-binaries fork of node-pty.
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
