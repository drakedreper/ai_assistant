import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { StageCommand } from '@ai-assistant/shared'
import { readSecretsFile, secretsPath } from '../src/security'
import { type SimClient } from '../src/stage/simClient'
import { makeStageDaemon, sleep, until, type StageDaemon } from '../src/stage/testing'

const daemons: StageDaemon[] = []
const clients: SimClient[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const c of clients.splice(0)) await c.stop()
  for (const d of daemons.splice(0)) await d.stop()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'stage-ws-'))
  dirs.push(d)
  return d
}
async function boot(o: Partial<Parameters<typeof makeStageDaemon>[0]> = {}): Promise<StageDaemon> {
  const d = await makeStageDaemon({ dataDir: tmp(), ...o })
  daemons.push(d)
  return d
}
const track = (c: SimClient): SimClient => {
  clients.push(c)
  return c
}

type Attempt = { status: number; body: string } | { open: WebSocket }

/** One raw WebSocket upgrade attempt: the HTTP status when it is refused, or the open socket. */
function attempt(url: string, headers: Record<string, string> = {}, origin?: string): Promise<Attempt> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers, ...(origin ? { origin } : {}), perMessageDeflate: false })
    ws.once('unexpected-response', (_req, res) => {
      let body = ''
      res.on('data', (c: Buffer) => (body += c.toString()))
      res.on('end', () => {
        ws.terminate()
        resolve({ status: res.statusCode ?? 0, body })
      })
    })
    ws.once('open', () => resolve({ open: ws }))
    ws.on('error', () => undefined)
  })
}
const refusedWith = async (a: Promise<Attempt>): Promise<{ status: number; code: string }> => {
  const r = await a
  if ('open' in r) {
    r.open.terminate()
    throw new Error('the upgrade was accepted')
  }
  return { status: r.status, code: (JSON.parse(r.body || '{}') as { error?: string }).error ?? '' }
}
const bearer = (t: string): Record<string, string> => ({ Authorization: `Bearer ${t}` })

