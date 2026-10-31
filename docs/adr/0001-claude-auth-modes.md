# ADR 0001: Claude authentication modes

Status: Accepted with one open item (the Anthropic terms question, spike (d)). Date: 2026-10-31.

## Context

The daemon will start Claude sessions through the Agent SDK for the Secretary and Reader lanes, and may call the Messages API directly for a Voice lane. How those calls authenticate decides cost, terms exposure, which features exist, and what the architecture can assume.

What the research verified (see [research/claude-integration.md](../research/claude-integration.md), [research/critic.md](../research/critic.md)):

- Anthropic's legal page says: "Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, Max, or Ultra plan credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens." It says developers using the Agent SDK "should use API key authentication". The SDK overview carries the same note ("Unless previously approved...").
- The same page says this does not prevent an end user from signing in to the unmodified Claude Code binary with their own subscription. It says nothing about a self-built daemon driving the SDK programmatically for one's own use, and it says plan limits "assume ordinary, individual usage of Claude Code and the Agent SDK". A 24/7 daemon with scheduled jobs, a voice loop and concurrent agents may not match that. The critic classed the personal-use question as unclear, to be settled by asking Anthropic.
- The SDK is governed by Anthropic's Commercial Terms. Free, Pro, Max and Ultra fall under the Consumer Terms; API-key use falls under the Commercial Terms. Whether chat data may be used for training differs between them. That difference is from memory and must be checked before email, finance and companion conversations flow through a subscription.
- `--bare` mode never reads OAuth credentials or the keychain and requires `ANTHROPIC_API_KEY`. A direct Messages API Voice lane also needs a key.
- claude.ai connectors (Gmail, Calendar, Microsoft 365) load into Claude Code and SDK sessions only under a claude.ai subscription login, and vanish with an API key. They are model-called, so they cannot serve as a raw data API for dashboards.
- Branding: "Claude Code" or "Claude Code Agent" may not be used in a product name; "Claude" inside an Agents menu or "<YourName> Powered by Claude" is allowed.

The user chose "both / not sure": a config switch rather than a fixed mode.

## Decision

1. Authentication is a config switch, `CLAUDE_AUTH_MODE=api-key|local-login` (already in `.env.example` and `ClaudeConnection.mode`). The default is `api-key`.
2. In `api-key` mode every Claude session the daemon starts uses `ANTHROPIC_API_KEY`, governed by per-lane budgets and a global daily cap.
3. `local-login` points `pathToClaudeCodeExecutable` at the user's own installed, unmodified, logged-in `claude` binary, for personal single-user use only. The daemon never reads, copies, stores or proxies OAuth tokens or session tokens, and never ships this mode to anyone else. Settings shows a "terms unclear" note next to the switch (as the mockup does). Proposed: until Anthropic answers, scheduled jobs (briefing, nightly dream) and the Voice lane stay on an API key even if the user switches interactive chat to `local-login`.
4. The user's own terminal Claude Code sessions are only observed (hooks and `claude agents --json`), whichever auth they use.
5. Nothing may depend on claude.ai connectors. Calendar, mail and contacts go through our own provider adapters and an in-process MCP server.
6. All dollar figures are labelled "API-equivalent estimate". On a subscription neither the SDK number nor OpenTelemetry is a bill.
7. The user sends the email in [spikes/tos-email.md](../../spikes/tos-email.md). If Anthropic confirms the subscription route is acceptable, the switch needs no architecture change.
8. Anything shared with other people requires each person to bring their own API key or login, and a fresh terms review.
9. The app and persona are never named "Claude" or "Claude Code".

## Consequences

- API-key mode is pay-per-token, so the budget service, `maxTurns` and per-session caps are required from Phase 1 (see ARCHITECTURE section 15).
- `--bare` can be used for scripted runs, but only in API-key mode.
- Connector-based shortcuts are off the table; the direct-adapter work in Phase 2 is the price.
- The Settings screen, the audit log and the budget chip all key off `ClaudeConnection.mode`.
- The decision is reversible by config, so the open terms question does not block Phase 1.

## Alternatives considered

| Option | Why not (or why later) |
|---|---|
| Subscription login only, driving the SDK from the daemon | Terms are unclear for a self-built daemon; limits assume ordinary individual usage; `--bare` and a Voice lane need a key anyway |
| API key only, no switch | Simplest and terms-safe, but the user asked to keep the option open and the cost of a switch is small |
| claude.ai connectors as the integration foundation | Only load under subscription login, model-mediated (every view costs tokens), no Contacts connector seen, cannot be re-registered locally |
| Headless `claude -p` subprocess instead of the SDK | Same terms question; you reimplement the stdin and stdout protocol; approvals need a PermissionRequest hook or a permission-prompt MCP tool |
| Reading the CLI's OAuth token to call the API directly | Explicitly prohibited ("collect, store, or intermediate Claude.ai credentials") |

## Sources

- https://code.claude.com/docs/en/legal-and-compliance
- https://code.claude.com/docs/en/agent-sdk/overview
- https://code.claude.com/docs/en/headless
- https://code.claude.com/docs/en/setup
- https://code.claude.com/docs/en/agent-sdk/claude-code-features
- https://code.claude.com/docs/en/mcp

## Update 2026-10-31: embedded terminal and connectors

The user wants to use either a Claude subscription or an API key, and to have terminal access inside the app. This sharpens the decision:

- **Embedded terminal (planned Phase 1.5):** the app hosts the user's own, unmodified `claude` binary in a pseudo-terminal. The user signs in themselves, so the subscription case is the documented end-user case, not an app offering claude.ai login. The daemon never reads or stores those credentials. Sessions started there are observed by the same hooks as any other terminal session.
- **Secretary lane (automated):** still a config switch (`api-key` or `local-login`). `api-key` stays the terms-safe default for anything the daemon launches unattended. `local-login` drives the user's own logged-in binary and remains a grey area until Anthropic confirms (see `spikes/tos-email.md`).
- **Connectors:** claude.ai connectors (Gmail, Google Calendar, and others) only load under a subscription login, not under an API key. With an API key the same services need direct OAuth or another tool server. The integrations hub (Phase 1.5) supports both routes behind one interface.
