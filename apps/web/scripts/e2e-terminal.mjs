#!/usr/bin/env node
/**
 * End-to-end test of the embedded terminals: the built web app, a real daemon process (zero-token FAKE Claude
 * backend, no network) and a real Chromium. Nothing here calls Anthropic or any remote host; every socket is 127.0.0.1.
 * "Claude" terminals run a tiny node script (TERMINAL_CLAUDE_COMMAND, the daemon's test-only override), so no real
 * claude, login or token is involved. Shells are the machine's real shell on a real PTY, in a throw-away home folder.
 *
 *   node apps/web/scripts/e2e-terminal.mjs   (builds apps/web first when dist is missing or stale)
 *
 * What it proves, in order:
 *   - terminals are refused (403 terminals_disabled) until the user switches them on, and the Terminal tab explains it;
 *   - the switch in Settings > Privacy turns them on (and is audited); the tab then offers New shell / New Claude terminal;
 *   - a real shell opens, typing produces output from a real PTY, a window resize reaches the process;
 *   - the (test) Claude terminal opens, echoes typing, learns the new size; "Open Claude here" starts in the project;
 *   - a page reload reattaches to the SAME running terminal and replays what was on screen;
 *   - closing a terminal kills its process;
 *   - protocol level (node WebSocket client): a ticket cannot be reused, a ticket for one terminal is refused on
 *     another, a cross-origin or wrong-Host WebSocket is refused, a socket without an auth frame is closed, a second
 *     client is refused, and no ticket or token ever appears in a URL;
 *   - switching terminals off in Settings kills every running terminal, empties the list and closes the sockets;
 *   - the daemon stops without leaving a terminal process behind.
 *
 * And, for the findings of the adversarial review (each a check below):
 *   - pairing: the sign-in link carries a second secret in its #fragment; the page takes it out of the address bar, a browser
 *     without it (or a program replaying a stolen cookie) cannot use a terminal, and the tab says so;
 *   - every terminal runs in its own PTY host process: no program of a later terminal holds an earlier terminal's PTY master;
 *   - closing a terminal ends its WHOLE tree (background jobs, nohup, subshell jobs, programs that ignore SIGHUP), also when the
 *     daemon is stopped, hung up (SIGHUP), or killed with SIGKILL; only a process that deliberately daemonised itself survives;
 *   - programs inside a terminal cannot make the page open a link without a confirmation that shows the real address;
 *   - signing out and the revoke command end sessions; the data folder and database are private (POSIX);
 *   - the daemon's loader variables (NODE_PATH, NODE_OPTIONS code-loading flags) do not reach a terminal;
 *   - a flood of text frames closes the socket (4429);
 *   - the live feed (/ws) read from a dev origin carries nothing about terminals (no list, no audit entry with an id).
 *
 * Options (environment):
 *   SHOTS_DIR     where screenshots go (default ./screenshots)
 *   SKIP_BUILD=1  do not rebuild apps/web even if dist looks stale
 *   KEEP_TMP=1    keep the temp folder
 *   E2E_VERBOSE=1 echo the daemon's output
 *
 * Needs Playwright with a Chromium browser (see smoke.mjs). Exit code is non-zero on any failure. On Windows the
 * script uses PowerShell syntax for the shell command; it has only been run in the Linux sandbox so far.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

const here = path.dirname(fileURLToPath(import.meta.url))
const webDir = path.resolve(here, '..')
const root = path.resolve(webDir, '..', '..')
const daemonDir = path.join(root, 'apps', 'daemon')
const sharedDir = path.join(root, 'packages', 'shared')
const WebSocket = createRequire(path.join(daemonDir, 'package.json'))('ws')
const SHOTS = path.resolve(process.env.SHOTS_DIR ?? './screenshots')
const VERBOSE = Boolean(process.env.E2E_VERBOSE)
const WIN = process.platform === 'win32'
mkdirSync(SHOTS, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const failures = []
const log = (s) => process.stdout.write(`${s}\n`)

async function until(label, fn, { timeout = 15_000, interval = 100 } = {}) {
  const start = Date.now()
  let last
  for (;;) {
    try {
      const v = await fn()
      if (v) return v
    } catch (e) {
      last = e
    }
    if (Date.now() - start > timeout) throw new Error(`timed out after ${timeout} ms waiting for: ${label}${last ? ` (${String(last.message ?? last).slice(0, 160)})` : ''}`)
    await sleep(interval)
  }
}

let page
let shotN = 0
async function shot(name, p = page) {
  if (!p) return
  const file = path.join(SHOTS, `e2e-term-${String(++shotN).padStart(2, '0')}-${name.replace(/\W+/g, '-').toLowerCase()}.png`)
  await p.screenshot({ path: file }).catch(() => undefined)
}

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

// ------------------------------------------------------------------------------------------------ processes

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

const maskCode = (s) => s.replace(/code=[\w-]+/g, 'code=***').replace(/#tp=[\w-]+/g, '#tp=***')
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Live (not zombie) processes whose whole command line is exactly this. Linux only. */
function runningCmd(cmdline) {
  if (WIN) return []
  const out = []
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    try {
      const cmd = readFileSync(`/proc/${name}/cmdline`, 'latin1').split('\0').filter(Boolean).join(' ')
      if (cmd !== cmdline) continue
      const stat = readFileSync(`/proc/${name}/stat`, 'latin1')
      const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3)
      if (state !== 'Z' && state !== 'X') out.push(Number(name))
    } catch {
      /* vanished while being read */
    }
  }
  return out
}
const killCmd = (cmdline) => runningCmd(cmdline).forEach((pid) => { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } })
/** The PTY host processes (children of this daemon whose command line names ptyHost). */
function hostsOf(daemonPid) {
  if (WIN) return []
  const out = []
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'latin1')
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
      if (ppid !== daemonPid) continue
      if (readFileSync(`/proc/${name}/cmdline`, 'latin1').includes('ptyHost')) out.push(Number(name))
    } catch {
      /* vanished */
    }
  }
  return out
}

