import type { AgentEvent, Approval, CostDay, Project, Session, Task, UsageBlock } from '../index'
import { ago, dateOnly } from './time'

export function buildProjects(): Project[] {
  return [
    { id: 'atlas', name: 'Atlas (finance app)', rootPath: 'C:\\dev\\atlas', status: 'active', tags: ['finance', 'local-first'], color: '#fbbf24', hubNote: '40-projects/atlas/README.md' },
    { id: 'assistant', name: 'ai_assistant', rootPath: 'C:\\dev\\ai_assistant', status: 'active', tags: ['assistant', 'claude'], color: '#f472b6', hubNote: '40-projects/assistant/README.md' },
    { id: 'site', name: 'portfolio-site', rootPath: 'C:\\dev\\site', status: 'active', tags: ['client'], color: '#60a5fa', hubNote: '40-projects/site/README.md' },
    { id: 'homelab', name: 'home-lab', rootPath: 'C:\\dev\\homelab', status: 'paused', tags: ['infra'], color: '#34d399', hubNote: '40-projects/homelab/README.md' },
  ]
}

/**
 * Ten sessions across the three sources (hook, sdk, import) and every status.
 * Contract ids from STORY.md are kept; the FixtureClient simulator mutates `s-daemon` and `s-sync-retry`
 * (both running, agents[0] is always the main agent).
 */
