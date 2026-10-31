#!/usr/bin/env node
/**
 * End-to-end test of the stage backend: a real daemon process (zero-token FAKE Claude backend, no network), the built
 * web app, a real Chromium and the headless SimulatorStage from packages/stage-core connected to the daemon's stage
 * WebSocket exactly like an engine would be (Authorization: Bearer <stage token> from secrets.json, no cookie).
 * Nothing here calls Anthropic or any remote host; every socket is 127.0.0.1.
 *
 *   node apps/web/scripts/e2e-stage.mjs      (builds apps/web into a TEMP folder, never into apps/web/dist)
 *
 * What it proves, in order:
 *   - the Settings > Stage tab: "Not connected" first; then the simulator connects over the stage socket and the tab
 *     shows Connected, the engine and the capabilities it declared; the draft Room card says what it does not draw;
 *   - changing the outfit in the UI reaches the simulator (its timeline and its state), and the tab shows it as worn;
 *   - a chat message produces perform.speak AND audio frames AND face frames on the simulator, and her mood readout moves;
 *   - clicking a camera shot moves the simulator's camera;
 *   - an out-of-range slider value typed in the UI is REFUSED with the range in the message and nothing reaches the stage;
 *   - an asset whose licence forbids personal use is refused in the UI, with the reason, and nothing is worn;
 *   - the stage token opens no browser route; the browser cookie opens no stage socket; a second stage is refused (409);
 *   - a daemon restart: the simulator reconnects by itself and the daemon rebuilds the whole look from SQLite
 *     (outfit, camera, her body sliders), and the page reconnects;
 *   - the mockup (?fixtures) says the Stage tab needs the daemon and shows no made-up data;
 *   - no console errors, and the stage token is never in any page text, URL, storage or console message.
 *
 * Options (environment): SHOTS_DIR (screenshots, default ./screenshots), SKIP_BUILD=1 with WEB_DIST=<folder with a
 * build>, KEEP_TMP=1, E2E_VERBOSE=1. Needs Playwright with a Chromium browser (see smoke.mjs). Exit code is non-zero on
 * any failure. Only run in the Linux sandbox so far (nothing here is Windows specific, but it was never run there).
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
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
const daemonRequire = createRequire(path.join(daemonDir, 'package.json'))
const WebSocket = daemonRequire('ws')
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
  const file = path.join(SHOTS, `e2e-stage-${String(++shotN).padStart(2, '0')}-${name.replace(/\W+/g, '-').toLowerCase()}.png`)
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
const daemons = new Set()

async function startDaemon({ port, dataDir, webDist }) {
  const env = { ...process.env, DAEMON_PORT: String(port), DATA_DIR: dataDir, CLAUDE_BACKEND: 'fake', LOG_LEVEL: 'warn', WEB_DIST: webDist }
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

/** One raw WebSocket upgrade attempt. Resolves {status} when refused, {open: ws} when accepted. */
function attempt(url, headers = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers })
    ws.once('unexpected-response', (_req, res) => {
      res.resume()
      ws.terminate()
      resolve({ status: res.statusCode })
    })
    ws.once('open', () => resolve({ open: ws }))
    ws.on('error', () => undefined)
  })
}

// ------------------------------------------------------------------------------------------------ web build (into a temp folder)

function buildWeb(outDir) {
  if (process.env.SKIP_BUILD && process.env.WEB_DIST) return path.resolve(process.env.WEB_DIST)
  log('building apps/web into a temp folder (the shared apps/web/dist is not touched)')
  // The package binaries (a shell shim on Windows, so through the shell there); `pnpm build` itself would write apps/web/dist.
  const bin = (name) => path.join(webDir, 'node_modules', '.bin', WIN ? `${name}.cmd` : name)
  const typecheck = spawnSync(bin('tsc'), ['-p', 'tsconfig.json'], { cwd: webDir, stdio: 'inherit', shell: WIN })
  if (typecheck.status !== 0) throw new Error('the web typecheck failed')
  const r = spawnSync(bin('vite'), ['build', '--outDir', outDir, '--emptyOutDir'], { cwd: webDir, stdio: VERBOSE ? 'inherit' : 'ignore', shell: WIN })
  if (r.status !== 0) throw new Error('the web build failed (run with E2E_VERBOSE=1 to see why)')
  return outDir
}

