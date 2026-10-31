#!/usr/bin/env node
/**
 * End-to-end test of the real thing: the built web app, a real daemon process (zero-token FAKE Claude backend, no
 * network), and a real Chromium. Nothing here calls Anthropic or any remote host: every socket is 127.0.0.1.
 *
 *   node apps/web/scripts/e2e-daemon.mjs   (builds apps/web first when dist is missing or stale)
 *
 * What it proves, in order:
 *   - sign-in: the one-time link is exchanged for a cookie and removed from the address bar; the UI runs in Live mode;
 *   - Work starts honestly empty, then fills live from realistic Claude Code hook payloads (status, subagent tree,
 *     timeline, and the "answer it in your terminal" copy instead of Approve/Deny for hook sessions);
 *   - security: wrong or missing hook token, wrong Host, wrong Origin, missing cookie are all refused;
 *   - sequence gaps are detected and healed with a snapshot refetch;
 *   - chat: a streamed reply with a tool chip, an approval card that is approved in the UI, history surviving a reload;
 *   - resilience: kill -9 the daemon, see the offline banner with the last data still on screen, a command while
 *     offline fails visibly, restart on the same port and data dir, see the UI reconnect and resync with history intact;
 *   - a second browser without the cookie cannot reuse the link and is told so instead of being shown fake data as real.
 *
 * Options (environment):
 *   SHOTS_DIR     where screenshots go (default ./screenshots)
 *   SKIP_BUILD=1  do not rebuild apps/web even if dist looks stale
 *   E2E_VIA=vite  serve the UI with the Vite dev server (proxying /api and /ws to the daemon) instead of letting the
 *                 daemon serve apps/web/dist, to exercise the dev proxy
 *   KEEP_TMP=1    keep the temp data dir (it holds the hook token; deleted otherwise)
 *   E2E_VERBOSE=1 echo the daemon's output
 *
 * Needs Playwright with a Chromium browser (see smoke.mjs). Exit code is non-zero on any failure.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

const here = path.dirname(fileURLToPath(import.meta.url))
const webDir = path.resolve(here, '..')
const root = path.resolve(webDir, '..', '..')
const daemonDir = path.join(root, 'apps', 'daemon')
const sharedDir = path.join(root, 'packages', 'shared')
const SHOTS = path.resolve(process.env.SHOTS_DIR ?? './screenshots')
const VIA_VITE = process.env.E2E_VIA === 'vite'
const VERBOSE = Boolean(process.env.E2E_VERBOSE)
mkdirSync(SHOTS, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const failures = []
const log = (s) => process.stdout.write(`${s}\n`)

/** Poll until `fn` returns something truthy. Waits on the condition, not on the clock. */
async function until(label, fn, { timeout = 15_000, interval = 120 } = {}) {
  const start = Date.now()
  let last
  for (;;) {
    try {
      const v = await fn()
      if (v) return v
    } catch (e) {
      last = e
    }
    if (Date.now() - start > timeout) {
      throw new Error(`timed out after ${timeout} ms waiting for: ${label}${last ? ` (${String(last.message ?? last).slice(0, 160)})` : ''}`)
    }
    await sleep(interval)
  }
}

let page // the main page, for failure screenshots
let shotN = 0
async function shot(name, p = page) {
  if (!p) return
  const file = path.join(SHOTS, `e2e-${String(++shotN).padStart(2, '0')}-${name.replace(/\W+/g, '-').toLowerCase()}.png`)
  await p.screenshot({ path: file }).catch(() => undefined)
}

/** Run one named check. A failure is recorded and printed; `fatal` stops the run (later checks depend on it). */
async function check(name, fn, { fatal = false } = {}) {
  try {
    const detail = await fn()
    log(`PASS  ${name}${typeof detail === 'string' && detail ? `  (${detail})` : ''}`)
  } catch (e) {
    const msg = String(e?.message ?? e).split('\n')[0].slice(0, 300)
    log(`FAIL  ${name}  (${msg})`)
    failures.push(name)
    await shot(`FAIL ${name}`)
    if (fatal) throw new Error(`fatal check failed: ${name}`)
  }
}

// ------------------------------------------------------------------------------------------------ daemon process

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })
}

const maskCode = (s) => s.replace(/code=[\w-]+/g, 'code=***')
const daemons = new Set()

/** Spawn the daemon as ONE node process (so SIGKILL cannot orphan a child) with the tsx loader. */
async function startDaemon({ port, dataDir, devOrigin }) {
  const env = { ...process.env, DAEMON_PORT: String(port), DATA_DIR: dataDir, CLAUDE_BACKEND: 'fake', LOG_LEVEL: 'warn' }
  delete env.ANTHROPIC_API_KEY // belt and braces: the fake backend never reads it, but a real key has no business here
  delete env.DEMO
  if (devOrigin) env.DEV_ORIGINS = devOrigin
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], { cwd: daemonDir, env, stdio: ['ignore', 'pipe', 'pipe'] })
  const d = { child, out: '', exited: false }
  daemons.add(d)
  const onData = (buf) => {
    const t = buf.toString('utf8')
    d.out = (d.out + t).slice(-20_000)
    if (VERBOSE) process.stderr.write(maskCode(t))
  }
  child.stdout.on('data', onData)
  child.stderr.on('data', onData)
  child.once('exit', () => {
    d.exited = true
  })
  const exchangeUrl = await until(
    'the daemon to print its sign-in link',
    () => {
      if (d.exited) throw new Error(`the daemon exited early:\n${maskCode(d.out).slice(-1500)}`)
      return /Sign in\s+(http:\/\/127\.0\.0\.1:\d+\/\?code=[\w-]+)/.exec(d.out)?.[1]
    },
    { timeout: 40_000, interval: 100 },
  )
  d.exchangeUrl = exchangeUrl
  return d
}

