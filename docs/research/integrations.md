# Research digest: integrations

Status: digest of one researcher's structured output, as of 2026-10-31. Tags: [verified] or [unverified] as reported. Many primary hosts were unreachable from the research sandbox (developers.google.com, support.google.com, learn.microsoft.com, open-meteo.com, newsapi.org, gnews.io, gdeltproject.org, wikipedia.org); facts about Google, Microsoft, NewsAPI, GNews, GDELT and Wikipedia rest on search excerpts or secondary sources and need one manual re-check before building.

## Question

How should the app reach Google and Microsoft personal data, news and world overview sources, weather and markets, and the user's Atlas finance app, and should it use claude.ai connectors and MCP servers or direct APIs?

## Key findings

1. [verified] Google OAuth (desktop): a "Desktop app" client in the user's own Cloud project, authorization code with PKCE (S256) and a loopback redirect `http://127.0.0.1:<random free port>`. With the consent screen in "Testing", authorisations and offline refresh tokens expire after 7 days and the test-user list is capped at 100. For one personal user the fix is "Publish app" to "In production" without verification (a one-time unverified-app click-through). The lifetime cap of 100 new users on unverified apps is irrelevant for one user. Other invalidations: about 6 months unused, user revocation, 100 refresh tokens per account per client, a password change for Gmail scopes (secondary). A Workspace "Internal" app avoids both the 7-day expiry and the 100-user cap. One forum reporter says to re-consent after switching. Sources (excerpts only): https://support.google.com/cloud/answer/15549945, https://developers.google.com/identity/protocols/oauth2/native-app, https://groups.google.com/g/adwords-api/c/QTdeilIh_QY/m/eOHg0Q9CAgAJ
2. [verified] Scopes and verification: `gmail.readonly`, `gmail.modify`, `gmail.compose`, `gmail.insert` and `https://mail.google.com/` are restricted (verification plus an annual CASA assessment if distributed); `gmail.send` is reportedly only sensitive (unconfirmed). Calendar and Contacts tiers conflict across third-party sources. Because the app stays unverified and single-user none of this blocks a personal tool, but it can never be shared without verification and CASA. Least-privilege plan: `calendar.readonly`, `gmail.readonly` plus `gmail.compose` (drafts only, never `gmail.send` at first), `contacts.readonly`. Sources: https://developers.google.com/workspace/gmail/api/auth/scopes (excerpt), https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server, https://developers.google.com/workspace/calendar/api/auth
3. [verified] SDKs and sync: `googleapis` 189.0.0 and `google-auth-library` 11.3.2 (Apache-2.0, Node 22 or later). Calendar incremental sync is verified (store `nextSyncToken`, send `syncToken`, HTTP 410 means full resync, bound the full sync with `timeMin`). Gmail `users.history.list` and People `connections.list` sync tokens are from memory. Push (Gmail watch, Calendar webhooks) needs a public HTTPS endpoint, so poll on an interval and on window focus. Cache in SQLite so dashboards render offline with zero tokens. Sources: https://registry.npmjs.org/googleapis/latest, https://developers.google.com/calendar/v3/sync
4. [verified] Microsoft Graph alternative: an Entra public-client app with `http://localhost` redirect; MSAL applies PKCE; add `offline_access`. `@azure/msal-node` 7.1.2 and `@microsoft/microsoft-graph-client` 3.0.7. Calendar delta sync verified (`/me/calendarView/delta`); mail and contacts delta unconfirmed. Basic auth retirement: Exchange Online SMTP AUTH basic default-disabled end of December 2026 (secondary source). An open MSAL.NET issue reports localhost-redirect breakage after an October 2025 Windows update. Refresh-token lifetime for public clients is from memory. Sources: https://learn.microsoft.com/en-us/entra/msal/dotnet/acquiring-tokens/using-web-browsers, https://learn.microsoft.com/en-us/graph/api/event-delta
5. [verified] CalDAV, CardDAV and IMAP are not a way around Google OAuth: from 14 Mar 2025 third-party apps must use OAuth for Gmail, Calendar and Contacts over IMAP, SMTP, POP, CalDAV and CardDAV (exact date for personal Gmail unconfirmed); app passwords are still allowed with 2-Step Verification. They help for non-Google providers (iCloud, Fastmail, Nextcloud) through `tsdav` 2.5.0 and `imapflow` 2.10.0 behind the same provider interfaces. Sources: https://knowledge.workspace.google.com/admin/sync/transition-from-less-secure-apps-to-oauth, https://developers.google.com/calendar/caldav/v2/guide
6. [verified] News: the Hacker News Firebase API needs no auth and states no rate limit (MIT); RSS and Atom are the backbone (poll every 15 to 60 minutes with ETag, normalise to a `BriefingItem`, dedupe on canonical URL, keep headline, link and short snippet). In Node prefer `fast-xml-parser` 5.11.2 over the stale `rss-parser`. Sources: https://github.com/HackerNews/API, https://registry.npmjs.org/fast-xml-parser/latest
7. [verified] World overview: GDELT DOC 2.0 (no key; ArtList and timeline modes; most recent 3 months; a rate limit of about 1 request per 5 s is from a third-party note, so cache at least 15 minutes). Wikipedia has no official current-events feed (options unverified: the MediaWiki Action API on `Portal:Current_events` subpages, or the Wikimedia REST feed). USGS earthquake GeoJSON feeds are keyless. Publisher RSS terms vary (BBC historically requires attribution). Sources: https://pypi.org/project/gdeltdoc/, https://github.com/wikimedia/mediawiki-services-wikifeeds, https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php
8. [verified] Commercial news APIs are a poor fit: NewsAPI.org's free plan is 100 requests per day, delayed 24 hours, development only; GNews's free plan is 100 requests per day and non-commercial. Make RSS, GDELT and Hacker News the default and keep them behind a `NewsProvider`. Sources: https://newsapi.org/pricing, https://newsapi.org/terms, https://gnews.io
9. [verified] Weather and markets: Open-Meteo needs no key and is free for non-commercial use (under 10,000 calls per day), CC BY 4.0 data (attribution), AGPL server code, self-hostable. FX: Frankfurter serves ECB reference rates (once per business day). Equity and crypto free tiers are tight and change often (Alpha Vantage 25 per day; Twelve Data 800 per day delayed; CoinGecko demo limits conflict; Yahoo free access described as deprecated). If Atlas supplies holdings only a few tickers per day are needed. Sources: https://open-meteo.com/en/terms, https://frankfurter.dev/providers/ecb/, https://dev.to/tildalice/free-stock-apis-2026-setup-cost-rate-limits-tested-2o34
10. [verified] claude.ai connectors versus MCP: connectors (including Anthropic-hosted Gmail, Google Calendar, Microsoft 365) load into Claude Code and SDK sessions only under a claude.ai subscription login, not with `ANTHROPIC_API_KEY`, Bedrock, Vertex or Foundry, or a setup-token. The hosted connectors cannot be re-added locally ("doesn't support local OAuth"). The model calls connector tools, so the app cannot use them as a plain data API for dashboards. There is no Contacts connector. Google also hosts official remote MCP servers (Preview) that use your own OAuth client; a community option is taylorwilsdon/google_workspace_mcp (MIT). Sources: https://code.claude.com/docs/en/mcp, https://code.claude.com/docs/en/security, https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server, https://github.com/taylorwilsdon/google_workspace_mcp
11. [verified] SDK mechanics for the briefing: in-process SDK servers are the cleanest way to expose normalised read-only tools; OAuth cannot run headless (tokens go in headers); structured output with `outputFormat: {type:'json_schema'}` (draft-07; with zod use `z.toJSONSchema(s, {target:'draft-7'})`) returns `structured_output`; `--max-budget-usd` exists; `--bare` needs a key and disables connectors. Scheduling: session-scoped cron expires after 7 days and fires only while a session is open; simplest is the app's own scheduler calling `query()`. Briefing pipeline: fetch, normalise, dedupe and cluster in SQLite, one tool-less Claude call with structured output, cached Briefing JSON. Treat news and email as untrusted: keep the summariser tool-less and separate from any agent holding send or modify tools. Sources: https://code.claude.com/docs/en/agent-sdk/structured-outputs, https://code.claude.com/docs/en/scheduled-tasks
12. [verified] Atlas contract precedents: Plaid's `/transactions/sync` (cursor, `added`, `modified`, `removed`, `next_cursor`, `has_more`); Actual Budget (MIT, `@actual-app/api`) and Firefly III (AGPL-3.0) as extra providers or contract sanity checks; tooling options JSON Schema, OpenAPI 3.1, TypeSpec, zod, Prism, msw. Money is integer minor units plus ISO 4217. Sources: https://docs.rs/plaid/latest/plaid/model/struct.TransactionsSyncResponse.html, https://github.com/actualbudget/actual, https://github.com/firefly-iii/firefly-iii