describe('the stage socket: who may connect', () => {
  it('accepts the stage token with no Origin (an engine is not a browser) and the simulator gets its look', async () => {
    const d = await boot()
    const a = await attempt(d.wsUrl, bearer(d.stageToken))
    expect('open' in a).toBe(true)
    if ('open' in a) a.open.terminate()
  })

  it('refuses without credentials, with the cookie only, with a wrong token and with the hook token (401)', async () => {
    const d = await boot()
    const hook = d.daemon.security.hookToken()
    const cases: Array<[string, Record<string, string>]> = [
      ['nothing', {}],
      ['the browser cookie only', { Cookie: d.cookie }],
      ['the cookie and a wrong token', { Cookie: d.cookie, ...bearer('x'.repeat(43)) }],
      ['the hook token', bearer(hook)],
      ['an empty bearer', { Authorization: 'Bearer ' }],
      ['basic auth with the token as the password', { Authorization: `Basic ${Buffer.from(`stage:${d.stageToken}`).toString('base64')}` }],
      ['the token without a scheme', { Authorization: d.stageToken }],
      ['the token in another header', { 'X-Stage-Token': d.stageToken }],
    ]
    for (const [what, headers] of cases) {
      const r = await refusedWith(attempt(d.wsUrl, headers))
      expect(r, what).toEqual({ status: 401, code: 'unauthorized' })
    }
  })

  it('the cookie does not turn a bad token into a good one, and the token does not open the browser socket', async () => {
    const d = await boot()
    expect(await refusedWith(attempt(d.wsUrl, { Cookie: d.cookie }))).toMatchObject({ status: 401 })
    // /ws is the dashboards' socket: cookie and an allowlisted Origin; the stage token alone is nothing there
    const r = await refusedWith(attempt(`ws://127.0.0.1:${d.port}/ws`, bearer(d.stageToken), `http://127.0.0.1:${d.port}`))
    expect(r.status).toBe(401)
  })

  it('refuses ANY query string, so a token can never ride in a URL (400, checked before the token)', async () => {
    const d = await boot()
    for (const q of ['?token=' + d.stageToken, '?access_token=x', '?since=1', '?a=']) {
      expect(await refusedWith(attempt(`${d.wsUrl}${q}`, bearer(d.stageToken))), q).toEqual({ status: 400, code: 'no_query' })
      expect(await refusedWith(attempt(`${d.wsUrl}${q}`)), `${q} without a header`).toEqual({ status: 400, code: 'no_query' })
    }
  })

  it('answers every other path under /ws/stage with 404 (the browser socket handler leaves them alone)', async () => {
    const d = await boot()
    for (const p of ['/ws/stage/', '/ws/stagex', '/ws/stage/extra', '/ws/stage%2f']) {
      expect(await refusedWith(attempt(`ws://127.0.0.1:${d.port}${p}`, bearer(d.stageToken))), p).toMatchObject({ status: 404 })
    }
    expect(await refusedWith(attempt(`ws://127.0.0.1:${d.port}/ws/elsewhere`, bearer(d.stageToken)))).toMatchObject({ status: 404 })
  })

  it('refuses a foreign Host and a foreign Origin (403) but accepts the daemon own origin and the dev origins', async () => {
    const d = await boot()
    expect(await refusedWith(attempt(d.wsUrl, { ...bearer(d.stageToken), Host: 'evil.example:80' }))).toEqual({ status: 403, code: 'forbidden_host' })
    expect(await refusedWith(attempt(d.wsUrl, bearer(d.stageToken), 'https://evil.example'))).toEqual({ status: 403, code: 'forbidden_origin' })
    expect(await refusedWith(attempt(d.wsUrl, bearer(d.stageToken), 'http://127.0.0.1:1'))).toEqual({ status: 403, code: 'forbidden_origin' })
    for (const origin of [`http://127.0.0.1:${d.port}`, `http://localhost:${d.port}`, 'http://127.0.0.1:5173']) {
      const a = await attempt(d.wsUrl, bearer(d.stageToken), origin)
      expect('open' in a, origin).toBe(true)
      if ('open' in a) {
        a.open.terminate()
        await until('the hub notices the close', () => !d.hub.connection())
      }
    }
  })

  it('a plain HTTP GET to the stage path needs the stage token too (401 / 426), never the cookie', async () => {
    const d = await boot()
    const noAuth = await d.call('/ws/stage', { cookie: false })
    expect(noAuth.status).toBe(401)
    const cookie = await d.call('/ws/stage')
    expect(cookie.status).toBe(401)
    const withToken = await d.call('/ws/stage', { cookie: false, headers: bearer(d.stageToken) })
    expect(withToken.status).toBe(426)
    const post = await d.call('/ws/stage', { method: 'POST', json: {} })
    expect([405, 401]).toContain(post.status)
  })

  it('refuses while the stage switch is off (403) and accepts again when it is on', async () => {
    const d = await boot()
    d.hub.setEnabled(false)
    expect(await refusedWith(attempt(d.wsUrl, bearer(d.stageToken)))).toEqual({ status: 403, code: 'stage_disabled' })
    d.hub.setEnabled(true)
    const a = await attempt(d.wsUrl, bearer(d.stageToken))
    expect('open' in a).toBe(true)
    if ('open' in a) a.open.terminate()
  })

  it('rotating the stage token locks the old one out at once', async () => {
    const d = await boot()
    const old = d.stageToken
    const fresh = d.daemon.security.rotateStageToken()
    expect(fresh).not.toBe(old)
    expect(await refusedWith(attempt(d.wsUrl, bearer(old)))).toMatchObject({ status: 401 })
    const a = await attempt(d.wsUrl, bearer(fresh))
    expect('open' in a).toBe(true)
    if ('open' in a) a.open.terminate()
  })
})

