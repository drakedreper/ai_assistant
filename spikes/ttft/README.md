# Spike (a): time to first token

Status: scaffold, not yet run. Date: 2026-10-31. Run it on the Windows 11 PC with your own API key; it was not executed in the build sandbox (only `node --check`).

Question: is a persistent Agent SDK streaming session fast enough for a voice loop, compared with a direct Messages API call to the same model at the same effort with the same system prompt? Background: [ADR 0006](../../docs/adr/0006-avatar-vrm-and-voice-stack.md) and [research/avatar-voice-room.md](../../docs/research/avatar-voice-room.md). No published TTFT numbers exist; user reports say a fresh headless `claude -p` adds roughly 0.6 to 0.8 s (anecdotal), so the script never spawns per turn.

## Run

In PowerShell, in this folder:

```
npm install                                   # only needed for the SDK path
$env:ANTHROPIC_API_KEY = Read-Host "key"      # this shell only; never saved to a file
node ttft.mjs                                 # direct and SDK, 2 warm-up turns + 12 measured turns
node ttft.mjs --turns 20 --gap-ms 2000 --json results\ttft-run1.json
node ttft.mjs --only direct                   # no SDK install needed
node ttft.mjs --system preset                 # SDK with the claude_code preset plus the persona appended
```

Options: `--model` (default `claude-haiku-5-5`), `--effort` (default `low`), `--turns`, `--warmup`, `--gap-ms`, `--system string|preset`, `--only both|direct|sdk`, `--json <file>`. Cost is a few cents.

If npm complains about peer dependencies for the SDK, install `zod@4`, `@anthropic-ai/sdk` and `@modelcontextprotocol/sdk` as its package metadata asks. `package.json` pins `@anthropic-ai/claude-agent-sdk` to 0.3.316, the version the research verified.

## What it measures

- Direct: a streaming `POST /v1/messages` with a cached system prompt, timed from sending the request to the first `text_delta`.
- SDK: one long-lived `query()` with streaming input, `settingSources: []`, partial messages on and built-in tools disabled, timed from pushing the user message to the first `text_delta`.
- The first turns (warm-up) are reported separately because they include process spawn and cache writes. Measured turns report p50 and p95; with fewer than 20 samples the p95 is close to the maximum.

Use `--system preset` as a second run to see what the heavier `claude_code` preset costs; the choice between preset-plus-append and a replacement prompt for the Secretary lane follows the numbers ([ARCHITECTURE.md](../../docs/ARCHITECTURE.md) section 4).

## Gate

SDK-session p50 of 1200 ms or less passes. Over it, add the Voice lane (direct Messages API, Haiku 5.5, low effort) in Phase 1. The script prints PASS or FAIL and the SDK overhead over the direct path at p50.

## Things to verify when you run it

The script says so in its header: the `output_config.effort` request field, the `effort` SDK option, the SDKUserMessage shape and the option that disables built-in tools have changed names across SDK versions. If a field is rejected, fix that one line and note it in your results; the comparison is only valid when both paths use the same model, effort and system prompt. If the SDK path reports a much larger first-token time than the direct path even with tools disabled, check that nothing is loading project settings or hooks (the SDK defaults to loading user, project and local settings unless `settingSources` is set).
