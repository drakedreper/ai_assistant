import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentEvent, Approval, ServerEvent, Session } from '@ai-assistant/shared'
import { Snapshot } from '@ai-assistant/shared'
import { createProjectResolver, PROJECT_PALETTE, normalizePathKey } from '../src/hooks/projects'
import { oneLine, summarizeTool } from '../src/hooks/projection'
import type { Scheduler } from '../src/hooks/service'
import { json, makeDaemon, makeTmp, payloads, type TestDaemon } from './helpers'

const open: TestDaemon[] = []
const tmps: Array<() => void> = []
afterEach(async () => {
  for (const d of open.splice(0)) await d.cleanup()
  for (const c of tmps.splice(0)) c()
})
async function daemon(opts: Parameters<typeof makeDaemon>[0] = {}): Promise<TestDaemon> {
  const d = await makeDaemon(opts)
  open.push(d)
  return d
}

const SID = 'sess-aaaa-0001'
const ev = (event: string, extra: Record<string, unknown> = {}, sid = SID) => payloads.base(sid, event, extra)
const sessionOf = (d: TestDaemon, id = SID): Session => {
  const s = d.daemon.store.getSession(id)
  if (!s) throw new Error(`no session ${id}`)
  return s
}
const ofType = <T extends ServerEvent['type']>(events: ServerEvent[], type: T) => events.filter((e): e is Extract<ServerEvent, { type: T }> => e.type === type)