export function buildSessions(now: Date): Session[] {
  return [
    {
      id: 's-daemon', projectId: 'assistant', title: 'Scaffold daemon health endpoint', source: 'sdk', kind: 'interactive', status: 'running',
      model: 'claude-sonnet-5-5', cwd: 'C:\\dev\\ai_assistant', branch: 'feat/daemon', startedAt: ago(now, 42), updatedAt: ago(now, 0), currentTool: 'Edit', costUsd: 1.42, contextPct: 46,
      agents: [
        { id: 'main', parentId: null, type: 'main', status: 'running', lastMessage: 'Editing apps/daemon/src/server.ts', currentTool: 'Edit' },
        { id: 'ag-explore', parentId: 'main', type: 'Explore', status: 'running', lastMessage: 'Searching for Hono WS examples', description: 'Find Hono WebSocket upgrade examples and the recommended close handling', currentTool: 'Grep' },
        { id: 'ag-plan', parentId: 'main', type: 'Plan', status: 'done', lastMessage: 'Plan ready: 4 steps, health route first', description: 'Plan the route layout and what GET /health reports' },
        { id: 'ag-gp', parentId: 'main', type: 'general-purpose', status: 'running', lastMessage: 'Drafting apps/daemon/test/health.test.ts', description: 'Write tests for GET /health, including the hook receiver state', currentTool: 'Write' },
      ],
      relatedNotes: ['40-projects/assistant/README.md', '30-knowledge/local-first-software.md'],
    },
    {
      id: 's-migrate', projectId: 'atlas', title: 'Migrate transactions table', source: 'hook', kind: 'interactive', status: 'blocked_permission',
      model: 'claude-opus-5-5', cwd: 'C:\\dev\\atlas', branch: 'chore/tx-migration', startedAt: ago(now, 95), updatedAt: ago(now, 4), currentTool: 'Bash', costUsd: 3.9, contextPct: 71,
      agents: [
        { id: 'main', parentId: null, type: 'main', status: 'waiting', lastMessage: 'Wants to run: rm -rf ./backup/2026-10', currentTool: 'Bash' },
        { id: 'ag-plan', parentId: 'main', type: 'Plan', status: 'done', lastMessage: 'Copy in 5k-row batches inside one WAL transaction', description: 'Plan a safe copy of 48k rows into transactions + postings' },
        { id: 'ag-gp', parentId: 'main', type: 'general-purpose', status: 'done', lastMessage: 'Wrote 0007_split_transactions.sql and its rollback', description: 'Write the migration and a rollback script' },
      ],
      relatedNotes: ['10-strategy/decision-atlas-beta.md', '30-knowledge/sqlite-wal.md'],
    },
    {
      id: 's-contract-tests', projectId: 'atlas', title: 'Write contract tests for FinanceProvider', source: 'hook', kind: 'interactive', status: 'waiting_input',
      model: 'claude-sonnet-5-5', cwd: 'C:\\dev\\atlas', branch: 'test/finance-contract', startedAt: ago(now, 130), updatedAt: ago(now, 12), costUsd: 2.15, contextPct: 58,
      agents: [
        { id: 'main', parentId: null, type: 'main', status: 'waiting', lastMessage: 'Should pending transactions count toward the budget?' },
        { id: 'ag-explore', parentId: 'main', type: 'Explore', status: 'done', lastMessage: 'Found 3 provider call sites and 2 fixtures', description: 'Find every place the FinanceProvider interface is consumed' },
      ],
      relatedNotes: ['30-knowledge/plaid-sync-pattern.md', '40-projects/atlas/README.md'],
    },
    {
      id: 's-sync-retry', projectId: 'atlas', title: 'Harden sync retry with backoff', source: 'sdk', kind: 'interactive', status: 'running',
      model: 'claude-sonnet-5-5', cwd: 'C:\\dev\\atlas', branch: 'fix/sync-retry', startedAt: ago(now, 38), updatedAt: ago(now, 0.8), currentTool: 'Bash', costUsd: 1.15, contextPct: 33,
      agents: [
        { id: 'main', parentId: null, type: 'main', status: 'running', lastMessage: 'Running pnpm test sync', currentTool: 'Bash' },
        { id: 'ag-sync-plan', parentId: 'main', type: 'Plan', status: 'done', lastMessage: 'Jittered backoff, cap at 5 attempts, resume from cursor', description: 'Plan retry and resume behaviour for the sync loop' },
        { id: 'ag-sync-gp', parentId: 'main', type: 'general-purpose', status: 'running', lastMessage: 'Refactoring the sync loop to resume from the cursor', description: 'Rework src/sync/loop.ts around the cursor', currentTool: 'Edit' },
        { id: 'ag-sync-explore', parentId: 'ag-sync-gp', type: 'Explore', status: 'running', lastMessage: 'Reading cursor handling in src/sync/plaid.ts', description: 'Check how the cursor is persisted between runs', currentTool: 'Read' },
      ],
      relatedNotes: ['30-knowledge/plaid-sync-pattern.md'],
    },
    {
      id: 's-ci-fail', projectId: 'site', title: 'Upgrade site build to Vite 7', source: 'hook', kind: 'interactive', status: 'error',
      model: 'claude-sonnet-5-5', cwd: 'C:\\dev\\site', branch: 'chore/vite-7', startedAt: ago(now, 130), updatedAt: ago(now, 62), costUsd: 0.88, contextPct: 64,
      agents: [
        { id: 'main', parentId: null, type: 'main', status: 'error', lastMessage: 'Build failed after the Vite 7 upgrade' },
        { id: 'ag-gp', parentId: 'main', type: 'general-purpose', status: 'error', lastMessage: 'Plugin lookup crashed: module not found', description: 'Bump Vite and fix plugin peer ranges' },
      ],
      error: 'pnpm build exited with code 1: Cannot find module "vite-plugin-sitemap" (peer range stops at Vite 6).',
      relatedNotes: ['40-projects/site/README.md'],
    },
    {
      id: 's-a11y', projectId: 'site', title: 'Fix Lighthouse a11y regressions', source: 'hook', kind: 'interactive', status: 'done',
      model: 'claude-haiku-5-5', cwd: 'C:\\dev\\site', branch: 'fix/a11y', startedAt: ago(now, 300), updatedAt: ago(now, 210), costUsd: 0.31, contextPct: 22,
      agents: [{ id: 'main', parentId: null, type: 'main', status: 'done', lastMessage: 'Score 93 -> 100. PR ready.' }],
      summary: 'Fixed contrast and label issues; Lighthouse accessibility 100.',
      relatedNotes: ['40-projects/site/README.md', '30-knowledge/people/priya-nair.md'],
    },
    {
      id: 's-certs', projectId: 'homelab', title: 'Renew TLS certs', source: 'hook', kind: 'background', status: 'idle',
      model: 'claude-haiku-5-5', cwd: 'C:\\dev\\homelab', startedAt: ago(now, 600), updatedAt: ago(now, 480), costUsd: 0.12, contextPct: 12,
      agents: [{ id: 'main', parentId: null, type: 'main', status: 'waiting', lastMessage: 'Next renewal check in 12 h' }],
      summary: 'All certificates valid for 41 more days; the next renewal check is scheduled.',
    },
    {
      id: 's-kokoro', projectId: 'assistant', title: 'Research: Kokoro latency on RTX', source: 'sdk', kind: 'background', status: 'done',
      model: 'claude-sonnet-5-5', cwd: 'C:\\dev\\ai_assistant', branch: 'spike/voice', startedAt: ago(now, 1500), updatedAt: ago(now, 1440), costUsd: 0.74, contextPct: 38,
      agents: [{ id: 'main', parentId: null, type: 'main', status: 'done', lastMessage: 'First audio ~180 ms warm, sentence-chunked.' }],
      summary: 'Kokoro first audio about 180 ms warm on the RTX; sentence chunking keeps gaps inaudible.',
      relatedNotes: ['40-projects/assistant/README.md'],
    },
    {
      id: 's-persona-old', projectId: 'assistant', title: 'Draft persona prompt compiler', source: 'hook', kind: 'interactive', status: 'stale',
      model: 'claude-sonnet-5-5', cwd: 'C:\\dev\\ai_assistant', branch: 'feat/persona-compiler', startedAt: ago(now, 3100), updatedAt: ago(now, 2900), costUsd: 1.96, contextPct: 81,
      agents: [{ id: 'main', parentId: null, type: 'main', status: 'waiting', lastMessage: 'Last seen: editing the persona compiler' }],
      error: 'No hook events for 48 h and the roster no longer lists it. Probably closed from the terminal.',
      relatedNotes: ['40-projects/assistant/README.md'],
    },
    {
      id: 's-schema-import', projectId: 'atlas', title: 'Design Atlas initial schema', source: 'import', kind: 'interactive', status: 'done',
      model: 'claude-opus-5-5', cwd: 'C:\\dev\\atlas', branch: 'main', startedAt: ago(now, 8700), updatedAt: ago(now, 8500), costUsd: 4.2, contextPct: 88,
      agents: [{ id: 'main', parentId: null, type: 'main', status: 'done', lastMessage: 'Schema v1 merged to main.' }],
      summary: 'Imported from Claude Code history: the first Atlas schema and the migration runner. No live events were recorded.',
      relatedNotes: ['40-projects/atlas/README.md'],
    },
  ]
}