## Options considered

| Option | Verdict |
|---|---|
| A. Direct APIs behind our own adapters, SQLite cache, in-process MCP for Claude | The base of the hybrid |
| B. claude.ai connectors only | Subscription-only, model-mediated, no raw data API, no Contacts |
| C. Local or Google-official MCP servers with our own OAuth client | Preview status, third-party supply chain, still model-mediated |
| D. Hybrid: direct adapters for dashboard reads, model-mediated tools for actions, connectors optional | Recommended |

## Recommendation

Hybrid (D), starting with direct adapters and mocks. Every integration sits behind a small provider interface (Calendar, Mail, Contacts, News, Weather, MarketData, Finance) with a seeded mock used by the mockup and tests; real data is normalised and cached in SQLite and the UI reads only the cache. The assistant reaches the same data through an in-process MCP server with narrow read tools and a few write tools (`draft_email`, `propose_event`) that always require explicit confirmation.

Google first after mocks: one personal Cloud project, a desktop client, consent screen External, "In production" without verification, PKCE, loopback, offline access, tokens in the OS credential store, `invalid_grant` re-prompts; scopes as in finding 2; Calendar `syncToken` with 410 resync; poll every few minutes and on focus. Microsoft Graph, CalDAV and IMAP only if needed, behind the same interfaces. News and world: RSS plus Hacker News plus GDELT plus Open-Meteo (attribute CC BY 4.0) plus Frankfurter; markets only for tickers Atlas holds; a daily briefing job on the Reader lane with structured output and a budget. Atlas: a read-only v0.1 contract, schema-first, `contractVersion`, capabilities, signed minor-unit money, cursor sync, typed errors, no money movement, a mock provider and a contract-test suite every provider must pass; aggregates by default. Do not make claude.ai connectors the foundation.

