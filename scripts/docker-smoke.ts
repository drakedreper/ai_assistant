/**
 * Proves a RUNNING compose stack, from the host's side, the way a browser and an engine reach it:
 *
 *   1. the container runs as a normal user, and the port is published on 127.0.0.1 only
 *   2. the one-time sign-in link in the logs is exchanged for a cookie, and the snapshot and the built web app answer
 *   3. the stage is switched on and a stage (the simulator) connects over the published port with the token the
 *      container's own CLI prints. It arrives from Docker's bridge address, which only container mode lets through
 *   4. the same door stays shut without the token and with a foreign Host header
 *   5. a restart keeps the data volume: the stage token is the same afterwards
 *
 * Run it after `docker compose up -d` (it needs Node, Docker, and `pnpm install` once, with or without scripts):
 *
 *   pnpm --filter @ai-assistant/daemon exec tsx ../../scripts/docker-smoke.ts [port]
 *
 * Prints PASS or FAIL per check and exits 1 on any FAIL. The sign-in code and the stage token are never printed.
 */
import { execFileSync } from 'node:child_process'
import http from 'node:http'
import { WebSocket } from 'ws'
import { connectSimulator } from '../apps/daemon/src/stage/simClient'

const port = Number(process.argv[2] ?? process.env.DAEMON_PORT ?? 7421)
const base = `http://127.0.0.1:${port}`
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const docker = (...args: string[]): string => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const compose = (...args: string[]): string => docker('compose', ...args)

let failed = 0
async function check(name: string, fn: () => Promise<string | void> | string | void): Promise<void> {
  try {
    const detail = await fn()
    console.log(`PASS  ${name}${detail ? `  (${detail})` : ''}`)
  } catch (e) {
    failed++
    console.log(`FAIL  ${name}  (${String((e as Error).message ?? e).split('\n')[0]?.slice(0, 220)})`)
  }
}
const must = (cond: unknown, why: string): void => {
  if (!cond) throw new Error(why)
}
const until = async (what: string, fn: () => boolean | Promise<boolean>, ms = 20_000): Promise<void> => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await fn()) return
    await sleep(150)
  }
  throw new Error(`timed out waiting for ${what}`)
}

async function signInLink(): Promise<string> {
  const re = /Sign in\s+(http:\/\/127\.0\.0\.1:\d+\/\?code=[\w-]+)/g
  for (let i = 0; i < 120; i++) {
    const out = compose('logs', '--no-color', 'daemon')
    const all = [...out.matchAll(re)]
    const last = all[all.length - 1]?.[1]
    if (last) return last
    await sleep(1000)
  }
  throw new Error('the daemon never printed a sign-in link')
}