async function startDaemonRetry(opts) {
  let last
  for (let i = 0; i < 4; i++) {
    try {
      return await startDaemon(opts)
    } catch (e) {
      last = e
      await sleep(600)
    }
  }
  throw last
}

async function killDaemon(d, signal = 'SIGKILL') {
  if (!d || d.exited) return
  const gone = new Promise((r) => d.child.once('exit', r))
  d.child.kill(signal)
  await Promise.race([gone, sleep(8000)])
  daemons.delete(d)
}

// ------------------------------------------------------------------------------------------------ raw HTTP

/** node:http (not fetch) so Host and Origin can be set freely. */
function raw({ port, method = 'GET', url = '/', headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers, timeout: 8000 }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8'), headers: res.headers }))
    })
    req.on('timeout', () => req.destroy(new Error('request timed out')))
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

// ------------------------------------------------------------------------------------------------ web build

function newest(dir, depth = 0) {
  let t = 0
  if (!existsSync(dir)) return t
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const p = path.join(dir, e.name)
    t = Math.max(t, e.isDirectory() && depth < 12 ? newest(p, depth + 1) : e.isFile() ? statSync(p).mtimeMs : 0)
  }
  return t
}

function ensureBuild() {
  if (VIA_VITE || process.env.SKIP_BUILD) return
  const index = path.join(webDir, 'dist', 'index.html')
  const builtAt = existsSync(index) ? statSync(index).mtimeMs : 0
  const sourceAt = Math.max(
    newest(path.join(webDir, 'src')),
    newest(path.join(sharedDir, 'src')),
    existsSync(path.join(webDir, 'index.html')) ? statSync(path.join(webDir, 'index.html')).mtimeMs : 0,
    statSync(path.join(webDir, 'vite.config.ts')).mtimeMs,
  )
  if (builtAt > sourceAt) {
    log('web build is up to date')
    return
  }
  log(builtAt ? 'web build is stale, rebuilding (pnpm --filter @ai-assistant/web build)' : 'no web build, building (pnpm --filter @ai-assistant/web build)')
  const r = spawnSync('pnpm', ['--filter', '@ai-assistant/web', 'build'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' })
  if (r.status !== 0) throw new Error('the web build failed')
}

async function startVite({ vitePort, daemonPort }) {
  const bin = path.join(path.dirname(require.resolve('vite/package.json', { paths: [webDir] })), 'bin', 'vite.js')
  const child = spawn(process.execPath, [bin, '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'], {
    cwd: webDir,
    env: { ...process.env, DAEMON_URL: `http://127.0.0.1:${daemonPort}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const v = { child, out: '', exited: false }
  child.stdout.on('data', (b) => (v.out = (v.out + b.toString()).slice(-8000)))
  child.stderr.on('data', (b) => (v.out = (v.out + b.toString()).slice(-8000)))
  child.once('exit', () => (v.exited = true))
  await until('the Vite dev server', () => {
    if (v.exited) throw new Error(`vite exited early:\n${v.out.slice(-800)}`)
    return /Local:\s+http:\/\/127\.0\.0\.1:\d+/.test(v.out)
  }, { timeout: 60_000 })
  return v
}

// ------------------------------------------------------------------------------------------------ hook payloads

const SID = 'e2e-sess-0001'
const CWD = '/home/dev/projects/atlas-api'
const common = (sid = SID) => ({
  session_id: sid,
  transcript_path: `/home/dev/.claude/projects/-home-dev-projects-atlas-api/${sid}.jsonl`,
  cwd: CWD,
  permission_mode: 'default',
})
// Shapes follow docs/research and spikes/hooks; real Claude Code payloads were not captured here (see README).
const P = {
  SessionStart: () => ({ ...common(), source: 'startup', model: 'claude-opus-4-5' }),
  UserPromptSubmit: () => ({ ...common(), prompt: 'Add a /health endpoint to the API and cover it with a test' }),
  Edit: () => ({
    ...common(),
    tool_name: 'Edit',
    tool_use_id: 'toolu_01Edit',
    tool_input: { file_path: `${CWD}/src/routes/health.ts`, old_string: 'export {}', new_string: 'export const health = () => ({ ok: true })' },
    tool_response: { filePath: `${CWD}/src/routes/health.ts`, success: true },
  }),
  SubagentStart: () => ({ ...common(), agent_id: 'agent-explore-01', agent_type: 'Explore' }),
  Bash: () => ({
    ...common(),
    tool_name: 'Bash',
    tool_use_id: 'toolu_02Bash',
    tool_input: { command: 'pnpm test --run', description: 'Run the unit tests' },
    // Contains a secret-looking value on purpose: it must never reach the UI or the snapshot.
    tool_response: { stdout: 'ok 3 passed  ANTHROPIC_API_KEY=sk-ant-api03-E2ELEAKCANARYE2ELEAKCANARY', stderr: '', interrupted: false },
  }),
  PermissionRequest: () => ({
    ...common(),
    tool_name: 'Bash',
    tool_use_id: 'toolu_03Rm',
    tool_input: { command: 'rm -rf dist', description: 'Clean the build output' },
  }),
  Notification: () => ({ ...common(), notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }),
  SubagentStop: () => ({
    ...common(),
    agent_id: 'agent-explore-01',
    agent_type: 'Explore',
    last_assistant_message: 'Found the route table in src/routes/index.ts.',
  }),
  Stop: () => ({ ...common(), stop_hook_active: false, last_assistant_message: 'Added GET /health and a passing test.' }),
}
const LEAK = 'sk-ant-api03-E2ELEAKCANARY'

// ------------------------------------------------------------------------------------------------ main

let browser
let vite
let tmp
let d1
let d2

try {
  ensureBuild()
  tmp = mkdtempSync(path.join(tmpdir(), 'mira-e2e-'))
  const dataDir = path.join(tmp, 'data')
  const port = await freePort()
  const vitePort = VIA_VITE ? await freePort() : 0
  const devOrigin = VIA_VITE ? `http://127.0.0.1:${vitePort}` : undefined

  d1 = await startDaemonRetry({ port, dataDir, devOrigin })
  log(`daemon up on 127.0.0.1:${port} (data dir ${dataDir})${VIA_VITE ? `, UI via Vite on :${vitePort}` : ''}`)
  const hookToken = JSON.parse(readFileSync(path.join(dataDir, 'secrets.json'), 'utf8')).hookToken
  if (typeof hookToken !== 'string' || hookToken.length < 32) throw new Error('could not read the hook token from secrets.json')

  let webOrigin = `http://127.0.0.1:${port}`
  if (VIA_VITE) {
    vite = await startVite({ vitePort, daemonPort: port })
    webOrigin = `http://127.0.0.1:${vitePort}`
  }
  const signInUrl = d1.exchangeUrl.replace(`http://127.0.0.1:${port}`, webOrigin)

  browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } })

  // A spy on the WebSocket: records every frame (type and seq), every URL the app connected with, and can drop frames
  // on demand to manufacture a sequence gap. It sits in front of the app's own handler, so the app cannot tell.
  await context.addInitScript(() => {
    const Native = window.WebSocket
    const spy = (window.__ws = { frames: [], urls: [], sockets: [], dropNext: 0, dropped: 0 })
    class Spy extends Native {
      #h = null
      constructor(url, protocols) {
        super(url, protocols)
        spy.urls.push(String(url))
        spy.sockets.push(this)
      }
      get onmessage() {
        return this.#h
      }
      set onmessage(fn) {
        this.#h = fn
        super.onmessage = fn
          ? (ev) => {
              let t = '?'
              let seq
              let resync
              try {
                const o = JSON.parse(String(ev.data))
                t = o.type
                seq = o.seq
                resync = o.resync
              } catch {
                /* not JSON */
              }
              const droppable = t !== 'hello' && t !== 'pong'
              if (droppable && spy.dropNext > 0) {
                spy.dropNext--
                spy.dropped++
                spy.frames.push({ t: `DROPPED:${t}`, seq })
                return
              }
              spy.frames.push({ t, seq, resync })
              if (spy.frames.length > 4000) spy.frames.splice(0, 1000)
              fn.call(this, ev)
            }
          : null
      }
    }
    window.WebSocket = Spy
  })

  page = await context.newPage()
  const errors = []
  let outage = false
  // The deliberately refused Approve click makes the browser log the daemon's 409 as "Failed to load resource".
  let expectConflict = false
  // Taking the cookie away makes the WebSocket handshake and the probe fail with 401, which the browser also logs.
  let expectAuthLoss = false
  const isNoise = (t) => /GPU stall|WebGL|GL Driver|swiftshader|THREE\.Clock/i.test(t)
  const isOutage = (t) => /ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_EMPTY_RESPONSE|Failed to load resource|WebSocket connection to/i.test(t)
  page.on('console', (m) => {
    if (m.type() !== 'error') return
    const t = m.text()
    if (isNoise(t) || (outage && isOutage(t)) || (expectConflict && /status of 409/.test(t)) || (expectAuthLoss && /status of 401|WebSocket connection to/.test(t))) return
    errors.push(t.slice(0, 260))
  })
  page.on('pageerror', (e) => errors.push(`PAGEERROR ${String(e.message).slice(0, 260)}`))
  let snapshotRequests = 0
  page.on('request', (r) => {
    if (r.url().includes('/api/snapshot')) snapshotRequests++
  })

  const nav = (label) => page.locator(`nav[aria-label="Main"] button[aria-label="${label}"]`).click()
  // Only the app's own socket: the Vite dev server opens its own HMR WebSocket too.
  const wsInfo = () =>
    page.evaluate(() => ({
      frames: window.__ws.frames.map((f) => f.t),
      urls: window.__ws.urls.filter((u) => new URL(u).pathname === '/ws'),
      dropped: window.__ws.dropped,
    }))
  const card = (sid = SID) => page.locator(`article[data-session-id="${sid}"]`)
  const detail = () => page.locator('[aria-label^="Session detail:"]')
  const cardStatus = async (sid = SID) => ((await card(sid).getAttribute('aria-label')) ?? '').split(', ').pop()
  const postHook = (event, payload, opts = {}) => {
    const token = 'token' in opts ? opts.token : hookToken
    return raw({
      port,
      method: 'POST',
      url: `/hooks/${event}`,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(opts.host ? { Host: opts.host } : {}),
      },
      body: JSON.stringify({ hook_event_name: event, ...payload }),
    })
  }
  const hookOk = async (event, payload) => {
    const r = await postHook(event, payload)
    if (r.status !== 200) throw new Error(`hook ${event} answered ${r.status}`)
  }
  const composer = () => page.locator('aside[aria-label="Mira\'s room and chat"] textarea').first()
  const chatText = () => page.locator('aside[aria-label="Mira\'s room and chat"]').innerText()

  // ---------------------------------------------------------------- 1. sign in, Live mode
  log('\n-- sign in')
  await page.goto(signInUrl)
  await page.waitForSelector('nav[aria-label="Main"]', { timeout: 30_000 })
  await check(
    'the UI loads in Live mode against the daemon',
    async () => {
      const badge = page.locator('[data-testid="mode-badge"]')
      await until('Live badge', async () => (await badge.getAttribute('data-mode')) === 'daemon' && (await badge.getAttribute('data-link')) === 'up')
      const txt = (await badge.innerText()).trim()
      if (!/^Live/.test(txt)) throw new Error(`badge says "${txt}"`)
      return txt.replace(/\s+/g, ' ')
    },
    { fatal: true },
  )
  await check('the one-time code is gone from the address bar', async () => {
    const u = page.url()
    if (/[?&]code=/.test(u)) throw new Error(`still in the URL: ${maskCode(u)}`)
    return u
  })
  await check('the session cookie is HttpOnly and SameSite=Strict (JavaScript cannot read it)', async () => {
    const cookies = await context.cookies()
    const c = cookies.find((x) => x.name.startsWith('aia_sid_'))
    if (!c) throw new Error('no session cookie')
    if (!c.httpOnly || c.sameSite !== 'Strict') throw new Error(`httpOnly=${c.httpOnly} sameSite=${c.sameSite}`)
    const visible = await page.evaluate(() => document.cookie)
    if (visible.includes('aia_sid_')) throw new Error('document.cookie exposes it')
  })
  await check('one WebSocket is open and resumes from the snapshot position (since + epoch)', async () => {
    await until('hello frame', async () => (await wsInfo()).frames.includes('hello'))
    const info = await wsInfo()
    if (info.urls.length !== 1) throw new Error(`${info.urls.length} sockets opened`)
    const u = new URL(info.urls[0])
    if (u.pathname !== '/ws' || !u.searchParams.has('since') || !u.searchParams.has('epoch')) throw new Error(`url ${info.urls[0]}`)
    if (/code|token/i.test(u.search)) throw new Error('a credential is in the WebSocket URL')
  })
  await shot('signed-in today')

  // ---------------------------------------------------------------- 2. Work starts empty
  log('\n-- Work, before any hook')
  await nav('Work')
  await page.getByRole('heading', { name: 'Mission control' }).waitFor({ timeout: 10_000 })
  await check('Work starts honestly empty: no fixture sessions', async () => {
    const n = await page.locator('article[data-session-id]').count()
    if (n !== 0) throw new Error(`${n} session cards`)
    const s = await page.evaluate(async () => (await fetch('/api/snapshot')).json())
    if (s.sessions.length !== 0 || s.approvals.length !== 0) throw new Error(`snapshot has ${s.sessions.length} sessions, ${s.approvals.length} approvals`)
    return 'no sessions, no approvals'
  })
  await shot('work empty')

  // ---------------------------------------------------------------- 3. hooks drive the Work screen live
  log('\n-- Claude Code hooks')
  await hookOk('SessionStart', P.SessionStart())
  await check('SessionStart: the session appears, idle', async () => {
    await until('card idle', async () => (await card().count()) === 1 && (await cardStatus()) === 'Idle')
    const label = await card().getAttribute('aria-label')
    return label ?? ''
  })

  await hookOk('UserPromptSubmit', P.UserPromptSubmit())
  await check('UserPromptSubmit: running, titled from the prompt', async () => {
    await until('running', async () => (await cardStatus()) === 'Running')
    const label = (await card().getAttribute('aria-label')) ?? ''
    if (!label.startsWith('Add a /health endpoint')) throw new Error(`title: ${label}`)
  })

  await hookOk('PostToolUse', P.Edit())
  await check('PostToolUse Edit: the card shows what is being edited', async () => {
    await until('edit summary', async () => /Edited .*health\.ts/.test(await card().innerText()))
  })

  await hookOk('SubagentStart', P.SubagentStart())
  await check('SubagentStart: the subagent is in the agent tree', async () => {
    await until('Explore agent', async () => (await detail().getByText('Explore', { exact: true }).count()) > 0)
    await until('Explore running', async () => /Explore\s*running/i.test((await detail().innerText()).replace(/\s+/g, ' ')))
  })

  await hookOk('PostToolUse', P.Bash())
  await check('PostToolUse Bash: it is in the timeline', async () => {
    await until('bash event', async () => /Ran pnpm test --run/.test(await detail().innerText()))
  })
  await check('a secret inside tool_response never reaches the screen', async () => {
    if ((await page.locator('body').innerText()).includes(LEAK)) throw new Error('canary visible in the UI')
  })
  await shot('work running with subagent')

  await hookOk('PermissionRequest', P.PermissionRequest())
  await check('PermissionRequest: Needs permission, with the terminal-only copy and no Approve/Deny', async () => {
    await until('blocked', async () => (await cardStatus()) === 'Needs permission')
    const note = card().locator('[data-testid="terminal-only-note"]')
    await until('note', async () => (await note.count()) === 1)
    const text = (await note.innerText()).trim()
    if (text !== 'Answer this in your terminal. Mira can only watch hook sessions.') throw new Error(`copy: ${text}`)
    const buttons = await card().getByRole('button', { name: /^(approve|deny|reply)$/i }).count()
    const inputs = await card().locator('input').count()
    if (buttons !== 0 || inputs !== 0) throw new Error(`${buttons} approve/deny/reply buttons, ${inputs} inputs on the card`)
  })
  await check('the detail panel carries the same honest copy', async () => {
    await until('detail note', async () => (await detail().locator('[data-testid="terminal-only-note"]').count()) === 1)
  })
  await shot('work blocked terminal only')

  await hookOk('Notification', P.Notification())
  await check('Notification (permission prompt): still Needs permission', async () => {
    await until('notification in timeline', async () => /Claude needs your permission to use Bash/.test(await detail().innerText()))
    if ((await cardStatus()) !== 'Needs permission') throw new Error(`status ${await cardStatus()}`)
  })

  await check('a hook approval on Today shows the terminal-only note (no Approve button) and the daemon refuses a direct decision', async () => {
    await nav('Today')
    const note = page.locator('main [data-testid="terminal-only-note"]').first()
    await note.waitFor({ timeout: 10_000 })
    const approveButtons = await page.locator('main').getByRole('button', { name: 'Approve', exact: true }).count()
    if (approveButtons !== 0) throw new Error(`${approveButtons} Approve buttons on Today for a permission owned by the user's terminal`)
    expectConflict = true
    const res = await page.evaluate(async () => {
      const snap = await (await fetch('/api/snapshot')).json()
      const ap = snap.approvals.find((a) => a.status === 'pending')
      if (!ap) return { status: 0, pending: 0 }
      const r = await fetch(`/api/approvals/${encodeURIComponent(ap.id)}/decision`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'approved' }),
      })
      const after = await (await fetch('/api/snapshot')).json()
      return { status: r.status, pending: after.approvals.filter((a) => a.status === 'pending').length }
    })
    expectConflict = false
    if (res.status !== 409) throw new Error(`direct decision returned ${res.status}, expected 409`)
    if (res.pending !== 1) throw new Error(`${res.pending} pending approvals after the refused decision, expected 1`)
    await shot('today terminal only')
    await nav('Work')
  })

  await hookOk('SubagentStop', P.SubagentStop())
  await check('SubagentStop: the subagent finishes', async () => {
    await until('Explore done', async () => /Explore\s*done/i.test((await detail().innerText()).replace(/\s+/g, ' ')))
  })

  await hookOk('Stop', P.Stop())
  await check('Stop: back to Idle, summary shown, the note is gone, the approval closed', async () => {
    await until('idle', async () => (await cardStatus()) === 'Idle')
    await until('summary', async () => (await detail().innerText()).includes('Added GET /health and a passing test.'))
    if ((await card().locator('[data-testid="terminal-only-note"]').count()) !== 0) throw new Error('note still shown')
    await until('approval closed', async () => {
      const s = await page.evaluate(async () => (await fetch('/api/snapshot')).json())
      return s.approvals.every((a) => a.status !== 'pending')
    })
  })
  await check('the timeline shows the whole turn, oldest events included', async () => {
    const t = (await detail().innerText()).replace(/\s+/g, ' ')
    for (const needle of ['Session started', 'Edited', 'Ran pnpm test --run', 'Permission needed', 'subagent finished', 'Turn finished']) {
      if (!t.includes(needle)) throw new Error(`missing "${needle}" in the timeline`)
    }
  })
  await shot('work after stop')

  // ---------------------------------------------------------------- 4. security
  log('\n-- security')
  await check('a hook with a wrong bearer token is rejected and creates nothing', async () => {
    const health = () => page.evaluate(async () => (await fetch('/api/health')).json())
    const before = await health()
    const r = await postHook('SessionStart', { ...common('e2e-evil-session'), source: 'startup' }, { token: 'not-the-token-not-the-token-not-the-token' })
    if (r.status !== 401) throw new Error(`status ${r.status}`)
    const r2 = await postHook('SessionStart', { ...common('e2e-evil-session'), source: 'startup' }, { token: '' })
    if (r2.status !== 401) throw new Error(`no-token status ${r2.status}`)
    // The daemon counts a hook only once it passed authentication, so the counter proves nothing was queued.
    const after = await health()
    if (after.hooksReceived !== before.hooksReceived) throw new Error(`hooksReceived went ${before.hooksReceived} -> ${after.hooksReceived}`)
    const s = await page.evaluate(async () => (await fetch('/api/snapshot')).json())
    if (s.sessions.some((x) => x.id === 'e2e-evil-session')) throw new Error('the rejected event created a session')
  })
  await check('a request with a wrong Host header is rejected (DNS rebinding)', async () => {
    const r = await postHook('Stop', P.Stop(), { host: 'evil.example:80' })
    if (r.status !== 403) throw new Error(`hook with a bad Host: ${r.status}`)
    const r2 = await raw({ port, url: '/', headers: { Host: `evil.example:${port}` } })
    if (r2.status !== 403) throw new Error(`static page with a bad Host: ${r2.status}`)
  })
  await check('browser routes refuse a missing cookie and a foreign Origin; the hook token does not open them', async () => {
    const noCookie = await raw({ port, url: '/api/snapshot' })
    if (noCookie.status !== 401) throw new Error(`no cookie: ${noCookie.status}`)
    const byHookToken = await raw({ port, url: '/api/snapshot', headers: { Authorization: `Bearer ${hookToken}` } })
    if (byHookToken.status !== 401) throw new Error(`hook token on a browser route: ${byHookToken.status}`)
    const cookie = (await context.cookies()).map((c) => `${c.name}=${c.value}`).join('; ')
    const foreign = await raw({
      port,
      method: 'POST',
      url: '/api/chat',
      headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example', Cookie: cookie },
      body: JSON.stringify({ text: 'hi', modality: 'text' }),
    })
    if (foreign.status !== 403) throw new Error(`foreign Origin with a valid cookie: ${foreign.status}`)
    const noOrigin = await raw({
      port,
      method: 'POST',
      url: '/api/chat',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ text: 'hi', modality: 'text' }),
    })
    if (noOrigin.status !== 403) throw new Error(`no Origin with a valid cookie: ${noOrigin.status}`)
  })
  await check('the snapshot never contains the hook token or the leaked canary', async () => {
    const cookie = (await context.cookies()).map((c) => `${c.name}=${c.value}`).join('; ')
    const r = await raw({ port, url: '/api/snapshot', headers: { Cookie: cookie, Origin: `http://127.0.0.1:${port}` } })
    if (r.status !== 200) throw new Error(`snapshot ${r.status}`)
    if (r.text.includes(hookToken)) throw new Error('hook token in the snapshot')
    if (r.text.includes(LEAK)) throw new Error('canary in the snapshot')
  })

  // ---------------------------------------------------------------- 5. a sequence gap heals itself
  log('\n-- sequence gap')
  await check('a dropped event is detected as a gap and healed by refetching the snapshot', async () => {
    const before = snapshotRequests
    const SID2 = 'e2e-sess-0002'
    await page.evaluate(() => (window.__ws.dropNext = 1))
    // Same project, so the daemon publishes plain events (session.update, agent.event): the first is dropped, the second reveals the gap.
    await hookOk('SessionStart', { ...common(SID2), source: 'startup', model: 'claude-sonnet-4-5' })
    await until('a frame was dropped', async () => (await wsInfo()).dropped === 1)
    await until('the snapshot was refetched', async () => snapshotRequests > before)
    await until('the new session is on screen anyway', async () => (await card(SID2).count()) === 1)
    const info = await wsInfo()
    if (info.urls.length !== 1) throw new Error('a gap must not need a new socket')
    // The stream keeps working after the heal.
    await hookOk('UserPromptSubmit', { ...common(SID2), prompt: 'Refactor the logger' })
    await until('live again', async () => (await cardStatus(SID2)) === 'Running')
  })

  // ---------------------------------------------------------------- 6. chat
  log('\n-- chat')
  await nav('Today')
  await check('a typed message gets a streamed reply with a tool chip, and no [emotion] tags show', async () => {
    const mark = (await wsInfo()).frames.length
    await composer().fill('What is on today?')
    await composer().press('Enter')
    await until('tool chip', async () => (await page.locator('aside [title="Tool: calendar_agenda"]').count()) > 0)
    await until('reply finished', async () => (await page.getByRole('button', { name: 'Stop reply' }).count()) === 0 && /calendar/i.test(await chatText()))
    const frames = (await wsInfo()).frames.slice(mark)
    const deltas = frames.filter((f) => f === 'chat.delta').length
    if (deltas < 3) throw new Error(`only ${deltas} chat.delta frames`)
    const t = await chatText()
    if (/\[(thinking|happy|neutral|relaxed|sad|shy)\]/.test(t)) throw new Error('an emotion tag leaked into the chat')
    return `${deltas} delta frames`
  })
  await shot('chat reply with tool chip')

  await check('"please delete the old backup" raises an approval card; approving it lets the reply continue', async () => {
    await composer().fill('please delete the old backup')
    await composer().press('Enter')
    const approve = page.locator('aside').getByRole('button', { name: 'Approve', exact: true }).first()
    await approve.waitFor({ timeout: 15_000 })
    await shot('chat approval card')
    await approve.click()
    await until('the reply continues', async () => /went through the mock tool/i.test(await chatText()), { timeout: 15_000 })
    await until('card shows Approved', async () => (await page.locator('aside').getByText('Approved', { exact: true }).count()) > 0)
    await until('turn ended', async () => (await page.getByRole('button', { name: 'Stop reply' }).count()) === 0)
  })
  await shot('chat after approval')

  await check('Denying works too: the reply says it will not do it', async () => {
    await composer().fill('please remove the temp notes')
    await composer().press('Enter')
    const deny = page.locator('aside').getByRole('button', { name: 'Deny', exact: true }).first()
    await deny.waitFor({ timeout: 15_000 })
    await deny.click()
    await until('the refusal reply', async () => /will not do that/i.test(await chatText()), { timeout: 15_000 })
  })

  // ---------------------------------------------------------------- 7. reload keeps history
  log('\n-- reload')
  await check('after a reload the chat history is still there (the daemon persisted it)', async () => {
    await page.reload()
    await page.waitForSelector('nav[aria-label="Main"]', { timeout: 30_000 })
    const badge = page.locator('[data-testid="mode-badge"]')
    await until('Live again after reload', async () => (await badge.getAttribute('data-mode')) === 'daemon' && (await badge.getAttribute('data-link')) === 'up')
    await until('history', async () => {
      const t = await chatText()
      return t.includes('What is on today?') && t.includes('please delete the old backup') && /went through the mock tool/i.test(t)
    })
    if (/[?&]code=/.test(page.url())) throw new Error('code back in the URL')
  })
  await check('after a reload the Work sessions are still there', async () => {
    await nav('Work')
    await until('both sessions', async () => (await card(SID).count()) === 1 && (await card('e2e-sess-0002').count()) === 1)
  })
  await shot('after reload work')

  // ---------------------------------------------------------------- 7b. the cookie disappears
  log('\n-- session cookie lost')
  await check('losing the session cookie takes the link offline with a sign-in message; it recovers when the cookie is back', async () => {
    const saved = await context.cookies()
    expectAuthLoss = true
    await context.clearCookies()
    await page.evaluate(() => {
      const app = window.__ws.sockets.filter((s) => new URL(s.url).pathname === '/ws')
      app[app.length - 1].close()
    })
    const banner = page.getByRole('status').filter({ hasText: /not signed in/i })
    await banner.first().waitFor({ state: 'visible', timeout: 20_000 })
    await shot('cookie lost')
    await context.addCookies(saved)
    await until('banner gone after the cookie is back', async () => (await page.getByRole('status').filter({ hasText: 'Reconnecting to the daemon' }).count()) === 0, { timeout: 60_000 })
    expectAuthLoss = false
    const badge = page.locator('[data-testid="mode-badge"]')
    await until('Live again', async () => (await badge.getAttribute('data-link')) === 'up')
  })

  // ---------------------------------------------------------------- 8. the daemon dies
  log('\n-- daemon outage')
  const snapshotsBeforeKill = snapshotRequests
  outage = true
  await killDaemon(d1, 'SIGKILL')
  await check('kill -9 the daemon: the offline banner appears, the last data stays on screen', async () => {
    const banner = page.getByRole('status').filter({ hasText: 'Reconnecting to the daemon' })
    await banner.first().waitFor({ state: 'visible', timeout: 20_000 })
    const badge = page.locator('[data-testid="mode-badge"]')
    await until('Offline badge', async () => (await badge.getAttribute('data-link')) === 'down')
    if ((await card(SID).count()) !== 1) throw new Error('the session card vanished with the link')
    if ((await page.locator('[data-link="down"][aria-busy="true"]').count()) === 0) throw new Error('the page is not marked as read-only/stale')
    return (await banner.first().innerText()).replace(/\s+/g, ' ').slice(0, 140)
  })
  await shot('offline banner')

  await check('a command while offline fails visibly and releases the chat', async () => {
    await nav('Today')
    await composer().fill('are you there?')
    await composer().press('Enter')
    const alert = page.getByRole('alert').filter({ hasText: /not reachable/i })
    await alert.first().waitFor({ state: 'visible', timeout: 10_000 })
    await until('chat not stuck streaming', async () => (await page.getByRole('button', { name: 'Stop reply' }).count()) === 0)
    await shot('offline command failed')
  })

  // ---------------------------------------------------------------- 9. the daemon comes back
  log('\n-- daemon restart')
  d2 = await startDaemonRetry({ port, dataDir, devOrigin })
  await check('restart on the same port and data dir: the UI reconnects by itself and resyncs', async () => {
    const banner = page.getByRole('status').filter({ hasText: 'Reconnecting to the daemon' })
    await until('banner gone', async () => (await banner.count()) === 0, { timeout: 60_000 })
    const badge = page.locator('[data-testid="mode-badge"]')
    await until('Live again', async () => (await badge.getAttribute('data-link')) === 'up' && (await badge.getAttribute('data-mode')) === 'daemon')
    await until('a fresh snapshot was fetched', async () => snapshotRequests > snapshotsBeforeKill)
    const info = await wsInfo()
    const last = new URL(info.urls[info.urls.length - 1])
    if (!last.searchParams.has('since') || !last.searchParams.has('epoch')) throw new Error('the reconnect did not try to resume')
    const hello = await page.evaluate(() => window.__ws.frames.filter((f) => f.t === 'hello').pop())
    if (hello?.resync !== true) throw new Error(`the new daemon epoch did not make the hello say resync (${JSON.stringify(hello)})`)
  })
  outage = false
  await check('after the restart the history is intact (chat and sessions)', async () => {
    await until('history', async () => {
      const t = await chatText()
      return t.includes('please delete the old backup') && /went through the mock tool/i.test(t)
    })
    await nav('Work')
    await until('sessions', async () => (await card(SID).count()) === 1 && (await card('e2e-sess-0002').count()) === 1)
    if ((await cardStatus(SID)) !== 'Idle') throw new Error(`status ${await cardStatus(SID)}`)
  })
  await check('the restarted daemon streams live again: hooks and chat both work', async () => {
    await hookOk('UserPromptSubmit', { ...common('e2e-sess-0002'), prompt: 'Now write the changelog' })
    await until('hook live', async () => (await card('e2e-sess-0002').innerText()).includes('Now write the changelog') || (await cardStatus('e2e-sess-0002')) === 'Running')
    await nav('Today')
    await composer().fill('thanks')
    await composer().press('Enter')
    await until('reply after restart', async () => /Happy to help/i.test(await chatText()), { timeout: 15_000 })
  })
  await shot('after restart')

  // ---------------------------------------------------------------- 10. a browser without the cookie
  log('\n-- a second browser')
  {
    const ctx2 = await browser.newContext({ viewport: { width: 1400, height: 800 } })
    const p2 = await ctx2.newPage()
    p2.on('pageerror', (e) => errors.push(`PAGEERROR(2) ${String(e.message).slice(0, 200)}`))
    await check('the one-time link cannot be reused, and the mockup says so instead of posing as live', async () => {
      await p2.goto(signInUrl)
      await p2.waitForSelector('nav[aria-label="Main"]', { timeout: 30_000 })
      const badge = p2.locator('[data-testid="mode-badge"]')
      if ((await badge.getAttribute('data-mode')) !== 'fixtures') throw new Error('claims to be live without a session')
      await p2.getByText(/already used or has expired/i).first().waitFor({ timeout: 10_000 })
      if (/[?&]code=/.test(p2.url())) throw new Error('the dead code is still in the URL')
      await shot('second browser reused link', p2)
    })
    await check('opening the daemon address without a cookie shows the mockup with a sign-in notice', async () => {
      const p3 = await ctx2.newPage()
      await p3.goto(`${webOrigin}/`)
      await p3.waitForSelector('nav[aria-label="Main"]', { timeout: 30_000 })
      if ((await p3.locator('[data-testid="mode-badge"]').getAttribute('data-mode')) !== 'fixtures') throw new Error('claims to be live without a session')
      await p3.getByText(/not signed in/i).first().waitFor({ timeout: 10_000 })
      await p3.close()
    })
    await ctx2.close()
  }

  // ---------------------------------------------------------------- 11. no errors anywhere
  log('\n-- console')
  await check('no console errors or page errors during the whole run (CSP included)', async () => {
    if (errors.length) throw new Error(`${errors.length}: ${errors.slice(0, 3).join(' | ')}`)
  })
} catch (e) {
  log(`\nABORTED: ${String(e?.message ?? e)}`)
  failures.push('aborted')
} finally {
  await browser?.close().catch(() => undefined)
  for (const dd of [...daemons]) await killDaemon(dd, 'SIGKILL')
  if (vite && !vite.exited) {
    vite.child.kill('SIGTERM')
    await sleep(300)
  }
  if (tmp && !process.env.KEEP_TMP) rmSync(tmp, { recursive: true, force: true })
  log(failures.length ? `\n${failures.length} check(s) failed: ${failures.join('; ')}` : '\nAll checks passed')
  process.exit(failures.length ? 1 : 0)
}
