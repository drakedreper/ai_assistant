import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isInside } from '../src/static'
import { json, makeDaemon, makeTmp, type TestDaemon } from './helpers'

const open: TestDaemon[] = []
const tmps: Array<() => void> = []
afterEach(async () => {
  for (const d of open.splice(0)) await d.cleanup()
  for (const c of tmps.splice(0)) c()
})

const SECRET = 'TOP-SECRET-OUTSIDE-DIST'

/** <tmp>/dist (served) next to <tmp>/secret.txt and <tmp>/dist-evil (not served, shares the name prefix). */
async function withDist(): Promise<{ d: TestDaemon; root: string; dist: string }> {
  const t = makeTmp()
  tmps.push(t.cleanup)
  const dist = join(t.dir, 'dist')
  mkdirSync(join(dist, 'assets'), { recursive: true })
  mkdirSync(join(dist, 'sub'), { recursive: true })
  mkdirSync(join(t.dir, 'dist-evil'), { recursive: true })
  writeFileSync(join(dist, 'index.html'), '<!doctype html><html><head><title>Mira</title><script type="module" src="/assets/app-abc123.js"></script></head><body><div id="root"></div></body></html>')
  writeFileSync(join(dist, 'assets', 'app-abc123.js'), 'console.log("app")')
  writeFileSync(join(dist, 'assets', 'style-def456.css'), 'body{color:red}')
  writeFileSync(join(dist, 'assets', 'model.vrm'), 'vrm-bytes')
  writeFileSync(join(dist, 'sub', 'index.html'), '<html>sub index</html>')
  writeFileSync(join(t.dir, 'secret.txt'), SECRET)
  writeFileSync(join(t.dir, 'dist-evil', 'secret.txt'), SECRET)
  const d = await makeDaemon({ config: { webDist: dist } })
  open.push(d)
  return { d, root: t.dir, dist }
}

const html = { accept: 'text/html,application/xhtml+xml' }