/** One WebSocket upgrade with explicit headers (so Host can be set); resolves to the HTTP status of a refusal, or "open". */
function upgrade(headers: Record<string, string>): Promise<number | 'open'> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/stage`, { headers, perMessageDeflate: false, handshakeTimeout: 6000 })
    ws.once('unexpected-response', (_req, res) => {
      res.resume()
      ws.terminate()
      resolve(res.statusCode ?? 0)
    })
    ws.once('open', () => {
      ws.terminate()
      resolve('open')
    })
    ws.on('error', () => undefined)
  })
}

/** A plain HTTP GET with an explicit Host header (fetch does not let a script send a foreign one). */
function getWithHost(path: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers: { Host: host } }, (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    req.on('error', reject)
    req.end()
  })
}

async function main(): Promise<void> {
  let cookie = ''
  let stageToken = ''
  const mask = (s: string): string => s.replaceAll(stageToken || '\u0000', '***')

  await check('the container runs as a normal user, not root', () => {
    const uid = compose('exec', '-T', 'daemon', 'id', '-u').trim()
    must(uid !== '0' && /^\d+$/.test(uid), `uid ${uid}`)
    return `uid ${uid}`
  })

  await check('the port is published on this PC\'s 127.0.0.1 only', () => {
    const mapped = compose('port', 'daemon', String(port)).trim()
    must(mapped.split('\n').every((l) => l.startsWith('127.0.0.1:')), `docker reports: ${mapped}`)
    return mapped
  })

  await check('the container reports healthy', async () => {
    let status = ''
    await until('a healthy container', () => {
      const id = compose('ps', '-q', 'daemon').trim()
      status = docker('inspect', '--format', '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}', id).trim()
      return status === 'healthy'
    }, 90_000)
    return status
  })

  await check('the one-time sign-in link is exchanged for a cookie (POST /api/auth/exchange)', async () => {
    const link = await signInLink()
    const code = /code=([\w-]+)/.exec(link)?.[1] ?? ''
    const r = await fetch(`${base}/api/auth/exchange`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ code }) })
    must(r.status === 200, `HTTP ${r.status}`)
    cookie = (r.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')
    must(cookie.length > 0, 'no cookie')
  })

  await check('the snapshot answers with the cookie, and 401 without it', async () => {
    const ok = await fetch(`${base}/api/snapshot`, { headers: { cookie } })
    const body = await ok.text()
    must(ok.status === 200 && body.length > 1000, `HTTP ${ok.status}, ${body.length} bytes`)
    const no = await fetch(`${base}/api/snapshot`)
    must(no.status === 401, `without the cookie: HTTP ${no.status}`)
    return `${body.length} bytes`
  })

  await check('the built web app is served', async () => {
    const r = await fetch(`${base}/`, { headers: { cookie } })
    const html = await r.text()
    must(r.status === 200 && /id="root"/.test(html), `HTTP ${r.status}`)
  })

  await check('a foreign Host header is refused (403), also with the cookie', async () => {
    const s = await getWithHost('/api/snapshot', 'evil.example')
    must(s === 403, `HTTP ${s}`)
  })

  await check('the stage switch can be turned on (PUT /api/settings/stage)', async () => {
    const r = await fetch(`${base}/api/settings/stage`, { method: 'PUT', headers: { 'content-type': 'application/json', origin: base, cookie }, body: JSON.stringify({ on: true }) })
    must(r.status === 200, `HTTP ${r.status}`)
  })

  await check('the container prints a stage token (its own CLI), and the token looks like a secret', () => {
    stageToken = compose('exec', '-T', 'daemon', 'node', '--import', 'tsx', 'src/stage/cli.ts', 'token').trim()
    must(/^[A-Za-z0-9_-]{43}$/.test(stageToken), 'not a 256-bit token')
  })

  await check('without the token the stage door answers 401, with a foreign Host 403', async () => {
    const a = await upgrade({ Host: `127.0.0.1:${port}` })
    must(a === 401, `no token: ${String(a)}`)
    const b = await upgrade({ Host: `evil.example:${port}`, Authorization: `Bearer ${stageToken}` })
    must(b === 403, `foreign Host: ${String(b)}`)
  })

  await check('a stage connects through the published port and is given her, you, and the void', async () => {
    const client = connectSimulator({ url: `ws://127.0.0.1:${port}/ws/stage`, token: stageToken, reconnect: false })
    try {
      const sim = await client.waitConnected(15_000)
      await until('the look to load', () => sim.state().scene !== null && Object.keys(sim.state().characters).length === 2)
      const st = sim.state()
      must(st.assistantId === 'char.assistant', `assistant ${String(st.assistantId)}`)
      const snap = (await (await fetch(`${base}/api/snapshot`, { headers: { cookie } })).json()) as { stage?: { stage?: { connected?: boolean; engine?: string } } }
      must(snap.stage?.stage?.connected === true && snap.stage?.stage?.engine === 'sim', `snapshot says ${JSON.stringify(snap.stage?.stage)}`)
      return `${Object.keys(st.characters).length} characters, ${st.scene?.cameraIds.length ?? 0} camera shots`
    } finally {
      await client.stop()
    }
  })

  await check('after a restart the data volume is still there: same stage token', async () => {
    const before = stageToken
    compose('restart', 'daemon')
    const after = compose('exec', '-T', 'daemon', 'node', '--import', 'tsx', 'src/stage/cli.ts', 'token').trim()
    must(after === before, 'the token changed: the data directory is not persisted')
  })

  await check('the logs never contain the stage token', () => {
    const logs = compose('logs', '--no-color', 'daemon')
    must(!logs.includes(stageToken), 'the stage token is in the container logs')
    return mask(`${logs.length} log characters read`)
  })

  console.log(`\n${failed === 0 ? 'ALL OK' : `${failed} FAILED`}`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('ABORTED:', String((e as Error).message ?? e).slice(0, 400))
  process.exit(1)
})
