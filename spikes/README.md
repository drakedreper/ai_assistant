# Phase 0b spikes: the four release gates

Status: scaffolds only, none of them run. Date: 2026-10-31.

These are for the user to run later, on their own Windows 11 PC, in one to two days. They were written in a Linux build sandbox without Windows, a GPU, a camera or any API key, and nothing here has been executed beyond a syntax check. Each spike is a gate: its result decides a specific later design choice (see [docs/PLAN.md](../docs/PLAN.md), Phase 0b).

Rules for all spikes
- Nothing needs the network or a key just to exist in the repo. Network, an API key or a download is needed only at the moment you run a spike, and each README says exactly where.
- Never write an API key or token into a file. Set them in the shell session (`$env:NAME = ...`) and close the window afterwards.
- Output goes to `results/` folders, which are git-ignored (`spikes/.gitignore`). Hook payloads, prompts, paths and camera reports can contain private data; look before sharing anything.
- Spike (b) edits your user-level Claude settings. It backs the file up first and says how to undo it.

## The gates

| Spike | Folder | Question | Pass | If it fails |
|---|---|---|---|---|
| (a) TTFT | [ttft/](ttft/README.md) | Is a persistent Agent SDK streaming session fast enough for a voice loop, compared with a direct Messages call (Haiku 5.5, low effort)? | SDK-session p50 time to first text token of about 1.2 s or less (p95 reported; proposed 2.0 s or less as a soft limit) | Add the Voice lane (direct Messages API, Haiku 5.5, low effort) in Phase 1 and keep the SDK for tool work |
| (b) Hooks | [hooks/](hooks/README.md) | Do user-level `http` hooks from Windows Claude Code reach a local receiver? Does a stopped receiver fail open? What does `claude agents --json --all` return? | Non-blocking events delivered with the expected fields; with the receiver down, sessions finish normally with no error and about 1 s or less added; roster fields captured | Hooks are not the primary feed for external sessions; fall back to roster polling plus SDK history; update ADR 0003 |
| (c) Browser, camera, audio, voice | [webgl-camera/index.html](webgl-camera/index.html), [voice/](voice/README.md) | Do WebGL2 (hardware, not software), `getUserMedia` for camera and microphone, AudioContext latency and AudioWorklet work in the browser? Do whisper.cpp (CUDA) and Kokoro meet the latency budget on the RTX? | WebGL2 on the real GPU with steady frames; a non-black camera frame; microphone signal; audio latency within the 30 to 100 ms alignment budget; STT, TTS and the combined estimate within the gates in the voice README | Fix drivers or settings first; otherwise change the voice order or engines, or reconsider the shell choice (ADR 0002, ADR 0006) |
| (d) ToS email | [tos-email.md](tos-email.md) | May a self-built local app drive the user's own logged-in Claude Code binary for personal use? | The email is sent. An answer is not needed to proceed, because the default is an API key | Keep every daemon-launched session on `ANTHROPIC_API_KEY`; keep `local-login` out of scheduled jobs |

What each gate decides
- (a) whether the Voice lane exists in Phase 1 or stays disabled.
- (b) whether hooks may be trusted as the live feed for sessions the daemon does not own, and what the roster really contains.
- (c) the Phase 3 voice order and engines, and whether Electron is confirmed for Phase 4.
- (d) whether `local-login` may ever serve scheduled jobs.

## Suggested order

1. (d) Send the email first; it runs on its own clock.
2. (c) Open the WebGL page and run all checks (10 minutes). Then record the machine and run the whisper.cpp and Kokoro procedure (a few hours including builds and downloads).
3. (b) Hooks and roster (about an hour).
4. (a) TTFT (about half an hour including `npm install` in `ttft/`).

## Results sheet

Copy this into `spikes/results/RESULTS.md` (git-ignored) and fill it in. Keep raw numbers; they replace the estimates in the research.

```
Date:                      Machine: (CPU / RAM / GPU + VRAM / Windows build)
Claude Code version:       Node version:        Browser + version:

(a) TTFT   model/effort/system:        direct p50/p95:        sdk p50/p95:        overhead:        PASS/FAIL
(b) Hooks  events seen:                missing:               fail-open test:     hung receiver:   roster fields:        PASS/FAIL
(c) WebGL  renderer:                   frame median/p95:      camera:             mic:             audio latency:        PASS/FAIL
    Voice  STT (model, ms):            TTS (engine, provider, ms):               contention:      combined estimate:    PASS/FAIL
(d) ToS    email sent (date):          reply (date, summary):
Decisions or ADR changes triggered:
```

## What to bring back

When the gates are recorded, the raw numbers go into the ADRs they affect (0001, 0002, 0003, 0006), the redacted hook payload lines become Phase 1 test fixtures, and any failed gate changes the phase plan in [docs/PLAN.md](../docs/PLAN.md).
