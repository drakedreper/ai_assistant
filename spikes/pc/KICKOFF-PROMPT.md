# Kickoff prompt for Claude Code on the Windows PC (RTX 5070 Ti)

Status: draft, 2026-10-31. Paste everything inside the box below into a new Claude Code session running on your PC, in an empty folder where the repo can be cloned (for example `C:\dev`). It does the Windows and GPU verification that the Linux build sandbox could not do. Nothing in it has been run yet.

How to start: open PowerShell, then

```powershell
cd C:\dev
claude
```

and paste the prompt.

````text
You are verifying a project on THIS Windows 11 PC. The project was built in a Linux sandbox, so nothing in it has ever run on Windows, against real Claude Code hook payloads, or on this GPU. Your job is to find out what really happens and report it plainly. Do not fix things silently and do not claim anything works unless you saw it work.

REPO: https://github.com/drakedreper/ai_assistant , branch claude/determined-pasteur-klc0fw. Read README.md, docs/PLAN.md, docs/PC-BRINGUP.md and spikes/README.md first.

RULES
1. Read-only first. Before ANY step that changes this machine, tell me exactly what it changes and wait for my explicit yes. That includes: installing software (Node, pnpm, Visual Studio Build Tools, Playwright browsers, CUDA, whisper.cpp, models), editing %USERPROFILE%\.claude\settings.json or any config outside the repo, setting an API key, opening the camera or microphone.
2. Never write an API key, token or password into a file, and never paste one back to me. If a step needs ANTHROPIC_API_KEY, tell me to set it in this shell session myself ($env:ANTHROPIC_API_KEY = "...") and to close the window afterwards.
3. Results go under spikes\pc\results\ (git-ignored). Do not commit anything and do not push. Tell me before you copy any output that may contain private paths, prompts or hook payloads, and redact usernames and tokens.
4. If something fails, stop on that step, give the exact command, the exact error text and your best diagnosis, and ask whether to continue. Do not paper over errors.
5. Report numbers, not adjectives.

STEPS (do them in order; skip a step only if I say so)
0. Preconditions. Report versions of git, node (needs >= 22.12), pnpm (needs 10), python, and whether Visual Studio Build Tools (C++ workload) is installed. If node or pnpm is missing, propose the install and wait for my yes (corepack enable is fine to propose for pnpm).
1. Clone the repo and check out the branch. Run spikes\pc\collect-system-info.ps1 (read-only). Show me the summary: OS build, CPU, RAM, GPU, driver, CUDA runtime, VRAM, Unreal and Unity installs, disks. Flag anything that looks wrong for a 16 GB RTX 5070 Ti.
2. Install and test. Run pnpm install and watch the native addons better-sqlite3 and node-pty: if either fails to build, capture the exact error and propose the fix (usually Visual Studio Build Tools) and wait for my yes. Then pnpm -r typecheck and pnpm test. List every failure verbatim and say whether it looks Windows-specific (paths, line endings, file locking, signals, process kill).
3. End to end. Ask before installing Playwright's Chromium (npx playwright install chromium). Then pnpm --filter @ai-assistant/web build and run, one by one: node apps\web\scripts\smoke.mjs (needs vite preview, see its header), node apps\web\scripts\e2e-daemon.mjs, and any e2e-terminal.mjs / e2e-stage.mjs that exist. Report pass/fail per check. The terminal checks are the most important Windows test: ConPTY, claude.exe resolution, process-tree kill.
4. Real Claude Code hooks (spikes\hooks\README.md). This is the biggest unknown. Start the receiver, then ask me before registering the hooks (it edits my user-level Claude settings; it must back the file up first and tell me how to undo it). Run a real claude session in a scratch folder that uses a tool, spawns a subagent and hits a permission prompt. Capture the REAL payloads for SessionStart, UserPromptSubmit, PostToolUse, PermissionRequest, Notification, SubagentStart/Stop, Stop, SessionEnd. Compare field by field with the HookPayload assumptions in packages/shared/src/daemon.ts and apps/daemon/src/hooks/projection.ts and list every difference. Then test: receiver stopped (does Claude finish normally, how much delay?), receiver hanging, and whether an empty 200 reply to PermissionRequest leaves the prompt undecided (ADR 0003 gate). Capture the output of "claude agents --json --all" with spikes\hooks\capture-agents.ps1. Offer to restore my settings at the end.
5. Time to first token (spikes\ttft\README.md). Only if I have set ANTHROPIC_API_KEY in this session. Run it and report p50 and p95 for the direct call and the Agent SDK session. The gate is p50 <= about 1.2 s.
6. GPU voice (spikes\voice\README.md). Ask before downloading or building anything. Measure whisper.cpp (CUDA) and Kokoro on this GPU in English: model, ms for STT after end of speech, first-audio ms for TTS, and VRAM use from nvidia-smi while both are loaded. Note that RTX 50-series (Blackwell) needs a recent CUDA toolkit and driver; report the exact versions that worked.
7. Browser and camera (spikes\webgl-camera\index.html). Open it in my default browser, tell me which checks need my permission (camera, microphone) and ask me to paste the report it shows. Confirm WebGL2 runs on the real GPU (not software).
8. Results. Fill spikes\pc\results\RESULTS.md using the template in spikes\README.md and add a short list of: what passed, what failed, what is unverified, and which ADR or phase decisions each result changes. Show it to me in full and ask whether I want it summarised back into the repo docs (do not do that without my yes).

When finished, print: the pass/fail table, the three biggest risks you found for running this on Windows, and the one thing you would fix first.
````

## Notes for the person who started the session

- It will ask before changing anything outside the repo folder. Say no to anything you do not understand.
- The hook step edits `%USERPROFILE%\.claude\settings.json`. It is backed up first, and the uninstall command restores it.
- Bring the pasted `RESULTS.md` back to the cloud session so the plan and ADRs can be updated with real numbers.