/** Claude Code hook events, newest first. PreToolUse is deliberately never hooked. */
export function buildEvents(now: Date): AgentEvent[] {
  type Row = [id: string, minutesAgo: number, sessionId: string, agentId: string, hook: string, tool: string | undefined, summary: string, level?: 'info' | 'warn' | 'error']
  const rows: Row[] = [
    ['ev-1', 0, 's-daemon', 'main', 'PostToolUse', 'Edit', 'Edited apps/daemon/src/server.ts'],
    ['ev-s1', 0.8, 's-sync-retry', 'ag-sync-explore', 'PostToolUse', 'Read', 'Read src/sync/plaid.ts'],
    ['ev-d2', 0.5, 's-daemon', 'ag-explore', 'PostToolUse', 'Read', 'Read node_modules/hono/dist/helper/websocket/index.d.ts'],
    ['ev-d3', 1.1, 's-daemon', 'ag-explore', 'PostToolUse', 'Grep', 'Searched "upgradeWebSocket" (6 matches)'],
    ['ev-2', 1.6, 's-daemon', 'ag-explore', 'SubagentStart', undefined, 'Explore subagent started: find Hono WebSocket examples'],
    ['ev-s2', 1.9, 's-sync-retry', 'main', 'PostToolUse', 'Bash', 'Ran pnpm test sync (18 passed)'],
    ['ev-s3', 2.5, 's-sync-retry', 'ag-sync-gp', 'PostToolUse', 'Edit', 'Edited src/sync/loop.ts (resume from cursor)'],
    ['ev-d4', 2.7, 's-daemon', 'ag-gp', 'PostToolUse', 'Write', 'Wrote apps/daemon/test/health.test.ts'],
    ['ev-s4', 3.2, 's-sync-retry', 'ag-sync-explore', 'SubagentStart', undefined, 'Explore subagent started under general-purpose: cursor handling'],
    ['ev-3', 4, 's-migrate', 'main', 'PermissionRequest', 'Bash', 'Permission needed: rm -rf ./backup/2026-10', 'warn'],
    ['ev-d6', 4.2, 's-daemon', 'main', 'PostToolUse', 'Bash', 'Ran pnpm --filter daemon typecheck (clean)'],
    ['ev-s5', 6.5, 's-sync-retry', 'main', 'PostToolUseFailure', 'Bash', 'pnpm test sync failed: 1 failing (retry cap not honored)', 'error'],
    ['ev-m2', 6, 's-migrate', 'main', 'PostToolUse', 'Bash', 'Ran sqlite3 atlas.db "PRAGMA integrity_check" (ok)'],
    ['ev-d7', 6.4, 's-daemon', 'main', 'PostToolUse', 'Write', 'Wrote apps/daemon/src/routes/health.ts'],
    ['ev-d8', 8, 's-daemon', 'ag-plan', 'SubagentStop', undefined, 'Plan subagent finished: 4 steps, health route first'],
    ['ev-s6', 9, 's-sync-retry', 'ag-sync-plan', 'SubagentStop', undefined, 'Plan subagent finished: jittered backoff, cap at 5'],
    ['ev-m3', 11, 's-migrate', 'main', 'PostToolUse', 'Write', 'Wrote migrations/0007_split_transactions.sql'],
    ['ev-4', 12, 's-contract-tests', 'main', 'Notification', undefined, 'Waiting for your input: pending transactions in the budget?', 'warn'],
    ['ev-c2', 13, 's-contract-tests', 'main', 'PostToolUse', 'Edit', 'Edited test/contract/finance-provider.test.ts'],
    ['ev-d9', 15, 's-daemon', 'main', 'UserPromptSubmit', undefined, 'Add GET /health: uptime, db state and hook receiver state'],
    ['ev-m4', 20, 's-migrate', 'main', 'PostToolUseFailure', 'Bash', 'pnpm test:migrations failed: 2 failing (row count mismatch)', 'error'],
    ['ev-c3', 22, 's-contract-tests', 'main', 'PostToolUse', 'Bash', 'Ran vitest contract (9 passed, 1 skipped)'],
    ['ev-m5', 34, 's-migrate', 'ag-plan', 'SubagentStop', undefined, 'Plan subagent finished: copy in 5k-row batches'],
    ['ev-s7', 38, 's-sync-retry', 'main', 'SessionStart', undefined, 'Session launched by the daemon (SDK)'],
    ['ev-d10', 42, 's-daemon', 'main', 'SessionStart', undefined, 'Session launched by the daemon (SDK)'],
    ['ev-c4', 55, 's-contract-tests', 'main', 'UserPromptSubmit', undefined, 'Write contract tests for the FinanceProvider interface'],
    ['ev-m6', 60, 's-migrate', 'main', 'UserPromptSubmit', undefined, 'Split transactions into transactions + postings; keep old rows readable'],
    ['ev-f1', 62, 's-ci-fail', 'main', 'Stop', undefined, 'Session stopped after a failed build', 'error'],
    ['ev-f2', 63, 's-ci-fail', 'main', 'PostToolUseFailure', 'Bash', 'pnpm build exited with code 1: Cannot find module "vite-plugin-sitemap"', 'error'],
    ['ev-f3', 75, 's-ci-fail', 'ag-gp', 'PostToolUse', 'Edit', 'Edited package.json (vite ^7.0.0)'],
    ['ev-m7', 95, 's-migrate', 'main', 'SessionStart', undefined, 'Session observed via hooks'],
    ['ev-5', 210, 's-a11y', 'main', 'Stop', undefined, 'Session finished', 'info'],
    ['ev-a2', 213, 's-a11y', 'main', 'PostToolUse', 'Bash', 'Ran lighthouse (accessibility 100)'],
    ['ev-a3', 225, 's-a11y', 'main', 'PostToolUse', 'Edit', 'Edited src/components/Nav.astro (aria-current, label)'],
    ['ev-ce1', 480, 's-certs', 'main', 'PostToolUse', 'Bash', 'Ran certbot renew --dry-run (all certs valid for 41 days)'],
    ['ev-ce2', 600, 's-certs', 'main', 'SessionStart', undefined, 'Background session started by cron'],
    ['ev-k1', 1440, 's-kokoro', 'main', 'Stop', undefined, 'Research finished: summary saved to the inbox'],
    ['ev-k2', 1450, 's-kokoro', 'main', 'PostToolUse', 'WebFetch', 'Fetched Kokoro ONNX benchmark notes'],
    ['ev-p1', 2900, 's-persona-old', 'main', 'PostToolUse', 'Edit', 'Edited packages/core/src/persona/compile.ts'],
    ['ev-p2', 3100, 's-persona-old', 'main', 'SessionStart', undefined, 'Session observed via hooks'],
  ]
  return rows
    .map(([id, min, sessionId, agentId, hookEvent, toolName, summary, level]) => ({
      id,
      ts: ago(now, min),
      sessionId,
      agentId,
      hookEvent,
      ...(toolName ? { toolName } : {}),
      summary,
      level: level ?? ('info' as const),
    }))
    .sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0))
}

