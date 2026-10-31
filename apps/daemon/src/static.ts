import { readFile, realpath, stat } from 'node:fs/promises'
import * as nodePath from 'node:path'
import type { Context } from 'hono'
import { classify } from './http/guards'
import type { Security } from './security'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.vrm': 'model/gltf-binary',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.webmanifest': 'application/manifest+json',
}

const PLACEHOLDER_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Mira daemon</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;background:#0b0d17;color:#e5e7eb}code{background:#1f2937;padding:.1rem .3rem;border-radius:.25rem}</style></head>
<body><h1>The daemon is running</h1>
<p>The web UI has not been built yet, so there is nothing to show here.</p>
<p>Build it with <code>pnpm --filter @ai-assistant/web build</code> and restart the daemon, or run the Vite dev server
(<code>pnpm dev</code>), which proxies <code>/api</code>, <code>/ws</code> to this daemon.</p></body></html>`

/** True when `child` is `root` or inside it. Windows paths compare case-insensitively. */
export function isInside(root: string, child: string): boolean {
  const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p)
  const r = norm(root)
  const c = norm(child)
  return c === r || c.startsWith(r.endsWith(nodePath.sep) ? r : r + nodePath.sep)
}

export type StaticHandler = (c: Context) => Promise<Response>

/**
 * Serves apps/web/dist with SPA fallback. Never serves anything outside the dist directory: the path is decoded,
 * backslashes are treated as separators, resolved against the root, and re-checked after symlinks are resolved.
 */
export function createStaticHandler(opts: { root: string | undefined; security: Security }): StaticHandler {
  const root = opts.root ? nodePath.resolve(opts.root) : undefined
  let realRoot: string | undefined

  const withCsp = (headers: Record<string, string>, type: string): Record<string, string> => {
    if (type.startsWith('text/html')) headers['Content-Security-Policy'] = opts.security.csp()
    return headers
  }

  return async (c) => {
    if (classify(c.req.path) !== 'static') return c.notFound()
    const head = c.req.method === 'HEAD'

    if (!root) {
      if (c.req.path === '/') {
        const headers = withCsp({ 'Content-Type': MIME['.html'] as string, 'Cache-Control': 'no-cache' }, 'text/html')
        return new Response(head ? null : PLACEHOLDER_HTML, { status: 200, headers })
      }
      return c.json({ error: 'not_found', message: 'The web UI is not built' }, 404)
    }

    let decoded: string
    try {
      decoded = decodeURIComponent(new URL(c.req.url).pathname)
    } catch {
      return c.json({ error: 'bad_request', message: 'Malformed path' }, 400)
    }
    if (decoded.includes('\0')) return c.json({ error: 'bad_request', message: 'Malformed path' }, 400)

    const rel = decoded.replace(/\\/g, '/').replace(/^\/+/, '')
    let target = nodePath.resolve(root, rel)
    if (!isInside(root, target)) return c.json({ error: 'not_found', message: 'No such file' }, 404)

    try {
      realRoot ??= await realpath(root)
      let info = await stat(target).catch(() => undefined)
      if (info?.isDirectory()) {
        target = nodePath.join(target, 'index.html')
        info = await stat(target).catch(() => undefined)
      }
      if (!info?.isFile()) {
        // SPA fallback: a navigation to a client-side route (no file extension, HTML accepted) gets index.html.
        const hasExt = nodePath.extname(rel) !== ''
        const wantsHtml = (c.req.header('accept') ?? '').includes('text/html')
        if (hasExt || !wantsHtml) return c.json({ error: 'not_found', message: 'No such file' }, 404)
        target = nodePath.join(root, 'index.html')
        info = await stat(target).catch(() => undefined)
        if (!info?.isFile()) return c.json({ error: 'not_found', message: 'The web UI is not built' }, 404)
      }
      // A symlink inside dist must not lead outside it.
      const real = await realpath(target)
      if (!isInside(realRoot, real)) return c.json({ error: 'not_found', message: 'No such file' }, 404)

      const type = MIME[nodePath.extname(real).toLowerCase()] ?? 'application/octet-stream'
      const immutable = /^\/assets\//.test(c.req.path) && type !== MIME['.html']
      const headers = withCsp(
        {
          'Content-Type': type,
          'Content-Length': String(info.size),
          'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
        },
        type,
      )
      if (head) return new Response(null, { status: 200, headers })
      const body = await readFile(real)
      return new Response(new Uint8Array(body), { status: 200, headers })
    } catch {
      return c.json({ error: 'not_found', message: 'No such file' }, 404)
    }
  }
}