const daemons = new Set()
async function startDaemon({ port, dataDir, env: extra }) {
  const env = { ...process.env, DAEMON_PORT: String(port), DATA_DIR: dataDir, CLAUDE_BACKEND: 'fake', LOG_LEVEL: 'warn', ...extra }
  delete env.ANTHROPIC_API_KEY
  delete env.DEMO
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
  child.once('exit', () => (d.exited = true))
  d.exchangeUrl = await until(
    'the daemon to print its sign-in link',
    () => {
      if (d.exited) throw new Error(`the daemon exited early:\n${maskCode(d.out).slice(-1500)}`)
      return /Sign in\s+(http:\/\/127\.0\.0\.1:\d+\/\?code=[\w-]+(?:#[\w=&-]+)?)/.exec(d.out)?.[1]
    },
    { timeout: 40_000 },
  )
  d.proof = /#tp=([\w-]+)/.exec(d.exchangeUrl)?.[1]
  proofs.set(port, d.proof)
  return d
}

async function stopDaemon(d, signal = 'SIGTERM') {
  if (!d || d.exited) return
  const gone = new Promise((r) => d.child.once('exit', r))
  d.child.kill(signal)
  await Promise.race([gone, sleep(12_000)])
  if (!d.exited) d.child.kill('SIGKILL')
  daemons.delete(d)
}

/** The terminal pairing proof of each daemon, by port: the part after "#tp=" of the sign-in link it printed. */
const proofs = new Map()
const isTerminalRoute = (url) => /^\/api\/(?:terminals|settings\/terminals)(?:[/?]|$)/.test(url)

/** `noProof: true` plays a client that does not have the pairing (a program replaying a stolen cookie). */
function raw({ port, method = 'GET', url = '/', headers = {}, body, noProof = false }) {
  return new Promise((resolve, reject) => {
    const sent = { ...headers }
    if (!noProof && isTerminalRoute(url) && proofs.get(port) && sent['X-Terminal-Proof'] === undefined) sent['X-Terminal-Proof'] = proofs.get(port)
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: sent, timeout: 8000 }, (res) => {
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
  if (process.env.SKIP_BUILD) return
  const index = path.join(webDir, 'dist', 'index.html')
  const builtAt = existsSync(index) ? statSync(index).mtimeMs : 0
  const sourceAt = Math.max(
    newest(path.join(webDir, 'src')),
    newest(path.join(sharedDir, 'src')),
    existsSync(path.join(webDir, 'index.html')) ? statSync(path.join(webDir, 'index.html')).mtimeMs : 0,
    statSync(path.join(webDir, 'vite.config.ts')).mtimeMs,
  )
  if (builtAt > sourceAt) return log('web build is up to date')
  log(builtAt ? 'web build is stale, rebuilding (pnpm --filter @ai-assistant/web build)' : 'no web build, building (pnpm --filter @ai-assistant/web build)')
  const r = spawnSync('pnpm', ['--filter', '@ai-assistant/web', 'build'], { cwd: root, stdio: 'inherit', shell: WIN })
  if (r.status !== 0) throw new Error('the web build failed')
}

// ------------------------------------------------------------------------------------------------ a node WebSocket client

/** Open a terminal socket. Resolves with a handle, or rejects with {status, body} when the handshake is refused. */
function openTerminalSocket({ port, id, origin, cookie, host }) {
  return new Promise((resolve, reject) => {
    const headers = {}
    if (origin !== null) headers.Origin = origin
    if (cookie) headers.Cookie = cookie
    if (host) headers.Host = host
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal/${encodeURIComponent(id)}`, { headers })
    const h = { ws, text: [], bin: [], closeInfo: undefined }
    h.closed = new Promise((res) =>
      ws.on('close', (code, reason) => {
        h.closeInfo = { code, reason: reason.toString() }
        res(h.closeInfo)
      }),
    )
    ws.on('message', (data, isBinary) => (isBinary ? h.bin.push(Buffer.from(data)) : h.text.push(JSON.parse(data.toString()))))
    ws.once('open', () => resolve(h))
    ws.once('error', () => {})
    ws.once('unexpected-response', (_req, res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode, body })))
    })
  })
}

// ------------------------------------------------------------------------------------------------ main

let browser
let tmp
let d1
const pidsToReap = new Set()

try {
  ensureBuild()
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'mira-term-e2e-')))
  const dataDir = path.join(tmp, 'data')
  const homeDir = path.join(tmp, 'home')
  const projectDir = path.join(tmp, 'project-atlas')
  mkdirSync(homeDir, { recursive: true })
  mkdirSync(projectDir, { recursive: true })

  // The test "claude": prints a banner with its pid and cwd, echoes typed lines, reports resizes, exits on "quit".
  const fakeClaude = path.join(tmp, 'fake-claude.mjs')
  writeFileSync(
    fakeClaude,
    `process.stdout.write('FAKE-CLAUDE ready PID:' + process.pid + ' CWD:' + process.cwd() + ' SIZE:' + process.stdout.columns + 'x' + process.stdout.rows + '\\r\\n')
process.stdout.on('resize', () => process.stdout.write('RESIZED:' + process.stdout.columns + 'x' + process.stdout.rows + '\\r\\n'))
process.stdin.setEncoding('utf8')
let line = ''
process.stdin.on('data', (d) => { for (const ch of d) { if (ch === '\\r' || ch === '\\n') { if (line.trim()) process.stdout.write('ECHO:' + line + '\\r\\n'); if (line === 'quit') process.exit(0); line = '' } else line += ch } })
if (process.stdin.isTTY) process.stdin.setRawMode(true)
setInterval(() => {}, 1000)
`,
  )

  writeFileSync(path.join(tmp, 'noop-loader.cjs'), '// the daemon launcher\'s loader (a stand-in): harmless, and must never reach a terminal\n')
  const port = await freePort()
  d1 = await startDaemon({
    port,
    dataDir,
    env: {
      TERMINAL_CLAUDE_COMMAND: JSON.stringify([process.execPath, fakeClaude]),
      HOME: homeDir,
      USERPROFILE: homeDir,
      ...(WIN ? {} : { SHELL: '/bin/sh' }),
      // Planted secrets: they must never reach a terminal (the shell test below prints its environment).
      AI_ASSISTANT_HOOK_TOKEN: 'E2E-PLANTED-HOOK-TOKEN-0123456789ABCDEF',
      STAGE_TOKEN: 'E2E-PLANTED-STAGE-TOKEN',
      // The daemon's launcher: a pnpm-shim style NODE_PATH next to the user's own entry, and NODE_OPTIONS with a harmless
      // code-loading flag next to a flag that is the user's own. The terminal must get the user's parts only.
      NODE_PATH: `${path.join(root, 'node_modules', '.pnpm', 'e2e-launcher@1', 'node_modules')}${path.delimiter}${path.join(tmp, 'user-modules')}`,
      NODE_OPTIONS: `--require ${path.join(tmp, 'noop-loader.cjs')} --max-old-space-size=1024`,
    },
  })
  log(`daemon up on 127.0.0.1:${port} (data dir ${dataDir})`)
  const hookToken = JSON.parse(readFileSync(path.join(dataDir, 'secrets.json'), 'utf8')).hookToken
  const origin = `http://127.0.0.1:${port}`

  browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
  const context = await browser.newContext({ viewport: { width: 1500, height: 950 } })
  await context.addInitScript(() => {
    const Native = window.WebSocket
    const spy = (window.__ws = { urls: [] })
    window.WebSocket = class extends Native {
      constructor(url, protocols) {
        super(url, protocols)
        spy.urls.push(String(url))
      }
    }
  })

  page = await context.newPage()
  const errors = []
  // Expected while the gate is closed or a terminal was just killed: the browser logs refused requests and dropped sockets.
  let expectRefusals = 0
  const isNoise = (t) => /GPU stall|WebGL|GL Driver|swiftshader|THREE\.Clock/i.test(t)
  const isRefusal = (t) => /status of 403|WebSocket connection to|status of 404|Failed to load resource/i.test(t)
  page.on('console', (m) => {
    if (m.type() !== 'error') return
    const t = m.text()
    if (isNoise(t) || (expectRefusals > 0 && isRefusal(t))) return
    errors.push(t.slice(0, 260))
  })
  page.on('pageerror', (e) => errors.push(`PAGEERROR ${String(e.message).slice(0, 260)}`))

  const nav = (label) => page.locator(`nav[aria-label="Main"] button[aria-label="${label}"]`).click()
  const apiFetch = (method, url, body) =>
    page.evaluate(
      async ({ method, url, body }) => {
        // the page's own stored pairing proof (taken from the sign-in link by terminalClient.ts), on terminal routes only
        const proof = /^\/api\/(?:terminals|settings\/terminals)(?:[/?]|$)/.test(url) ? localStorage.getItem('aia.terminalProof') : null
        const r = await fetch(url, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(proof ? { 'X-Terminal-Proof': proof } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
        const text = await r.text()
        let json
        try {
          json = JSON.parse(text)
        } catch {
          /* not json */
        }
        return { status: r.status, json }
      },
      { method, url, body },
    )
  const openTerminalTab = async () => {
    await nav('Work')
    await page.getByRole('heading', { name: 'Mission control' }).waitFor({ timeout: 10_000 })
    await page.getByRole('tab', { name: 'Terminal' }).click()
  }
  const hostLocator = () => page.locator('[data-testid="terminal-host"]')
  const screenText = async () => (await hostLocator().locator('.xterm-rows').innerText().catch(() => '')).replace(/ /g, ' ')
  const waitScreen = (re, label, timeout = 15_000) => until(label, async () => (re.test(await screenText()) ? true : false), { timeout })
  const waitLive = () => until('the terminal to be connected', async () => (await hostLocator().getAttribute('data-phase')) === 'live', { timeout: 20_000 })
  const listApi = async () => (await apiFetch('GET', '/api/terminals')).json
  const typeLine = async (text) => {
    await hostLocator().click()
    await page.keyboard.type(text, { delay: 8 })
    await page.keyboard.press('Enter')
  }
  const shellCommand = WIN ? 'echo ("e2e-" + (6*7) + "-done")' : 'echo e2e-$((6*7))-done'
  const shellMarker = /e2e-42-done/
  // Distinct commands whose OUTPUT differs from what is typed, so a match proves the shell really ran them.
  const markerCommand = (word, a, b) => (WIN ? `echo ("${word}-" + (${a}*${b}) + "-marker")` : `echo ${word}-$((${a}*${b}))-marker`)

  // ---------------------------------------------------------------- 1. sign in
  log('\n-- sign in')
  await page.goto(d1.exchangeUrl)
  await page.waitForSelector('nav[aria-label="Main"]', { timeout: 30_000 })
  await check(
    'the UI loads in Live mode against the daemon',
    async () => {
      const badge = page.locator('[data-testid="mode-badge"]')
      await until('Live badge', async () => (await badge.getAttribute('data-mode')) === 'daemon' && (await badge.getAttribute('data-link')) === 'up')
      return (await badge.innerText()).trim().replace(/\s+/g, ' ')
    },
    { fatal: true },
  )

  // ---------------------------------------------------------------- 2. refused until enabled
  log('\n-- the gate')
  await check('every terminal API route answers 403 terminals_disabled until terminals are switched on', async () => {
    expectRefusals++
    const results = [
      await apiFetch('GET', '/api/terminals'),
      await apiFetch('POST', '/api/terminals', { kind: 'shell' }),
      await apiFetch('GET', '/api/terminals/nope'),
      await apiFetch('DELETE', '/api/terminals/nope'),
      await apiFetch('POST', '/api/terminals/nope/ticket', {}),
    ]
    for (const r of results) if (r.status !== 403 || r.json?.error !== 'terminals_disabled') throw new Error(`got ${r.status} ${JSON.stringify(r.json)}`)
    return `${results.length} routes refused`
  })
  await check('the Terminal tab explains that terminals are off and links to Settings', async () => {
    await openTerminalTab()
    const box = page.locator('[data-testid="terminal-disabled"]')
    await box.waitFor({ timeout: 10_000 })
    const text = await box.innerText()
    if (!/switched off/i.test(text) || !/runs commands as you/i.test(text)) throw new Error(`copy: ${text.slice(0, 120)}`)
    if ((await page.getByRole('button', { name: /Open Settings, Privacy/ }).count()) !== 1) throw new Error('no link to Settings')
  })
  await shot('terminal tab off')

  // ---------------------------------------------------------------- 3. switch it on in Settings
  log('\n-- enabling in Settings')
  await check('the link opens Settings > Privacy, where an honest switch is off', async () => {
    await page.getByRole('button', { name: /Open Settings, Privacy/ }).click()
    const sw = page.getByRole('switch', { name: 'Embedded terminals' })
    await sw.waitFor({ timeout: 10_000 })
    if ((await sw.getAttribute('aria-checked')) !== 'false') throw new Error('the switch is not off by default')
    const text = await page.locator('main').innerText()
    if (!/runs commands as you/i.test(text) || !/never written to disk/i.test(text)) throw new Error('the explanation is missing')
  })
  await shot('settings terminals off')
  await check('switching it on persists, is audited and shows in the snapshot', async () => {
    await page.getByRole('switch', { name: 'Embedded terminals' }).click()
    await until('switch on', async () => (await page.getByRole('switch', { name: 'Embedded terminals' }).getAttribute('aria-checked')) === 'true')
    const snap = (await apiFetch('GET', '/api/snapshot')).json
    if (snap.settings?.terminals?.enabled !== true) throw new Error('snapshot does not say enabled')
    if (!snap.settings.audit.some((a) => a.action === 'Turned embedded terminals on')) throw new Error('no audit entry')
  })

  // ---------------------------------------------------------------- 4. a real shell
  log('\n-- a real shell')
  await check('New shell opens a terminal and connects', async () => {
    await openTerminalTab()
    await page.getByRole('button', { name: 'New shell' }).click()
    await waitLive()
    const list = await listApi()
    if (list.length !== 1 || list[0].kind !== 'shell') throw new Error(`list: ${JSON.stringify(list)}`)
    if (realpathSync(list[0].cwd) !== realpathSync(homeDir)) throw new Error(`cwd ${list[0].cwd}`)
    return list[0].title
  })
  const shellId = (await listApi())[0]?.id
  await check('typing produces output from a real PTY', async () => {
    await typeLine(shellCommand)
    await waitScreen(shellMarker, 'the command output')
  })
  await check('daemon secrets are not in the shell environment (counted, never printed)', async () => {
    // Only counts reach the screen: the whole environment must not end up in a screenshot of the user's PC.
    const secrets = WIN
      ? 'echo ("secrets-" + @(Get-ChildItem env: | Where-Object { $_.Name -match "AI_ASSISTANT|STAGE_TOKEN|HOOK_TOKEN" -or $_.Value -match "PLANTED" }).Count + "-found")'
      : 'echo secrets-$(env | grep -c -E "PLANTED|HOOK_TOKEN|STAGE_TOKEN")-found'
    const path = WIN ? 'echo ("path-" + @(Get-ChildItem env: | Where-Object { $_.Name -eq "PATH" }).Count + "-present")' : 'echo path-$(env | grep -c "^PATH=")-present'
    await typeLine(secrets)
    await waitScreen(/secrets-\d+-found/, 'the secret count')
    if (!/secrets-0-found/.test(await screenText())) throw new Error('a planted secret is visible in the shell environment')
    await typeLine(path)
    await waitScreen(/path-1-present/, 'the PATH control (the environment itself is not empty)')
  })
  await check('a window resize reaches the process', async () => {
    const before = (await listApi())[0]
    await page.setViewportSize({ width: 1000, height: 800 })
    await until('the daemon to learn the new size', async () => {
      const now = (await listApi())[0]
      return now.cols !== before.cols || now.rows !== before.rows
    })
    const after = (await listApi())[0]
    return `${before.cols}x${before.rows} -> ${after.cols}x${after.rows}`
  })
  await check('the shell prints a marker right before the reload test', async () => {
    await typeLine(markerCommand('reload', 7, 7))
    await waitScreen(/reload-49-marker/, 'the marker')
  })
  await shot('shell running')

  // ---------------------------------------------------------------- 5. claude (test command)
  log('\n-- a Claude terminal (test command)')
  await check('New Claude terminal starts the (test) claude and shows its banner', async () => {
    await page.getByRole('button', { name: 'New Claude terminal' }).click()
    await waitLive()
    await waitScreen(/FAKE-CLAUDE ready PID:\d+/, 'the banner')
    const m = /PID:(\d+)/.exec(await screenText())
    pidsToReap.add(Number(m[1]))
  })
  await check('typing reaches the program and a resize is reported to it', async () => {
    await typeLine('hello from the browser')
    await waitScreen(/ECHO:hello from the browser/, 'the echo')
    await page.setViewportSize({ width: 1300, height: 900 })
    await waitScreen(/RESIZED:\d+x\d+/, 'the program to see the resize')
  })

  // A project makes "Open Claude here" appear. Hooks are how projects are discovered.
  await raw({
    port,
    method: 'POST',
    url: '/hooks/SessionStart',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hookToken}` },
    body: JSON.stringify({ session_id: 'e2e-term-sess', cwd: projectDir, hook_event_name: 'SessionStart', source: 'startup' }),
  })
  await check('"Open Claude here" starts in the project folder', async () => {
    await until('the project in the tab', async () => (await page.getByRole('button', { name: /Open Claude here: / }).count()) > 0, { timeout: 15_000 })
    await page.getByRole('button', { name: /Open Claude here: / }).first().click()
    await until('a third terminal', async () => (await listApi()).length === 3)
    await waitLive()
    await waitScreen(/CWD:/, 'the banner with the folder')
    const m = /CWD:(\S+)/.exec(await screenText())
    if (realpathSync(m[1]) !== realpathSync(projectDir)) throw new Error(`cwd ${m[1]}`)
    const pid = /PID:(\d+)/.exec(await screenText())
    pidsToReap.add(Number(pid[1]))
  })
  await shot('claude in project')

  // ---------------------------------------------------------------- 6. reload reattaches
  log('\n-- reload and reattach')
  const beforeReload = await listApi()
  const claudeInfo = beforeReload.find((t) => t.kind === 'claude' && t.projectId)
  await check('a page reload reattaches to the SAME running terminal and replays the screen', async () => {
    await page.reload()
    await page.waitForSelector('nav[aria-label="Main"]', { timeout: 30_000 })
    await openTerminalTab()
    const row = page.locator(`[data-terminal-id="${shellId}"]`)
    await row.waitFor({ timeout: 15_000 })
    await row.getByRole('button', { name: /^Open |^Show/ }).first().click()
    await waitLive()
    await waitScreen(/reload-49-marker/, 'the earlier output to be replayed')
    const after = await listApi()
    if (after.length !== beforeReload.length) throw new Error(`terminal count changed ${beforeReload.length} -> ${after.length}`)
    if (!after.every((t) => t.state === 'running')) throw new Error('a terminal is not running any more')
    if (after.find((t) => t.id === shellId)?.createdAt !== beforeReload.find((t) => t.id === shellId)?.createdAt) throw new Error('the shell was replaced, not reattached')
    // and it still works
    await typeLine(markerCommand('after', 8, 8))
    await waitScreen(/after-64-marker/, 'a new command to run in the reattached shell')
  })
  await check('no ticket or token ever appears in a WebSocket URL', async () => {
    const urls = await page.evaluate(() => window.__ws.urls)
    const term = urls.filter((u) => new URL(u).pathname.startsWith('/ws/terminal/'))
    if (term.length === 0) throw new Error('the page opened no terminal socket')
    for (const u of term) if (new URL(u).search !== '') throw new Error(`query in ${u}`)
    for (const u of urls) if (/ticket|token|code=/i.test(u)) throw new Error(`secret-looking URL ${u}`)
    return `${term.length} terminal sockets, no query strings`
  })

  // ---------------------------------------------------------------- 7. protocol level
  log('\n-- the WebSocket protocol (node client)')
  const cookies = await context.cookies()
  const sid = cookies.find((c) => c.name.startsWith('aia_sid_'))
  const cookie = `${sid.name}=${sid.value}`
  // Two spare terminals nobody is attached to.
  const mk = async () => (await raw({ port, method: 'POST', url: '/api/terminals', headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie }, body: JSON.stringify({ kind: 'shell' }) }))
  const ticketFor = async (id) => {
    const r = await raw({ port, method: 'POST', url: `/api/terminals/${id}/ticket`, headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie }, body: '{}' })
    if (r.status !== 200) throw new Error(`ticket answered ${r.status}`)
    return JSON.parse(r.text).ticket
  }
  // The UI has 3 terminals; the cap is 4. Close the claude-in-project one through the API first to make room for two.
  await raw({ port, method: 'DELETE', url: `/api/terminals/${claudeInfo.id}`, headers: { Origin: origin, Cookie: cookie } })
  pidsToReap.delete(undefined)
  const a = await mk()
  if (a.status !== 201) throw new Error(`could not create a spare terminal: ${a.status} ${a.text.slice(0, 120)}`)
  const spareA = JSON.parse(a.text).id
  const b = await raw({ port, method: 'DELETE', url: `/api/terminals/${spareA}`, headers: { Origin: origin, Cookie: cookie } }).then(() => mk())
  const spareB = JSON.parse(b.text).id

  await check('the ticket works once, then is refused', async () => {
    const t = await ticketFor(spareB)
    const first = await openTerminalSocket({ port, id: spareB, origin, cookie })
    first.ws.send(JSON.stringify({ type: 'auth', ticket: t }))
    await until('ready frame', async () => first.text.some((m) => m.type === 'ready'))
    first.ws.close()
    await first.closed
    await sleep(150)
    const second = await openTerminalSocket({ port, id: spareB, origin, cookie })
    second.ws.send(JSON.stringify({ type: 'auth', ticket: t }))
    const info = await second.closed
    if (info.code !== 4401) throw new Error(`close code ${info.code}`)
  })
  await check('a ticket minted for one terminal is refused on another', async () => {
    const t = await ticketFor(spareB)
    const other = shellId
    const h = await openTerminalSocket({ port, id: other, origin, cookie })
    h.ws.send(JSON.stringify({ type: 'auth', ticket: t }))
    const info = await h.closed
    if (info.code !== 4401) throw new Error(`close code ${info.code}`)
  })
  await check('a cross-origin WebSocket (and a dev-origin REST call or switch) is refused before it opens (403)', async () => {
    const t = await ticketFor(spareB)
    void t
    // 5173 is the Vite dev origin the daemon allows for the rest of the API: terminals refuse it unless TERMINAL_ALLOW_DEV_ORIGINS is set.
    for (const bad of ['http://evil.example', 'http://127.0.0.1:1', 'null', 'http://127.0.0.1:5173', 'http://localhost:5173']) {
      const err = await openTerminalSocket({ port, id: spareB, origin: bad, cookie }).then(
        () => null,
        (e) => e,
      )
      if (!err || err.status !== 403) throw new Error(`origin ${bad}: ${err ? err.status : 'connected'}`)
    }
    const devRest = await raw({ port, method: 'GET', url: '/api/terminals', headers: { Origin: 'http://127.0.0.1:5173', Cookie: cookie } })
    if (devRest.status !== 403 || !/forbidden_origin/.test(devRest.text)) throw new Error(`REST from the dev origin answered ${devRest.status}`)
    const devSwitch = await raw({ port, method: 'PUT', url: '/api/settings/terminals', headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:5173', Cookie: cookie }, body: JSON.stringify({ on: false }) })
    if (devSwitch.status !== 403) throw new Error(`the switch from the dev origin answered ${devSwitch.status}`)
    const noOrigin = await openTerminalSocket({ port, id: spareB, origin: null, cookie }).then(() => null, (e) => e)
    if (!noOrigin || noOrigin.status !== 403) throw new Error('a socket without Origin was not refused')
    const wrongHost = await openTerminalSocket({ port, id: spareB, origin, cookie, host: 'evil.example:80' }).then(() => null, (e) => e)
    if (!wrongHost || wrongHost.status !== 403) throw new Error('a wrong Host was not refused')
    const noCookie = await openTerminalSocket({ port, id: spareB, origin, cookie: null }).then(() => null, (e) => e)
    if (!noCookie || noCookie.status !== 401) throw new Error(`a socket without the cookie answered ${noCookie?.status}`)
  })
  await check('the live feed (/ws) read from a dev origin carries nothing about terminals: no list, no audit entry with an id; the daemon\'s own origin sees them', async () => {
    const snap = await raw({ port, method: 'GET', url: '/api/snapshot', headers: { Origin: origin, Cookie: cookie } })
    const epoch = String(snap.headers['x-daemon-epoch'] ?? '')
    if (snap.status !== 200 || !epoch) throw new Error(`snapshot ${snap.status}, epoch ${epoch || 'missing'}`)
    // The replay of everything since the start of the daemon (or, when the ring no longer reaches back, a fresh snapshot.reset): the audit log is full of terminals by now.
    const feedText = (o) =>
      new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?since=0&epoch=${epoch}`, { headers: { Origin: o, Cookie: cookie } })
        const texts = []
        ws.on('message', (d, bin) => {
          if (!bin) texts.push(d.toString())
        })
        ws.once('error', reject)
        ws.once('open', () =>
          setTimeout(() => {
            ws.close()
            resolve(texts)
          }, 1200),
        )
      })
    const TERM_ID = /\bterm-[a-z0-9]+-[a-z0-9]+-[0-9a-f]{4}\b/ // the daemon's terminal ids (the hook session of this script is called e2e-term-sess)
    const own = (await feedText(origin)).join('\n')
    if (!TERM_ID.test(own)) throw new Error('the own-origin feed shows no terminal id either, so this check would prove nothing')
    for (const dev of ['http://127.0.0.1:5173', 'http://localhost:5173']) {
      const text = (await feedText(dev)).join('\n')
      if (!/snapshot\.reset|settings\.update/.test(text)) throw new Error(`${dev}: the feed carried no snapshot or settings event, so there was nothing to check`)
      if (TERM_ID.test(text) || /Opened a terminal|Closed (?:an idle |a )?terminal|Refused to open a terminal|A terminal exited|Turned embedded terminals|(?:shell|claude) terminal/i.test(text)) throw new Error(`${dev}: the feed mentions a terminal: ${(/.{40}(?:\bterm-[a-z0-9]+-|terminal ).{40}/i.exec(text) ?? [''])[0]}`)
    }
  })
  await check('a socket that never sends the auth frame is closed (about 5 seconds)', async () => {
    const h = await openTerminalSocket({ port, id: spareB, origin, cookie })
    const started = Date.now()
    const info = await h.closed
    const secs = (Date.now() - started) / 1000
    if (info.code !== 4408) throw new Error(`close code ${info.code}`)
    if (secs < 3 || secs > 9) throw new Error(`closed after ${secs.toFixed(1)} s`)
    return `${secs.toFixed(1)} s`
  })
  await check('a second client on a terminal that already has one is refused with a clear error', async () => {
    const t1 = await ticketFor(spareB)
    const one = await openTerminalSocket({ port, id: spareB, origin, cookie })
    one.ws.send(JSON.stringify({ type: 'auth', ticket: t1 }))
    await until('first client ready', async () => one.text.some((m) => m.type === 'ready'))
    const t2 = await ticketFor(spareB)
    const two = await openTerminalSocket({ port, id: spareB, origin, cookie })
    two.ws.send(JSON.stringify({ type: 'auth', ticket: t2 }))
    const info = await two.closed
    if (info.code !== 4409 || !two.text.some((m) => m.type === 'error' && m.message === 'already_attached')) throw new Error(`code ${info.code}, ${JSON.stringify(two.text)}`)
    one.ws.close()
    await one.closed
  })
  await check('keystrokes sent as binary frames run in a real shell; the PTY outlives its socket', async () => {
    const t = await ticketFor(spareB)
    const h = await openTerminalSocket({ port, id: spareB, origin, cookie })
    h.ws.send(JSON.stringify({ type: 'auth', ticket: t }))
    await until('ready', async () => h.text.some((m) => m.type === 'ready'))
    h.ws.send(Buffer.from(`${shellCommand}\r`))
    await until('command output', async () => /e2e-42-done/.test(Buffer.concat(h.bin).toString('utf8').replace(shellCommand, '')))
    h.ws.close()
    await h.closed
    await sleep(200)
    const info = (await listApi()).find((x) => x.id === spareB)
    if (!info || info.state !== 'running') throw new Error('the terminal did not survive its socket')
  })

  // ---------------------------------------------------------------- 8. closing kills the process
  log('\n-- closing kills the process')
  await check('closing the (test) Claude terminal in the UI ends its process', async () => {
    await page.reload()
    await page.waitForSelector('nav[aria-label="Main"]', { timeout: 30_000 })
    await openTerminalTab()
    const claudeRow = page.locator('[data-terminal-kind="claude"]').first()
    await claudeRow.waitFor({ timeout: 15_000 })
    await claudeRow.getByRole('button', { name: /^Open |^Show/ }).first().click()
    await waitLive()
    await waitScreen(/FAKE-CLAUDE ready PID:\d+/, 'banner after the reload')
    const pid = Number(/PID:(\d+)/.exec(await screenText())[1])
    if (!alive(pid)) throw new Error('the process is not running before the close')
    await page.getByRole('button', { name: 'Close this terminal and end its process' }).click()
    await until('the process to be gone', async () => !alive(pid), { timeout: 10_000 })
    await until('the row to disappear', async () => (await page.locator('[data-terminal-kind="claude"]').count()) === 0, { timeout: 10_000 })
    pidsToReap.delete(pid)
    return `pid ${pid} gone`
  })


  // ---------------------------------------------------------------- 8b. the adversarial review's findings
  log('\n-- pairing, descriptors, process trees, links, the loader environment')

  /** Every terminal except the UI's own shell goes: each check below starts from the same clean state. */
  const dropExtras = async () => {
    for (const t of await listApi()) if (t.id !== shellId) await raw({ port, method: 'DELETE', url: `/api/terminals/${t.id}`, headers: { Origin: origin, Cookie: cookie } })
  }
  await dropExtras()
  const nodeShell = async () => {
    const r = await raw({ port, method: 'POST', url: '/api/terminals', headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie }, body: JSON.stringify({ kind: 'shell' }) })
    if (r.status !== 201) throw new Error(`create answered ${r.status} ${r.text.slice(0, 100)}`)
    const id = JSON.parse(r.text).id
    const h = await openTerminalSocket({ port, id, origin, cookie })
    h.ws.send(JSON.stringify({ type: 'auth', ticket: await ticketFor(id) }))
    await until('the shell to be ready', async () => h.text.some((m) => m.type === 'ready'))
    h.id = id
    h.screen = () => Buffer.concat(h.bin).toString('utf8')
    h.type = (t) => h.ws.send(Buffer.from(`${t}\r`))
    h.remove = () => raw({ port, method: 'DELETE', url: `/api/terminals/${id}`, headers: { Origin: origin, Cookie: cookie } })
    return h
  }

  await check('the page took the pairing proof out of the address bar and keeps it for this origin only', async () => {
    const hash = new URL(page.url()).hash
    if (/tp=/.test(page.url()) || hash !== '') throw new Error(`the address bar still has it: ${page.url().replace(/code=[\w-]+/, 'code=***')}`)
    const stored = await page.evaluate(() => localStorage.getItem('aia.terminalProof'))
    if (!d1.proof || stored !== d1.proof) throw new Error('the page did not keep the proof it was handed in the sign-in link')
  })
  await check('a program replaying the session cookie WITHOUT the pairing cannot start a terminal, mint a ticket or switch terminals on', async () => {
    const stolen = cookie
    const h = { 'Content-Type': 'application/json', Origin: origin, Cookie: stolen }
    const must401 = async (label, args) => {
      const r = await raw({ port, noProof: true, ...args })
      if (r.status !== 401 || !/terminal_proof_required/.test(r.text)) throw new Error(`${label}: answered ${r.status} ${r.text.slice(0, 80)}`)
    }
    await must401('list', { method: 'GET', url: '/api/terminals', headers: h })
    await must401('create', { method: 'POST', url: '/api/terminals', headers: h, body: '{"kind":"shell"}' })
    await must401('ticket', { method: 'POST', url: `/api/terminals/${shellId}/ticket`, headers: h, body: '{}' })
    await must401('switch on', { method: 'PUT', url: '/api/settings/terminals', headers: h, body: '{"on":true}' })
    const wrong = await raw({ port, noProof: true, method: 'GET', url: '/api/terminals', headers: { ...h, 'X-Terminal-Proof': hookToken } })
    if (wrong.status !== 401) throw new Error(`a wrong proof answered ${wrong.status}`)
    const right = await raw({ port, method: 'GET', url: '/api/terminals', headers: h })
    if (right.status !== 200) throw new Error(`the right proof answered ${right.status}`)
  })
  await check('a browser that has the cookie but not the pairing is told how to pair, and its terminal calls are refused', async () => {
    const sid1 = (await context.cookies()).find((c) => c.name.startsWith('aia_sid_'))
    const ctx2 = await browser.newContext({ viewport: { width: 1300, height: 900 } })
    try {
      await ctx2.addCookies([{ name: sid1.name, value: sid1.value, url: origin, httpOnly: true, sameSite: 'Strict' }])
      const p2 = await ctx2.newPage()
      await p2.goto(`${origin}/`)
      await p2.waitForSelector('nav[aria-label="Main"]', { timeout: 30_000 })
      await p2.locator('nav[aria-label="Main"] button[aria-label="Work"]').click()
      await p2.getByRole('heading', { name: 'Mission control' }).waitFor({ timeout: 10_000 })
      await p2.getByRole('tab', { name: 'Terminal' }).click()
      const note = p2.locator('[data-testid="terminal-unpaired"]')
      await note.waitFor({ timeout: 10_000 })
      if (!/not paired/i.test(await note.innerText())) throw new Error('the note does not say the browser is not paired')
      await p2.getByRole('button', { name: 'New shell' }).click()
      const err = p2.locator('[data-testid="terminal-error"]')
      await err.waitFor({ timeout: 10_000 })
      const text = await err.innerText()
      if (!/not paired/i.test(text) || /signed out/i.test(text)) throw new Error(`error copy: ${text.slice(0, 120)}`)
      if ((await raw({ port, method: 'GET', url: '/api/terminals', headers: { Origin: origin, Cookie: cookie } })).status !== 200) throw new Error('the paired browser was affected')
    } finally {
      await ctx2.close()
    }
  })

  await check(WIN ? 'every terminal runs in its own PTY host (skipped on Windows: not verified there)' : 'a shell opened after another holds NO PTY master descriptor (each terminal runs in its own PTY host process)', async () => {
    if (WIN) return 'skipped'
    await dropExtras()
    const a = await nodeShell()
    const b = await nodeShell()
    const c = await nodeShell()
    b.type('echo MASTERS-$(ls -l /proc/$$/fd | grep -c ptmx)-END')
    c.type('echo MASTERS-$(ls -l /proc/$$/fd | grep -c ptmx)-END')
    for (const t of [b, c]) {
      const n = await until('the descriptor count', async () => /MASTERS-(\d+)-END/.exec(t.screen())?.[1])
      if (n !== '0') throw new Error(`a later shell sees ${n} PTY master descriptor(s)`)
    }
    // the daemon process itself holds none either, and every host holds exactly its own
    const own = (pid) => readdirSync(`/proc/${pid}/fd`).filter((f) => { try { return readlinkSync(`/proc/${pid}/fd/${f}`) === '/dev/ptmx' } catch { return false } }).length
    if (own(d1.child.pid) !== 0) throw new Error('the daemon holds a PTY master')
    const hosts = hostsOf(d1.child.pid)
    if (hosts.length < 3) throw new Error(`only ${hosts.length} PTY host processes`)
    for (const hpid of hosts) if (own(hpid) !== 1) throw new Error(`host ${hpid} holds ${own(hpid)} masters`)
    for (const t of [a, b, c]) await t.remove()
    return `${hosts.length} hosts, one master each`
  })

  await check(WIN ? 'closing a terminal ends its whole tree (skipped on Windows: not verified there)' : 'closing a terminal ends its WHOLE tree: background, nohup, subshell and HUP-ignoring jobs die with it', async () => {
    if (WIN) return 'skipped'
    const leaves = [424201, 424202, 424203, 424204, 424205]
    leaves.forEach((n) => killCmd(`sleep ${n}`))
    await dropExtras()
    const t = await nodeShell()
    t.type('sleep 424201 &')
    t.type('nohup sleep 424202 >/dev/null 2>&1 &')
    t.type('(sleep 424203 &)')
    t.type("trap '' HUP; sleep 424204 &")
    t.type(`sh -c 'trap "" HUP TERM INT; sleep 424205' &`)
    try {
      await until('the jobs to run', async () => leaves.every((n) => runningCmd(`sleep ${n}`).length > 0), { timeout: 15_000 })
      const started = Date.now()
      const del = await t.remove()
      if (del.status !== 204) throw new Error(`DELETE answered ${del.status}`)
      await until('every job to be gone', async () => leaves.every((n) => runningCmd(`sleep ${n}`).length === 0), { timeout: 10_000 })
      return `all ${leaves.length} gone ${((Date.now() - started) / 1000).toFixed(1)} s after the close`
    } finally {
      leaves.forEach((n) => killCmd(`sleep ${n}`))
    }
  })

  await check('the terminal tab says what it keeps (shell history is the shell\'s own) and the daemon\'s loader variables do not reach the shell', async () => {
    await openTerminalTab()
    const note = await page.locator('[data-testid="terminal-tab"] [role="note"]').first().innerText()
    if (!/history file/i.test(note) || !/own records|keep their own/i.test(note)) throw new Error(`note: ${note.slice(0, 160)}`)
    if (/never written to disk, logged, or shown/i.test(note)) throw new Error('the old over-claim is still there')
    await dropExtras()
    const t = await nodeShell()
    t.type('echo NP-[$NODE_PATH]-NP; echo NO-[$NODE_OPTIONS]-NO')
    const np = await until('NODE_PATH', async () => /NP-\[([^\]$]*)\]-NP/.exec(t.screen())?.[1])
    const no = await until('NODE_OPTIONS', async () => /NO-\[([^\]$]*)\]-NO/.exec(t.screen())?.[1])
    await t.remove()
    const userPath = path.join(tmp, 'user-modules')
    if (np !== userPath) throw new Error(`NODE_PATH in the shell: ${np}`)
    if (no !== '--max-old-space-size=1024') throw new Error(`NODE_OPTIONS in the shell: ${no}`)
  })

  await check('a flood of text frames closes the socket with 4429 and the terminal keeps running', async () => {
    await dropExtras()
    const t = await nodeShell()
    for (let i = 0; i < 400; i++) t.ws.send(JSON.stringify({ type: 'resize', cols: 80 + (i % 2), rows: 24 }))
    const info = await t.closed
    if (info.code !== 4429) throw new Error(`close code ${info.code}`)
    const listed = (await listApi()).find((x) => x.id === t.id)
    if (listed?.state !== 'running') throw new Error('the terminal did not survive the flood')
    await t.remove()
  })

  await check('a link a program prints (OSC 8) is only opened after a confirmation that shows the real address, and with noopener', async () => {
    await openTerminalTab()
    const row = page.locator(`[data-terminal-id="${shellId}"]`)
    await row.getByRole('button', { name: /^Open |^Show/ }).first().click()
    await waitLive()
    const dialogs = []
    let answer = 'dismiss'
    const onDialog = async (dlg) => {
      dialogs.push(dlg.message())
      await (answer === 'accept' ? dlg.accept() : dlg.dismiss()).catch(() => undefined)
    }
    page.on('dialog', onDialog)
    const popups = []
    const onPage = (p) => popups.push(p)
    context.on('page', onPage)
    try {
      await page.evaluate(() => {
        const original = window.open
        window.__opens = []
        window.open = (...a) => (window.__opens.push(a.map(String)), original.apply(window, a))
      })
      const link = (url, text) => `printf '\\033]8;;${url}\\033\\\\${text}\\033]8;;\\033\\\\\\n'`
      await typeLine(link('https://example.invalid/phish?x=1', 'CLICKME-OK'))
      await typeLine(link('https://github.com@evil.example/login', 'CLICKME-USERINFO'))
      await typeLine(link('javascript:window.__pwned=1', 'CLICKME-JS'))
      await waitScreen(/CLICKME-JS/, 'the links to be printed')
      const clickText = async (text) => {
        const box = await hostLocator().locator('.xterm-rows > div', { hasText: text }).last().boundingBox()
        if (!box) throw new Error(`no row with ${text}`)
        await page.mouse.move(box.x + 30, box.y + box.height / 2)
        await sleep(250)
        await page.mouse.click(box.x + 30, box.y + box.height / 2)
        await sleep(700)
      }
      // 1. a plain https link: a confirmation naming the real address; "no" opens nothing
      await clickText('CLICKME-OK')
      if (dialogs.length !== 1) throw new Error(`${dialogs.length} dialogs for the first click`)
      if (!/A program in this terminal printed a link/.test(dialogs[0]) || !dialogs[0].includes('https://example.invalid/phish?x=1')) throw new Error(`dialog: ${dialogs[0].slice(0, 200)}`)
      if (/Do you want to navigate to/.test(dialogs[0])) throw new Error('xterm.js\'s own confirmation was used')
      if (popups.length !== 0 || (await page.evaluate(() => window.__opens.length)) !== 0) throw new Error('the link was opened without a yes')
      // 2. "yes": opened with noopener and noreferrer, to exactly that address
      answer = 'accept'
      await clickText('CLICKME-OK')
      const opens = await page.evaluate(() => window.__opens)
      if (opens.length !== 1 || opens[0][0] !== 'https://example.invalid/phish?x=1' || !/noopener/.test(opens[0][2]) || !/noreferrer/.test(opens[0][2])) throw new Error(`window.open calls: ${JSON.stringify(opens)}`)
      await until('the popup', async () => popups.length === 1, { timeout: 5000 })
      await popups[0].close().catch(() => undefined)
      // 3. a link with a user name in it, and a javascript: link: nothing is offered, nothing opens
      const before = dialogs.length
      await clickText('CLICKME-USERINFO')
      await clickText('CLICKME-JS')
      if (dialogs.length !== before) throw new Error('a refused link still raised a dialog')
      if ((await page.evaluate(() => window.__opens.length)) !== 1) throw new Error('a refused link was opened')
      if ((await page.evaluate(() => window.__pwned)) !== undefined) throw new Error('script ran')
      if (!/was not opened/.test(await page.locator('[data-testid="terminal-status"]').innerText())) throw new Error('no notice about the refused link')
    } finally {
      page.off('dialog', onDialog)
      context.off('page', onPage)
    }
  })

  // Node-level checks of the link rules (the browser run above covers the wiring, these cover the cases).
  await check('the link rules: only plain http(s) without credentials or hidden characters, shown in their punycode form', async () => {
    const daemonRequire = createRequire(path.join(daemonDir, 'package.json'))
    const api = await import(pathToFileURL(daemonRequire.resolve('tsx/esm/api')).href)
    const mod = await api.tsImport(path.join(webDir, 'src', 'api', 'terminalClient.ts'), import.meta.url)
    const ok = (u) => mod.safeLinkTarget(u)
    if (ok('https://example.com/a?b=1#c')?.href !== 'https://example.com/a?b=1#c') throw new Error('a plain link is refused')
    if (ok('https://аpple.com/x')?.host !== 'xn--pple-43d.com') throw new Error('a look-alike host is not shown in punycode')
    const refused = ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'ftp://example.com/', 'https://user:pw@example.com/', 'https://github.com@evil.example/', 'http://', '', 'not a url', `https://example.com/${'a'.repeat(2100)}`, 'https://exa\u0000mple.com/', 'https://example.com/‮evil', 'https://example.com/​x', 'https://example.com/\nx']
    for (const u of refused) if (ok(u) !== undefined) throw new Error(`accepted ${JSON.stringify(u.slice(0, 40))}`)
    const calls = []
    const h = mod.createLinkHandler({ confirm: (m) => (calls.push(['confirm', m]), true), open: (href) => calls.push(['open', href]), setTitle: (t) => calls.push(['title', t]), refused: () => calls.push(['refused']) })
    h.activate({}, 'javascript:alert(1)')
    h.hover({}, 'https://example.com/')
    h.leave()
    if (JSON.stringify(calls.map((c) => c[0])) !== JSON.stringify(['refused', 'title', 'title'])) throw new Error(`calls: ${JSON.stringify(calls.map((c) => c[0]))}`)
    if (calls[1][1] !== 'https://example.com/' || calls[2][1] !== '') throw new Error('the hover title is wrong')
  })

  // ---------------------------------------------------------------- 9. disabling kills everything
  log('\n-- switching off')
  const survivorPids = []
  await check('a terminal that exits by itself stays listed with its exit code', async () => {
    const r = await raw({ port, method: 'POST', url: '/api/terminals', headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie }, body: JSON.stringify({ kind: 'claude' }) })
    if (r.status !== 201) throw new Error(`create answered ${r.status} ${r.text.slice(0, 100)}`)
    const id = JSON.parse(r.text).id
    const t = await ticketFor(id)
    const h = await openTerminalSocket({ port, id, origin, cookie })
    h.ws.send(JSON.stringify({ type: 'auth', ticket: t }))
    await until('banner', async () => /PID:(\d+)/.test(Buffer.concat(h.bin).toString('utf8')))
    h.ws.send(Buffer.from('quit\r'))
    await until('exit frame', async () => h.text.some((m) => m.type === 'exit'))
    const info = (await listApi()).find((x) => x.id === id)
    if (!info || info.state !== 'exited' || info.exitCode !== 0) throw new Error(`info: ${JSON.stringify(info)}`)
    await raw({ port, method: 'DELETE', url: `/api/terminals/${id}`, headers: { Origin: origin, Cookie: cookie } })
  })
  await check('switching terminals off kills every running terminal and empties the list', async () => {
    // one more Claude terminal so a known pid is running when the switch goes off
    const r = await raw({ port, method: 'POST', url: '/api/terminals', headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie }, body: JSON.stringify({ kind: 'claude' }) })
    const id = JSON.parse(r.text).id
    const t = await ticketFor(id)
    const h = await openTerminalSocket({ port, id, origin, cookie })
    h.ws.send(JSON.stringify({ type: 'auth', ticket: t }))
    const pid = Number(await until('pid', async () => /PID:(\d+)/.exec(Buffer.concat(h.bin).toString('utf8'))?.[1]))
    survivorPids.push(pid)
    if (!alive(pid)) throw new Error('the process is not running before switching off')
    const running = (await listApi()).filter((x) => x.state === 'running').length
    if (running < 2) throw new Error(`only ${running} running terminals`)

    await nav('Settings')
    await page.locator('#settings-tab-privacy').click()
    await page.getByRole('switch', { name: 'Embedded terminals' }).waitFor({ timeout: 10_000 })
    expectRefusals++
    await page.getByRole('switch', { name: 'Embedded terminals' }).click()
    await until('switch off', async () => (await page.getByRole('switch', { name: 'Embedded terminals' }).getAttribute('aria-checked')) === 'false')
    await until('the claude process to be gone', async () => !alive(pid), { timeout: 10_000 })
    await h.closed
    const list = await apiFetch('GET', '/api/terminals')
    if (list.status !== 403) throw new Error(`list answered ${list.status}`)
    const snap = (await apiFetch('GET', '/api/snapshot')).json
    if ((snap.terminals ?? []).length !== 0 || snap.settings.terminals.enabled !== false) throw new Error('the snapshot still lists terminals')
    if (!snap.settings.audit.some((x) => x.action === 'Turned embedded terminals off')) throw new Error('no audit entry for switching off')
    if (!snap.settings.audit.some((x) => /Closed a terminal/.test(x.action))) throw new Error('no audit entry for closing')
    const audit = JSON.stringify(snap.settings.audit)
    if (/hello from the browser|e2e-42-done|PLANTED/.test(audit)) throw new Error('keystrokes or output leaked into the audit log')
  })
  await check('the Terminal tab is back to the explanation', async () => {
    await openTerminalTab()
    await page.locator('[data-testid="terminal-disabled"]').waitFor({ timeout: 10_000 })
  })
  await shot('terminal tab off again')

  // ---------------------------------------------------------------- 10. shutdown leaves nothing behind
  log('\n-- daemon shutdown')
  await check('a graceful daemon stop leaves no terminal process behind', async () => {
    // turn them on again and leave one running
    const on = await raw({ port, method: 'PUT', url: '/api/settings/terminals', headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie }, body: JSON.stringify({ on: true }) })
    if (on.status !== 200) throw new Error(`enable answered ${on.status}`)
    const r = await raw({ port, method: 'POST', url: '/api/terminals', headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie }, body: JSON.stringify({ kind: 'claude' }) })
    const id = JSON.parse(r.text).id
    const t = await ticketFor(id)
    const h = await openTerminalSocket({ port, id, origin, cookie })
    h.ws.send(JSON.stringify({ type: 'auth', ticket: t }))
    const pid = Number(await until('pid', async () => /PID:(\d+)/.exec(Buffer.concat(h.bin).toString('utf8'))?.[1]))
    if (!alive(pid)) throw new Error('not running before shutdown')
    await stopDaemon(d1, 'SIGTERM')
    await until('the terminal process to be gone after the daemon stopped', async () => !alive(pid), { timeout: 10_000 })
  })

  await check(WIN ? 'a hard-killed daemon leaves no terminal process behind (skipped on Windows: not verified there)' : 'a hard-killed daemon (SIGKILL, no cleanup at all) leaves no terminal process behind', async () => {
    if (WIN) return 'skipped'
    const dataDir2 = path.join(tmp, 'data2')
    const port2 = await freePort()
    const d2 = await startDaemon({ port: port2, dataDir: dataDir2, env: { TERMINAL_CLAUDE_COMMAND: JSON.stringify([process.execPath, fakeClaude]), HOME: homeDir, USERPROFILE: homeDir, SHELL: '/bin/sh' } })
    const origin2 = `http://127.0.0.1:${port2}`
    const ex = await raw({ port: port2, method: 'POST', url: '/api/auth/exchange', headers: { 'Content-Type': 'application/json', Origin: origin2 }, body: JSON.stringify({ code: /code=([\w-]+)/.exec(d2.exchangeUrl)[1] }) })
    const cookie2 = String(ex.headers['set-cookie']?.[0] ?? '').split(';')[0]
    const hdrs = { 'Content-Type': 'application/json', Origin: origin2, Cookie: cookie2 }
    await raw({ port: port2, method: 'PUT', url: '/api/settings/terminals', headers: hdrs, body: JSON.stringify({ on: true }) })
    const made = await raw({ port: port2, method: 'POST', url: '/api/terminals', headers: hdrs, body: JSON.stringify({ kind: 'claude' }) })
    const id = JSON.parse(made.text).id
    const tk = JSON.parse((await raw({ port: port2, method: 'POST', url: `/api/terminals/${id}/ticket`, headers: hdrs, body: '{}' })).text).ticket
    const h = await openTerminalSocket({ port: port2, id, origin: origin2, cookie: cookie2 })
    h.ws.send(JSON.stringify({ type: 'auth', ticket: tk }))
    const pid = Number(await until('pid', async () => /PID:(\d+)/.exec(Buffer.concat(h.bin).toString('utf8'))?.[1]))
    pidsToReap.add(pid)
    if (!alive(pid)) throw new Error('not running before the kill')
    await stopDaemon(d2, 'SIGKILL')
    await until('the terminal process to be gone after the daemon was killed', async () => !alive(pid), { timeout: 10_000 })
    pidsToReap.delete(pid)
    return `pid ${pid} gone`
  })


  // ---------------------------------------------------------------- 10b. lifecycle, sessions and modes (fresh daemons)
  log('\n-- the daemon dying, signing out, revoking, private files')
  const quick = async (name, extraEnv = {}) => {
    const dataDirN = path.join(tmp, name)
    const portN = await freePort()
    const dN = await startDaemon({ port: portN, dataDir: dataDirN, env: { TERMINAL_CLAUDE_COMMAND: JSON.stringify([process.execPath, fakeClaude]), HOME: homeDir, USERPROFILE: homeDir, ...(WIN ? {} : { SHELL: '/bin/sh' }), ...extraEnv } })
    const originN = `http://127.0.0.1:${portN}`
    const ex = await raw({ port: portN, method: 'POST', url: '/api/auth/exchange', headers: { 'Content-Type': 'application/json', Origin: originN }, body: JSON.stringify({ code: /code=([\w-]+)/.exec(dN.exchangeUrl)[1] }) })
    const cookieN = String(ex.headers['set-cookie']?.[0] ?? '').split(';')[0]
    const hdr = { 'Content-Type': 'application/json', Origin: originN, Cookie: cookieN }
    const on = await raw({ port: portN, method: 'PUT', url: '/api/settings/terminals', headers: hdr, body: '{"on":true}' })
    if (on.status !== 200) throw new Error(`switching terminals on answered ${on.status}`)
    const term = async (cmd) => {
      const made = await raw({ port: portN, method: 'POST', url: '/api/terminals', headers: hdr, body: '{"kind":"shell"}' })
      if (made.status !== 201) throw new Error(`create answered ${made.status} ${made.text.slice(0, 100)}`)
      const id = JSON.parse(made.text).id
      const tk = JSON.parse((await raw({ port: portN, method: 'POST', url: `/api/terminals/${id}/ticket`, headers: hdr, body: '{}' })).text).ticket
      const h = await openTerminalSocket({ port: portN, id, origin: originN, cookie: cookieN })
      h.ws.send(JSON.stringify({ type: 'auth', ticket: tk }))
      await until('ready', async () => h.text.some((m) => m.type === 'ready'))
      await sleep(250) // the shell has to be up before it reads the line
      if (cmd) h.ws.send(Buffer.from(`${cmd}\r`))
      h.id = id
      return h
    }
    return { d: dN, port: portN, origin: originN, cookie: cookieN, hdr, dataDir: dataDirN, term }
  }

  await check(WIN ? 'a hard-killed daemon with several terminals (skipped on Windows: not verified there)' : 'a hard-killed daemon (SIGKILL) ends EVERY terminal tree, also when a later terminal has a job that ignores SIGHUP', async () => {
    if (WIN) return 'skipped'
    const leaves = [424301, 424302, 424303, 424304]
    leaves.forEach((n) => killCmd(`sleep ${n}`))
    const q = await quick('data3')
    try {
      await q.term('sleep 424301')
      await q.term('sleep 424302 &')
      await q.term('(sleep 424304 &)')
      await q.term("trap '' HUP; sleep 424303 &") // the review's poison: a later terminal whose process outlives a hang-up
      await until('the jobs to run', async () => leaves.every((n) => runningCmd(`sleep ${n}`).length > 0), { timeout: 15_000 })
      const hostsBefore = hostsOf(q.d.child.pid)
      if (hostsBefore.length !== 4) throw new Error(`${hostsBefore.length} PTY hosts for 4 terminals`)
      await stopDaemon(q.d, 'SIGKILL')
      await until('every job to be gone after the daemon was killed', async () => leaves.every((n) => runningCmd(`sleep ${n}`).length === 0), { timeout: 12_000 })
      await until('every PTY host to be gone', async () => hostsBefore.every((p) => !alive(p) || readFileSync(`/proc/${p}/stat`, 'latin1').includes(') Z ')), { timeout: 12_000 })
      return `${leaves.length} jobs and ${hostsBefore.length} hosts gone`
    } finally {
      leaves.forEach((n) => killCmd(`sleep ${n}`))
      await stopDaemon(q.d, 'SIGKILL').catch(() => undefined)
    }
  })

  await check(WIN ? 'SIGHUP stops the daemon gracefully (skipped on Windows: not verified there)' : 'SIGHUP (a closed terminal window) stops the daemon gracefully: exit 0, every tree ended, no PTY host left', async () => {
    if (WIN) return 'skipped'
    const leaves = [424311, 424312]
    leaves.forEach((n) => killCmd(`sleep ${n}`))
    const q = await quick('data4')
    try {
      await q.term('sleep 424311 &')
      await q.term("trap '' HUP TERM; sleep 424312 &")
      await until('the jobs to run', async () => leaves.every((n) => runningCmd(`sleep ${n}`).length > 0), { timeout: 15_000 })
      const hostsBefore = hostsOf(q.d.child.pid)
      const gone = new Promise((r) => q.d.child.once('exit', (code, sig) => r({ code, sig })))
      q.d.child.kill('SIGHUP')
      const exit = await Promise.race([gone, sleep(15_000).then(() => 'timeout')])
      if (exit === 'timeout') throw new Error('the daemon did not stop on SIGHUP')
      if (exit.code !== 0 || exit.sig !== null) throw new Error(`exit ${JSON.stringify(exit)} (a SIGHUP that kills the process outright is the old behaviour)`)
      await until('every job to be gone', async () => leaves.every((n) => runningCmd(`sleep ${n}`).length === 0), { timeout: 10_000 })
      for (const p of hostsBefore) if (alive(p) && !readFileSync(`/proc/${p}/stat`, 'latin1').includes(') Z ')) throw new Error(`PTY host ${p} is still running after a graceful stop`)
      // the data folder and database of this run are private
      const mode = (f) => statSync(f).mode & 0o777
      if (mode(q.dataDir) !== 0o700) throw new Error(`data folder mode ${mode(q.dataDir).toString(8)}`)
      for (const f of ['app.db', 'secrets.json']) if (mode(path.join(q.dataDir, f)) !== 0o600) throw new Error(`${f} mode ${mode(path.join(q.dataDir, f)).toString(8)}`)
      return `exit 0; ${hostsBefore.length} hosts gone; folder 700, files 600`
    } finally {
      leaves.forEach((n) => killCmd(`sleep ${n}`))
      await stopDaemon(q.d, 'SIGKILL').catch(() => undefined)
    }
  })

  await check('signing out ends the session and closes its sockets, the terminal keeps running; the revoke command signs every browser out', async () => {
    const q = await quick('data5')
    try {
      const t = await q.term()
      const feed = await new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${q.port}/ws`, { headers: { Origin: q.origin, Cookie: q.cookie } })
        const o = { ws, closed: undefined }
        o.closed = new Promise((res) => ws.on('close', (code) => res(code)))
        ws.once('open', () => resolve(o))
        ws.once('error', reject)
      })
      if ((await raw({ port: q.port, method: 'GET', url: '/api/health', headers: { Cookie: q.cookie } })).status !== 200) throw new Error('not signed in before')
      const out = await raw({ port: q.port, method: 'POST', url: '/api/auth/signout', headers: q.hdr })
      if (out.status !== 200 || !/Max-Age=0/i.test(String(out.headers['set-cookie']?.[0] ?? ''))) throw new Error(`sign-out answered ${out.status}, set-cookie ${out.headers['set-cookie']}`)
      if ((await raw({ port: q.port, method: 'GET', url: '/api/health', headers: { Cookie: q.cookie } })).status !== 401) throw new Error('the cookie still works after signing out')
      const codeOf = (x) => (typeof x === 'number' ? x : x?.code)
      const codes = await Promise.race([Promise.all([feed.closed, t.closed]), sleep(5000).then(() => 'timeout')])
      if (codes === 'timeout' || codeOf(codes[0]) !== 4401 || codeOf(codes[1]) !== 4401) throw new Error(`socket close codes ${JSON.stringify(codes)}`)
    } finally {
      await stopDaemon(q.d, 'SIGKILL').catch(() => undefined)
    }
    // the command line: a second daemon with a live session
    const r = await quick('data6')
    try {
      const run = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/revoke.ts'], { cwd: daemonDir, env: { ...process.env, DATA_DIR: r.dataDir, HOME: homeDir }, encoding: 'utf8' })
      if (run.status !== 0 || !/Revoked 1 browser session/.test(run.stdout)) throw new Error(`revoke: exit ${run.status}, ${String(run.stdout + run.stderr).slice(0, 200)}`)
      if (/[A-Za-z0-9_-]{40,}/.test(run.stdout + run.stderr)) throw new Error('the command printed something that looks like a token')
      await sleep(30)
      if ((await raw({ port: r.port, method: 'GET', url: '/api/health', headers: { Cookie: r.cookie } })).status !== 401) throw new Error('the running daemon still accepts the revoked cookie')
      return 'sign-out and revoke both end the session'
    } finally {
      await stopDaemon(r.d, 'SIGKILL').catch(() => undefined)
    }
  })

  await check('the browser raised no unexpected console errors', async () => {
    if (errors.length > 0) throw new Error(errors.slice(0, 3).join(' | '))
  })
} catch (e) {
  log(`ERROR  ${String(e?.message ?? e).split('\n')[0]}`)
  failures.push('run aborted')
} finally {
  for (const pid of pidsToReap) if (alive(pid)) process.kill(pid, 'SIGKILL')
  await browser?.close().catch(() => undefined)
  for (const d of [...daemons]) await stopDaemon(d, 'SIGKILL').catch(() => undefined)
  if (tmp && !process.env.KEEP_TMP) rmSync(tmp, { recursive: true, force: true })
}

if (failures.length > 0) {
  log(`\n${failures.length} check(s) failed: ${failures.join('; ')}`)
  process.exit(1)
}
log('\nAll terminal end-to-end checks passed.')