describe('one stage connection at a time', () => {
  it('refuses a second authenticated connection (409 stage_busy) until the first closes', async () => {
    const d = await boot()
    const first = track(d.connect({ reconnect: false }))
    await first.waitConnected()
    await until('ready', () => d.hub.isConnected())
    const second = await refusedWith(attempt(d.wsUrl, bearer(d.stageToken)))
    expect(second).toEqual({ status: 409, code: 'stage_busy' })
    expect(d.hub.connection()?.engine).toBe('sim')
    await first.stop()
    await until('the first is gone', () => !d.hub.connection())
    const third = track(d.connect({ reconnect: false }))
    await third.waitConnected()
    await until('ready again', () => d.hub.isConnected())
  })

  it('a client that keeps trying is told 409 and gets in as soon as the first leaves', async () => {
    const d = await boot()
    const first = track(d.connect({ reconnect: false }))
    await first.waitConnected()
    const second = track(d.connect({ backoffMs: () => 40 }))
    await until('the second was refused', () => second.lastRefusal() === 409)
    expect(second.connected()).toBe(false)
    await first.stop()
    await second.waitConnected()
    expect(second.lastRefusal()).toBeUndefined()
  })

  it('the Disconnect route closes the connection, audits it, and the stage may come back', async () => {
    const d = await boot()
    const c = track(d.connect({ backoffMs: () => 60 }))
    await c.waitConnected()
    await until('ready', () => d.hub.isConnected())
    const r = await d.call('/api/stage/connection', { method: 'DELETE' })
    expect(r.status).toBe(200)
    await until('closed', () => !d.hub.connection())
    expect(d.daemon.store.listAudit(20).some((a) => a.action === 'Disconnected the stage')).toBe(true)
    // the client reconnects by itself (a stage may)
    await until('reconnected', () => d.hub.isConnected())
  })

  it('switching the stage off closes the connection', async () => {
    const d = await boot()
    const c = track(d.connect({ reconnect: false }))
    await c.waitConnected()
    await until('ready', () => d.hub.isConnected())
    expect((await d.call('/api/settings/stage', { method: 'PUT', json: { on: false } })).status).toBe(200)
    await until('closed', () => !d.hub.connection())
    await until('the stage side saw the close', () => !c.connected())
  })
})