## MVP versus later

Mockup and Phases 0 to 1 (no live credentials): provider contracts and JSON schemas, mock providers with realistic fixtures, in-app fixtures, a stub MCP server with the read-only tool names. Real and cheap first: RSS, Hacker News, Open-Meteo, Frankfurter, GDELT and the daily briefing. Real personal data next: Google Calendar read-only, then Gmail read and drafts, then Contacts. Later: Microsoft Graph, CalDAV, CardDAV and IMAP fallbacks, write actions behind confirmation, market data for holdings, connectors or community MCP for ad-hoc tasks, the real Atlas provider once stable.

## Risks

- Verification gaps for many hosts; re-check tiers, GDELT limits, Wikipedia routes and Microsoft token lifetimes once.
- Google token fragility even in production; a visible "reconnect" state is required.
- Gmail scopes are restricted: sharing later needs verification and CASA.
- Claude auth coupling: connectors only load under subscription login.
- Prompt injection through news, mail and invites.
- Privacy: mailbox and finance data sent to the API need a minimisation policy.
- Free-tier terms (NewsAPI dev-only, GNews and Open-Meteo non-commercial, CC BY attribution, AGPL only if embedding code).
- Google's official MCP servers are Preview; community MCP is a supply-chain risk.
- Atlas instability and the Secondbrain "Atlas" naming collision.
- Runtime constraints (Node 22 or later for googleapis; native binaries per platform).
- Unconfirmed rate limits; cache aggressively.

## Open questions

- Consumer Gmail or Google Workspace? An Outlook account too?
- Claude auth: subscription (connectors, limits) or API key (pay per token, no connectors)?
- Atlas's stack and surface (REST, IPC, SQLite file, MCP), auth, and entities; distinct from Secondbrain's Atlas.
- Privacy appetite for raw bodies and transactions.
- Topics, regions, publishers and languages for the world overview; whether GDELT, Wikipedia and USGS are in the MVP.
- Which markets matter; whether Atlas provides holdings.
- Whether the persona may take write actions autonomously after a trust period (the trust ladder answers: only by the user's promotion).
- Will the app ever be shared? (CASA budget.)

## Decisions that followed

[ADR 0007](../adr/0007-finance-contract-and-atlas.md), [ADR 0001](../adr/0001-claude-auth-modes.md), [ADR 0005](../adr/0005-privacy-tiers-and-autonomy.md), [PRIVACY.md](../PRIVACY.md) section 8.
