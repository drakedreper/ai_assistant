# Spike (b): do Windows `http` hooks reach a local receiver, and fail open?

Status: scaffold, not yet run. Date: 2026-10-31. Run it on the Windows 11 PC; nothing here has been executed in the build sandbox.

Why: the monitor ([ADR 0003](../../docs/adr/0003-monitoring-hooks-and-roster.md)) wants user-level `http` hooks as the primary live feed for Claude Code sessions the daemon does not own. Researchers cited GitHub issues for hooks failing silently on Windows 11 (December 2025, reported resolved) and for transcripts not written when HOME or USERPROFILE is redirected (July 2026, open); neither was verified. Only a real run on the real machine can settle it, and the recorded payloads become Phase 1 test fixtures.

Files

| File | Purpose |
|---|---|
| `receiver.mjs` | Dependency-free receiver. Binds 127.0.0.1, checks a bearer token and the Host header, always answers 200 `{}` fast, logs one JSON line per delivery to `results/hooks-log.jsonl` |
| `settings.snippet.json` | User-level `http` hooks for non-blocking events only. No `PreToolUse`, and no `PermissionRequest` in the base snippet |
| `capture-agents.ps1` | Captures `claude agents --json --all` and lists the fields each entry has |

Field names in the snippet (`type: http`, `url`, `timeout` in seconds, `headers`, `allowedEnvVars`, `onFailure`) follow the hooks reference as summarised in `docs/research/`. If Claude Code reports a settings validation error, check https://code.claude.com/docs/en/hooks and fix the snippet; note the correction in your results.

## Setup (PowerShell)

1. Back up your settings: `Copy-Item "$env:USERPROFILE\.claude\settings.json" "$env:USERPROFILE\.claude\settings.json.bak"` (skip if the file does not exist).
2. Create a token in the shell you will use for everything below:
   ```
   $env:SPIKE_HOOK_TOKEN = -join ((48..57) + (97..102) | Get-Random -Count 32 | ForEach-Object { [char]$_ })
   ```
   The token is never written to a file. The hooks read it from the environment of the `claude` process, so start `claude` from a shell where it is set.
3. Merge the `hooks` object from `settings.snippet.json` into `%USERPROFILE%\.claude\settings.json`. If that file already has `hooks`, merge per event rather than replacing. Do not paste secrets into it.
4. Start the receiver in its own window: `node receiver.mjs`. Check `Invoke-RestMethod http://127.0.0.1:7433/health` returns `ok`.

To undo everything afterwards: restore the `.bak` file (or remove the `hooks` entries you added) and delete `results\`.

## Tests

Record the result of each in your results sheet (see [../README.md](../README.md)). Use an empty or throwaway working directory.

1. Baseline with the receiver up. Run three times and note the durations:
   ```
   Measure-Command { claude -p "Reply with the single word ok." }
   ```
   Expect `SessionStart`, `UserPromptSubmit` and `Stop` lines in the receiver window. Some events may not fire in `-p` mode; record which do.
2. A tool-using prompt:
   ```
   claude -p "Read README.md and quote its first line." --allowedTools Read
   ```
   Expect `PostToolUse` with a `tool_use_id`. Open `results\hooks-log.jsonl` and check each line has `session_id`, `hook_event_name`, `cwd` and `transcript_path`, and note how Windows paths appear (backslashes, drive letter case).
3. Daemon down. Stop the receiver with Ctrl+C (it prints a summary). Repeat tests 1 and 2.
   - Expect: exit code 0 (`$LASTEXITCODE`), no hook error text, and durations within about 1 s of the baseline median.
   - Record any warning or delay Claude Code shows.
4. Hung receiver. Start it with a delay: `$env:SPIKE_DELAY_MS = 5000; node receiver.mjs`, then run test 1 again. With the 2 s hook timeout, each event should add at most about 2 s and never fail the run. This shows why hook timeouts must be short in the real installer. Unset the variable afterwards (`Remove-Item Env:SPIKE_DELAY_MS`) and restart the receiver without it.
5. Recovery. Restart the receiver normally and run test 1. Deliveries must resume with no change to the settings file.
6. Interactive session. In another folder run `claude`, send a prompt that uses a tool, trigger one permission prompt if you can, then `/exit`. Record which events arrived, in what order, and whether `SessionEnd` arrived at all (it only gets a 1.5 s budget, so a miss is normal and is why the daemon needs a staleness timer). Note whether `Notification` fired and with what type.
7. Roster capture. While a few sessions exist (one idle interactive, one busy or waiting interactive, ideally one background session):
   ```
   .\capture-agents.ps1 -Samples 12 -IntervalSeconds 5
   ```
   Record the property set per `kind`, and whether interactive entries lack `id` and `state` (the critic's refutation) and show only `status` (busy, waiting, idle). Note `pid`, `waitingFor`, `sessionId`, `name` where present.
8. Optional, needs the SDK from `../ttft`: run a tiny `query()` session with `settingSources: ['project']` and confirm no hooks reach the receiver, versus the default settings where they should. This confirms the expected dedupe behaviour in [ARCHITECTURE.md](../../docs/ARCHITECTURE.md) section 5.

## Gate

| Check | Pass |
|---|---|
| Delivery | `SessionStart`, `UserPromptSubmit`, `PostToolUse` and `Stop` each arrive at least once in the scenarios above; the observed or missing status of `Notification`, `SubagentStart`, `SubagentStop` and `SessionEnd` is recorded (a missing `SessionEnd` is expected and not a failure) |
| Payload | Fields present: `session_id`, `hook_event_name`, `cwd`, `transcript_path`; `tool_use_id` on `PostToolUse` |
| Fail-open | With the receiver stopped, runs finish with exit code 0, no error output and no more than about 1 s of added time; with a hung receiver the delay is bounded by the hook timeout |
| Roster | `claude agents --json --all` output is captured and the per-kind field table is recorded |

If the gate fails: hooks are not the primary feed for external sessions. The monitor falls back to roster polling plus SDK history (coarser status), daemon-owned sessions are unaffected, and ADR 0003 is updated.

Keep the redacted `results\hooks-log.jsonl` lines for the Phase 1 fixture set after you have looked through them. They are git-ignored by default.
