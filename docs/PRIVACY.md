# Privacy specification

Status: draft specification for review; the mockup shows the data-flow map, audit log and Guest mode in Settings on fixture data only. Date: 2026-10-31. Updated 2026-11-01 with rows and rules for her character memory, the embedded terminal and the stage connection, which now exist in the daemon (sections 3, 9, 10 and 13).

This document says what leaves the PC, under whose terms, and what the product does to minimise and record it. It is not legal advice. Items marked "unverified" came from research that could not reach primary sources; items marked "proposed" are design choices.

Related: [ADR 0005](adr/0005-privacy-tiers-and-autonomy.md), [ARCHITECTURE.md](ARCHITECTURE.md) section 10, [PERSONA.md](PERSONA.md), [research/integrations.md](research/integrations.md), [research/critic.md](research/critic.md).

## 1. Principles

1. Local first. Data stays on the PC unless a Claude call or a named integration needs it.
2. Aggregates by default. Raw bodies and raw transactions only on demand.
3. Label, then redact, in the adapter, before anything reaches a prompt.
4. Record what was sent. The audit log is the user's view of egress.
5. Forgetting is real: it covers derived data, git history and backups, with stated limits.
6. The user is never surprised: the Settings privacy map and each integration's `dataLeaves` line say what leaves.

## 2. Terms that apply to data sent to Claude

| Auth mode | Terms (verified that both exist) | Notes |
|---|---|---|
| `api-key` (default) | Anthropic Commercial Terms | The Agent SDK is governed by them |
| `local-login` | Consumer Terms for Free, Pro, Max and Ultra plans | Whether chat data may be used for model training differs between the two sets of terms. The difference is from memory and unverified: check it before email, finance and companion conversations flow through a subscription |

Retention and handling of data on Anthropic's side are governed by those terms and are not verified here. See [ADR 0001](adr/0001-claude-auth-modes.md).

## 3. Data-flow map: what leaves the PC

| Source | Leaves the PC? | Goes to | What exactly | Default policy |
|---|---|---|---|---|
| Chat text (typed, or voice transcript) | Yes | Anthropic (Claude API) | The messages of the current conversation | Sent; stored locally in the ops database and in Claude's own session transcript |
| Tool results | Yes | Anthropic | Whatever a tool returns into context: note snippets, calendar items, mail snippets, finance aggregates | Narrow read tools return snippets with a cap; each call is audited |
| Vault notes | Only as retrieved snippets | Anthropic | The few chunks `brain_search` returns, not the vault | Notes marked `sensitive` never enter cloud context; `private` only on demand |
| Journal and memory | Short excerpts on demand | Anthropic | Entries the assistant reads for a question or a job | Entries tagged intimate are excluded from cloud context by default |
| Email | Yes, minimal | Anthropic | Snippets by default; full bodies only on demand and logged; read by the Reader lane, not the Secretary | Sensitive senders labelled; `data-sensitive` in the UI |
| Calendar | Yes | Anthropic | Event titles and times; attendee emails stay local | Read-only first |
| Contacts | Rarely | Anthropic | Only the people the user asks about | Names stay local otherwise |
| Finance (Atlas) | Yes, minimal | Anthropic | Aggregates only (balances, category totals, upcoming bills, net worth); raw transactions on demand through a redaction layer | Every raw read is audited; money movement does not exist |
| Webcam frames | Only on an explicit press | Anthropic | One downscaled JPEG per "look at this" | Off by default; never persisted by us (see section 6) |
| Voice audio | No | Stays on the PC | Speech-to-text runs locally (whisper.cpp); only the transcript is sent; audio is not kept | Local by default |
| Spoken replies (TTS) | No by default | Local Kokoro; optionally ElevenLabs | With ElevenLabs each reply sentence is sent to the provider | ElevenLabs is off by default |
| News feeds | Headlines only | Anthropic (Reader lane) | Headlines and short snippets; the Reader lane never sees the user's notes | Ranking happens on the PC |
| Weather | City name | Open-Meteo | Coordinates or city for the forecast | Data licensed CC BY 4.0 (attribution required) |
| Google data (Calendar, Gmail, Contacts) | Fetched to the PC | Google, directly | The daemon calls Google's APIs with the user's own OAuth client; Anthropic sees only what a tool passes on | Tokens in Windows Credential Manager |
| Hook payloads and transcripts | No | Stay local | Claude Code session data observed by the monitor; plaintext, may include secrets and file contents | Redacted before persisting; receiver bound to loopback |
| Her character memory (stage) | Only a short digest | Anthropic (Secretary lane), only with the real Claude backend (`CLAUDE_BACKEND=sdk`); nothing leaves with the fake backend | A digest of at most about 900 characters of what she wrote down with `character_remember`: relationship facts, preferences and recent moments, each quoted as data. Only items labelled `normal` are included; text that looks like a secret is refused when written; private and sensitive items are never added to the digest (the text she passed to the tool was, of course, in the conversation that wrote it) | Visible and deletable in Settings, Stage ("What she remembers"); every deletion is audited without the text |
| Embedded terminal | Not through this app | Whatever program you run in it | Keystrokes and output pass between your browser, the daemon and the PTY on this PC. They are never logged, never written to disk (the scrollback lives in memory) and never given to any Claude lane or tool. A `claude` you start there talks to Anthropic under its own login and terms | Off until you switch it on in Settings; every open and close is audited, keystrokes never |
| Stage connection (engine or simulator) | No | A process on this PC, over loopback | Character, wardrobe, scene and mood state, speech audio and face frames, and for the cerebral space the titles and paths of your notes (not their bodies) and the titles and status of your Claude sessions, so the constellation and the orbit can be labelled | One stage at a time, with its own token. Titles of `sensitive` notes are included today (open item 6 in section 13) |
| Telemetry | Avoid | Google (MediaPipe), others | MediaPipe Tasks send usage metrics to Google by default; Claude Code OTel attributes include `user.email`; claude-view official builds send anonymous telemetry | Self-host MediaPipe assets and check egress; OTel off; do not run claude-view builds with telemetry on |

