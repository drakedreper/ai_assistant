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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
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

const maskCode = (s) => s.replace(/code=[\w-]+/g, 'code=***')
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
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
      return /Sign in\s+(http:\/\/127\.0\.0\.1:\d+\/\?code=[\w-]+)/.exec(d.out)?.[1]
    },
    { timeout: 40_000 },
  )
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
        const r = await fetch(url, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
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
