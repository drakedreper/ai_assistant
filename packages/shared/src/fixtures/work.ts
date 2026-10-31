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

/** SEED. Work owner enriches (more sessions/subagents/events) but keeps the ids in STORY.md. */
export function buildSessions(now: Date): Session[] {
  return [
    {
      id: 's-daemon', projectId: 'assistant', title: 'Scaffold daemon health endpoint', source: 'sdk', kind: 'interactive', status: 'running',
      model: 'claude-sonnet-5-5', cwd: 'C:\\dev\\ai_assistant', branch: 'feat/daemon', startedAt: ago(now, 42), updatedAt: ago(now, 0), currentTool: 'Edit', costUsd: 1.42, contextPct: 46,
      agents: [
        { id: 'main', parentId: null, type: 'main', status: 'running', lastMessage: 'Editing apps/daemon/src/server.ts' },
        { id: 'ag-explore', parentId: 'main', type: 'Explore', status: 'running', lastMessage: 'Searching for Hono WS examples' },
      ],
    },
    {
      id: 's-migrate', projectId: 'atlas', title: 'Migrate transactions table', source: 'hook', kind: 'interactive', status: 'blocked_permission',
      model: 'claude-opus-5-5', cwd: 'C:\\dev\\atlas', branch: 'chore/tx-migration', startedAt: ago(now, 95), updatedAt: ago(now, 4), currentTool: 'Bash', costUsd: 3.9, contextPct: 71,
      agents: [{ id: 'main', parentId: null, type: 'main', status: 'waiting', lastMessage: 'Wants to run: rm -rf ./backup/2026-10' }],
    },
    {
      id: 's-contract-tests', projectId: 'atlas', title: 'Write contract tests for FinanceProvider', source: 'hook', kind: 'interactive', status: 'waiting_input',
      model: 'claude-sonnet-5-5', cwd: 'C:\\dev\\atlas', branch: 'test/finance-contract', startedAt: ago(now, 130), updatedAt: ago(now, 12), costUsd: 2.15, contextPct: 58,
      agents: [{ id: 'main', parentId: null, type: 'main', status: 'waiting', lastMessage: 'Should pending transactions count toward the budget?' }],
    },
    {
      id: 's-a11y', projectId: 'site', title: 'Fix Lighthouse a11y regressions', source: 'hook', kind: 'interactive', status: 'done',
      model: 'claude-haiku-5-5', cwd: 'C:\\dev\\site', branch: 'fix/a11y', startedAt: ago(now, 300), updatedAt: ago(now, 210), costUsd: 0.31, contextPct: 22,
      agents: [{ id: 'main', parentId: null, type: 'main', status: 'done', lastMessage: 'Score 93 -> 100. PR ready.' }],
      summary: 'Fixed contrast and label issues; Lighthouse accessibility 100.',
    },
    {
      id: 's-certs', projectId: 'homelab', title: 'Renew TLS certs', source: 'hook', kind: 'background', status: 'idle',
      model: 'claude-haiku-5-5', cwd: 'C:\\dev\\homelab', startedAt: ago(now, 600), updatedAt: ago(now, 480), costUsd: 0.12, contextPct: 12,
      agents: [{ id: 'main', parentId: null, type: 'main', status: 'waiting', lastMessage: 'Next renewal check in 12 h' }],
    },
    {
      id: 's-kokoro', projectId: 'assistant', title: 'Research: Kokoro latency on RTX', source: 'sdk', kind: 'background', status: 'done',
      model: 'claude-sonnet-5-5', cwd: 'C:\\dev\\ai_assistant', branch: 'spike/voice', startedAt: ago(now, 1500), updatedAt: ago(now, 1440), costUsd: 0.74, contextPct: 38,
      agents: [{ id: 'main', parentId: null, type: 'main', status: 'done', lastMessage: 'First audio ~180 ms warm, sentence-chunked.' }],
      summary: 'Kokoro first audio about 180 ms warm on the RTX; sentence chunking keeps gaps inaudible.',
    },
  ]
}

export function buildEvents(now: Date): AgentEvent[] {
  return [
    { id: 'ev-1', ts: ago(now, 0), sessionId: 's-daemon', agentId: 'main', hookEvent: 'PostToolUse', toolName: 'Edit', summary: 'Edited apps/daemon/src/server.ts', level: 'info' },
    { id: 'ev-2', ts: ago(now, 1), sessionId: 's-daemon', agentId: 'ag-explore', hookEvent: 'SubagentStart', summary: 'Explore subagent started', level: 'info' },
    { id: 'ev-3', ts: ago(now, 4), sessionId: 's-migrate', agentId: 'main', hookEvent: 'PermissionRequest', toolName: 'Bash', summary: 'Permission needed: rm -rf ./backup/2026-10', level: 'warn' },
    { id: 'ev-4', ts: ago(now, 12), sessionId: 's-contract-tests', agentId: 'main', hookEvent: 'Notification', summary: 'Waiting for your input', level: 'warn' },
    { id: 'ev-5', ts: ago(now, 210), sessionId: 's-a11y', agentId: 'main', hookEvent: 'Stop', summary: 'Session finished', level: 'info' },
  ]
}

