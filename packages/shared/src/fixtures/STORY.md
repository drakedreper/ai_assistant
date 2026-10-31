# Fixture story bible

All mock data tells ONE coherent story so every screen cross-references the others. Fixtures are built
relative to `now` (see `time.ts`) so the mockup always looks like "today". `test/integrity.test.ts`
enforces the cross-references below; keep it green when you enrich a domain.

## Cast
- **You**: an independent software builder, based in a lightly-fictional European city. Never named.
- **Mira**: the assistant (placeholder name, editable). Warm, playful partner + sharp secretary. Writes in
  first person, short sentences, dry wit, never guilt-trips. Emotion tags (`neutral|happy|sad|angry|relaxed|surprised|shy|thinking`).
- **People**: Dana Reyes (mentor, ex-founder, may intro a seed investor), Leo Park (designer friend),
  Priya Nair (client for the portfolio site), Marcus Webb (accountant), Elena (Mom, birthday soon).

## Projects (ids are contracts)
| id | name | color | path | what it is |
|---|---|---|---|---|
| `atlas` | Atlas (finance app) | `#fbbf24` | `C:\dev\atlas` | the user's local personal-finance app, beta planned before December. The finance connector reads from it. |
| `assistant` | ai_assistant | `#f472b6` | `C:\dev\ai_assistant` | THIS app. |
| `site` | portfolio-site | `#60a5fa` | `C:\dev\site` | client site for Priya. |
| `homelab` | home-lab | `#34d399` | `C:\dev\homelab` | self-hosted services, certs, backups. |

## Vault notes (paths are contracts; anything that cites a note MUST use one of these)
Core (always in context): `00-core/persona.md`, `00-core/values.md`, `00-core/user-profile.md`, `00-core/operating-rules.md`
Strategy: `10-strategy/q4-positioning.md`, `10-strategy/financial-independence.md`, `10-strategy/deep-work-system.md`, `10-strategy/decision-atlas-beta.md`
Journal (dynamic dates via `journalPath(now, offset)`): today, yesterday, two days ago.
Knowledge: `30-knowledge/local-first-software.md`, `30-knowledge/plaid-sync-pattern.md`, `30-knowledge/sqlite-wal.md`,
`30-knowledge/people/dana-reyes.md`, `30-knowledge/people/leo-park.md`, `30-knowledge/people/priya-nair.md`
Projects: `40-projects/atlas/README.md`, `40-projects/assistant/README.md`, `40-projects/site/README.md`, `40-projects/homelab/README.md`
Inbox: `50-inbox/idea-voice-capture.md`
Federated from the Secondbrain app (read-only, `source: 'secondbrain'`): `secondbrain/atlas-planning-recap.md`, `secondbrain/weekly-tasks.md`
(Never call Secondbrain's graph "Atlas". Atlas is the finance app.)

## Sessions (ids are contracts)
`s-daemon` (assistant, running), `s-migrate` (atlas, blocked_permission, approval `ap-rm-backup`),
`s-contract-tests` (atlas, waiting_input), `s-a11y` (site, done), `s-certs` (homelab, background idle),
`s-kokoro` (assistant, done, summary of Kokoro latency research).

## Approvals (ids are contracts)
`ap-rm-backup` (tool_permission, s-migrate), `ap-reply-priya` (email_draft, mail `m-priya`),
`ap-q4-proposal` (brain_proposal, proposal `pr-q4`), `ap-focus-block` (calendar_event).

## Mail ids
`m-priya` (needs_reply, draft, approval `ap-reply-priya`), `m-marcus`, `m-dana`, `m-news`, `m-receipt`.

## Money
Currency USD. Atlas is NOT connected in the mockup (`finance.connected = false`, mock banner). Aggregates by default.

## Tone rules
- Briefing/thread copy must cite a strategy/knowledge note ("this touches your Q4 positioning").
- No real brands/people. Keep amounts plausible and modest.
- Dates always relative to `now`.