export function buildTasks(): Task[] {
  return [
    { id: 't1', projectId: 'atlas', title: 'Ship Atlas beta', column: 'doing', priority: 'high', sessionIds: ['s-migrate'], source: 'manual', branch: 'chore/tx-migration' },
    { id: 't2', projectId: 'atlas', title: 'FinanceProvider contract tests', column: 'doing', priority: 'high', sessionIds: ['s-contract-tests'], source: 'assistant', branch: 'test/finance-contract' },
    { id: 't3', projectId: 'assistant', title: 'Daemon health endpoint', column: 'doing', priority: 'medium', sessionIds: ['s-daemon'], source: 'assistant', branch: 'feat/daemon' },
    { id: 't9', projectId: 'atlas', title: 'Sync: backoff and resume from cursor', column: 'doing', priority: 'high', sessionIds: ['s-sync-retry'], source: 'claude_task', branch: 'fix/sync-retry' },
    { id: 't10', projectId: 'site', title: 'Upgrade site build to Vite 7', column: 'doing', priority: 'medium', sessionIds: ['s-ci-fail'], source: 'claude_task', branch: 'chore/vite-7' },
    { id: 't4', projectId: 'site', title: 'Lighthouse a11y pass', column: 'review', priority: 'medium', sessionIds: ['s-a11y'], source: 'manual', branch: 'fix/a11y', prUrl: 'https://example.com/pr/12' },
    { id: 't12', projectId: 'homelab', title: 'Automate cert renewal check', column: 'review', priority: 'low', sessionIds: ['s-certs'], source: 'claude_task', prUrl: 'https://example.com/pr/9' },
    { id: 't5', projectId: 'assistant', title: 'Windows hooks spike', column: 'todo', priority: 'high', sessionIds: [], source: 'assistant' },
    { id: 't7', projectId: 'site', title: 'Send revised homepage to Priya', column: 'todo', priority: 'medium', sessionIds: [], source: 'federated' },
    { id: 't14', projectId: 'assistant', title: 'Hook receiver health badge', column: 'todo', priority: 'medium', sessionIds: [], source: 'assistant' },
    { id: 't15', projectId: 'atlas', title: 'Backup and restore drill before beta', column: 'todo', priority: 'high', sessionIds: [], source: 'federated' },
    { id: 't16', projectId: 'site', title: 'Footer copy tweaks from Priya', column: 'todo', priority: 'low', sessionIds: [], source: 'federated' },
    { id: 't6', projectId: 'homelab', title: 'Offsite backup drill', column: 'backlog', priority: 'low', sessionIds: [], source: 'manual' },
    { id: 't11', projectId: 'assistant', title: 'Persona prompt compiler', column: 'backlog', priority: 'medium', sessionIds: ['s-persona-old'], source: 'manual', branch: 'feat/persona-compiler' },
    { id: 't13', projectId: 'atlas', title: 'CSV import fallback', column: 'backlog', priority: 'low', sessionIds: [], source: 'manual' },
    { id: 't17', projectId: 'assistant', title: 'Cost estimator: cache-read pricing', column: 'backlog', priority: 'medium', sessionIds: [], source: 'claude_task' },
    { id: 't8', projectId: 'assistant', title: 'Kokoro vs ElevenLabs voice test', column: 'done', priority: 'low', sessionIds: ['s-kokoro'], source: 'manual' },
    { id: 't18', projectId: 'atlas', title: 'Atlas initial schema', column: 'done', priority: 'high', sessionIds: ['s-schema-import'], source: 'manual' },
  ]
}

