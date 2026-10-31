# Research digest: second-brain

Status: digest of one researcher's structured output, as of 2026-10-31. Tags: [verified] or [unverified] as reported. The "Recommendation" section is design reasoning built on the verified findings, not sourced fact. Unreachable from the research sandbox: help.obsidian.md, jsoncanvas.org, ollama.com, huggingface.co, arxiv.org, sqlite.org, letta.com.

## Question

How should the app build an Obsidian-inspired second brain with the assistant as its embodiment: formats, retrieval, memory design, the way Claude exposes it, consolidation jobs, editor and graph, and how to avoid being "just another calendar overview"?

## Key findings

1. [verified] Obsidian-compatible formats are open and small. Bases (core plugin, GA in Obsidian 1.9.10 on 2025-08-18) are `.base` YAML files with filters, formulas, properties, summaries and views; data comes from note frontmatter and `file.*` fields. JSON Canvas 1.0 (`.canvas`, MIT) has text, file, link and group nodes. Bases is young; treat it as optional and derived. Sources: https://github.com/obsidianmd/obsidian-help/blob/master/en/Bases/Bases%20syntax.md, https://obsidian.md/changelog/2025-08-18-desktop-v1.9.10, https://github.com/obsidianmd/jsoncanvas/blob/main/spec/1.0.md
2. [verified] Karpathy's "LLM Wiki" gist (April 2026): immutable raw sources, an LLM-owned markdown wiki, a schema file (`CLAUDE.md` or `AGENTS.md`); ingest, query and lint; `index.md` as the catalogue read first and `log.md` as an append-only log. He says the index works to about 100 sources and hundreds of pages without embedding RAG. Source: https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f
3. [verified] qmd (MIT, Node 22 or Bun): a local markdown search engine with SQLite FTS5 BM25 plus vectors plus LLM rerank through node-llama-cpp and GGUF models (about 300 MB, 640 MB and 1.1 GB), with an MCP server. Its README does not mention Windows. A reference design or optional sidecar later. Source: https://github.com/tobi/qmd
4. [verified] sqlite-vec: Apache-2.0 or MIT, pure C, runs on Windows, explicitly "pre-v1, expect breaking changes", about 8k stars. npm 0.1.9 with an optional `sqlite-vec-windows-x64` package (a Go mirror lists 0.1.11, a conflict). KNN is brute force (from memory), fine under about 100k chunks. Sources: https://github.com/asg017/sqlite-vec, https://registry.npmjs.org/sqlite-vec/latest
5. [verified] LanceDB (Apache-2.0, `@lancedb/lancedb` 0.41.0, Node 22 or later, `win32-x64-msvc` package) is the main alternative vector store: hybrid search with RRF and versioning. Weaker fit for a markdown vault (a second store is needed for metadata and links); its FTS scoring was not confirmed as BM25. Sources: https://github.com/lancedb/lancedb, https://docs.lancedb.com/search/hybrid-search/
6. [unverified] Local embeddings: EmbeddingGemma (308M parameters, 768 dimensions, Matryoshka-truncatable, 100+ languages, Gemma Terms of Use, not OSI); Qwen3-Embedding-0.6B scores higher per a vendor blog but needs about 5.8 GB in Ollama; `@huggingface/transformers` 4.3.2 can embed in-process, but no confirmed report of EmbeddingGemma on Node under Windows. Ollama availability comes from third-party tutorials only. Sources: https://huggingface.co/blog/embeddinggemma (excerpt only), https://registry.npmjs.org/@huggingface/transformers/latest
7. [verified] Letta Context Repositories (MemFS, launched 2026-02-12) is the closest prior art: agent memory as a git-backed folder of markdown with YAML frontmatter, every edit a commit, memory subagents ("dreaming", "memory doctor") running in git worktrees, no semantic index by default. Validates files plus git plus background consolidation. Sources: https://docs.letta.com/letta-agent/memfs, https://github.com/letta-ai/letta
8. [verified] Graph and vector frameworks are heavier than a single-user app needs: Graphiti (Apache-2.0; bi-temporal facts, provenance; Python only; needs Neo4j, FalkorDB or Neptune; defaults to OpenAI; reference MCP server has no auth), Zep Community Edition (deprecated), mem0 (Apache-2.0; headline benchmarks are for the managed platform), Basic Memory (AGPL-3.0, Python 3.12 or later). Borrow ideas only. Sources: https://github.com/getzep/graphiti, https://help.getzep.com/ce-deprecation-notice, https://github.com/mem0ai/mem0, https://github.com/basicmachines-co/basic-memory
9. [verified] Claude Code's native memory is coding-oriented: `CLAUDE.md` with `@path` imports (under 200 lines per file); auto memory in `~/.claude/projects/<project>/memory/` with an index of which only the first 200 lines or 25 KB load; disable with `autoMemoryEnabled:false` or `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`. The API memory tool (`memory_20250818`) is client-side. Auto-dream is documented only by third-party blogs; Managed Agents "Dreams" is a gated research preview. So we must build our own dreaming. Sources: https://code.claude.com/docs/en/memory, https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool, https://platform.claude.com/docs/en/managed-agents/dreams.md
10. [verified] The SDK has what a brain needs: in-process MCP tools (`tool()`, `createSdkMcpServer()`, `readOnlyHint:true` allows parallel calls), `allowedTools:['mcp__brain__*']`, `SessionStart` and `UserPromptSubmit` hooks that can inject `additionalContext`, skills in `.claude/skills/<name>/SKILL.md`, `claude -p --json-schema --max-budget-usd`. `--bare` needs an API key. Sources: https://code.claude.com/docs/en/agent-sdk/custom-tools, https://code.claude.com/docs/en/hooks-guide, https://code.claude.com/docs/en/skills
11. [verified] UI libraries: CodeMirror 6 (Obsidian's own approach), TipTap 3.32.2, Milkdown/Crepe 7.23.0, Lexical 0.53.0 (pre-1.0); `@flowershow/remark-wiki-link` 4.0.1; chokidar 6.0.0 (Node 22.22 or later); graph: sigma 4.0.4 (WebGL, graphology), force-graph 1.52.0, cytoscape 3.34.4. ProseMirror editors re-serialise markdown and can normalise the user's text; CM6 edits text directly (reasoning, not a source). Sources: https://docs.obsidian.md/Plugins/Editor/View+plugins, https://registry.npmjs.org/@codemirror/view/latest, https://github.com/jacomyal/sigma.js, https://github.com/vasturiano/force-graph
12. [unverified] Generative Agents (Park et al. 2023): a memory stream scored by recency (exponential decay, about 0.995 per hour), importance (LLM 1 to 10) and relevance (embedding cosine) with equal weights; reflection triggers when summed importance passes a threshold (150 from memory; secondary sources say 100 or 150). arXiv was unreachable. Source: https://arxiv.org/pdf/2304.03442v2 (search result only).

## Options considered

| Option | Verdict |
|---|---|
| A. Markdown vault as truth, derived SQLite index (FTS5, then sqlite-vec), custom in-process `brain` MCP server | Recommended |
| B. Off-the-shelf memory framework (Letta server, mem0, Graphiti) | Python, Docker or graph-database sidecars; OpenAI-first; memory in a database; churn |
| C. Pure Claude Code native memory, no index | Zero infrastructure but repo-scoped, no ranking, backlinks or write policy |
| D. LanceDB instead of SQLite | Two engines; unnecessary at this scale |

## Recommendation (design reasoning)

Build the second brain as an Obsidian-compatible vault, single source of truth, with a rebuildable SQLite index beside it and the assistant as the only writer through typed `brain` tools. The vault is plain text, git-versioned and readable in Obsidian.

- Layers (folder is the layer): `00-core` (persona, values, user profile, operating rules; always in context, about 3 to 4k tokens), `10-strategy`, `20-journal`, `30-knowledge`, `40-projects`, `50-inbox`, plus `raw/` (immutable), `_system/` (schema, index, log, proposals, bases, templates) and `.brain/` (derived index, gitignored). Persona and values are data the user edits.
- Flat frontmatter (Properties-safe): `id` (ULID), `type`, `layer`, `status`, `created`, `updated`, `tags`, `aliases`, `importance` 1 to 5, `confidence`, `provenance`, `sources`, `supersedes`, `valid_from`, `valid_to`, `review_after`, `privacy`.
- Derived index: `notes`, `chunks` (heading-aware, about 300 to 500 tokens), `chunks_fts` (FTS5, porter unicode61), `chunk_vec` (sqlite-vec) plus `embed_meta`, `links`, `tags`, `aliases`, `access_log`, `jobs`; later a `facts` table. A `VectorStore` interface so LanceDB can replace sqlite-vec. A chokidar watcher with debounce, hash compare and a self-write guard; Obsidian-style link resolution; NFC filenames and short paths on Windows.
- Retrieval: always in context (core, strategy index, today's journal, open loops); `brain_search` runs FTS5 and vector top-30, fuses with RRF (k=60), re-scores by importance and recency (30-day half-life for episodic, none for core, strategy, semantic), boosts link neighbours, returns about 8 cited snippets; `_system/index.md` as a navigation fallback; LLM rerank later; a 30 to 50 query eval set gates every upgrade on recall@5.
- Claude exposure: an in-process `brain` MCP server. Read tools: `brain_search`, `brain_read`, `brain_list`, `brain_neighbors`, `brain_today`, `brain_timeline`. Write tools: `brain_journal_append`, `brain_capture`, `brain_upsert_note` (`str_replace` semantics), `brain_link`, `brain_supersede`, `brain_propose`. Write policy by layer (journal and inbox auto; knowledge and project notes auto plus a git commit; core and strategy only as proposals in `_system/proposals/`), a vault-root path jail and size caps. Skills in `.claude/skills/` (daily-briefing, capture, ingest-source, weekly-review, nightly-dream, lint-vault, decision-record, person-dossier). `CLAUDE.md` as the vault schema. Auto memory off in the persona agent so there is one memory system.
- Consolidation jobs run as headless SDK sessions with `brain` tools only (no Bash), a cheaper model and a budget cap, one job record and one git commit per run, catch-up at start: triage (hourly or on event); nightly dream (about 03:00 or first idle: compress the day, extract durable facts, update entities, supersede with `valid_to`, score importance, flag contradictions as proposals, update index and log, re-embed, write a report; never edits core); weekly review (Sunday: roll up, compare against strategy, surface open loops, write 3 to 5 reflection notes, propose strategy edits); monthly or quarterly (strategy review, archive, persona-drift diff, lint).
- Not just a calendar overview: every proactive card or briefing item must cite a strategy or knowledge note ("this week's meeting touches your Q4 positioning decision"). The day opens from "threads of thinking", not tasks.
- Editor and graph: CodeMirror 6 with live-preview decorations and `[[` autocomplete; sigma plus graphology for the vault graph (colour by layer, size by importance, time slider), force-graph for a small dashboard "constellation"; JSON Canvas and hand-written `.base` files later.

## MVP versus later

MVP, in order: vault skeleton with `_system/CLAUDE.md`, five core files, daily note template, inbox and git auto-commit; indexer with watcher, parser, tables and FTS5; `brain` MCP server with about nine tools, path jail, layer-based write policy and per-write commits; an injection mechanism for core files, strategy index, today's note and open loops; UI with CM6 editor, backlinks and search panel, proposals queue and a basic graph; nightly digest then weekly review with a cost cap; vectors in the second half (sqlite-vec plus one embedding model chosen after a Windows test, `embed_meta` from day one, before and after eval). Later: bi-temporal facts table, entity resolution, contradiction detection, LLM reranker, qmd evaluation, importance-sum reflection triggers, memory-doctor lint, persona-drift checks, JSON Canvas and `.base` parsing, WYSIWYG blocks, graph time slider, ingestion pipelines with per-source privacy labels, voice "remember this", multilingual embeddings if notes are not English, encrypted-at-rest vault, sync, mobile read-only.

## Risks

- Prompt injection and memory poisoning through ingested email, news and web content recalled as trusted memory (the critic found this path was not closed; see [critic.md](critic.md)).
- Over-consolidation and hallucinated memories; keep raw and journal immutable and every job a commit.
- Dual-writer conflicts, worsened on Windows by file locking, case-insensitive paths, the 260-character limit and synced folders.
- sqlite-vec is pre-v1; embedding changes force a full re-embed; review the Gemma licence before redistribution.
- Cost, rate limits and policy for unattended jobs.
- Context bloat and tool overload (200-line index limit, 25k-token MCP spill).
- Format drift (Bases is new; Obsidian-flavoured features need round-trip tests).
- Product risk: the brain becomes a note pile or "just another calendar overview".
- Persona and companion data is highly personal; mark sensitive notes and exclude them from cloud context by default.

## Open questions

- Auth and cost for nightly and weekly jobs (monthly budget).
- Note language (English is now locked, which favours a small English embedding model).
- Existing Obsidian vault to import, its size and plugins.
- Which layers and sensitivity classes may be sent to the Claude API.
- Autonomy boundaries and who owns `persona.md` and `values.md` edits.
- App shell choice's effect on SQLite binding (Node, so better-sqlite3).
- sqlite-vec version discrepancy (0.1.9 versus 0.1.11) and a Windows load test in the chosen shell.
- Whether Claude Code's auto-dream is stable; assumed unavailable.

## Decisions that followed

[ADR 0004](../adr/0004-memory-model-and-vault.md), [ADR 0005](../adr/0005-privacy-tiers-and-autonomy.md), [PRIVACY.md](../PRIVACY.md) (forget semantics).