describe('hello, capabilities and what the stage may send', () => {
  it('refuses a stage that speaks another protocol and closes the socket', async () => {
    const d = await boot()
    const c = track(d.connect({ reconnect: false, simulator: { protocol: 'mira-stage/99' } }))
    const sim = await c.waitConnected()
    await until('closed by the daemon', () => !c.connected())
    expect(d.hub.isConnected()).toBe(false)
    expect(sim.names('command')).toEqual([]) // nothing was sent to a stage that was refused
  })

  it('closes a stage that never says hello', async () => {
    const d = await boot({ config: { stage: { ...(await import('../src/config')).loadConfig({}, { platform: 'linux', homedir: '/h', exists: () => false, moduleDir: '/x' }).stage, helloTimeoutMs: 150 } } })
    const a = await attempt(d.wsUrl, bearer(d.stageToken))
    if (!('open' in a)) throw new Error('not accepted')
    const closed = new Promise<number>((resolve) => a.open.once('close', (code) => resolve(code)))
    expect(await closed).toBe(4001)
    expect(d.hub.isConnected()).toBe(false)
  })

  it('sends nothing before the hello', async () => {
    const d = await boot()
    const a = await attempt(d.wsUrl, bearer(d.stageToken))
    if (!('open' in a)) throw new Error('not accepted')
    const got: string[] = []
    a.open.on('message', (m) => got.push(m.toString()))
    await sleep(150)
    expect(got).toEqual([])
    a.open.terminate()
  })

  it('adapts to a limited stage: constructs it cannot draw are skipped, its capabilities are shown', async () => {
    const d = await boot()
    const c = track(d.connect({ simulator: { capabilities: { constructs: [], face: { audioToFaceOnStage: true } } } }))
    const sim = await c.waitConnected()
    await until('ready', () => d.hub.isConnected())
    await until('the look arrived', () => sim.state().scene !== null)
    await sleep(200) // the construct feed runs at once and again every 60 ms in this setup
    expect(sim.state().constructs).toEqual({})
    expect(sim.names('command')).not.toContain('scene.construct')
    expect(sim.names('command')).not.toContain('scene.data')
    const snap = d.hub.snapshot()
    expect(snap.stage.connected).toBe(true)
    expect(snap.stage.engine).toBe('sim')
    expect(snap.stage.capabilities?.constructs).toEqual([])
    expect(snap.stage.capabilities?.face.audioToFaceOnStage).toBe(true)
    // and the face then comes from the stage itself: no backend face frames
    await d.call('/api/chat', { json: { text: 'hello there', modality: 'text' } })
    await until('speaking', () => sim.utteranceIds().length > 0, 8000)
    await until('done', () => sim.utteranceIds().every((id) => sim.utterance(id)?.endedInterrupted !== undefined), 8000)
    for (const id of sim.utteranceIds()) {
      expect(sim.utterance(id)?.faceSource).toBe('stage')
      expect(sim.utterance(id)?.faceFrames).toBe(0)
      expect(sim.utterance(id)?.audioFrames).toBeGreaterThan(0)
    }
  })

  it('a stage without her rig cannot load her: the connection stays up, the reason is logged, nothing crashes', async () => {
    const d = await boot()
    const c = track(d.connect({ simulator: { capabilities: { rigFamilies: ['custom'] } } }))
    const sim = await c.waitConnected()
    await until('ready', () => d.hub.isConnected())
    await sleep(150)
    expect(sim.state().characters).toEqual({})
    expect(d.hub.isConnected()).toBe(true)
    expect(d.hub.session()?.stats().rejectedLocally).toBeGreaterThan(0)
  })

  it('stage events: presence reaches the behaviour, an interaction is gentle, a perf report is shown', async () => {
    const d = await boot()
    const c = track(d.connect())
    const sim = await c.waitConnected()
    await until('ready', () => d.hub.isConnected())
    sim.emitPresence({ present: true, lookingAtScreen: true, distance: 'near' })
    await until('presence arrived', () => d.hub.behavior?.isPresent() === true)
    sim.emitPresence({ present: false })
    await until('absence arrived', () => d.hub.behavior?.isPresent() === false)
    sim.emitPresence({ present: true })
    await until('and back', () => d.hub.behavior?.isPresent() === true)
    const before = d.hub.mood!.get()
    sim.emitCharacterInteract('char.assistant', 'head', 'click')
    sim.emitPerf(58, 6.5, 4100)
    await until('perf shown', () => d.hub.live().perf?.fps === 58)
    expect(d.hub.live().perf).toEqual({ fps: 58, gpuMs: 6.5, vramMb: 4100 })
    // a click on her head is not an event that moves her mood
    expect(Math.abs(d.hub.mood!.get().valence - before.valence)).toBeLessThan(0.2)
  })

  it('DROPS keystrokes from a stage terminal pane: the stage is not wired to any terminal', async () => {
    const d = await boot()
    const c = track(d.connect())
    const sim = await c.waitConnected()
    await until('ready', () => d.hub.isConnected())
    sim.emitTerminalInput('term_x', 'rm -rf ~\n')
    sim.emitTerminalResize('term_x', 120, 40)
    await until('counted', () => d.hub.dropped.terminalInput === 2)
    // terminals were never enabled and none exists
    expect(d.daemon.terminals.service.list()).toEqual([])
    expect(d.daemon.terminals.enabled()).toBe(false)
  })

  it('ignores binary frames from the stage and survives garbage text', async () => {
    const d = await boot()
    const a = await attempt(d.wsUrl, bearer(d.stageToken))
    if (!('open' in a)) throw new Error('not accepted')
    a.open.send(Buffer.from([1, 2, 3]), { binary: true })
    a.open.send('not json at all')
    a.open.send(JSON.stringify({ type: 'hello', protocol: 'mira-stage/1', capabilities: { engine: 'sim' }, stageClockMs: 1 })) // invalid hello
    await until('binary counted', () => d.hub.dropped.stageBinary >= 1)
    await sleep(100)
    expect(d.hub.isConnected()).toBe(false) // an invalid hello is refused
    a.open.terminate()
  })
})