The mockup's `PrivacyFlow` list (10 rows) and each `IntegrationStatus.dataLeaves` string are the UI form of this table; keep them in sync.

## 4. Sensitivity labels and redaction

| Label | Meaning | Cloud-bound context |
|---|---|---|
| `normal` | Everyday content (chat, calendar titles, headlines) | Allowed |
| `private` | Notes, mail, contacts | Only the snippets needed; full text on demand and logged |
| `sensitive` | Finance, intimate memory, health or relationship notes, webcam | Excluded by default; aggregates or redacted forms only; shown with `data-sensitive` |

Where labels come from: notes carry `sensitivity` in frontmatter; adapters label mail (by sender and keywords), finance (always `sensitive`) and calendar. Where redaction happens: in the adapter or tool layer, before tool output enters a prompt (account numbers, full addresses, attendee emails), and in logging (no email bodies or finance figures in logs). Hook payloads, `tool_input` and transcripts are redacted before the ops database stores them.

## 5. Audit log

- Append-only, in the ops database: time, actor (`you`, `mira`, `agent`, `job`), action, target, outcome (`approved`, `denied`, `auto`, `blocked`), and for anything sent to the cloud a short description of what was sent ("three note snippets, 1.2 KB") but not the content.
- Records blocked attempts (an agent trying to read `.env`, a request to move money) and distinguishes revealing raw data on screen from sending it to the cloud.
- Sensitive entries carry `data-sensitive` and are blurred in Guest mode.
- The log is the basis for the trust ladder's approval and rejection counts.
- Retention: proposed to keep it as long as the vault; erasing content leaves a tombstone (hash of the path, time, actor), not the content.

## 6. Webcam rules

