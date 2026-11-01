import { mkdtempSync, rmSync } from 'node:fs'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { formatBanner, type BannerInfo } from '../src/banner'
import { describeConfig, loadConfig } from '../src/config'
import { classifyPeer, type PeerClass } from '../src/net/peer'
import { makeStageDaemon, type StageDaemon } from '../src/stage/testing'

const ctx = { platform: 'linux' as const, homedir: '/home/test', exists: () => false, moduleDir: '/nowhere' }
const cfg = (env: Record<string, string>) => loadConfig({ DATA_DIR: '/tmp/mira-test', ...env }, ctx)

describe('container mode: the one switch that moves the listening address', () => {
  it('is off by default: loopback only, as before', () => {
    const c = cfg({})
    expect(c.host).toBe('127.0.0.1')
    expect(c.containerMode).toBe(false)
    expect(describeConfig(c)).toMatchObject({ host: '127.0.0.1', containerMode: false })
  })

  it('MIRA_CONTAINER=1 listens on the container interface; 0, empty and nonsense stay on loopback', () => {
    for (const on of ['1', 'true', 'yes', 'on', ' TRUE ']) {
      const c = cfg({ MIRA_CONTAINER: on })
      expect(c.host, on).toBe('0.0.0.0')
      expect(c.containerMode, on).toBe(true)
    }
    for (const off of ['0', 'false', 'no', 'off', '', 'maybe', '2']) {
      const c = cfg({ MIRA_CONTAINER: off })
      expect(c.host, off).toBe('127.0.0.1')
      expect(c.containerMode, off).toBe(false)
    }
  })

  it('no other setting can move it: DAEMON_HOST, DAEMON_BIND, HOST and BIND_ADDRESS are not read at all', () => {
    const c = cfg({ DAEMON_HOST: '0.0.0.0', DAEMON_BIND: '0.0.0.0', HOST: '0.0.0.0', HOSTNAME: '0.0.0.0', BIND_ADDRESS: '0.0.0.0', DAEMON_ADDRESS: '::' })
    expect(c.host).toBe('127.0.0.1')
    expect(c.containerMode).toBe(false)
  })
})

describe('container mode: what the banner says', () => {
  const info: BannerInfo = {
    version: '0.0.0',
    port: 7421,
    exchangeUrl: 'http://127.0.0.1:7421/?code=abc',
    exchangeTtlMinutes: 15,
    dataDir: '/data',
    backend: 'fake',
    authMode: 'api-key',
    apiKeyPresent: false,
    demo: false,
    webBuilt: true,
  }
  const text = (extra: Partial<BannerInfo>) => formatBanner({ ...info, ...extra }).join('\n')

  it('says "loopback only" outside a container, exactly as before', () => {
    expect(text({})).toContain('(loopback only)')
    expect(text({ containerMode: false })).toContain('(loopback only)')
    expect(text({})).not.toMatch(/container/i)
  })

  it('in container mode says what that means and that the port must be published on 127.0.0.1 only', () => {
    const t = text({ containerMode: true, containerDetected: true })
    expect(t).not.toContain('(loopback only)')
    expect(t).toContain('container mode')
    expect(t).toContain('127.0.0.1:PORT:PORT')
    expect(t).not.toContain('WARNING')
    expect(t).toContain('http://127.0.0.1:7421/?code=abc') // the link a browser on the host uses stays on 127.0.0.1
  })

  it('warns when container mode is on but nothing says this is a container (the daemon would be reachable from the network)', () => {
    expect(text({ containerMode: true, containerDetected: false })).toContain('WARNING: MIRA_CONTAINER=1 but this does not look like a container')
    expect(text({ containerMode: true })).not.toContain('WARNING')
  })
})

// ---- real sockets: a real listening daemon, reached the way Docker reaches a container (from a non-loopback address) ----

const localIPv4s = (): Array<{ address: string; cls: PeerClass }> => {
  const out: Array<{ address: string; cls: PeerClass }> = []
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4') out.push({ address: a.address, cls: classifyPeer(a.address) })
  }
  return out.filter((a) => a.cls !== 'loopback')
}

type Attempt = { status: number; code: string } | { open: WebSocket } | { unreachable: string }