describe('hook receiver: fail-open', () => {
  it('answers 200 {} before anything is processed, then projects after the response', async () => {
    const d = await daemon()
    const res = await d.hook('SessionStart', ev('SessionStart'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({})
    expect(d.daemon.store.getSession(SID)).toBeUndefined() // not yet: processing happens after the reply
    await d.daemon.ctx.hooks.drain()
    expect(d.daemon.store.getSession(SID)).toBeDefined()
  })

  it.each([
    ['not JSON', '{{{ nope'],
    ['empty body', ''],
    ['a JSON array', '[1,2,3]'],
    ['JSON null', 'null'],
    ['a JSON string', '"hello"'],
    ['a number', '42'],
    ['an object without session_id', '{"hook_event_name":"Stop"}'],
    ['a session_id of the wrong type', '{"session_id": 12345, "hook_event_name":"Stop"}'],
    ['an enormous session_id', JSON.stringify({ session_id: 'x'.repeat(5000), hook_event_name: 'Stop' })],
    ['binary-ish noise', '\u0000\u0001\u0002 \uFFFF'],
  ])('tolerates %s without crashing or stalling later events', async (_name, raw) => {
    const d = await daemon()
    const res = await d.hook('Stop', undefined, { raw })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({})
    await d.daemon.ctx.hooks.drain()
    expect(d.daemon.store.countSessions()).toBe(0)
    // A valid event right after garbage is still projected.
    await d.hookAndDrain('SessionStart', ev('SessionStart'))
    expect(sessionOf(d).status).toBe('idle')
  })

  it('survives oddly typed optional fields: the event is kept, the bad field is ignored', async () => {
    const d = await daemon()
    await d.hookAndDrain('PostToolUse', ev('PostToolUse', { tool_name: 5, tool_use_id: { x: 1 }, prompt: ['a'], agent_id: false, cwd: 'C:\\dev\\atlas' }))
    const s = sessionOf(d)
    expect(s.status).toBe('running')
    expect(s.currentTool).toBeUndefined()
  })

  it('counts invalid bodies and keeps health honest', async () => {
    const d = await daemon()
    await d.hook('Stop', undefined, { raw: 'garbage' })
    await d.hookAndDrain('SessionStart', ev('SessionStart'))
    const health = await json<{ hooksReceived: number; lastHookAt: string | null; sessions: number }>(await d.call('/api/health'))
    expect(health.hooksReceived).toBe(2)
    expect(health.lastHookAt).toBe(new Date(d.clock.now()).toISOString())
    expect(health.sessions).toBe(1)
    expect(d.daemon.ctx.hooks.stats().invalid).toBe(1)
  })

  it('drops (but still answers 200 to) a body that declares an absurd size', async () => {
    const d = await daemon()
    const res = await d.hook('Stop', ev('Stop'), { headers: { 'Content-Length': String(50 * 1024 * 1024) } })
    expect(res.status).toBe(200)
    expect(d.daemon.ctx.hooks.stats().dropped).toBe(1)
  })

  it('also drops a body that exceeds the cap when it did not declare a length', async () => {
    const d = await daemon()
    const res = await d.hook('Stop', undefined, { raw: `{"session_id":"s","pad":"${'x'.repeat(9 * 1024 * 1024)}"}` })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({})
    expect(d.daemon.ctx.hooks.stats().dropped).toBe(1)
    await d.daemon.ctx.hooks.drain()
    expect(d.daemon.store.countSessions()).toBe(0)
  })

  it('bounds its queue instead of growing without limit', async () => {
    const d = await daemon()
    const hooks = d.daemon.ctx.hooks
    // enqueue far more than the queue holds without yielding to the event loop
    for (let i = 0; i < 2600; i++) hooks.enqueue('Unknown', JSON.stringify({ session_id: `s${i}` }))
    expect(hooks.stats().dropped).toBeGreaterThan(0)
    await hooks.drain()
  })

  it('stores unknown events raw and ignores them in projections', async () => {
    const d = await daemon()
    await d.hookAndDrain('FancyNewEvent2027', ev('FancyNewEvent2027', { novel: 'field' }))
    expect(d.daemon.store.countEvents(SID)).toBe(1)
    expect(d.daemon.store.getSession(SID)).toBeUndefined()
    expect(d.daemon.store.countSessions()).toBe(0)
    // Known-but-unhandled events (e.g. PreCompact) behave the same.
    await d.hookAndDrain('PreCompact', ev('PreCompact'))
    expect(d.daemon.store.countSessions()).toBe(0)
  })

  it('uses the event name from the payload, falling back to the URL', async () => {
    const d = await daemon()
    await d.hookAndDrain('Stop', ev('SessionStart'))
    expect(d.daemon.store.listEvents(SID, 1)[0]?.hookEvent).toBe('SessionStart')
    await d.hookAndDrain('SessionEnd', { session_id: SID, cwd: 'C:\\dev\\atlas' })
    expect(d.daemon.store.listEvents(SID, 1)[0]?.hookEvent).toBe('SessionEnd')
    await d.hookAndDrain('bad name!!', { session_id: SID, hook_event_name: '../../etc' })
    expect(d.daemon.store.listEvents(SID, 1)[0]?.hookEvent).toBe('Unknown')
  })
})

describe('session projection: lifecycle', () => {
  it('walks SessionStart -> UserPromptSubmit -> tools -> Stop -> SessionEnd', async () => {
    const d = await daemon()
    await d.hookAndDrain('SessionStart', ev('SessionStart', { source: 'startup', model: 'claude-sonnet-5-5' }))
    let s = sessionOf(d)
    expect(s).toMatchObject({ source: 'hook', kind: 'interactive', status: 'idle', model: 'claude-sonnet-5-5', cwd: 'C:\\dev\\atlas', costUsd: 0, contextPct: 0 })
    expect(s.title).toBe('Claude Code in atlas')
    expect(s.agents).toEqual([{ id: 'main', parentId: null, type: 'main', status: 'waiting', lastMessage: '' }])

    d.clock.advance(5_000)
    await d.hookAndDrain('UserPromptSubmit', ev('UserPromptSubmit', { prompt: 'Add retry with backoff to the sync loop\nand write tests' }))
    s = sessionOf(d)
    expect(s.status).toBe('running')
    expect(s.title).toBe('Add retry with backoff to the sync loop') // first line only
    expect(s.updatedAt).toBe(new Date(d.clock.now()).toISOString())

    await d.hookAndDrain('PostToolUse', ev('PostToolUse', { tool_name: 'Bash', tool_use_id: 'toolu_1', tool_input: { command: 'pnpm test sync' }, tool_response: { stdout: 'ok' } }))
    s = sessionOf(d)
    expect(s).toMatchObject({ status: 'running', currentTool: 'Bash' })
    expect(s.agents[0]).toMatchObject({ id: 'main', status: 'running', currentTool: 'Bash', lastMessage: 'Ran pnpm test sync' })

    await d.hookAndDrain('PostToolUseFailure', ev('PostToolUseFailure', { tool_name: 'Bash', tool_use_id: 'toolu_2', tool_input: { command: 'pnpm build' }, error: 'exit code 1' }))
    expect(sessionOf(d).agents[0]?.lastMessage).toBe('Ran pnpm build failed: exit code 1')

    await d.hookAndDrain('Stop', ev('Stop', { last_assistant_message: 'Done. Retry cap is 5 attempts with jitter.' }))
    s = sessionOf(d)
    expect(s.status).toBe('idle')
    expect(s.currentTool).toBeUndefined()
    expect(s.summary).toBe('Done. Retry cap is 5 attempts with jitter.')
    expect(s.agents[0]?.status).toBe('waiting')

    await d.hookAndDrain('SessionEnd', ev('SessionEnd', { reason: 'prompt_input_exit' }))
    s = sessionOf(d)
    expect(s.status).toBe('done')
    expect(s.agents.every((a) => a.status === 'done')).toBe(true)

    const events = d.daemon.store.listAgentEvents(50).reverse()
    expect(events.map((e) => e.hookEvent)).toEqual(['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'SessionEnd'])
    expect(events[2]).toMatchObject({ toolName: 'Bash', summary: 'Ran pnpm test sync', level: 'info', agentId: 'main' })
    expect(events[3]).toMatchObject({ level: 'error' })
    expect(events[5]?.summary).toBe('Session ended (prompt_input_exit)')
  })

  it('publishes session.update and agent.event ServerEvents with increasing seq', async () => {
    const d = await daemon()
    d.events.length = 0
    await d.hookAndDrain('SessionStart', ev('SessionStart'))
    await d.hookAndDrain('UserPromptSubmit', ev('UserPromptSubmit', { prompt: 'hi' }))
    await d.hookAndDrain('PostToolUse', ev('PostToolUse', { tool_name: 'Read', tool_input: { file_path: 'src/a.ts' } }))
    const types = d.events.map((e) => e.type)
    expect(types).toContain('session.update')
    expect(types).toContain('agent.event')
    const seqs = d.events.map((e) => e.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    expect(new Set(seqs).size).toBe(seqs.length)
    const last = ofType(d.events, 'session.update').at(-1)!
    expect(last.session.status).toBe('running')
    const agentEv = ofType(d.events, 'agent.event').at(-1)!.event as AgentEvent
    expect(agentEv).toMatchObject({ hookEvent: 'PostToolUse', toolName: 'Read', summary: 'Read src/a.ts', sessionId: SID })
  })

  it('creates a session from any event, even when the daemon started after the session did', async () => {
    const d = await daemon()
    await d.hookAndDrain('PostToolUse', ev('PostToolUse', { tool_name: 'Edit', tool_input: { file_path: 'x.ts' } }))
    expect(sessionOf(d)).toMatchObject({ status: 'running', currentTool: 'Edit' })
  })

  it('revives a finished session when events arrive again (resume with the same id)', async () => {
    const d = await daemon()
    await d.hookAndDrain('SessionStart', ev('SessionStart'))
    await d.hookAndDrain('SessionEnd', ev('SessionEnd'))
    expect(sessionOf(d).status).toBe('done')
    await d.hookAndDrain('SessionStart', ev('SessionStart', { source: 'resume' }))
    expect(sessionOf(d).status).toBe('idle')
    await d.hookAndDrain('UserPromptSubmit', ev('UserPromptSubmit', { prompt: 'continue' }))
    expect(sessionOf(d).status).toBe('running')
  })

  it('treats SessionStart after a compaction as still running', async () => {
    const d = await daemon()
    await d.hookAndDrain('UserPromptSubmit', ev('UserPromptSubmit', { prompt: 'go' }))
    await d.hookAndDrain('SessionStart', ev('SessionStart', { source: 'compact' }))
    expect(sessionOf(d).status).toBe('running')
  })

  it('marks a failed turn as an error with the reason, and recovers on the next prompt', async () => {
    const d = await daemon()
    await d.hookAndDrain('StopFailure', ev('StopFailure', { error: 'rate_limit: slow down' }))
    expect(sessionOf(d)).toMatchObject({ status: 'error', error: 'rate_limit: slow down' })
    await d.hookAndDrain('UserPromptSubmit', ev('UserPromptSubmit', { prompt: 'retry' }))
    expect(sessionOf(d).status).toBe('running')
    expect(sessionOf(d).error).toBeUndefined()
  })

  it('classifies background sessions only from explicit flags', async () => {
    const d = await daemon()
    await d.hookAndDrain('SessionStart', ev('SessionStart'))
    await d.hookAndDrain('SessionStart', ev('SessionStart', { kind: 'background' }, 'bg-1'))
    await d.hookAndDrain('SessionStart', ev('SessionStart', { background: true }, 'bg-2'))
    expect(sessionOf(d).kind).toBe('interactive')
    expect(sessionOf(d, 'bg-1').kind).toBe('background')
    expect(sessionOf(d, 'bg-2').kind).toBe('background')
  })

  it('keeps hook sessions at zero cost', async () => {
    const d = await daemon()
    await d.hookAndDrain('PostToolUse', ev('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'x' }, cost_usd: 99, total_cost_usd: 99 }))
    expect(sessionOf(d).costUsd).toBe(0)
  })
})

describe('permission requests and notifications', () => {
  it('PermissionRequest blocks the session and queues an approval the app cannot answer', async () => {
    const d = await daemon()
    await d.hookAndDrain('SessionStart', ev('SessionStart'))
    d.events.length = 0
    await d.hookAndDrain('PermissionRequest', ev('PermissionRequest', { tool_name: 'Bash', tool_use_id: 'toolu_p', tool_input: { command: 'rm -rf ./backup/2026-10' } }))
    expect(sessionOf(d)).toMatchObject({ status: 'blocked_permission', currentTool: 'Bash' })
    const [approval] = ofType(d.events, 'approval.new')
    expect(approval?.approval).toMatchObject({ kind: 'tool_permission', status: 'pending', sessionId: SID, risk: 'high', tier: 'T4', area: 'work', preview: 'Ran rm -rf ./backup/2026-10' })
    expect(approval?.approval.detail).toMatch(/non-blocking/)
    const stored = d.daemon.store.getApproval(approval!.approval.id)
    expect(stored?.origin).toBe('hook')

    const decided = await d.call(`/api/approvals/${approval!.approval.id}/decision`, { json: { decision: 'approved' } })
    expect(decided.status).toBe(409)
    const body = await json(decided)
    expect(body.error).toBe('not_answerable_here')
    expect(String(body.message)).toMatch(/terminal/)
    expect(d.daemon.store.getApproval(approval!.approval.id)?.approval.status).toBe('pending')
  })

  it('does not queue the same pending request twice', async () => {
    const d = await daemon()
    const p = ev('PermissionRequest', { tool_name: 'Write', tool_use_id: 'toolu_w', tool_input: { file_path: 'a.ts', content: 'x' } })
    await d.hookAndDrain('PermissionRequest', p)
    await d.hookAndDrain('PermissionRequest', { ...p, tool_use_id: 'toolu_w' })
    expect(d.daemon.store.pendingApprovalsForSession(SID)).toHaveLength(1)
  })

  it('resolves the approval as approved when the tool then runs, and the session moves on', async () => {
    const d = await daemon()
    await d.hookAndDrain('PermissionRequest', ev('PermissionRequest', { tool_name: 'Bash', tool_use_id: 'toolu_p', tool_input: { command: 'npm install' } }))
    d.events.length = 0
    await d.hookAndDrain('PostToolUse', ev('PostToolUse', { tool_name: 'Bash', tool_use_id: 'toolu_p', tool_input: { command: 'npm install' } }))
    expect(ofType(d.events, 'approval.resolved')).toHaveLength(1)
    expect(ofType(d.events, 'approval.resolved')[0]).toMatchObject({ status: 'approved' })
    expect(sessionOf(d).status).toBe('running')
    expect(d.daemon.store.pendingApprovalsForSession(SID)).toHaveLength(0)
  })

  it('resolves it as denied when the turn ends or the session ends instead', async () => {
    const d = await daemon()
    await d.hookAndDrain('PermissionRequest', ev('PermissionRequest', { tool_name: 'Bash', tool_use_id: 'a', tool_input: { command: 'x' } }))
    await d.hookAndDrain('Stop', ev('Stop'))
    expect(d.daemon.store.listApprovals()[0]?.status).toBe('denied')

    await d.hookAndDrain('PermissionRequest', ev('PermissionRequest', { tool_name: 'Bash', tool_use_id: 'b', tool_input: { command: 'y' } }))
    await d.hookAndDrain('SessionEnd', ev('SessionEnd'))
    expect(d.daemon.store.pendingApprovalsForSession(SID)).toHaveLength(0)
  })

  it.each([
    ['permission_prompt', 'Claude needs your permission to use Bash', 'blocked_permission'],
    ['idle_prompt', 'Claude is waiting for your input', 'waiting_input'],
    ['agent_needs_input', 'Agent needs input', 'waiting_input'],
    ['elicitation_dialog', 'Pick one', 'waiting_input'],
  ])('Notification %s moves the session to %s', async (type, message, status) => {
    const d = await daemon()
    await d.hookAndDrain('UserPromptSubmit', ev('UserPromptSubmit', { prompt: 'go' }))
    await d.hookAndDrain('Notification', ev('Notification', { notification_type: type, message }))
    expect(sessionOf(d).status).toBe(status)
    expect(d.daemon.store.listAgentEvents(1)[0]).toMatchObject({ hookEvent: 'Notification', level: 'warn', summary: message })
  })

  it('other notification types are logged without changing the status', async () => {
    const d = await daemon()
    await d.hookAndDrain('UserPromptSubmit', ev('UserPromptSubmit', { prompt: 'go' }))
    await d.hookAndDrain('Notification', ev('Notification', { notification_type: 'plugin_notification', message: 'Plugin updated' }))
    expect(sessionOf(d).status).toBe('running')
    expect(d.daemon.store.listAgentEvents(1)[0]).toMatchObject({ level: 'info' })
  })

  it('falls back to the message text when a Notification has no type', async () => {
    const d = await daemon()
    await d.hookAndDrain('Notification', ev('Notification', { message: 'Claude needs your permission to use Edit' }))
    expect(sessionOf(d).status).toBe('blocked_permission')
  })
})

describe('subagent tree', () => {
  it('builds agent nodes with parent links and per-agent current tools', async () => {
    const d = await daemon()
    await d.hookAndDrain('SessionStart', ev('SessionStart'))
    await d.hookAndDrain('SubagentStart', ev('SubagentStart', { agent_id: 'ag-explore', agent_type: 'Explore', prompt: 'Find the cursor handling' }))
    await d.hookAndDrain('SubagentStart', ev('SubagentStart', { agent_id: 'ag-nested', agent_type: 'general-purpose', parent_agent_id: 'ag-explore' }))
    await d.hookAndDrain('PostToolUse', ev('PostToolUse', { agent_id: 'ag-explore', agent_type: 'Explore', tool_name: 'Grep', tool_input: { pattern: 'cursor' } }))
    let s = sessionOf(d)
    expect(s.status).toBe('running')
    expect(s.agents.map((a) => [a.id, a.parentId, a.type, a.status])).toEqual([
      ['main', null, 'main', 'running'],
      ['ag-explore', 'main', 'Explore', 'running'],
      ['ag-nested', 'ag-explore', 'general-purpose', 'running'],
    ])
    expect(s.agents[1]).toMatchObject({ currentTool: 'Grep', description: 'Find the cursor handling', lastMessage: 'Searched "cursor"' })
    expect(s.agents[0]?.currentTool).toBeUndefined() // the tool call belonged to the subagent

    await d.hookAndDrain('SubagentStop', ev('SubagentStop', { agent_id: 'ag-explore', agent_type: 'Explore', last_assistant_message: 'Cursor is persisted in sync_state' }))
    s = sessionOf(d)
    expect(s.agents[1]).toMatchObject({ status: 'done', lastMessage: 'Cursor is persisted in sync_state' })
    expect(s.agents[1]?.currentTool).toBeUndefined()
    expect(s.agents[2]?.status).toBe('running')
    expect(d.daemon.store.listAgentEvents(10).map((e) => [e.hookEvent, e.agentId])).toContainEqual(['SubagentStop', 'ag-explore'])
  })

  it('attaches an unknown parent to the main agent and tolerates a Stop for an unseen subagent', async () => {
    const d = await daemon()
    await d.hookAndDrain('SubagentStart', ev('SubagentStart', { agent_id: 'orphan', agent_type: 'Plan', parent_agent_id: 'never-seen' }))
    expect(sessionOf(d).agents.find((a) => a.id === 'orphan')?.parentId).toBe('main')
    await d.hookAndDrain('SubagentStop', ev('SubagentStop', { agent_id: 'ghost', agent_type: 'Explore' }))
    expect(sessionOf(d).agents.find((a) => a.id === 'ghost')?.status).toBe('done')
  })

  it('ends every agent when the session ends', async () => {
    const d = await daemon()
    await d.hookAndDrain('SubagentStart', ev('SubagentStart', { agent_id: 'a1', agent_type: 'Explore' }))
    await d.hookAndDrain('SessionEnd', ev('SessionEnd'))
    expect(sessionOf(d).agents.every((a) => a.status === 'done')).toBe(true)
  })

  it('caps the number of agent nodes per session', async () => {
    const d = await daemon()
    for (let i = 0; i < 90; i++) {
      await d.hookAndDrain('SubagentStart', ev('SubagentStart', { agent_id: `a${i}`, agent_type: 'Explore' }))
      await d.hookAndDrain('SubagentStop', ev('SubagentStop', { agent_id: `a${i}`, agent_type: 'Explore' }))
    }
    expect(sessionOf(d).agents.length).toBeLessThanOrEqual(64)
    expect(sessionOf(d).agents[0]?.id).toBe('main')
  })
})

describe('projects', () => {
  it('creates a project from the folder name with a stable id and a palette colour, and announces it once', async () => {
    const d = await daemon()
    d.events.length = 0
    await d.hookAndDrain('SessionStart', ev('SessionStart'))
    const s = sessionOf(d)
    expect(s.projectId).toMatch(/^p-atlas-[0-9a-f]{6}$/)
    const project = d.daemon.store.getProject(s.projectId)!
    expect(project).toMatchObject({ name: 'atlas', rootPath: 'C:\\dev\\atlas', status: 'active' })
    expect(PROJECT_PALETTE).toContain(project.color)
    // A new project has no event of its own: the daemon pushes a snapshot.reset that already contains it.
    const resets = ofType(d.events, 'snapshot.reset')
    expect(resets).toHaveLength(1)
    expect(resets[0]!.snapshot.projects.some((p) => p.id === s.projectId)).toBe(true)
    expect(resets[0]!.snapshot.seq).toBe(resets[0]!.seq)

    d.events.length = 0
    await d.hookAndDrain('SessionStart', ev('SessionStart', {}, 'second-session'))
    expect(sessionOf(d, 'second-session').projectId).toBe(s.projectId)
    expect(ofType(d.events, 'snapshot.reset')).toHaveLength(0)
    expect(d.daemon.store.listProjects()).toHaveLength(1)
  })

  it('gives Windows paths one project regardless of case, separators or a trailing slash', () => {
    const r = createProjectResolver({ existsSync: () => false, readFileSync: () => '', isDirectory: () => false })
    const ids = ['C:\\dev\\Atlas', 'c:\\dev\\atlas\\', 'C:/dev/atlas'].map((p) => r.resolve(p).project.id)
    expect(new Set(ids).size).toBe(1)
    expect(r.resolve('C:\\dev\\other').project.id).not.toBe(ids[0])
    expect(r.resolve('/home/u/proj').project.name).toBe('proj')
    expect(normalizePathKey('C:\\Dev\\Atlas\\')).toBe('c:\\dev\\atlas')
  })

  it('uses the git root when it can be found on disk, and reads the branch from .git/HEAD', () => {
    const t = makeTmp()
    tmps.push(t.cleanup)
    const root = join(t.dir, 'repo')
    mkdirSync(join(root, '.git'), { recursive: true })
    writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/feat/daemon\n')
    mkdirSync(join(root, 'apps', 'daemon'), { recursive: true })
    const r = createProjectResolver()
    const a = r.resolve(join(root, 'apps', 'daemon'))
    const b = r.resolve(root)
    expect(a.project.id).toBe(b.project.id)
    expect(a.project.rootPath).toBe(root)
    expect(a.project.name).toBe('repo')
    expect(r.branch(join(root, 'apps', 'daemon'))).toBe('feat/daemon')
    expect(r.branch(join(t.dir, 'nowhere'))).toBeUndefined()
  })

  it('reads the branch through a worktree .git file and ignores a detached HEAD', () => {
    const t = makeTmp()
    tmps.push(t.cleanup)
    const main = join(t.dir, 'main.git')
    mkdirSync(main, { recursive: true })
    writeFileSync(join(main, 'HEAD'), 'ref: refs/heads/wt-branch\n')
    const wt = join(t.dir, 'wt')
    mkdirSync(wt)
    writeFileSync(join(wt, '.git'), `gitdir: ${main}\n`)
    const detached = join(t.dir, 'det')
    mkdirSync(join(detached, '.git'), { recursive: true })
    writeFileSync(join(detached, '.git', 'HEAD'), 'a1b2c3d4e5f6\n')
    const r = createProjectResolver()
    expect(r.branch(wt)).toBe('wt-branch')
    expect(r.branch(detached)).toBeUndefined()
  })

  it('files sessions without a cwd under an "Unassigned" project', async () => {
    const d = await daemon()
    await d.hookAndDrain('SessionStart', { session_id: 'nocwd', hook_event_name: 'SessionStart' })
    const s = sessionOf(d, 'nocwd')
    expect(s.projectId).toBe('unassigned')
    expect(d.daemon.store.getProject('unassigned')?.name).toBe('Unassigned sessions')
  })

  it('shows the git branch on the session when the resolver finds one', async () => {
    const d = await daemon({
      fs: {
        existsSync: (p) => p === 'C:\\dev\\atlas\\.git' || p === 'C:\\dev\\atlas\\.git\\HEAD',
        readFileSync: () => 'ref: refs/heads/fix/sync-retry\n',
        isDirectory: (p) => p === 'C:\\dev\\atlas\\.git',
      },
    })
    await d.hookAndDrain('SessionStart', ev('SessionStart'))
    expect(sessionOf(d).branch).toBe('fix/sync-retry')
  })
})

describe('deduplication', () => {
  it('drops the second delivery of the same tool call', async () => {
    const d = await daemon()
    const p = ev('PostToolUse', { tool_name: 'Bash', tool_use_id: 'toolu_dup', tool_input: { command: 'ls' } })
    await d.hookAndDrain('PostToolUse', p)
    await d.hookAndDrain('PostToolUse', p)
    expect(d.daemon.store.countEvents(SID)).toBe(1)
    expect(d.daemon.store.countAgentEvents(SID)).toBe(1)
    expect(d.daemon.ctx.hooks.stats().duplicates).toBe(1)
    // The same tool_use_id under a different hook event is a different event.
    await d.hookAndDrain('PostToolUseFailure', { ...p, hook_event_name: 'PostToolUseFailure' })
    expect(d.daemon.store.countEvents(SID)).toBe(2)
  })

  it('does not collapse repeated events that carry no tool_use_id', async () => {
    const d = await daemon()
    await d.hookAndDrain('Stop', ev('Stop'))
    await d.hookAndDrain('Stop', ev('Stop'))
    expect(d.daemon.store.countEvents(SID)).toBe(2)
  })

  it('dedupes subagent events by agent id', async () => {
    const d = await daemon()
    const p = ev('SubagentStart', { agent_id: 'a1', agent_type: 'Explore' })
    await d.hookAndDrain('SubagentStart', p)
    await d.hookAndDrain('SubagentStart', p)
    expect(d.daemon.store.countEvents(SID)).toBe(1)
  })

  it('drops every hook event of a session the Secretary lane owns', async () => {
    const d = await daemon({ laneOptions: { backendSessionId: 'sdk-session-77' } })
    d.events.length = 0
    await d.hookAndDrain('SessionStart', ev('SessionStart', {}, 'sdk-session-77'))
    await d.hookAndDrain('PostToolUse', ev('PostToolUse', { tool_name: 'Bash', tool_use_id: 't', tool_input: { command: 'x' } }, 'sdk-session-77'))
    expect(d.daemon.store.countSessions()).toBe(0)
    expect(d.daemon.store.countEvents('sdk-session-77')).toBe(0)
    expect(d.daemon.ctx.hooks.stats().ownedDropped).toBe(2)
    expect(ofType(d.events, 'session.update')).toHaveLength(0)
    // an ordinary session next to it is unaffected
    await d.hookAndDrain('SessionStart', ev('SessionStart'))
    expect(d.daemon.store.countSessions()).toBe(1)
  })

  it('remembers lane sessions across a restart', async () => {
    const t = makeTmp()
    tmps.push(t.cleanup)
    const dbFile = join(t.dir, 'app.db')
    const first = await makeDaemon({ dataDir: t.dir, keepDir: true, config: { dbFile }, laneOptions: { backendSessionId: 'sdk-keep' } })
    await first.cleanup()
    const second = await daemon({ dataDir: t.dir, keepDir: true, config: { dbFile } })
    await second.hookAndDrain('SessionStart', ev('SessionStart', {}, 'sdk-keep'))
    expect(second.daemon.store.countSessions()).toBe(0)
  })

  it('removes a session that was projected a moment before the lane reported its id, and tells clients', async () => {
    const d = await daemon()
    await d.hookAndDrain('SessionStart', ev('SessionStart', {}, 'late-sdk-1'))
    expect(d.daemon.store.getSession('late-sdk-1')).toBeDefined()
    d.events.length = 0
    d.lane.ctx.store.saveBackendSessionId('secretary', 'late-sdk-1')
    expect(d.daemon.store.getSession('late-sdk-1')).toBeUndefined()
    expect(ofType(d.events, 'snapshot.reset')).toHaveLength(1)
    // and nothing more is projected for it
    await d.hookAndDrain('Stop', ev('Stop', {}, 'late-sdk-1'))
    expect(d.daemon.store.getSession('late-sdk-1')).toBeUndefined()
  })
})

describe('staleness', () => {
  it('marks a running session stale after the threshold, with the reason, and revives it on the next event', async () => {
    const d = await daemon()
    await d.hookAndDrain('UserPromptSubmit', ev('UserPromptSubmit', { prompt: 'go' }))
    d.clock.advance(9 * 60_000)
    expect(d.daemon.ctx.projection.sweep()).toBe(0)
    expect(sessionOf(d).status).toBe('running')

    d.events.length = 0
    d.clock.advance(2 * 60_000)
    expect(d.daemon.ctx.projection.sweep()).toBe(1)
    const s = sessionOf(d)
    expect(s.status).toBe('stale')
    expect(s.error).toMatch(/No hook events for 11 minutes/)
    expect(s.error).toMatch(/SessionEnd/)
    expect(s.agents[0]?.status).toBe('waiting')
    expect(ofType(d.events, 'session.update')[0]?.session.status).toBe('stale')
    expect(d.daemon.ctx.projection.sweep()).toBe(0) // already stale

    await d.hookAndDrain('PostToolUse', ev('PostToolUse', { tool_name: 'Read', tool_input: { file_path: 'a' } }))
    expect(sessionOf(d).status).toBe('running')
    expect(sessionOf(d).error).toBeUndefined()
  })

  it('leaves idle and waiting sessions alone for much longer, then marks them stale too', async () => {
    const d = await daemon()
    await d.hookAndDrain('SessionStart', ev('SessionStart', {}, 'idle-1'))
    await d.hookAndDrain('Notification', ev('Notification', { notification_type: 'idle_prompt', message: 'waiting' }, 'wait-1'))
    d.clock.advance(60 * 60_000)
    expect(d.daemon.ctx.projection.sweep()).toBe(0)
    d.clock.advance(6 * 3_600_000)
    expect(d.daemon.ctx.projection.sweep()).toBe(2)
    expect(sessionOf(d, 'idle-1').status).toBe('stale')
    expect(sessionOf(d, 'wait-1').error).toMatch(/hours/)
  })

  it('never touches finished sessions, and closes pending permission cards of a stale session', async () => {
    const d = await daemon()
    await d.hookAndDrain('SessionStart', ev('SessionStart', {}, 'done-1'))
    await d.hookAndDrain('SessionEnd', ev('SessionEnd', {}, 'done-1'))
    await d.hookAndDrain('PermissionRequest', ev('PermissionRequest', { tool_name: 'Bash', tool_use_id: 'x', tool_input: { command: 'ls' } }, 'blocked-1'))
    d.clock.advance(7 * 3_600_000)
    d.daemon.ctx.projection.sweep()
    expect(sessionOf(d, 'done-1').status).toBe('done')
    expect(sessionOf(d, 'blocked-1').status).toBe('stale')
    expect(d.daemon.store.pendingApprovalsForSession('blocked-1')).toHaveLength(0)
  })

  it('is driven by the injected scheduler', async () => {
    const callbacks: Array<() => void> = []
    const cleared: unknown[] = []
    const scheduler: Scheduler = {
      setInterval(fn) {
        callbacks.push(fn)
        return callbacks.length
      },
      clearInterval(h) {
        cleared.push(h)
      },
    }
    const d = await daemon({ scheduler })
    await d.hookAndDrain('UserPromptSubmit', ev('UserPromptSubmit', { prompt: 'go' }))
    d.daemon.ctx.hooks.start()
    d.daemon.ctx.hooks.start() // idempotent
    expect(callbacks).toHaveLength(1)
    d.clock.advance(15 * 60_000)
    callbacks[0]!()
    expect(sessionOf(d).status).toBe('stale')
    d.daemon.ctx.hooks.stop()
    expect(cleared).toEqual([1])
  })

  it('honours custom thresholds', async () => {
    const d = await daemon({ projection: { staleRunningMs: 60_000 } })
    await d.hookAndDrain('UserPromptSubmit', ev('UserPromptSubmit', { prompt: 'go' }))
    d.clock.advance(61_000)
    expect(d.daemon.ctx.projection.sweep()).toBe(1)
  })

  it('deletes finished sessions after the retention period', async () => {
    const d = await daemon({ projection: { retentionMs: 24 * 3_600_000 } })
    await d.hookAndDrain('SessionStart', ev('SessionStart'))
    await d.hookAndDrain('SessionEnd', ev('SessionEnd'))
    d.clock.advance(3 * 24 * 3_600_000)
    d.daemon.ctx.projection.sweep()
    expect(d.daemon.store.getSession(SID)).toBeUndefined()
    expect(d.daemon.store.countEvents(SID)).toBe(0)
  })
})

describe('redaction and retention of what hooks store', () => {
  it('never persists secrets: raw payloads, summaries and session text are masked', async () => {
    const d = await daemon()
    const secret = 'sk-ant-api03-ZZZZSECRETZZZZ0123456789'
    await d.hookAndDrain(
      'PostToolUse',
      ev('PostToolUse', {
        tool_name: 'Bash',
        tool_use_id: 'toolu_s',
        tool_input: { command: `curl -H "Authorization: Bearer ${secret}" https://api.example.com && export API_KEY=${secret}` },
        tool_response: { stdout: `ANTHROPIC_API_KEY=${secret}\n${'x'.repeat(50_000)}` },
        prompt: `use ${secret}`,
      }),
    )
    await d.hookAndDrain('UserPromptSubmit', ev('UserPromptSubmit', { prompt: `my key is ${secret} please remember it` }))
    await d.hookAndDrain('Stop', ev('Stop', { last_assistant_message: `ok, I stored ${secret}` }))
    const dump = JSON.stringify({
      raw: d.daemon.store.listEvents(SID, 50),
      events: d.daemon.store.listAgentEvents(50),
      session: d.daemon.store.getSession(SID),
    })
    expect(dump).not.toContain('ZZZZSECRET')
    const raw = d.daemon.store.listEvents(SID, 50).find((e) => e.hookEvent === 'PostToolUse')!
    expect(raw.payloadJson.length).toBeLessThan(4096)
    expect(raw.payloadJson).toContain('"chars"')
  })

  it('also masks the daemon\'s own hook token if a payload echoes it', async () => {
    const d = await daemon()
    const token = d.daemon.security.hookToken()
    await d.hookAndDrain('UserPromptSubmit', ev('UserPromptSubmit', { prompt: `the token is ${token}` }))
    expect(JSON.stringify(d.daemon.store.listAgentEvents(5))).not.toContain(token)
    expect(JSON.stringify(d.daemon.store.listEvents(SID, 5))).not.toContain(token)
  })

  it('redacts a megabyte of tool output quickly (no catastrophic backtracking)', async () => {
    const d = await daemon()
    const started = Date.now()
    await d.hookAndDrain('PostToolUse', ev('PostToolUse', { tool_name: 'Read', tool_use_id: 'big', tool_input: { file_path: 'a' }, tool_response: { content: `${'a'.repeat(1_000_000)} token ${'b'.repeat(500_000)}` } }))
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('bounds the events kept per session', async () => {
    const d = await daemon({ projection: { eventsPerSession: 5 } })
    for (let i = 0; i < 40; i++) {
      await d.hookAndDrain('PostToolUse', ev('PostToolUse', { tool_name: 'Read', tool_use_id: `t${i}`, tool_input: { file_path: `f${i}` } }))
    }
    expect(d.daemon.store.countAgentEvents(SID)).toBe(5)
    expect(d.daemon.store.listAgentEvents(10)[0]?.summary).toBe('Read f39')
    expect(d.daemon.store.countEvents(SID)).toBeLessThanOrEqual(40)
  })

  it('caps the number of sessions kept, dropping the oldest finished ones', async () => {
    const d = await daemon({ projection: { maxSessions: 3 } })
    for (let i = 0; i < 6; i++) {
      await d.hookAndDrain('SessionStart', ev('SessionStart', {}, `s${i}`))
      await d.hookAndDrain('SessionEnd', ev('SessionEnd', {}, `s${i}`))
      d.clock.advance(1000)
    }
    expect(d.daemon.store.countSessions()).toBeLessThanOrEqual(4)
    expect(d.daemon.store.getSession('s5')).toBeDefined()
  })
})

describe('snapshot with hook sessions', () => {
  it('still validates against the shared Snapshot schema and shows the live session', async () => {
    const d = await daemon()
    await d.hookAndDrain('SessionStart', ev('SessionStart', { model: 'claude-sonnet-5-5' }))
    await d.hookAndDrain('PermissionRequest', ev('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'rm -rf x' } }))
    await d.hookAndDrain('SubagentStart', ev('SubagentStart', { agent_id: 'a1', agent_type: 'Explore' }))
    const snap = await json(await d.call('/api/snapshot'))
    const parsed = Snapshot.safeParse(snap)
    if (!parsed.success) console.error(parsed.error.issues.slice(0, 5))
    expect(parsed.success).toBe(true)
    const data = parsed.data!
    expect(data.sessions).toHaveLength(1)
    expect(data.sessions[0]?.agents).toHaveLength(2)
    expect(data.projects).toHaveLength(1)
    expect(data.approvals.filter((a: Approval) => a.status === 'pending')).toHaveLength(1)
    expect(data.events.length).toBeGreaterThan(0)
  })
})

describe('summaries', () => {
  it('summarises tool calls without leaking file contents', () => {
    expect(summarizeTool('Bash', { command: 'pnpm test\nsecond line' })).toBe('Ran pnpm test')
    expect(summarizeTool('Write', { file_path: 'a.ts', content: 'SECRET BODY' })).toBe('Wrote a.ts')
    expect(summarizeTool('Edit', { file_path: 'b.ts', old_string: 'x', new_string: 'y' })).toBe('Edited b.ts')
    expect(summarizeTool('Grep', { pattern: 'upgradeWebSocket' })).toBe('Searched "upgradeWebSocket"')
    expect(summarizeTool('WebFetch', { url: 'https://example.com/x' })).toBe('Fetched https://example.com/x')
    expect(summarizeTool('Task', { description: 'Find call sites' })).toBe('Started a subagent: Find call sites')
    expect(summarizeTool('mcp__github__create_issue', {})).toBe('Called github / create_issue')
    expect(summarizeTool('Mystery', null)).toBe('Used Mystery')
    expect(summarizeTool(undefined, undefined)).toBe('Used tool')
    expect(summarizeTool('Bash', { command: 'curl -H "Authorization: Bearer abcdefghijklmnop" x' })).not.toContain('abcdefghijklmnop')
  })

  it('oneLine takes the first non-empty line, collapses whitespace and truncates', () => {
    expect(oneLine('\n\n  hello   world  \nsecond', 50)).toBe('hello world')
    expect(oneLine('x'.repeat(500), 20)).toContain('+480 chars')
    expect(oneLine(undefined, 10)).toBe('')
    expect(oneLine(42, 10)).toBe('')
  })
})