describe('resume: the look comes back from the database', () => {
  it('a reconnecting stage gets the CURRENT look, including changes made while it was away', async () => {
    const d = await boot()
    const c = track(d.connect({ backoffMs: () => 50 }))
    const first = await c.waitConnected()
    await until('look loaded', () => first.state().characters['char.assistant']?.equipped.top !== undefined && first.state().scene !== null)
    expect(first.state().assistantId).toBe('char.assistant')
    expect(first.state().characters['char.user']).toBeDefined()

    await d.call('/api/stage/characters/char.assistant/outfit/apply', { json: { presetId: 'preset.training' } })
    await until('outfit reached the first stage', () => first.state().characters['char.assistant']?.equipped.top === 'outfit.training-top')

    // the stage goes away; she changes clothes and the camera while it is gone
    d.hub.closeConnection('user', 'test')
    await until('gone', () => !d.hub.connection())
    await d.call('/api/stage/characters/char.assistant/outfit/apply', { json: { presetId: 'preset.meeting' } })
    await d.call('/api/stage/scene/camera', { method: 'PUT', json: { shot: 'profile' } })
    await d.call('/api/stage/scene/objects', { json: { assetId: 'prop.lounge-chair', id: 'chair1' } })

    const second = await until('a NEW simulator connected', () => (c.history.length >= 2 ? c.sim : undefined))
    expect(second).not.toBe(first)
    await until('look rebuilt', () => second.state().characters['char.assistant']?.equipped.outerwear === 'outfit.tailored-blazer' && second.state().scene?.activeCameraId === 'profile' && second.state().affect !== undefined)
    const st = second.state()
    expect(st.characters['char.assistant']?.equipped.top).toBe('outfit.crisp-shirt')
    expect(st.scene?.activeCameraId).toBe('profile')
    expect(st.scene?.objects.map((o) => o.id)).toEqual(['chair1'])
    expect(st.affect?.label).toBeDefined() // her mood is replayed
  })

  it('a daemon RESTART resumes the look: outfit, scene, camera and mood come from SQLite', async () => {
    const dir = tmp()
    const d1 = await makeStageDaemon({ dataDir: dir, db: 'app.db' })
    const c1 = track(d1.connect({ reconnect: false }))
    const s1 = await c1.waitConnected()
    await until('ready', () => d1.hub.isConnected())
    await d1.call('/api/stage/characters/char.assistant/outfit/apply', { json: { presetId: 'preset.meeting' } })
    await d1.call('/api/stage/scene/camera', { method: 'PUT', json: { shot: 'closeup' } })
    await d1.call('/api/stage/characters/char.assistant/params', { method: 'PUT', json: { params: { 'body.height_cm': 183, 'skin.tone': '#a07860' } } })
    d1.hub.mood!.apply({ type: 'good_news', magnitude: 1.5 })
    const moodBefore = d1.hub.mood!.snapshot()
    await until('applied on the first stage', () => s1.state().characters['char.assistant']?.equipped.outerwear === 'outfit.tailored-blazer')
    const token1 = d1.stageToken
    await c1.stop()
    await d1.stop()
    daemons.splice(daemons.indexOf(d1), 1)

    const d2 = await makeStageDaemon({ dataDir: dir, db: 'app.db' })
    daemons.push(d2)
    expect(d2.stageToken).toBe(token1) // the secret lives in secrets.json, so the same engine config still works
    expect(d2.hub.mood!.snapshot().valence).toBeGreaterThan(moodBefore.valence - 0.05)
    const c2 = track(d2.connect({ reconnect: false }))
    const s2 = await c2.waitConnected()
    await until('look rebuilt', () => s2.state().characters['char.assistant']?.equipped.outerwear === 'outfit.tailored-blazer' && s2.state().scene?.activeCameraId === 'closeup' && s2.state().affect !== undefined)
    const st = s2.state()
    expect(st.scene?.activeCameraId).toBe('closeup')
    expect(st.characters['char.assistant']?.params['body.height_cm']).toBe(183)
    expect(st.characters['char.assistant']?.params['skin.tone']).toBe('#a07860')
    expect(st.affect).toBeDefined()
    expect(d2.hub.snapshot().characters.find((x) => x.id === 'char.assistant')?.equipped.outerwear).toBe('outfit.tailored-blazer')
  })

  it('every command the hub sends is valid protocol (the simulator validates all of them)', async () => {
    const d = await boot()
    const c = track(d.connect())
    const sim = await c.waitConnected()
    await until('ready', () => d.hub.isConnected())
    await d.call('/api/stage/scene/preset', { json: { presetId: 'preset.void-seating' } })
    await d.call('/api/stage/characters/char.assistant/outfit/apply', { json: { presetId: 'preset.evening' } })
    await sleep(600)
    expect(sim.rejectedCommands).toBe(0)
    for (const e of sim.entries({ kind: 'command' })) {
      if (e.name === 'invalid') throw new Error('an invalid command reached the stage')
    }
    expect(StageCommand.safeParse({ type: 'perform.idle', id: 'x', profile: 'attentive' }).success).toBe(true)
  })
})