/** One WebSocket upgrade to `address`, sending the Host header a browser or engine on the host would send (127.0.0.1:PORT). */
function attempt(address: string, d: StageDaemon): Promise<Attempt> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://${address}:${d.port}/ws/stage`, {
      headers: { Host: `127.0.0.1:${d.port}`, Authorization: `Bearer ${d.stageToken}` },
      perMessageDeflate: false,
      handshakeTimeout: 4000,
    })
    ws.once('unexpected-response', (_req, res) => {
      let body = ''
      res.on('data', (c: Buffer) => (body += c.toString()))
      res.on('end', () => {
        ws.terminate()
        resolve({ status: res.statusCode ?? 0, code: (JSON.parse(body || '{}') as { error?: string }).error ?? '' })
      })
    })
    ws.once('open', () => resolve({ open: ws }))
    ws.on('error', (err) => resolve({ unreachable: (err as NodeJS.ErrnoException).code ?? String(err.message) }))
  })
}

const daemons: StageDaemon[] = []
const dirs: string[] = []
const sockets: WebSocket[] = []
afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate()
  for (const d of daemons.splice(0)) await d.stop()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
async function boot(config: Parameters<typeof makeStageDaemon>[0]['config']): Promise<StageDaemon> {
  const dataDir = mkdtempSync(join(tmpdir(), 'container-mode-'))
  dirs.push(dataDir)
  const d = await makeStageDaemon({ dataDir, ...(config ? { config } : {}) })
  daemons.push(d)
  return d
}

describe.skipIf(process.platform === 'win32')('container mode on real sockets', () => {
  const nonLoopback = localIPv4s()
  const privateOne = nonLoopback.find((a) => a.cls === 'private')
  const publicOne = nonLoopback.find((a) => a.cls === 'public')

  it('by default the daemon is not reachable on any other address of this machine at all', async () => {
    const other = nonLoopback[0]
    if (!other) return // a machine with no network interface besides loopback: nothing to try
    const d = await boot(undefined)
    const r = await attempt(other.address, d)
    expect('unreachable' in r, JSON.stringify(r)).toBe(true)
    const viaLoopback = await attempt('127.0.0.1', d)
    expect('open' in viaLoopback).toBe(true)
    if ('open' in viaLoopback) sockets.push(viaLoopback.open)
  })

  it.skipIf(!publicOne)('in container mode a PUBLIC peer address is refused by the stage lock (403 peer_not_allowed), token or not', async () => {
    const d = await boot({ host: '0.0.0.0', containerMode: true })
    const r = await attempt((publicOne as { address: string }).address, d)
    expect(r).toEqual({ status: 403, code: 'peer_not_allowed' })
  })

  it.skipIf(!privateOne)('in container mode a PRIVATE peer address (how Docker delivers a published port) is accepted with the stage token', async () => {
    const d = await boot({ host: '0.0.0.0', containerMode: true })
    const r = await attempt((privateOne as { address: string }).address, d)
    expect('open' in r, JSON.stringify(r)).toBe(true)
    if ('open' in r) sockets.push(r.open)
  })

  it.skipIf(!privateOne)('and still needs the token: the private address alone opens nothing', async () => {
    const d = await boot({ host: '0.0.0.0', containerMode: true })
    const address = (privateOne as { address: string }).address
    const r = await new Promise<Attempt>((resolve) => {
      const ws = new WebSocket(`ws://${address}:${d.port}/ws/stage`, { headers: { Host: `127.0.0.1:${d.port}` }, perMessageDeflate: false })
      ws.once('unexpected-response', (_req, res) => {
        res.resume()
        ws.terminate()
        resolve({ status: res.statusCode ?? 0, code: '' })
      })
      ws.once('open', () => resolve({ open: ws }))
      ws.on('error', () => undefined)
    })
    expect(r).toMatchObject({ status: 401 })
  })

  it.skipIf(!privateOne)('and a foreign Host header is still refused (DNS rebinding protection does not depend on the address)', async () => {
    const d = await boot({ host: '0.0.0.0', containerMode: true })
    const address = (privateOne as { address: string }).address
    const r = await new Promise<Attempt>((resolve) => {
      const ws = new WebSocket(`ws://${address}:${d.port}/ws/stage`, {
        headers: { Host: `evil.example:${d.port}`, Authorization: `Bearer ${d.stageToken}` },
        perMessageDeflate: false,
      })
      ws.once('unexpected-response', (_req, res) => {
        res.resume()
        ws.terminate()
        resolve({ status: res.statusCode ?? 0, code: '' })
      })
      ws.once('open', () => resolve({ open: ws }))
      ws.on('error', () => undefined)
    })
    expect(r).toMatchObject({ status: 403 })
  })
})
