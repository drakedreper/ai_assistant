# ADR 0004: Memory model and the vault

Status: Accepted (layers, formats and write policy). Embeddings, the facts table and the Secondbrain federation mechanics are deferred and flagged below. Date: 2026-10-31.

## Context

The second brain is the product's differentiator: it keeps the assistant from being "another calendar overview" because every proactive item cites the user's own strategy or knowledge notes. Research across companion projects found memory is chat history or vector RAG everywhere and nothing resembling a knowledge base ([research/prior-art-companions.md](../research/prior-art-companions.md)), so this has to be built. See [research/second-brain.md](../research/second-brain.md) for the full digest.

Verified inputs:

- Obsidian-compatible formats are open and small: markdown with YAML frontmatter and `[[wikilinks]]`; Bases (`.base` YAML, young) and JSON Canvas 1.0 (stable, minimal) are optional.
- Karpathy's "LLM Wiki" pattern: immutable raw sources, an LLM-owned wiki, a schema file (`CLAUDE.md`); ingest, query and lint operations; an `index.md` catalogue that works to hundreds of pages without embeddings.
- Letta's Context Repositories (2026-02-12) validate files plus git plus background consolidation agents.
- Graph and vector frameworks (Graphiti, mem0, Zep) are heavier than a single-user app needs, are Python or graph-database based, default to OpenAI, and keep memory in a database rather than human-editable files. Basic Memory is AGPL-3.0.
- Claude Code's native memory is coding-oriented (auto memory loads only the first 200 lines or 25 KB of its index); auto-dream is documented only by third-party blogs and the API "Dreams" feature is a gated research preview, so consolidation is ours to build.
- sqlite-vec is pre-v1 ("expect breaking changes").
- The critic found a memory-poisoning path no researcher closed: a nightly consolidation job that reads email-derived text and auto-writes notes.

## Decision

1. The vault is a folder of Obsidian-compatible markdown, git-versioned, and the single source of truth for knowledge. A derived SQLite index sits beside it and can be deleted and rebuilt.
2. Layout (folder is the layer; frontmatter `layer:` mirrors it):

```
vault/
  00-core/      persona.md, values.md, user-profile.md, operating-rules.md   always in context (~3-4k tokens)
  10-strategy/  goals, life areas, theses, strategies, decision records        titles and one-liners always in context
  20-journal/   YYYY/YYYY-MM-DD.md daily log (append-only), weekly/, monthly/
  30-knowledge/ atomic concept notes and entity pages (people, orgs, places)
  40-projects/  <slug>/README.md hub (status, decisions, log) linking to Work sessions
  50-inbox/     unprocessed captures (voice, email, clips)
  raw/          immutable sources, never edited
  _system/      CLAUDE.md (schema), index.md, log.md, proposals/, bases/, templates/
  .brain/       index.sqlite and embeddings (gitignored, derived)
```

3. Persona and values are data, not code: the user edits them and the assistant may only propose changes (see [PERSONA.md](../PERSONA.md)).
4. Notes use flat, Obsidian-Properties-safe frontmatter (no nested objects). The shared `Note` schema in `packages/shared` implements: `id`, `path`, `title`, `layer` (`core`, `strategy`, `episodic`, `semantic`, `project`, `inbox`), `type`, `status` (`draft`, `active`, `superseded`, `archived`), `importance` (1 to 5), `confidence`, `provenance` (`user`, `assistant`, `dream`, `import`, `federated`), `sensitivity` (`normal`, `private`, `sensitive`), `tags`, `created`, `updated`, `source` (`vault` or `secondbrain`), `reviewAfter`, `contextTokens`, `supersededBy`, and the markdown `body`. The research design also names `aliases`, `sources`, `supersedes`, `valid_from` and `valid_to`; add them as optional fields when needed. A ULID `id` stays stable across renames.
5. Write policy by layer, matching the autonomy tiers ([ADR 0005](0005-privacy-tiers-and-autonomy.md)):

| Layer | Who writes | Policy |
|---|---|---|
| Journal and inbox | Mira | Auto, append-only (T1) |
| Knowledge and project notes | Mira | Auto plus one git commit per write, message `brain: <tool> <session>` (T2) |
| Core and strategy | User only | Mira can only create a diff in `_system/proposals/`; the user approves it in the proposals queue and the approval makes the commit (T3) |
| `raw/` | Nobody | Immutable |

   Every write goes through typed `brain_*` tools with a path jail (reject `..`, `%2e`, absolute paths and Windows backslash forms), size caps, `str_replace` semantics (never whole-file overwrite), and output pagination below the 25,000-token MCP result limit.
