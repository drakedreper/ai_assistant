import type { Context, Hono } from 'hono'
import type { ZodType } from 'zod'
import { DaemonRoutes, OnOffRequest, TerminalCreateRequest, type TerminalTicketResponse } from '@ai-assistant/shared'
import type { Security } from '../security'
import { sessionKeyOf, type TicketStore } from './tickets'
import { TerminalError, type TerminalService } from './service'

/**
 * REST routes of the embedded terminals. They are registered AFTER the global guards run, so every one of them has
 * already passed Host, Origin (required on POST and DELETE), the JSON content-type rule and the session cookie check
 * (src/http/guards.ts treats /api/terminals as a browser route). On top of that, every route except the on/off
 * switch answers 403 `terminals_disabled` until the user has switched terminals on.
 */

export interface TerminalRouteDeps {
  service: TerminalService
  tickets: TicketStore
  security: Security
  enabled: () => boolean
  setEnabled: (on: boolean) => Promise<void>
  /** Terminals answer to the daemon's own origin only (and the dev origins when explicitly allowed). */
  originAllowed: (origin: string | undefined) => boolean
}

const DISABLED = 'Embedded terminals are switched off. Turn them on in Settings, Privacy.'
export const FOREIGN_ORIGIN = 'Terminals can only be used from the daemon\'s own address (http://127.0.0.1:PORT or http://localhost:PORT), not from another web page or dev server.'

function fail(c: Context, status: number, code: string, message: string, details?: unknown): Response {
  return c.json({ error: code, message, ...(details !== undefined ? { details } : {}) }, status as 400)
}

async function readBody<T>(c: Context, schema: ZodType<T>, optional = false): Promise<{ ok: true; data: T } | { ok: false; res: Response }> {
  let raw: unknown
  try {
    const text = await c.req.text()
    raw = text.trim() === '' && optional ? {} : JSON.parse(text)
  } catch {
    return { ok: false, res: fail(c, 400, 'invalid_json', 'The request body is not valid JSON') }
  }
  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    return {
      ok: false,
      res: fail(
        c,
        400,
        'invalid_request',
        'The request body does not match the expected shape',
        parsed.error.issues.slice(0, 8).map((i) => ({ path: i.path.join('.'), message: i.message })),
      ),
    }
  }
  return { ok: true, data: parsed.data }
}

function errorResponse(c: Context, err: unknown): Response {
  if (err instanceof TerminalError) return fail(c, err.status, err.code, err.message)
  throw err
}

export function registerTerminalRoutes(app: Hono, deps: TerminalRouteDeps): void {
  const { service, tickets, security } = deps
  // The origin rule comes first (even for the switch), then the on/off gate.
  const foreign = (c: Context): Response | undefined => (deps.originAllowed(c.req.header('origin')) ? undefined : fail(c, 403, 'forbidden_origin', FOREIGN_ORIGIN))
  const gated = (c: Context): Response | undefined => foreign(c) ?? (deps.enabled() ? undefined : fail(c, 403, 'terminals_disabled', DISABLED))

  app.get(DaemonRoutes.terminals, (c) => gated(c) ?? c.json(service.list()))

  app.post(DaemonRoutes.terminals, async (c) => {
    const g = gated(c)
    if (g) return g
    const body = await readBody(c, TerminalCreateRequest)
    if (!body.ok) return body.res
    try {
      return c.json(await service.create(body.data), 201)
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  app.get('/api/terminals/:id', (c) => {
    const g = gated(c)
    if (g) return g
    const info = service.get(c.req.param('id'))
    return info ? c.json(info) : fail(c, 404, 'not_found', 'No such terminal.')
  })

  app.delete('/api/terminals/:id', async (c) => {
    const g = gated(c)
    if (g) return g
    try {
      await service.close(c.req.param('id'), 'user')
      return c.body(null, 204)
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  // A single-use, short-lived, terminal-bound ticket for the WebSocket's first frame (see tickets.ts).
  app.post('/api/terminals/:id/ticket', async (c) => {
    const g = gated(c)
    if (g) return g
    const id = c.req.param('id')
    if (!service.get(id)) return fail(c, 404, 'not_found', 'No such terminal.')
    const cookie = security.parseSessionCookie(c.req.header('cookie'))
    if (!cookie) return fail(c, 401, 'unauthorized', 'Sign in required')
    const minted = tickets.mint({ terminalId: id, sessionKey: sessionKeyOf(cookie) })
    const body: TerminalTicketResponse = { ticket: minted.ticket, expiresInSec: minted.expiresInSec }
    return c.json(body)
  })

  // A plain GET to the WebSocket path (no Upgrade) is a client mistake.
  app.get('/ws/terminal/:id', (c) => gated(c) ?? fail(c, 426, 'upgrade_required', 'Use a WebSocket connection'))

  // The switch itself. PUT, with POST accepted as an alias like the other settings routes.
  app.on(['PUT', 'POST'], DaemonRoutes.terminalsEnabled, async (c) => {
    const refused = foreign(c)
    if (refused) return refused
    const body = await readBody(c, OnOffRequest)
    if (!body.ok) return body.res
    await deps.setEnabled(body.data.on)
    return c.json({ ok: true, enabled: deps.enabled() })
  })
}