describe('static serving', () => {
  it('serves index.html at / with the strict CSP and no-cache', async () => {
    const { d } = await withDist()
    const res = await d.call('/', { cookie: false, headers: html })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(res.headers.get('cache-control')).toBe('no-cache')
    expect(await res.text()).toContain('<div id="root">')
    const csp = res.headers.get('content-security-policy') ?? ''
    expect(csp).toBe(d.daemon.security.csp())
    for (const part of [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "connect-src 'self' ws://127.0.0.1:7421 ws://localhost:7421",
      "img-src 'self' data: blob:",
      "worker-src 'self' blob:",
      "frame-ancestors 'none'",
      "base-uri 'none'",
    ]) {
      expect(csp).toContain(part)
    }
    expect(res.headers.get('x-frame-options')).toBe('DENY')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('needs no login for the app shell (the bundle holds no secrets), but API routes still do', async () => {
    const { d } = await withDist()
    expect((await d.call('/', { cookie: false })).status).toBe(200)
    expect((await d.call('/api/snapshot', { cookie: false })).status).toBe(401)
  })

  it('serves assets with their type and long immutable caching, without a CSP on non-HTML', async () => {
    const { d } = await withDist()
    const js = await d.call('/assets/app-abc123.js')
    expect(js.status).toBe(200)
    expect(js.headers.get('content-type')).toContain('text/javascript')
    expect(js.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(js.headers.get('content-security-policy')).toBeNull()
    expect(await js.text()).toBe('console.log("app")')
    const css = await d.call('/assets/style-def456.css')
    expect(css.headers.get('content-type')).toContain('text/css')
    expect((await d.call('/assets/model.vrm')).headers.get('content-type')).toBe('model/gltf-binary')
  })

  it('falls back to index.html for client-side routes that a browser navigates to', async () => {
    const { d } = await withDist()
    for (const path of ['/brain', '/work/sessions/s-1', '/settings']) {
      const res = await d.call(path, { headers: html })
      expect(res.status, path).toBe(200)
      expect(await res.text()).toContain('<div id="root">')
    }
  })

  it('does not fall back for missing files or for non-HTML requests', async () => {
    const { d } = await withDist()
    expect((await d.call('/assets/missing.js', { headers: html })).status).toBe(404)
    expect((await d.call('/missing.png', { headers: html })).status).toBe(404)
    expect((await d.call('/brain', { headers: { accept: 'application/json' } })).status).toBe(404)
    expect((await d.call('/brain')).status).toBe(404)
  })

  it('serves a directory index and answers HEAD without a body', async () => {
    const { d } = await withDist()
    expect(await (await d.call('/sub/')).text()).toBe('<html>sub index</html>')
    const head = await d.call('/assets/app-abc123.js', { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(Number(head.headers.get('content-length'))).toBe('console.log("app")'.length)
    expect(await head.text()).toBe('')
  })

  it('never routes /api, /hooks or /ws paths to the SPA fallback', async () => {
    const { d } = await withDist()
    const res = await d.call('/api/nothing', { headers: html })
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toContain('application/json')
  })

  it('applies the Host check to static files too', async () => {
    const { d } = await withDist()
    expect((await d.call('/', { host: 'evil.example.com' })).status).toBe(403)
    expect((await d.call('/assets/app-abc123.js', { host: 'evil.example.com' })).status).toBe(403)
  })

  it('does not accept writes on static paths', async () => {
    const { d } = await withDist()
    const res = await d.call('/index.html', { method: 'POST', json: {} })
    expect(res.status).toBe(405)
    expect((await d.call('/index.html', { method: 'PUT', json: {}, origin: false })).status).toBe(403)
  })
})

describe('path traversal', () => {
  const attempts = [
    '/../secret.txt',
    '/..%2fsecret.txt',
    '/%2e%2e/secret.txt',
    '/%2e%2e%2fsecret.txt',
    '/%2E%2E%2Fsecret.txt',
    '/..%5csecret.txt',
    '/..\\secret.txt',
    '/assets/../../secret.txt',
    '/assets/..%2f..%2fsecret.txt',
    '/assets/%2e%2e/%2e%2e/secret.txt',
    '/%252e%252e/secret.txt',
    '/..%c0%afsecret.txt',
    '/../dist-evil/secret.txt',
    '/..%2fdist-evil%2fsecret.txt',
    '/index.html%00.png',
    '/%00',
    '/assets/app-abc123.js%00../../secret.txt',
    '//secret.txt',
    '/./../secret.txt',
  ]

  it.each(attempts)('never serves files outside dist: %s', async (path) => {
    const { d } = await withDist()
    for (const accept of [html, {}]) {
      const res = await d.call(path, { headers: accept })
      const body = await res.text()
      expect(body, `${path} leaked`).not.toContain(SECRET)
      // Either refused, or (for SPA-style navigations) answered with the app shell: never the outside file.
      expect([200, 400, 403, 404], `${path}: ${res.status}`).toContain(res.status)
      if (res.status === 200) expect(body).toContain('<div id="root">')
    }
  })

  it('does not follow a symlink that points outside dist', async () => {
    const { d, root, dist } = await withDist()
    try {
      symlinkSync(join(root, 'secret.txt'), join(dist, 'assets', 'link.txt'))
    } catch {
      return // symlinks need privileges on Windows; nothing to test there
    }
    const res = await d.call('/assets/link.txt')
    expect(res.status).toBe(404)
    expect(await res.text()).not.toContain(SECRET)
  })

  it('isInside is strict about sibling directories that share a prefix', () => {
    expect(isInside('/srv/dist', '/srv/dist')).toBe(true)
    expect(isInside('/srv/dist', '/srv/dist/a/b')).toBe(true)
    expect(isInside('/srv/dist', '/srv/dist-evil/a')).toBe(false)
    expect(isInside('/srv/dist', '/srv')).toBe(false)
    expect(isInside('/srv/dist/', '/srv/dist/a')).toBe(true)
  })
})

describe('path traversal over a real socket', () => {
  function rawGet(port: number, path: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      // node:http sends the path exactly as written (no URL normalisation on the client side).
      const req = httpRequest({ host: '127.0.0.1', port, method: 'GET', path, headers: { Accept: 'text/html' } }, (res) => {
        let body = ''
        res.on('data', (c) => (body += c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      })
      req.on('error', reject)
      req.end()
    })
  }

  it.each(['/../secret.txt', '/..%2fsecret.txt', '/%2e%2e/%2e%2e/secret.txt', '/assets/../../secret.txt', '/..%5c..%5csecret.txt', '/....//secret.txt'])('%s', async (path) => {
    const t = makeTmp()
    tmps.push(t.cleanup)
    const dist = join(t.dir, 'dist')
    mkdirSync(dist, { recursive: true })
    writeFileSync(join(dist, 'index.html'), '<div id="root"></div>')
    writeFileSync(join(t.dir, 'secret.txt'), SECRET)
    const d = await makeDaemon({ signIn: false, config: { port: 0, webDist: dist } })
    open.push(d)
    const info = await d.daemon.start()
    const res = await rawGet(info.port, path)
    expect(res.body).not.toContain(SECRET)
    expect([200, 400, 403, 404]).toContain(res.status)
  })
})

describe('without a built web UI', () => {
  it('shows a placeholder page at / (with the CSP) and 404s everything else', async () => {
    const d = await makeDaemon({ signIn: false })
    open.push(d)
    const res = await d.call('/', { headers: html })
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('not been built')
    expect(res.headers.get('content-security-policy')).toBe(d.daemon.security.csp())
    expect((await d.call('/assets/x.js')).status).toBe(404)
    expect((await json(await d.call('/whatever', { headers: html }))).error).toBe('not_found')
    expect((await d.call('/', { method: 'HEAD' })).status).toBe(200)
  })
})