6. Retrieval: always in context are the core files, a strategy index (title plus one line, about 1.5k tokens), today's journal and open loops. Beyond that, `brain_search` runs FTS5 first. Until vectors exist the model can read `_system/index.md`. Vectors (sqlite-vec behind a `VectorStore` interface, one local embedding model, `embed_meta` recording model id and dimension) arrive only after a 30 to 50 query eval set shows FTS misses. Proposed ranking when vectors exist (design reasoning, not sourced): reciprocal-rank fusion with k=60, re-scored by importance and a 30-day half-life for episodic notes, none for core, strategy and semantic notes, plus a small boost for link neighbours.
7. Consolidation jobs run on the app's own scheduler as restricted sessions: `brain` tools only (no Bash), a cheaper model, a budget cap, one job record and one git commit per run, catch-up at start.
   - Triage (hourly or on event) sorts the inbox. Nightly dream (about 03:00 or first idle) compresses the day, extracts durable facts, updates entity and project pages, supersedes rather than overwrites, flags contradictions as proposals and writes a dream report. Weekly review rolls up the week against `10-strategy`. Monthly or quarterly: strategy review, archive, persona-drift diff and vault lint.
   - Jobs never edit core notes directly. Jobs that read inbox- or email-derived text may only call `brain_propose` or write to a quarantine folder; promotion into knowledge notes needs a second pass or user approval.
8. Every proactive card, briefing thread, learned fact and finance insight must cite at least one note (`BriefingThread.cites` has `min(1)` in the schema).
9. Secondbrain is federated read-only: its tasks, daily notes, meetings and entities appear under `secondbrain/` with `source: 'secondbrain'` and follow the same retrieval and sensitivity rules. How a local daemon authenticates to it is unverified and the first Phase 2 task. The UI never calls Secondbrain's knowledge graph "Atlas".
10. The editor is CodeMirror 6 in source mode with `[[` autocomplete and a properties panel, because it edits text directly and cannot normalise the user's markdown; ProseMirror-based editors re-serialise (this is reasoning, not sourced). Note language is English, which fits a small English embedding model such as EmbeddingGemma-300M (Gemma Terms of Use, review before any redistribution), chosen after a quick Windows test.

## Consequences

- The user can open the folder in Obsidian today and keep the data if the app dies; git gives undo and an audit trail for every assistant write.
- We build the chunker, watcher, link resolver and ranker ourselves, and need eval discipline so retrieval does not silently regress.
- Dual writers (the user in the editor or Obsidian, the assistant through tools) need care: hash and mtime checks, a self-write guard in the watcher, append-only journals, and the vault kept out of OneDrive-style synced folders. Windows file locking and case-insensitive paths apply.
- Forgetting is not just deleting a file: see [PRIVACY.md](../PRIVACY.md).
- A schema migration story is required for frontmatter and the index (`schema_version` in `_system`).
- Dream jobs can still hallucinate or over-compress; raw sources and the journal stay immutable, every job is a commit, and consolidation supersedes, never deletes.

## Alternatives considered

| Option | Why not (or why later) |
|---|---|
| Letta, mem0 or Graphiti plus a graph database | Python, Docker or graph-database sidecars on Windows; OpenAI-first defaults; structured-output failures with small local models; memory not human-editable; mem0's headline benchmarks are for the managed platform; Zep Community Edition is deprecated. Borrow ideas only (bi-temporal validity, observations) |
| Claude Code native memory only (`CLAUDE.md`, auto memory, grep) | Repo-scoped, coding-oriented, loads only the first 200 lines or 25 KB, no ranking, backlinks or graph, no write policy by layer |
| LanceDB as the retrieval store | Two engines still needed (relational for notes, links and jobs); heavier native dependency; unnecessary at personal-vault scale; its FTS scoring was not confirmed to be BM25. Remains the fallback behind `VectorStore` |
| qmd as a sidecar | MIT and capable (FTS5 plus vectors plus LLM rerank, MCP server) but its README does not mention Windows and it pulls about 2 GB of models; reference design for later |
| A database as source of truth, exporting to markdown | Loses the Obsidian-portability goal |
| Basic Memory | AGPL-3.0 and Python 3.12 or later; do not copy |
| Bi-temporal facts table, JSON Canvas, `.base` parsing, WYSIWYG blocks, importance-sum reflection triggers | Deferred (scope cuts); each is a later addition behind the same files |

## Sources

- https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f
- https://docs.letta.com/letta-agent/memfs
- https://github.com/tobi/qmd
- https://github.com/asg017/sqlite-vec
- https://github.com/getzep/graphiti, https://github.com/mem0ai/mem0, https://github.com/basicmachines-co/basic-memory
- https://code.claude.com/docs/en/memory
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool
- https://github.com/obsidianmd/obsidian-help/blob/master/en/Bases/Bases%20syntax.md
- https://github.com/obsidianmd/jsoncanvas/blob/main/spec/1.0.md
- https://docs.obsidian.md/Plugins/Editor/View+plugins
- https://arxiv.org/pdf/2304.03442v2 (Generative Agents; numbers unverified)