export function buildApprovals(now: Date): Approval[] {
  return [
    // Pending (ids from STORY.md are contracts).
    { id: 'ap-rm-backup', kind: 'tool_permission', title: 'Atlas migration wants to delete a backup folder', detail: 'Session "Migrate transactions table" asks to run a destructive shell command.', requestedAt: ago(now, 4), sessionId: 's-migrate', status: 'pending', risk: 'high', tier: 'T4', preview: 'rm -rf ./backup/2026-10', area: 'work' },
    { id: 'ap-reply-priya', kind: 'email_draft', title: 'Reply to Priya about site revisions', detail: 'Draft prepared by Mira. Sends only if you approve.', requestedAt: ago(now, 20), status: 'pending', risk: 'medium', tier: 'T4', preview: 'Hi Priya, revised homepage attached. Happy to walk through it Thursday...', area: 'life', refId: 'm-priya' },
    { id: 'ap-q4-proposal', kind: 'brain_proposal', title: 'Edit to your Q4 positioning note', detail: 'Strategy notes change only through proposals you review.', requestedAt: ago(now, 55), status: 'pending', risk: 'low', tier: 'T3', preview: '-Be a general productivity toolmaker.\n+Be the local-first toolmaker for independent builders.', area: 'brain', refId: 'pr-q4' },
    { id: 'ap-focus-block', kind: 'calendar_event', title: 'Block Thursday 09:00-11:00 for deep work', detail: 'Matches your deep-work system. Adds a calendar event.', requestedAt: ago(now, 90), status: 'pending', risk: 'low', tier: 'T4', preview: 'Deep work: Atlas beta (Thu 09:00-11:00)', area: 'life' },
    // History: already decided.
    { id: 'ap-vitest-run', kind: 'tool_permission', title: 'Contract tests session wants to run the test suite', detail: 'Session "Write contract tests for FinanceProvider" asks to run a shell command.', requestedAt: ago(now, 40), sessionId: 's-contract-tests', status: 'approved', risk: 'low', tier: 'T4', preview: 'pnpm vitest run test/contract', area: 'work' },
    { id: 'ap-env-edit', kind: 'tool_permission', title: 'Atlas migration wants to edit .env.local', detail: 'Session "Migrate transactions table" asks to modify a file that holds local settings.', requestedAt: ago(now, 70), sessionId: 's-migrate', status: 'denied', risk: 'medium', tier: 'T4', preview: '+ATLAS_DB_PATH=C:\\dev\\atlas\\data\\atlas.db', area: 'work' },
    { id: 'ap-git-push', kind: 'tool_permission', title: 'Site a11y session wants to push a branch', detail: 'Session "Fix Lighthouse a11y regressions" asks to publish its branch to the remote.', requestedAt: ago(now, 220), sessionId: 's-a11y', status: 'approved', risk: 'medium', tier: 'T4', preview: 'git push origin fix/a11y', area: 'work' },
    { id: 'ap-certbot', kind: 'tool_permission', title: 'Cert session wants to renew certificates', detail: 'Session "Renew TLS certs" asks to run a privileged command.', requestedAt: ago(now, 485), sessionId: 's-certs', status: 'approved', risk: 'medium', tier: 'T4', preview: 'sudo certbot renew --quiet', area: 'work' },
    { id: 'ap-webfetch', kind: 'tool_permission', title: 'Kokoro research wants to fetch a web page', detail: 'Session "Research: Kokoro latency on RTX" asks to read an external page.', requestedAt: ago(now, 1450), sessionId: 's-kokoro', status: 'approved', risk: 'low', tier: 'T4', preview: 'WebFetch https://example.com/kokoro-onnx-benchmarks', area: 'work' },
  ]
}