// ------------------------------------------------------------------------------------------------ main

let browser
let tmp
let d1
let d2
let sim
let sim2
let client

try {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'mira-stage-e2e-')))
  const dataDir = path.join(tmp, 'data')
  const webDist = buildWeb(path.join(tmp, 'web'))

  // The simulator comes from stage-core (TypeScript): load it the way the daemon is run, through tsx.
  const { register } = await import(pathToFileURL(daemonRequire.resolve('tsx/esm/api')).href)
  register()
  const { connectSimulator } = await import(pathToFileURL(path.join(daemonDir, 'src', 'stage', 'simClient.ts')).href)

  const port = await freePort()
  d1 = await startDaemon({ port, dataDir, webDist })
  log(`daemon up on 127.0.0.1:${port} (data dir ${dataDir})`)
  const origin = `http://127.0.0.1:${port}`
  const secrets = () => JSON.parse(readFileSync(path.join(dataDir, 'secrets.json'), 'utf8'))
  const stageToken = secrets().stageToken
  const wsUrl = `ws://127.0.0.1:${port}/ws/stage`
  if (!stageToken || stageToken.length < 40) throw new Error('secrets.json has no stage token')

  browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } })
  page = await context.newPage()
  const errors = []
  const consoleText = []
  let expectRefusals = 0
  const isNoise = (t) => /GPU stall|WebGL|GL Driver|swiftshader|THREE\.Clock/i.test(t)
  // The browser logs refused requests (422, 409, 401 on purpose) and dropped sockets (the daemon restart) as console errors.
  const isRefusal = (t) => /status of (4\d\d)|WebSocket connection to|ERR_CONNECTION_REFUSED|Failed to load resource|net::ERR/i.test(t)
  page.on('console', (m) => {
    consoleText.push(m.text())
    if (m.type() !== 'error') return
    const t = m.text()
    if (isNoise(t) || (expectRefusals > 0 && isRefusal(t))) return
    errors.push(t.slice(0, 260))
  })
  page.on('pageerror', (e) => errors.push(`PAGEERROR ${String(e.message).slice(0, 260)}`))

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
  const openStageTab = async () => {
    await page.locator('nav[aria-label="Main"] button[aria-label="Settings"]').click()
    await page.getByRole('heading', { name: 'Settings' }).waitFor({ timeout: 10_000 })
    await page.getByRole('tab', { name: /^Stage/ }).click()
    await page.getByRole('heading', { name: 'Stage', exact: true }).waitFor({ timeout: 10_000 })
  }
  const status = () => page.locator('[data-testid="stage-status"]')
  const errText = async () => (await page.locator('[data-testid="stage-error"]').first().innerText().catch(() => '')).trim()

  // ---------------------------------------------------------------- 1. sign in, the tab before any stage
  log('\n-- sign in and the Stage tab')
  await page.goto(d1.exchangeUrl)
  await page.waitForSelector('nav[aria-label="Main"]', { timeout: 30_000 })
  await check(
    'the UI loads in Live mode against the daemon',
    async () => {
      const badge = page.locator('[data-testid="mode-badge"]')
      await until('Live badge', async () => (await badge.getAttribute('data-mode')) === 'daemon' && (await badge.getAttribute('data-link')) === 'up')
    },
    { fatal: true },
  )
  await check('the Stage tab opens and says "Not connected" with no stage attached', async () => {
    await openStageTab()
    await until('status shown', async () => (await status().count()) === 1)
    const t = await status().innerText()
    if (!/Not connected/.test(t)) throw new Error(`status: ${t}`)
    const page_ = await page.locator('main').innerText()
    if (!/Room \(draft stage\)/.test(page_) || !/Does not draw: outfits and the wardrobe/.test(page_)) throw new Error('the draft Room card is missing or not honest')
    if (!/ws:\/\/127\.0\.0\.1:PORT\/ws\/stage/.test(page_)) throw new Error('the connection hint is missing')
  })
  await check('the seed is there: her and your character, the catalog with licences, the void, six camera shots', async () => {
    const t = await page.locator('main').innerText()
    if (!/Her/.test(t) || !/You/.test(t)) throw new Error('character groups missing')
    if ((await page.locator('[data-character]').count()) !== 2) throw new Error('expected two characters')
    if (!/abstract/i.test(await page.locator('[data-testid="stage-characters-user"]').innerText())) throw new Error('your representation is not the abstract presence')
    if ((await page.locator('[data-shot]').count()) !== 6) throw new Error('expected six shots')
    if ((await page.locator('[data-testid="stage-presets"] [data-preset]').count()) < 5) throw new Error('outfit presets missing')
    if (!/Every character is an adult/i.test(t)) throw new Error('the adult note is missing')
  })
  await shot('stage tab no stage')

  // ---------------------------------------------------------------- 2. the simulator connects over the stage socket
  log('\n-- a stage connects')
  client = connectSimulator({ url: wsUrl, token: stageToken, reconnect: true })
  sim = await client.waitConnected(15_000)
  await check('the tab shows Connected, the engine and the capabilities the simulator declared', async () => {
    await until('Connected', async () => /Connected/.test(await status().innerText()) && !/Not connected/.test(await status().innerText()))
    const t = await status().innerText()
    if (!/sim/.test(t)) throw new Error(`engine not shown: ${t}`)
    const caps = await page.locator('[data-testid="stage-capabilities"]').innerText()
    for (const needle of ['vrm1', 'metahuman', 'ARKit-52', 'knowledge_graph', 'session_orbit', 'Characters at once']) if (!caps.includes(needle)) throw new Error(`capabilities miss "${needle}": ${caps.slice(0, 200)}`)
    if ((await page.getByRole('button', { name: /Disconnect/ }).count()) !== 1) throw new Error('no Disconnect button')
  })
  await shot('stage tab connected')
  await check('the simulator was given her, you, the void and the constructs', async () => {
    await until('look loaded', async () => sim.state().scene !== null && Object.keys(sim.state().characters).length === 2)
    const st = sim.state()
    if (st.assistantId !== 'char.assistant') throw new Error(`assistant ${st.assistantId}`)
    if (st.scene.cameraIds.length !== 6) throw new Error('scene cameras')
    await until('the knowledge graph arrived', async () => (sim.state().constructs['construct.brain']?.data.nodes.length ?? 0) > 5)
    return `${Object.keys(st.characters).join(', ')}; ${sim.state().constructs['construct.brain'].data.nodes.length} notes drawn`
  })
  await check('the draft Room follows the backend mood: the readout shows her mood and where she looks', async () => {
    const mood = page.locator('[data-testid="stage-mood"]')
    await mood.waitFor({ timeout: 10_000 })
    const t = await mood.innerText()
    if (!/Valence/.test(t) || !/Arousal/.test(t) || !/Dominance/.test(t)) throw new Error(`mood panel: ${t}`)
    await until('an idle profile shows', async () => /attentive|relaxed|busy|sleepy|asleep/.test(await mood.innerText()), { timeout: 10_000 })
  })

  await check('the draft Room follows the backend: quiet hours put her to sleep in the Room, and she wakes when they end', async () => {
    const hm = (ms) => {
      const d = new Date(ms)
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    }
    const chip = () => page.locator('[role="status"]').filter({ hasText: 'Mira' }).first()
    const now = Date.now()
    // quiet hours that contain "now": the behaviour director goes asleep at once (nobody has written to her yet)
    const put = (from, to) => apiFetch('PUT', '/api/settings/persona', { quietHours: { from, to } })
    const asleepWindow = await put(hm(now - 3_600_000), hm(now + 3_600_000))
    if (asleepWindow.status !== 200) throw new Error(`persona: ${asleepWindow.status}`)
    await until('the backend says asleep', async () => sim.state().idle === 'asleep', { timeout: 15_000 })
    await until('the Room says asleep', async () => /asleep/.test(await chip().innerText()), { timeout: 15_000 })
    // quiet hours that do NOT contain now: she wakes
    const awakeWindow = await put(hm(now + 3 * 3_600_000), hm(now + 4 * 3_600_000))
    if (awakeWindow.status !== 200) throw new Error(`persona: ${awakeWindow.status}`)
    await until('the backend wakes her', async () => sim.state().idle !== 'asleep', { timeout: 15_000 })
    await until('the Room wakes', async () => !/asleep/.test(await chip().innerText()), { timeout: 15_000 })
  })

  // ---------------------------------------------------------------- 3. wardrobe
  log('\n-- wardrobe')
  await check('wearing the Meeting outfit in the UI reaches the simulator timeline and state', async () => {
    const before = sim.names('command').filter((n) => n === 'character.outfit' || n === 'character.equip').length
    await page.getByRole('button', { name: 'Wear the Meeting outfit' }).click()
    await until('the simulator received it', async () => sim.names('command').filter((n) => n === 'character.outfit' || n === 'character.equip').length > before)
    await until('the blazer is on in the simulator', async () => sim.state().characters['char.assistant']?.equipped.outerwear === 'outfit.tailored-blazer')
    const eq = sim.state().characters['char.assistant'].equipped
    if (!eq.top || !eq.bottom) throw new Error('she is not fully dressed')
    await until('the tab shows it as worn', async () => (await page.locator('[data-preset="preset.meeting"]').innerText()).includes('wearing'))
  })
  await shot('wardrobe meeting outfit')
  await check('taking off her last full outfit is refused in plain words, and she stays dressed', async () => {
    expectRefusals++
    await page.getByRole('button', { name: /^Take off Crisp shirt/ }).click()
    await until('the refusal shows', async () => /full outfit|baseline/i.test(await errText()))
    const eq = (await apiFetch('GET', '/api/stage')).json.characters.find((c) => c.id === 'char.assistant').equipped
    if (!eq.top || !eq.bottom) throw new Error('she was undressed')
    if (sim.state().characters['char.assistant'].equipped.top === null) throw new Error('the simulator was undressed')
  })
  await check('the OutfitDirector\'s suggestion is shown with its explanation', async () => {
    const box = page.locator('[data-testid="stage-suggestion"]')
    const t = await box.innerText()
    if (!/Keeping|Changing into/.test(t)) throw new Error(`suggestion: ${t.slice(0, 160)}`)
    await page.getByLabel('Context for the suggestion').selectOption('sleep')
    await box.getByRole('button', { name: 'Ask' }).click()
    await until('a suggestion for sleep', async () => /Restful|Changing into|Keeping/.test(await box.innerText()))
  })
  await check('an asset whose licence forbids personal use is refused in the UI with the reason, and nothing is worn', async () => {
    expectRefusals++
    const manifest = {
      id: 'outfit.vendor-coat',
      kind: 'outfit',
      name: 'Vendor coat (no personal use)',
      tags: ['dark'],
      rigFamilies: ['vrm1', 'metahuman', 'cc5'],
      locator: 'wardrobe/vendor-coat',
      slots: ['outerwear'],
      hides: ['torso', 'arms'],
      params: [],
      license: { id: 'vendor-eula', personalUse: false, commercialUse: false, redistribution: false },
    }
    const reg = await apiFetch('POST', '/api/stage/assets', { manifest })
    if (reg.status !== 201) throw new Error(`register: ${reg.status} ${JSON.stringify(reg.json)}`)
    const row = page.locator('[data-asset="outfit.vendor-coat"]').first()
    await row.waitFor({ timeout: 10_000 })
    if (!/does not permit personal use/i.test(await row.innerText())) throw new Error('the licence is not shown on the row')
    await row.getByRole('button', { name: /^Wear Vendor coat/ }).click()
    await until('the refusal shows', async () => /licen[cs]e/i.test(await errText()))
    const err = await errText()
    if (!/Vendor coat/.test(err)) throw new Error(`message does not name the asset: ${err}`)
    const eq = sim.state().characters['char.assistant'].equipped
    const worn = Object.values(eq).filter(Boolean)
    if (worn.includes('outfit.vendor-coat')) throw new Error('the forbidden asset reached the stage')
    return err.slice(0, 100)
  })

  // ---------------------------------------------------------------- 4. a chat message becomes a performance
  log('\n-- a reply is performed on the stage')
  await check('a chat message produces perform.speak, audio frames AND face frames on the simulator', async () => {
    const composer = page.locator('aside[aria-label="Mira\'s room and chat"] textarea').first()
    const moodBefore = await page.locator('[data-testid="stage-mood"]').innerText()
    await composer.fill('Hello, what is on my calendar today?')
    await composer.press('Enter')
    await until('speech reached the simulator', async () => sim.names('command').includes('perform.speak'), { timeout: 20_000 })
    await until('audio and face frames arrived', async () => {
      const ids = sim.utteranceIds()
      return ids.length > 0 && ids.some((id) => (sim.utterance(id)?.audioFrames ?? 0) > 3 && (sim.utterance(id)?.faceFrames ?? 0) > 3)
    }, { timeout: 20_000 })
    const u = sim.utteranceIds().map((id) => sim.utterance(id))
    if (u.some((x) => x.faceSource !== 'backend')) throw new Error('the face did not come from the backend')
    if (sim.orphanFrames !== 0 || sim.rejectedFrames !== 0) throw new Error(`orphan ${sim.orphanFrames} rejected ${sim.rejectedFrames}`)
    void moodBefore
    return `${u.length} utterance(s): ${u.map((x) => `${x.audioFrames} audio / ${x.faceFrames} face`).join('; ')}`
  })
  await check('the performance finishes cleanly (every utterance ended, none underran)', async () => {
    await until('all utterances ended', async () => sim.utteranceIds().length > 0 && sim.utteranceIds().every((id) => sim.utterance(id)?.endedInterrupted !== undefined), { timeout: 30_000 })
    if (sim.utteranceIds().some((id) => (sim.utterance(id)?.underruns ?? 0) > 0)) throw new Error('an utterance underran')
  })
  await shot('after the spoken reply')

  // ---------------------------------------------------------------- 5. camera
  log('\n-- camera')
  await check('clicking a camera shot moves the simulator camera and the button shows it', async () => {
    await page.locator('[data-shot="closeup"]').click()
    await until('the simulator camera moved', async () => sim.state().scene?.activeCameraId === 'closeup')
    await until('the button is pressed', async () => (await page.locator('[data-shot="closeup"]').getAttribute('aria-pressed')) === 'true')
    await page.locator('[data-shot="profile"]').click()
    await until('and again', async () => sim.state().scene?.activeCameraId === 'profile')
    await page.locator('[data-shot="closeup"]').click()
    await until('back to the close-up', async () => sim.state().scene?.activeCameraId === 'closeup')
  })

  // ---------------------------------------------------------------- 6. appearance: ranges
  log('\n-- body parameters')
  await check('a slider value inside the range is accepted and reaches the simulator', async () => {
    const box = page.locator('[data-param="body.height_cm"]')
    await box.fill('183')
    await box.press('Enter')
    await until('the simulator has the new height', async () => sim.state().characters['char.assistant']?.params['body.height_cm'] === 183)
  })
  await check('an out-of-range value typed in the UI is REFUSED with the range in the message, nothing reaches the stage', async () => {
    expectRefusals++
    const sent = sim.names('command').filter((n) => n === 'character.params').length
    const box = page.locator('[data-param="body.height_cm"]')
    await box.fill('250')
    await box.press('Enter')
    await until('the refusal shows', async () => /Height \(cm\) must be between 162 and 190/.test(await errText()))
    const msg = await errText()
    if (!/you sent 250/.test(msg) || !/adult/i.test(msg)) throw new Error(`message: ${msg}`)
    await until('the box went back to the real value', async () => (await box.inputValue()) === '183')
    await sleep(300)
    if (sim.names('command').filter((n) => n === 'character.params').length !== sent) throw new Error('a refused value reached the stage')
    if (sim.state().characters['char.assistant'].params['body.height_cm'] !== 183) throw new Error('the stage value changed')
    return msg.slice(0, 120)
  })
  await check('a childlike apparent age cannot be typed in either', async () => {
    expectRefusals++
    await page.locator('summary', { hasText: /^Face/ }).first().click()
    const age = page.locator('[data-param="face.apparent_age"]')
    await age.waitFor({ timeout: 5000 })
    for (const v of ['15', '24']) {
      await age.fill(v)
      await age.press('Enter')
      await until(`age ${v} refused`, async () => /Apparent age \(years\) must be between 28 and 58/.test(await errText()))
    }
    const c = (await apiFetch('GET', '/api/stage')).json.characters.find((x) => x.id === 'char.assistant')
    if (c.params['face.apparent_age'] < 28) throw new Error('a childlike age was stored')
  })
  await shot('appearance refusal')

  // ---------------------------------------------------------------- 7. credentials
  log('\n-- credentials')
  const cookieHeader = (await context.cookies()).map((c) => `${c.name}=${c.value}`).join('; ')
  await check('the stage token opens no browser route', async () => {
    for (const url of ['/api/stage', '/api/snapshot', '/api/health', '/api/tasks']) {
      const r = await raw({ port, url, headers: { Host: `127.0.0.1:${port}`, Authorization: `Bearer ${stageToken}` } })
      if (r.status !== 401) throw new Error(`${url} answered ${r.status} to the stage token`)
    }
    const w = await attempt(`ws://127.0.0.1:${port}/ws`, { Authorization: `Bearer ${stageToken}`, Origin: origin })
    if (w.open) {
      w.open.terminate()
      throw new Error('the browser socket accepted the stage token')
    }
    if (w.status !== 401) throw new Error(`browser socket answered ${w.status}`)
  })
  await check('the browser cookie opens no stage socket (401), with or without an allowed Origin', async () => {
    if (!cookieHeader) throw new Error('no cookie to test with')
    for (const headers of [{ Cookie: cookieHeader }, { Cookie: cookieHeader, Origin: origin }]) {
      const w = await attempt(wsUrl, headers)
      if (w.open) {
        w.open.terminate()
        throw new Error('the stage socket accepted a browser cookie')
      }
      if (w.status !== 401) throw new Error(`answered ${w.status}`)
    }
  })
  await check('a second stage is refused (409) while one is connected; a token in the URL is refused (400)', async () => {
    const w = await attempt(wsUrl, { Authorization: `Bearer ${stageToken}` })
    if (w.open) {
      w.open.terminate()
      throw new Error('a second stage was accepted')
    }
    if (w.status !== 409) throw new Error(`answered ${w.status}`)
    const q = await attempt(`${wsUrl}?token=${stageToken}`, { Authorization: `Bearer ${stageToken}` })
    if (q.open) {
      q.open.terminate()
      throw new Error('a query string was accepted')
    }
    if (q.status !== 400) throw new Error(`query answered ${q.status}`)
  })
  await check('the stage token is nowhere in the page: not in its text, its storage, its URL or the console', async () => {
    const dump = await page.evaluate(() => JSON.stringify({ text: document.body.innerText, html: document.documentElement.innerHTML.length, url: location.href, ls: { ...localStorage }, ss: { ...sessionStorage } }))
    if (dump.includes(stageToken)) throw new Error('found in the page')
    if (consoleText.some((t) => t.includes(stageToken))) throw new Error('found in the console')
    const html = await page.content()
    if (html.includes(stageToken)) throw new Error('found in the DOM')
  })

  // ---------------------------------------------------------------- 8. restart
  log('\n-- a daemon restart')
  await check('the daemon restarts; the simulator reconnects by itself and the whole look is rebuilt from SQLite', async () => {
    expectRefusals++
    const firstSim = sim
    await stopDaemon(d1)
    await until('the simulator saw the daemon go', async () => !client.connected(), { timeout: 15_000 })
    d2 = await startDaemon({ port, dataDir, webDist })
    sim2 = await until('a NEW simulator connected', async () => (client.history.length >= 2 && client.connected() ? client.sim : undefined), { timeout: 40_000 })
    if (sim2 === firstSim) throw new Error('the same simulator?')
    await until('the look was rebuilt', async () => {
      const st = sim2.state()
      return st.scene !== null && st.characters['char.assistant']?.equipped.outerwear === 'outfit.tailored-blazer' && st.scene.activeCameraId === 'closeup'
    }, { timeout: 30_000 })
    const st = sim2.state()
    if (st.characters['char.assistant'].params['body.height_cm'] !== 183) throw new Error(`height ${st.characters['char.assistant'].params['body.height_cm']}`)
    if (!st.characters['char.user']) throw new Error('your character was not loaded')
    if (!st.affect) throw new Error('her mood was not replayed')
    await until('the knowledge graph is drawn again', async () => (sim2.state().constructs['construct.brain']?.data.nodes.length ?? 0) > 5, { timeout: 20_000 })
    return `outfit, camera ${st.scene.activeCameraId}, height 183, mood ${st.affect.label}`
  })
  await check('the page reconnects to the restarted daemon and the Stage tab is live again', async () => {
    await until('Connected shows again', async () => /Connected/.test(await status().innerText().catch(() => '')) && !/Not connected/.test(await status().innerText().catch(() => '')), { timeout: 40_000 })
    await until('the worn outfit is still Meeting', async () => (await page.locator('[data-preset="preset.meeting"]').innerText()).includes('wearing'), { timeout: 20_000 })
  })
  await check('the stage token survived the restart (same engine configuration still works)', async () => {
    if (secrets().stageToken !== stageToken) throw new Error('the token changed')
  })
  await shot('after restart')

  // ---------------------------------------------------------------- 9. disconnect and the switch
  log('\n-- disconnect and the switch')
  await check('Disconnect closes the stage connection; the simulator may reconnect', async () => {
    await page.getByRole('button', { name: /Disconnect/ }).click()
    await until('the simulator saw the close', async () => !client.connected(), { timeout: 10_000 })
    await until('and it reconnected by itself', async () => client.connected() && client.history.length >= 3, { timeout: 20_000 })
  })
  await check('switching the stage backend off disconnects the stage and the tab says so; on again restores it', async () => {
    expectRefusals++
    await page.getByRole('switch', { name: 'Stage backend' }).click()
    await until('the tab says the stage is off', async () => /The stage is off/.test(await page.locator('main').innerText()))
    await until('the stage was disconnected', async () => !client.connected(), { timeout: 10_000 })
    await sleep(1500)
    if (client.connected()) throw new Error('a stage connected while the stage is off')
    await page.getByRole('switch', { name: 'Stage backend' }).click()
    await until('the tab is back', async () => (await page.locator('[data-character]').count()) === 2, { timeout: 15_000 })
    await until('the stage reconnects', async () => client.connected(), { timeout: 20_000 })
  })

  // ---------------------------------------------------------------- 10. the mockup says it needs the daemon
  log('\n-- the mockup')
  await check('the mockup (?fixtures) says the Stage tab needs the daemon and shows no stage data', async () => {
    const p2 = await context.newPage()
    p2.on('pageerror', (e) => errors.push(`PAGEERROR(2) ${String(e.message).slice(0, 200)}`))
    await p2.goto(`${origin}/?fixtures`)
    await p2.waitForSelector('nav[aria-label="Main"]', { timeout: 30_000 })
    await p2.locator('nav[aria-label="Main"] button[aria-label="Settings"]').click()
    await p2.getByRole('tab', { name: /^Stage/ }).click()
    await p2.getByText('Needs the daemon').waitFor({ timeout: 10_000 })
    if ((await p2.locator('[data-character]').count()) !== 0 || (await p2.locator('[data-shot]').count()) !== 0) throw new Error('stage data shown in the mockup')
    await shot('mockup needs the daemon', p2)
    await p2.close()
  })

  // ---------------------------------------------------------------- 11. console
  log('\n-- console')
  await check('no console errors or page errors during the whole run', async () => {
    if (errors.length > 0) throw new Error(errors.slice(0, 3).join(' | '))
  })
} catch (e) {
  log(`\nABORTED: ${String(e?.message ?? e)}`)
  failures.push('aborted')
} finally {
  try {
    await client?.stop?.()
  } catch {
    /* gone */
  }
  await browser?.close().catch(() => undefined)
  for (const d of [...daemons]) await stopDaemon(d, 'SIGTERM').catch(() => undefined)
  if (tmp && !process.env.KEEP_TMP) rmSync(tmp, { recursive: true, force: true })
  log(failures.length === 0 ? '\nALL CHECKS PASSED' : `\n${failures.length} FAILED: ${failures.join('; ')}`)
  process.exit(failures.length === 0 ? 0 : 1)
}