1. Off by default. Turning it on is an explicit toggle, per session. An always-visible in-app indicator (top bar) is shown in addition to the camera LED. `webcam.retention` is `none` in the settings schema.
2. No persistence by us: frames live in memory and are never written to disk, the ops database, the vault or logs.
3. Frames reach Claude only on an explicit "look at this" press: one frame, downscaled (about 768 px maximum, JPEG; roughly 400 to 800 visual tokens). The UI says at that moment that the frame goes to Anthropic. No continuous streaming of frames to the API.
4. Open question that affects rule 2: images sent in a Claude turn are re-sent as base64 on every later turn of that session unless the Files API is used, and may be stored in the session transcript under `~\.claude\projects` (unverified). Proposed: run vision calls in a throwaway session (TypeScript `persistSession: false`) and verify that nothing image-sized lands in the transcripts. If it does, purge those sessions.
5. Local presence and gaze later: MediaPipe Face Landmarker with self-hosted WASM and model files. MediaPipe sends performance and usage metrics to Google by default, so check network egress before enabling it. It outputs landmarks and blendshape scores, not emotion labels. Any "mood" is a soft hint, never stored as a fact about the user and never used for a consequential decision.
6. No face recognition or identification. Face landmarks are biometric-adjacent data.
7. The camera can capture other people. Proposed: Guest mode turns the camera off. Handle "camera in use" gracefully when Teams or Zoom holds it.

## 7. Voice rules

- Push-to-talk first. The microphone has an always-visible indicator. Audio is transcribed locally and discarded; only the transcript is sent and stored.
- Hands-free listening (VAD) arrives later and starts with headphones, because speaker echo can feed her own voice back as input.
- Spoken replies use local Kokoro by default. A cloud voice is an explicit opt-in whose `dataLeaves` line says the sentences are sent to the provider.
- Guest mode: she does not read sensitive content aloud.

## 8. Google OAuth notes

The daemon calls Google's APIs itself with the user's own OAuth client (desktop client, authorization code with PKCE S256, loopback redirect on `127.0.0.1` with a random free port, `access_type=offline`).

- Consent screen in "Testing": authorisations and offline refresh tokens expire after 7 days and the test-user list is capped at 100. For one personal user the fix is to publish the app to "In production" without submitting it for verification: the user clicks through the "Google hasn't verified this app" warning once. The cap on new users of unverified apps is irrelevant for one user. A forum report says to re-consent after publishing and not to reuse tokens minted in Testing. Source of these points: search excerpts of Google help pages and a Google forum advisor; the primary pages were unreachable (re-check once before building).
- Tokens can still die: about 6 months unused, user revocation, more than 100 refresh tokens per account per client, and (secondary source) a password change for Gmail scopes. The UI needs a visible "reconnect Google" state; `invalid_grant` triggers it.
- Scopes. Gmail `gmail.readonly`, `gmail.modify`, `gmail.compose`, `gmail.insert` and `https://mail.google.com/` are restricted (verification plus an annual third-party security assessment, CASA, if the app is distributed); `gmail.send` is reportedly only sensitive (unconfirmed). Calendar and Contacts tiers conflict across third-party sources and are unconfirmed. Plan (least privilege): `calendar.readonly` first, `gmail.readonly` plus `gmail.compose` (drafts only, never `gmail.send` at first), `contacts.readonly`.
- Consequence: the app is a personal tool. It can never be shared without paying for verification and CASA, so "drafts only" is a safety choice, not a verification saving.
- Google's API Services User Data Policy "Limited Use" rules on passing Google user data to third-party AI services are from memory and unverified. They are moot for purely personal use and decisive if the app is ever shared. Re-check on developers.google.com.
- Tokens live in Windows Credential Manager through `@napi-rs/keyring` (small secrets only). The daemon never stores Claude or claude.ai credentials.
- Workspace accounts can use an "Internal" app, which avoids both the 7-day expiry and the 100-user cap; the account type is an open question.

## 9. At rest and on the PC

- The vault and the ops database are unencrypted by default; rely on BitLocker. Secrets sit in the keychain. Logs are redacted. An encrypted-at-rest option is a later question.
- Claude Code transcripts under `~\.claude\projects` are plaintext, include tool output and anything a command prints (secrets included), and are retained 30 days by default (`cleanupPeriodDays`). The Secretary session persists so it can resume, so its transcript holds chat and tool results (note and mail snippets). Treat that folder as a sensitive store.
- Her character memory sits in the ops database (table `stage_memory`) in plaintext like the rest of it. The database runs with `secure_delete` on, so a deleted row is overwritten in the file instead of only being unlinked (tested, with a control that shows the text lingers without it).
- The daemon's `secrets.json` (the hook token and the stage token, among others) is created owner-only (mode 0600) on POSIX systems (tested on Linux). On Windows the permission bits do nothing and it relies on the default access rules of the user's profile folder (`%APPDATA%`). Not verified on the PC yet.
- The loopback-only daemon and its token protect against other websites; they do not protect against other software running as the same user.