export function buildTasks(): Task[] {
  return [
    { id: 't1', projectId: 'atlas', title: 'Ship Atlas beta', column: 'doing', priority: 'high', sessionIds: ['s-migrate'], source: 'manual', branch: 'chore/tx-migration' },
    { id: 't2', projectId: 'atlas', title: 'FinanceProvider contract tests', column: 'doing', priority: 'high', sessionIds: ['s-contract-tests'], source: 'assistant', branch: 'test/finance-contract' },
    { id: 't3', projectId: 'assistant', title: 'Daemon health endpoint', column: 'doing', priority: 'medium', sessionIds: ['s-daemon'], source: 'assistant', branch: 'feat/daemon' },
    { id: 't4', projectId: 'site', title: 'Lighthouse a11y pass', column: 'review', priority: 'medium', sessionIds: ['s-a11y'], source: 'manual', prUrl: 'https://example.com/pr/12' },
    { id: 't5', projectId: 'assistant', title: 'Windows hooks spike', column: 'todo', priority: 'high', sessionIds: [], source: 'assistant' },
    { id: 't6', projectId: 'homelab', title: 'Offsite backup drill', column: 'backlog', priority: 'low', sessionIds: [], source: 'manual' },
    { id: 't7', projectId: 'site', title: 'Send revised homepage to Priya', column: 'todo', priority: 'medium', sessionIds: [], source: 'federated' },
    { id: 't8', projectId: 'assistant', title: 'Kokoro vs ElevenLabs voice test', column: 'done', priority: 'low', sessionIds: ['s-kokoro'], source: 'manual' },
  ]
}

export function buildApprovals(now: Date): Approval[] {
  return [
    { id: 'ap-rm-backup', kind: 'tool_permission', title: 'Atlas migration wants to delete a backup folder', detail: 'Session "Migrate transactions table" asks to run a destructive shell command.', requestedAt: ago(now, 4), sessionId: 's-migrate', status: 'pending', risk: 'high', tier: 'T4', preview: 'rm -rf ./backup/2026-10', area: 'work' },
    { id: 'ap-reply-priya', kind: 'email_draft', title: 'Reply to Priya about site revisions', detail: 'Draft prepared by Mira. Sends only if you approve.', requestedAt: ago(now, 20), status: 'pending', risk: 'medium', tier: 'T4', preview: 'Hi Priya, revised homepage attached. Happy to walk through it Thursday...', area: 'life', refId: 'm-priya' },
    { id: 'ap-q4-proposal', kind: 'brain_proposal', title: 'Edit to your Q4 positioning note', detail: 'Strategy notes change only through proposals you review.', requestedAt: ago(now, 55), status: 'pending', risk: 'low', tier: 'T3', preview: '-Be a general productivity toolmaker.\n+Be the local-first toolmaker for independent builders.', area: 'brain', refId: 'pr-q4' },
    { id: 'ap-focus-block', kind: 'calendar_event', title: 'Block Thursday 09:00-11:00 for deep work', detail: 'Matches your deep-work system. Adds a calendar event.', requestedAt: ago(now, 90), status: 'pending', risk: 'low', tier: 'T4', preview: 'Deep work: Atlas beta (Thu 09:00-11:00)', area: 'life' },
  ]
}

export function buildCostDays(now: Date): CostDay[] {
  const rows: Array<[number, number, number, number, number]> = [
    // dayOffset, atlas, assistant, site, homelab
    [-6, 2.1, 0.9, 0.4, 0.1], [-5, 3.0, 1.2, 0.0, 0.2], [-4, 1.4, 2.4, 0.9, 0.0], [-3, 2.8, 1.6, 0.3, 0.1],
    [-2, 4.2, 0.7, 0.0, 0.0], [-1, 3.1, 2.0, 0.6, 0.1], [0, 6.05, 2.16, 0.31, 0.12],
  ]
  return rows.map(([off, a, b, c, d]) => {
    const total = a + b + c + d
    return {
      date: dateOnly(now, off),
      byProject: { atlas: a, assistant: b, site: c, homelab: d },
      byModel: { 'claude-opus-5-5': +(total * 0.45).toFixed(2), 'claude-sonnet-5-5': +(total * 0.45).toFixed(2), 'claude-haiku-5-5': +(total * 0.1).toFixed(2) },
    }
  })
}

export function buildUsageBlock(now: Date): UsageBlock {
  return { startedAt: ago(now, 140), endsAt: ago(now, -160), usedPct: 62, costUsd: 5.4 }
}
