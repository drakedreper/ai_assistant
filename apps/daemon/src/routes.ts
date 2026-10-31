import type { Hono } from 'hono'
import type { Context } from 'hono'
import type { ZodType } from 'zod'
import { z } from 'zod'
import {
  AuthExchangeRequest,
  ChatRequest,
  ClaudeModeRequest,
  DaemonRoutes,
  DecisionRequest,
  OnOffRequest,
  PersonaPatchRequest,
  Snapshot,
  TaskCreateRequest,
  TrustModeRequest,
  TaskColumn,
  type DaemonHealth,
} from '@ai-assistant/shared'
import { Commands } from './commands'
import { HttpError, type DaemonContext } from './context'
import { redactText } from './store/redact'

/** Hook bodies above this are dropped (still answered 200 so Claude Code never waits or fails). */
export const MAX_HOOK_BODY = 8 * 1024 * 1024
const MAX_API_BODY = 512 * 1024

/** Task edits beyond a column move (the shared TaskMoveRequest only carries the column). */
export const TaskPatchRequest = z
  .object({
    column: TaskColumn.optional(),
    title: z.string().min(1).max(200).optional(),
    description: z.string().max(4000).optional(),
    priority: z.enum(['low', 'medium', 'high']).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field' })

/** Read a request body as text, giving up (null) once it exceeds `max` bytes, even without a Content-Length. */
async function readCapped(req: Request, max: number): Promise<string | null> {
  if (!req.body) return ''
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Cap request bodies on /api/*. Hono's own bodyLimit rebuilds the Request when there is no Content-Length, and that
 * throws on the node adapter's request object (a bare DELETE from a browser, or any chunked upload, became a 500).
 * This version never rebuilds anything: a declared length is checked as is, no body passes, and a body without a
 * declared length is read under the cap and handed back through Hono's body cache for c.req.json() and text().
 */
async function limitApiBody(c: Context, next: () => Promise<void>): Promise<Response | void> {
  const tooLarge = () => c.json({ error: 'payload_too_large', message: 'Request body is too large' }, 413)
  const declared = c.req.header('content-length')
  if (declared !== undefined) {
    if (Number(declared) > MAX_API_BODY) return tooLarge()
    return next()
  }
  if (!c.req.raw.body) return next()
  const text = await readCapped(c.req.raw, MAX_API_BODY)
  if (text === null) return tooLarge()
  // Hono keeps the pending read in bodyCache (typed as the value, stored as a promise); json() and text() reuse it.
  ;(c.req.bodyCache as Record<string, unknown>).text = Promise.resolve(text)
  return next()
}

async function parseBody<T>(c: Context, schema: ZodType<T>): Promise<T> {
  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    throw new HttpError(400, 'invalid_json', 'The request body is not valid JSON')
  }
  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    throw new HttpError(
      400,
      'invalid_request',
      'The request body does not match the expected shape',
      parsed.error.issues.slice(0, 8).map((i) => ({ path: i.path.join('.'), message: i.message })),
    )
  }
  return parsed.data
}

/** Browser-facing REST routes, the exchange route and the hook receiver. Guards run before any of these. */
export function registerRoutes(app: Hono, ctx: DaemonContext, commands: Commands = new Commands(ctx)): void {
  app.use('/api/*', limitApiBody)

  // ---------------------------------------------------------------- open: exchange the one-time code for a cookie
  app.post(DaemonRoutes.authExchange, async (c) => {
    const { code } = await parseBody(c, AuthExchangeRequest)
    const result = ctx.security.exchange(code)
    if (!result.ok) {
      if (result.reason === 'rate_limited') {
        c.header('Retry-After', String(result.retryAfterSec ?? 60))
        return c.json({ error: 'rate_limited', message: 'Too many failed attempts, wait and retry' }, 429)
      }
      return c.json({ error: 'invalid_code', message: 'That sign-in code is invalid, expired or already used' }, 401)
    }
    c.header('Set-Cookie', ctx.security.setCookieHeader(result.token, result.maxAgeSec))
    ctx.store.insertAudit({ id: ctx.newId('au'), at: ctx.now().toISOString(), actor: 'you', action: 'Signed in from a browser', target: 'Local daemon', outcome: 'auto' })
    return c.json({ ok: true })
  })

  // ---------------------------------------------------------------- reads
  app.get(DaemonRoutes.health, (c) => {
    const stats = ctx.hooks.stats()
    const body: DaemonHealth = {
      ok: true,
      version: ctx.config.version,
      epoch: ctx.bus.epoch,
      uptimeSec: Math.max(0, Math.round((ctx.clock() - ctx.startedAt) / 1000)),
      backend: ctx.config.backend,
      lane: ctx.lane.status().state,
      hooksReceived: stats.received,
      lastHookAt: stats.lastAt,
      sessions: ctx.store.countSessions(),
      dataDir: ctx.config.dataDir,
    }
    c.header('X-Daemon-Epoch', ctx.bus.epoch)
    return c.json(body)
  })

  app.get(DaemonRoutes.snapshot, (c) => {
    const snap: Snapshot = ctx.snapshots.build()
    c.header('X-Daemon-Epoch', ctx.bus.epoch)
    return c.json(snap)
  })

  // A plain GET to the WebSocket path (no Upgrade) is a client mistake.
  app.get(DaemonRoutes.ws, (c) => c.json({ error: 'upgrade_required', message: 'Use a WebSocket connection' }, 426))

  // ---------------------------------------------------------------- chat
  app.post(DaemonRoutes.chat, async (c) => {
    const body = await parseBody(c, ChatRequest)
    await commands.sendChat(body)
    return c.json({ accepted: true }, 202)
  })
  app.post(DaemonRoutes.chatInterrupt, async (c) => {
    await commands.interruptChat()
    return c.json({ ok: true }, 202)
  })

  // ---------------------------------------------------------------- decisions
  app.post('/api/approvals/:id/decision', async (c) => {
    const { decision } = await parseBody(c, DecisionRequest)
    return c.json(commands.decideApproval(c.req.param('id'), decision))
  })
  app.post('/api/proposals/:id/decision', async (c) => {
    const { decision } = await parseBody(c, DecisionRequest)
    return c.json(commands.decideProposal(c.req.param('id'), decision))
  })

  // ---------------------------------------------------------------- tasks
  app.get(DaemonRoutes.tasks, (c) => c.json(commands.listTasks()))
  app.post(DaemonRoutes.tasks, async (c) => c.json(commands.createTask(await parseBody(c, TaskCreateRequest)), 201))
  // Column moves arrive as PATCH (ARCHITECTURE section 8); PUT is accepted as the same operation.
  app.on(['PATCH', 'PUT'], '/api/tasks/:id', async (c) => {
    const body = await parseBody(c, TaskPatchRequest)
    return c.json(commands.patchTask(c.req.param('id'), body))
  })
  app.delete('/api/tasks/:id', (c) => {
    commands.deleteTask(c.req.param('id'))
    return c.body(null, 204)
  })

  // ---------------------------------------------------------------- settings (PUT; POST is accepted as an alias)
  app.on(['PUT', 'POST'], '/api/settings/trust/:ruleId', async (c) => {
    const { mode } = await parseBody(c, TrustModeRequest)
    commands.setTrustMode(c.req.param('ruleId'), mode)
    return c.json({ ok: true })
  })
  app.on(['PUT', 'POST'], DaemonRoutes.claudeMode, async (c) => {
    const { mode } = await parseBody(c, ClaudeModeRequest)
    commands.setClaudeMode(mode)
    return c.json({ ok: true })
  })
  app.on(['PUT', 'POST'], DaemonRoutes.guestMode, async (c) => {
    const { on } = await parseBody(c, OnOffRequest)
    commands.setGuestMode(on)
    return c.json({ ok: true })
  })
  app.on(['PUT', 'POST'], DaemonRoutes.webcam, async (c) => {
    const { on } = await parseBody(c, OnOffRequest)
    commands.setWebcam(on)
    return c.json({ ok: true })
  })
  app.on(['PUT', 'POST'], DaemonRoutes.persona, async (c) => {
    const patch = await parseBody(c, PersonaPatchRequest)
    return c.json(commands.patchPersona(patch))
  })
  app.delete('/api/learned/:id', (c) => {
    commands.forgetFact(c.req.param('id'))
    return c.body(null, 204)
  })

  // ---------------------------------------------------------------- Claude Code hooks (bearer hook token only)
  app.post('/hooks/:event', async (c) => {
    const declared = Number(c.req.header('content-length') ?? 0)
    if (declared > MAX_HOOK_BODY) {
      ctx.hooks.counters.dropped++
      return c.json({})
    }
    let body: string | null = ''
    try {
      body = await readCapped(c.req.raw, MAX_HOOK_BODY)
    } catch {
      body = ''
    }
    // Fail open: answer 200 {} now, project later. Nothing below can delay or fail the hook.
    if (body === null) ctx.hooks.counters.dropped++
    else ctx.hooks.enqueue(c.req.param('event'), body)
    return c.json({})
  })

  // ---------------------------------------------------------------- errors
  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ error: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) }, err.status)
    }
    ctx.log.error('unhandled error in route', { path: c.req.path, error: redactText(err instanceof Error ? err.message : 'unknown', 200) })
    return c.json({ error: 'internal_error', message: 'Something went wrong in the daemon' }, 500)
  })
  app.notFound((c) => c.json({ error: 'not_found', message: 'No such route' }, 404))
}
