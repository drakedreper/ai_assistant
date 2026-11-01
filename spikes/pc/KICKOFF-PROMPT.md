# Kickoff prompt for Claude Code on the Windows PC (optional, about 15 minutes, no GPU)

Status: optional, updated 2026-11-01. Nothing the project needs next depends on this. Use it when you want to see the real daemon and the embedded terminal run on Windows. It no longer measures the GPU, voice or camera: those are parked in [PARKED.md](PARKED.md) until an engine is chosen.

Zero-paste alternative: in the Claude desktop app, enable Remote Control for a folder (Settings, Claude Code, Remote Control) and ask the cloud session to run these steps; you only approve prompts.

How to start: open PowerShell, then

```powershell
cd C:\dev
claude
```

and paste the prompt.

````text
You are checking a project on THIS Windows 11 PC. It was built in a Linux sandbox, so none of it has ever run on Windows. Find out what really happens and report it plainly. Do not fix things silently and do not claim anything works unless you saw it work. Keep your own output short: tables and numbers, not narration.

REPO: https://github.com/drakedreper/ai_assistant , branch claude/determined-pasteur-klc0fw. Read CLAUDE.md first, then docs/PC-BRINGUP.md.

RULES
1. Read-only first. Before ANY step that changes this machine, tell me exactly what it changes and wait for my explicit yes. That includes: installing software (Node, pnpm, Visual Studio Build Tools, Playwright browsers), editing %USERPROFILE%\.claude\settings.json or any config outside the repo, and setting an API key.
2. Never write an API key, token or password into a file, and never paste one back to me.
3. Results go under spikes\pc\results\ (git-ignored). Do not commit anything and do not push. Redact usernames and tokens from anything you save.
4. If something fails, stop on that step, give the exact command, the exact error text and your best diagnosis, and ask whether to continue. Do not paper over errors.
5. Report numbers, not adjectives.

STEPS (do them in order; skip a step only if I say so)
0. Preconditions. Report versions of git, node (needs >= 22.12), pnpm (needs 10), python, and whether Visual Studio Build Tools (C++ workload) is installed. If node or pnpm is missing, propose the install and wait for my yes (corepack enable is fine to propose for pnpm).
1. Clone the repo and check out the branch. Report OS build, CPU, RAM, GPU name and driver version, one line each (no script needed).
2. Install and test. Run pnpm install and watch the native addons better-sqlite3 and node-pty: if either fails to build, capture the exact error and propose the fix (usually Visual Studio Build Tools) and wait for my yes. Then pnpm -r typecheck and pnpm test. On Linux this gives 2,761 passing tests (shared 9, agent-core 464, stage-core 1,400, daemon 888): report your counts per package and treat any difference as a finding. List every failure verbatim and say whether it looks Windows-specific (paths, line endings, file locking, signals, process kill). Also report git config core.autocrlf.
3. End to end. Ask before installing Playwright's Chromium (npx playwright install chromium). Then pnpm --filter @ai-assistant/web build and run, one by one: node apps\web\scripts\smoke.mjs (needs vite preview, see its header), node apps\web\scripts\e2e-daemon.mjs, node apps\web\scripts\e2e-terminal.mjs and node apps\web\scripts\e2e-stage.mjs. On Linux they have 26, 37, 41 and 38 checks. Report pass/fail per check. IMPORTANT: five checks in e2e-terminal.mjs print PASS on Windows but their names end with "(skipped on Windows: not verified there)". They did not run. Count them as NOT VERIFIED, never as passes, and do them by hand in step 3b. If a check that did run fails, first decide whether the script's own Windows branch (a PowerShell one-liner) is at fault or the product, and say which.
3b. The terminal on Windows, by hand. This is the most important Windows test: ConPTY, claude.exe resolution, process-tree kill, and above all what happens to a terminal's processes when the daemon is killed or its window is closed. Follow "Manual terminal checks (PowerShell)", T1 to T8, in docs/PC-BRINGUP.md. Tell me before T3 and T4 (they stop the daemon with Stop-Process -Force and by closing its window) and wait for my yes. For each check report what you ran, the exact output, pass or fail, and for anything still running after a daemon kill: what it was and how long it survived.
4. Results. Print: the pass/fail table, the NOT VERIFIED list, the three biggest risks you found for running this on Windows, and the one thing you would fix first. Save the same text to spikes\pc\results\RESULTS.md. Do not summarise anything back into the repo docs without my yes.

OPTIONAL, only if I say "do the hooks step": real Claude Code hooks (spikes\hooks\README.md). Start the receiver, then ask me before registering the hooks (it edits my user-level Claude settings; it must back the file up first and tell me how to undo it). Run a real claude session in a scratch folder that uses a tool, spawns a subagent and hits a permission prompt. Capture the REAL payloads for SessionStart, UserPromptSubmit, PostToolUse, PermissionRequest, Notification, SubagentStart/Stop, Stop, SessionEnd. Compare field by field with the HookPayload assumptions in packages/shared/src/daemon.ts and apps/daemon/src/hooks/projection.ts and list every difference. Then test: receiver stopped (does Claude finish normally, how much delay?), receiver hanging, and whether an empty 200 reply to PermissionRequest leaves the prompt undecided (ADR 0003 gate). Offer to restore my settings at the end.
````

## Notes for the person who started the session

- It will ask before changing anything outside the repo folder. Say no to anything you do not understand.
- The hook step, if you ask for it, edits `%USERPROFILE%\.claude\settings.json`. It is backed up first, and the uninstall command restores it.
- Bring the pasted results back to the cloud session so the docs can be updated with real numbers.