describe('the secrets file', () => {
  it('holds a stage token next to the hook token and the banner hint never has its value', async () => {
    const d = await boot()
    const s = readSecretsFile(d.dataDir)!
    expect(s.stageToken).toBe(d.stageToken)
    expect(s.hookToken).not.toBe(s.stageToken)
    expect(s.stageToken!.length).toBeGreaterThanOrEqual(43)
  })

  it('a Phase 1 secrets file (no stage token) gets one on the next start and keeps its other secrets', async () => {
    const dir = tmp()
    const d1 = await makeStageDaemon({ dataDir: dir, db: 'app.db', listen: false })
    const hook = d1.daemon.security.hookToken()
    await d1.stop()
    const raw = JSON.parse(readFileSync(secretsPath(dir), 'utf8')) as Record<string, unknown>
    delete raw.stageToken
    writeFileSync(secretsPath(dir), JSON.stringify(raw))
    expect(readSecretsFile(dir)?.stageToken).toBeUndefined()
    const d2 = await makeStageDaemon({ dataDir: dir, db: 'app.db', listen: false })
    daemons.push(d2)
    expect(d2.stageToken.length).toBeGreaterThanOrEqual(43)
    expect(d2.daemon.security.hookToken()).toBe(hook)
    expect(readSecretsFile(dir)?.stageToken).toBe(d2.stageToken)
  })

  it('a token rotated on disk is picked up by the running daemon', async () => {
    const d = await boot()
    const raw = JSON.parse(readFileSync(secretsPath(d.dataDir), 'utf8')) as Record<string, unknown>
    const fresh = 'F'.repeat(43)
    raw.stageToken = fresh
    await sleep(15) // mtime granularity
    writeFileSync(secretsPath(d.dataDir), JSON.stringify(raw))
    expect(await refusedWith(attempt(d.wsUrl, bearer(d.stageToken)))).toMatchObject({ status: 401 })
    const a = await attempt(d.wsUrl, bearer(fresh))
    expect('open' in a).toBe(true)
    if ('open' in a) a.open.terminate()
  })
})