## 10. "Forget" semantics

A git-versioned vault makes "delete" misleading: deleting a note leaves it in history, in derived data, and in backups. Proposed three levels, with "retire" as the default button and "erase" a separate, explicit action.

| Level | What happens | What remains |
|---|---|---|
| Forget a learned fact (`forgetFact`) | The fact is removed from the learned list and from retrieval; if a note was derived from it, an edit is proposed | History of the source note |
| Retire a note | Status set to `superseded` or `archived`; excluded from retrieval and context; the file and history stay | Everything in git and backups |
| Erase | Delete the file; remove its FTS rows, links, chunks and embeddings; rewrite git history to remove every blob of it (for example with `git filter-repo`); find and review derived artifacts that quoted it (dream reports, digests, weekly notes); delete matching Claude session transcripts that contain it (file deletion; the format is internal); leave a tombstone in the audit log | Offsite backups until the snapshots rotate or are pruned (for example `restic forget` and `prune`); copies in other tools such as Obsidian sync; anything already sent to Anthropic or another third party, which this product cannot recall |

Details
- Embeddings are derived data. Erasing means deleting vector rows; rebuilding the index from files restores consistency.
- Rewriting history breaks any clone or remote. The vault has no remote by default; if one is added, erase requires a coordinated force-push.
- `raw/` and the journal are immutable by policy. Erase is a deliberate exception that needs a typed confirmation in the UI and an audit tombstone.
- Secondbrain items are a read-only mirror; forgetting the source happens in that app.
- Her character memory: Settings, Stage, "What she remembers" lists every item with its kind and privacy label and forgets one item or all of it, also while the stage is switched off. The row is deleted and overwritten in the database file, and the audit log records that something was forgotten and of what kind, never what it said. It does not reach a Claude conversation that is already open (it keeps what it was told until it restarts), Claude Code's own transcript of past turns under `~\.claude\projects` (which holds the text she passed to `character_remember`), backups, or anything the drive itself retains. Like the rest of this section, deleting it from the app is not the same as erasing every copy.
- A "forget" of intimate or companion memory follows the same levels and defaults to excluding it from all cloud-bound context immediately.

## 11. Guest mode

- The shell blurs every element carrying `data-sensitive`. In the mockup this is a visual blur only.
- Proposed daemon enforcement: sensitive tools return "hidden in guest mode", sensitive content is not read aloud, and the camera turns off. See [PERSONA.md](PERSONA.md) section 7.

## 12. GDPR: a question to settle, not an assumption

Research flagged a possible EU or Nordic context from indirect hints; it is not confirmed. The questions to settle:

1. Where does the user live? If in the EU or EEA, which GDPR duties apply to a personal tool?
2. The household or personal exemption probably covers a purely personal tool, but that is a question, not a conclusion.
3. Webcam frames can include other people; contacts' personal data would be sent to a US-based API; face landmarks are biometric-adjacent.
4. If the app is ever shared with others, the exemption no longer applies and a proper review is needed (together with the Gmail verification question in section 8).

## 13. Open items for the user

1. Privacy appetite: may raw email bodies and raw transactions go to Claude, or snippets and aggregates only? (Defaults here assume the latter.)
2. Subscription terms: after the ToS email, confirm what the Consumer Terms imply for email, finance and companion content.
3. Residence and GDPR position (section 12).
4. Whether the vault may ever have a remote, which complicates "erase".
5. Backup destination and rotation period, which sets how long forgotten data persists offsite.
6. Note titles on the stage: the knowledge constellation sends the title and path of every note, `sensitive` ones included, to the stage process on this PC (the notes are sample notes today). Proposed default once the real vault exists: leave `sensitive` notes out of the constructs. A third-party engine plugin is the realistic risk, because the stage process is the one component that may be someone else's code.
7. Two memories: Settings, Memory (what she has learned about you) and Settings, Stage ("What she remembers", her character memory) are separate stores today. Decide whether they merge when the real vault exists, so there is one place to inspect and forget.
