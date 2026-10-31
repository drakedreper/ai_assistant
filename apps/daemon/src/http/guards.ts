import type { Context, MiddlewareHandler } from 'hono'
import { DaemonRoutes } from '@ai-assistant/shared'
import type { Logger } from '../log'
import type { Security, Verdict } from '../security'

export type RouteClass = 'hook' | 'exchange' | 'browser' | 'static'

/** Which authentication regime a path falls under. */
export function classify(path: string): RouteClass {
  if (path === '/hooks' || path.startsWith('/hooks/')) return 'hook'
  if (path === DaemonRoutes.authExchange) return 'exchange'
  if (path === '/api' || path.startsWith('/api/') || path === DaemonRoutes.ws) return 'browser'
  // A plain HTTP request to a terminal socket path needs the cookie like any browser route (the real upgrade is
  // checked in src/terminal/ws.ts, which never goes through this middleware).
  if (path.startsWith('/ws/terminal/')) return 'browser'
  return 'static'
}

function isJsonContentType(ct: string | undefined): boolean {
  if (!ct) return false
  return (ct.split(';')[0] ?? '').trim().toLowerCase() === 'application/json'
}

function hasBody(c: Context): boolean {
  const len = c.req.header('content-length')
  if (len !== undefined && Number(len) > 0) return true
  return c.req.header('transfer-encoding') !== undefined
}

export function reject(c: Context, v: Extract<Verdict, { ok: false }>, extra?: Record<string, string>): Response {
  if (extra) for (const [k, val] of Object.entries(extra)) c.header(k, val)
  return c.json({ error: v.code, message: v.message }, v.status)
}

/**
 * Headers for every response. No CORS headers are ever added: the browser app is same-origin (the Vite dev server
 * proxies), so there is no cross-origin reader to allow.
 */
export function securityHeaders(): MiddlewareHandler {
  return async (c, next) => {
    await next()
    const h = c.res.headers
    h.set('X-Content-Type-Options', 'nosniff')
    h.set('X-Frame-Options', 'DENY')
    h.set('Referrer-Policy', 'no-referrer')
    h.set('Cross-Origin-Opener-Policy', 'same-origin')
    h.set('Cross-Origin-Resource-Policy', 'same-origin')
    h.set('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=(), payment=(), usb=()')
    if (classify(c.req.path) !== 'static') {
      h.set('Cache-Control', 'no-store')
      if (!h.has('Content-Security-Policy')) h.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'")
    }
  }
}

/**
 * The request gate, in a fixed order:
 *   1. Host must be exactly 127.0.0.1:PORT or localhost:PORT (DNS rebinding)        -> 403
 *   2. Origin: absent only for safe (GET/HEAD) requests and for bearer-authenticated hooks;
 *      otherwise it must be in the allowlist                                          -> 403
 *   3. Mutating browser routes need Content-Type: application/json                   -> 415
 *   4. Browser routes need a valid session cookie; the hook route accepts ONLY the
 *      bearer hook token (a cookie is ignored there, the hook token is ignored on
 *      browser routes)                                                               -> 401
 */
export function guards(security: Security, log: Logger): MiddlewareHandler {
  return async (c, next) => {
    const method = c.req.method.toUpperCase()
    const cls = classify(c.req.path)
    const safe = method === 'GET' || method === 'HEAD'

    const host = security.checkHost(c.req.header('host'))
    if (!host.ok) {
      log.warn('rejected request: bad host', { path: c.req.path })
      return reject(c, host)
    }

    const origin = security.checkOrigin(c.req.header('origin'), !safe && cls !== 'hook')
    if (!origin.ok) {
      log.warn('rejected request: bad origin', { path: c.req.path, method })
      return reject(c, origin)
    }

    // The hook route skips the content-type rule: its auth is a bearer token (no ambient credentials, so no CSRF),
    // and the exact headers Claude Code sends were not verified against a live client.
    if (!safe && method !== 'OPTIONS' && cls !== 'hook') {
      const ct = c.req.header('content-type')
      const okType = isJsonContentType(ct) || (ct === undefined && !hasBody(c))
      if (!okType) return reject(c, { ok: false, status: 415, code: 'unsupported_media_type', message: 'Content-Type must be application/json' })
    }

    switch (cls) {
      case 'browser': {
        const v = security.checkSessionCookie(c.req.header('cookie'))
        if (!v.ok) return reject(c, v)
        break
      }
      case 'hook': {
        if (!security.verifyHookToken(c.req.header('authorization'))) {
          return reject(c, { ok: false, status: 401, code: 'unauthorized', message: 'Bearer hook token required' })
        }
        break
      }
      case 'static':
        if (!safe) return c.json({ error: 'method_not_allowed', message: 'Only GET and HEAD are served here' }, 405)
        break
      case 'exchange':
        break
    }
    await next()
    return undefined
  }
}