/** 14 days, oldest first. The last row is "today" and roughly matches the sessions updated today. */
export function buildCostDays(now: Date): CostDay[] {
  const rows: Array<[number, number, number, number, number]> = [
    // dayOffset, atlas, assistant, site, homelab
    [-13, 2.4, 1.1, 0.6, 0.0], [-12, 3.2, 0.8, 0.0, 0.3], [-11, 0.9, 0.4, 0.0, 0.0], [-10, 0.0, 1.9, 0.2, 0.5],
    [-9, 3.9, 1.4, 1.1, 0.0], [-8, 4.6, 2.2, 0.0, 0.1], [-7, 2.1, 3.1, 0.7, 0.0],
    [-6, 2.1, 0.9, 0.4, 0.1], [-5, 3.0, 1.2, 0.0, 0.2], [-4, 1.4, 2.4, 0.9, 0.0], [-3, 2.8, 1.6, 0.3, 0.1],
    [-2, 4.2, 0.7, 0.0, 0.0], [-1, 3.1, 2.0, 0.6, 0.1], [0, 7.2, 1.59, 1.19, 0.12],
  ]
  // Opus share and haiku share per day; sonnet takes the rest so the model split always sums to the day total.
  const opusShare = [0.44, 0.38, 0.30, 0.22, 0.48, 0.52, 0.41, 0.45, 0.36, 0.28, 0.42, 0.55, 0.40, 0.46]
  const haikuShare = [0.08, 0.1, 0.14, 0.12, 0.07, 0.06, 0.09, 0.1, 0.11, 0.13, 0.09, 0.05, 0.1, 0.07]
  return rows.map(([off, a, b, c, d], i) => {
    const total = a + b + c + d
    const opus = +(total * (opusShare[i] ?? 0.4)).toFixed(2)
    const haiku = +(total * (haikuShare[i] ?? 0.1)).toFixed(2)
    const sonnet = +(total - opus - haiku).toFixed(2)
    return {
      date: dateOnly(now, off),
      byProject: { atlas: a, assistant: b, site: c, homelab: d },
      byModel: { 'claude-opus-5-5': opus, 'claude-sonnet-5-5': sonnet, 'claude-haiku-5-5': haiku },
    }
  })
}

export function buildUsageBlock(now: Date): UsageBlock {
  return { startedAt: ago(now, 140), endsAt: ago(now, -160), usedPct: 62, costUsd: 5.4 }
}
