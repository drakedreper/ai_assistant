# ADR 0005: Privacy tiers and the autonomy ladder

Status: Accepted (tiers, hard limits, lanes). Promotion thresholds and quiet-hours numbers are proposals. Date: 2026-10-31.

## Context

The assistant reads email, news, calendar invites, notes and finance aggregates, and has tools that can send, write and (if allowed) spend. The user chose to start strict and widen after a trust period. Research found three risks to design for explicitly (see [research/shell-architecture.md](../research/shell-architecture.md), [research/integrations.md](../research/integrations.md), [research/critic.md](../research/critic.md)):

- Prompt injection: email, news and invite text is attacker-controllable, and a tool-equipped agent that reads it can be steered. Anthropic advises not piping untrusted content straight into Claude.
- Data egress: chat text, tool results, email bodies, finance figures and webcam frames go to Anthropic's API under whichever terms the chosen auth falls under.
- Memory poisoning: a consolidation agent with write tools over the memory it feeds.

The mockup already shows a trust ladder, an audit log and a privacy map (`TrustRule`, `AuditEntry`, `PrivacyFlow` in `packages/shared/src/schemas/settings.ts`).

## Decision

1. Sensitivity labels: `normal`, `private`, `sensitive` (the `Sensitivity` enum). They are carried by notes, mail and finance items and decide what may enter cloud-bound context. Adapters apply the label and redaction before data reaches a prompt. The UI marks sensitive elements with `data-sensitive`, which Guest mode blurs.
2. Aggregates by default; raw on demand. The assistant sees balances, category totals and upcoming bills. Email gets snippets by default; full bodies and raw transactions only on demand, with a redaction layer and a per-call audit entry.
3. Autonomy tiers (shared with `tools.ts` and the Approval schema):

| Tier | Meaning | Default |
|---|---|---|
| T0 | Read freely (search, read, agenda, status) | Auto |
| T1 | Journal and inbox appends; raw transaction reads | Auto, logged |
| T2 | Knowledge and project notes plus a git commit; kanban cards | Ask until promoted |
| T3 | Core and strategy notes, persona changes | Proposals only; locked |
| T4 | Outward actions: send, create, spend, run shell commands in agents | Approval card until promoted, except locked rules |

4. The trust ladder is per action type, not global. A rule moves from `ask` to `auto` only by the user's click, after the system suggests it (proposed: when approvals pile up with zero rejections, for example roughly 10 to 15; the mockup shows suggestions at 14 and 17). A rejection resets the suggestion. Promotions and demotions are audited.
5. Hard limits, regardless of trust history, enforced in code and not by the prompt:
   - No money movement in v0.x. `finance_move_money` exists only as a locked placeholder with no lane. Atlas access is read-only.
   - Core and strategy notes and the persona change only through proposals the user applies.
   - Untrusted content (mail, news, web, invites) is read only in tool-less or read-only lanes. The Reader lane has no write, send or finance tools.
   - Memory-writing jobs over inbox-derived text may only propose or quarantine.
   - Affection never authorises an action ([PERSONA.md](../PERSONA.md)).
6. Lanes: Secretary (actor tools behind `canUseTool`), Reader (tool-less, schema-constrained), Voice (no tools). One session never holds both untrusted-content reading and send, write or finance tools.
7. Audit log: an append-only record of every approval, tool call and job step with actor (`you`, `mira`, `agent`, `job`), target, outcome (`approved`, `denied`, `auto`, `blocked`) and, for anything sent to the cloud, a short description of what was sent. Sensitive entries are blurred in Guest mode.
8. Budget service: per-lane and per-job caps, a global daily cap and a kill switch ([ARCHITECTURE.md](../ARCHITECTURE.md) section 15).
9. Agents (Claude Code sessions) are denied secrets paths (`.env`, `~/.ssh`, browser profiles, keychain) by deny rules and hooks; the audit log shows blocked attempts. Native Windows has no Claude Code sandbox, so these rules are the only guard.

## Consequences

- Safety does not depend on the model behaving; it depends on tool lists per lane, `canUseTool`, path jails and locked rules, all testable without tokens using the fake-Claude transport.
- Locked rules (`tr-strategy`, `tr-money`, `tr-persona` in the mockup fixtures) show a lock and a reason in the UI and refuse promotion at the API.
- Strictness costs friction early (many approval cards); the ladder exists to reduce it over time.
- The audit log and the privacy map must stay truthful: the Settings integration list must say what leaves the PC through each integration.
- A "reveal" of raw data on screen is not the same as sending it to the cloud; the audit log distinguishes them (the mockup's `au-12`).

## Alternatives considered

| Option | Why not |
|---|---|
| A single global autonomy slider | Cannot express "journal appends are free, sending mail is not" |
| Full autonomy after onboarding | The user asked to start strict; injection blast radius is too large |
| Per-message confirmation for everything | Unusable; the ladder gives the same safety where it matters |
| Relying on the system prompt for boundaries | Prompts can be steered by injected text; code-level lanes and tiers hold |
| A local-model fallback for sensitive small talk | Deferred; worth revisiting after the data-flow map is exercised |

## Sources

- https://code.claude.com/docs/en/agent-sdk/permissions
- https://code.claude.com/docs/en/security
- https://code.claude.com/docs/en/agent-sdk/user-input (callback signature, not fetched by researchers)
- https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/specification/2025-06-18/basic/transports.mdx (Origin validation guidance)
- Research digests listed above
