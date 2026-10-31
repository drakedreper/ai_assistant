# PC bring-up (Windows 11, RTX 5070 Ti)

Status: draft, 2026-10-31. Nothing in this document has been run on the PC yet.

## Why this exists

Everything so far was built and tested in a Linux cloud sandbox: 800+ unit tests, end-to-end runs in Chromium against a real daemon, and a scripted fake Claude. That proves the logic and the wiring. It cannot prove the parts that depend on the user's machine: Windows paths and signals, native addons, real Claude Code hook payloads, the GPU, the camera, the microphone, or any game engine. This page says how to close that gap and what each step decides.

The agreed route (2026-10-31): the user runs Claude Code **on their own PC**, in a clone of this repo, using [spikes/pc/KICKOFF-PROMPT.md](../spikes/pc/KICKOFF-PROMPT.md). The cloud session cannot reach the PC (Remote Control lists no computer, and the Desktop Commander available in the cloud session runs inside the sandbox, not on the user's machine). Results are pasted back and folded into the docs.

## What each step verifies

| Step | Verifies | Why it matters |
|---|---|---|
| System inventory (`collect-system-info.ps1`) | GPU, driver, CUDA, VRAM, Unreal and Unity installs, build tools, Node, pnpm, claude | Picks the engine spike setup and flags missing prerequisites |
| `pnpm install`, typecheck, tests | `better-sqlite3` and `node-pty` native addons on Windows; every package's tests on Windows | The daemon and terminal depend on native code; paths and file locking behave differently |
| End-to-end scripts | Sign-in cookie flow, WebSocket reconnect, terminal (ConPTY, `claude.exe` lookup, process-tree kill), stage simulator | The terminal is the highest-risk and most Windows-sensitive feature |
| Hooks with a real session | The real field names and delivery of Claude Code hooks; fail-open behaviour; PermissionRequest side effects | The hook monitor is built on assumptions taken from documentation (ADR 0003) |
| Time to first token | Whether a persistent SDK session is fast enough for voice | Decides whether a separate voice lane exists |
| whisper.cpp (CUDA) and Kokoro | Latency and VRAM on the 5070 Ti, in English | Decides the voice stack and the GPU budget shared with the 3D stage |
| WebGL and camera page | Hardware WebGL2, camera, microphone, audio latency | Decides the browser stage options |

## Risks specific to this machine

- **Blackwell consumer GPU (compute capability 12.0).** From general knowledge it needs a recent driver and CUDA 12.8 or newer, and some prebuilt ML wheels only support it from builds made for that CUDA. Verify against the actual tools; do not assume a benchmark transfers from other cards. (Unverified here.)
- **16 GB of VRAM is shared** by the 3D stage, local speech models and anything else running. Always record VRAM with the stage and each model loaded.
- **Native addons need a compiler on Windows** unless a prebuilt binary matches. If `node-pty` or `better-sqlite3` fails to install, the usual fix is the Visual Studio Build Tools C++ workload; the fallback for the terminal is a prebuilt-binaries fork of node-pty.
- **Claude Code on native Windows has no sandbox** and uses Git Bash or PowerShell for its tools; the embedded terminal inherits whatever the user runs there.

## Steps that change the machine (always need the user's yes)

Installing Node, pnpm, Build Tools, CUDA, whisper.cpp or models; installing Playwright's Chromium; registering hooks in `%USERPROFILE%\.claude\settings.json` (backed up first, undo command provided); setting `ANTHROPIC_API_KEY` in a shell session; opening the camera or microphone.

## After the run

1. The user pastes `spikes\pc\results\RESULTS.md` back to the cloud session.
2. Real hook payloads become Phase 1 test fixtures; differences from the assumed shape change `HookPayload` and the projection.
3. Failed gates change [docs/PLAN.md](PLAN.md) and the ADRs they affect (0001, 0002, 0003, 0006).
4. The engine spike (Unreal or Unity, measured on the 5070 Ti) is planned next, after the user's reference material and the engine decision: frame time with strand hair on and off, VRAM, outfit-swap time, audio-to-lip latency, and Audio2Face-3D throughput if its licence suits. Proposed gates: 60 fps at 1440p with one character and a small scene, outfit swap under 1 s, audio-to-lip latency under about 120 ms. See [ADR 0008](adr/0008-stage-protocol-and-engine-choice.md).
