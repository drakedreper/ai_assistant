import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { StageCapabilities, StageLive } from '@ai-assistant/shared'
import { DRAFT_STAGE_CAPABILITIES, DRAFT_STAGE_DOES_NOT, createDraftStage, gazeToLook, liveToRoom, moodToExpression } from '../../web/src/stage/draftStage'
import { readSecretsFile } from '../src/security'
import { makeStageDaemon } from '../src/stage/testing'

/**
 * The DRAFT web stage (apps/web/src/stage/draftStage.ts) is pure mapping code with no DOM, so it is tested here, next to the
 * backend that feeds it. (The web package has no test runner of its own; the e2e script covers the React side.)
 */

const live = (over: Partial<StageLive> = {}): StageLive => ({ rev: 1, enabled: true, connected: false, mood: { valence: 0.2, arousal: -0.1, dominance: 0.7, label: 'neutral' }, speaking: false, ...over })

describe('the draft stage declares honest capabilities', () => {
  it('is a valid StageCapabilities that claims nothing it cannot do', () => {
    expect(StageCapabilities.safeParse(DRAFT_STAGE_CAPABILITIES).success).toBe(true)
    const c = DRAFT_STAGE_CAPABILITIES
    expect(c.engine).toBe('web')
    expect(c.constructs).toEqual([]) // no constructs
    expect(c.rigFamilies).toEqual([]) // no outfit-capable rig, so nothing is dressed
    expect(c.render).toEqual({ strandHair: false, clothSim: false, runtimeAssetLoading: false, embeddedStream: false })
    expect(c.face).toEqual({ arkit52: false, visemes: false, audioToFaceOnStage: false })
    expect(c.tracking).toEqual({ face: false, body: false })
    expect(c.maxCharacters).toBe(1)
    expect(DRAFT_STAGE_DOES_NOT.join(' ')).toMatch(/outfits/)
    expect(DRAFT_STAGE_DOES_NOT.join(' ')).toMatch(/constructs/)
  })
})

describe('mood, gaze and sleep map onto the Room', () => {
  it('a neutral mood shows no expression; others scale with how far she leans', () => {
    expect(moodToExpression(null)).toEqual({ emotion: 'neutral', intensity: 0 })
    expect(moodToExpression({ valence: 0.2, arousal: -0.1, dominance: 0.7, label: 'neutral' })).toEqual({ emotion: 'neutral', intensity: 0 })
    const mild = moodToExpression({ valence: 0.3, arousal: 0.1, dominance: 0.7, label: 'happy' })
    const strong = moodToExpression({ valence: 0.9, arousal: 0.8, dominance: 0.7, label: 'happy' })
    expect(mild.emotion).toBe('happy')
    expect(strong.intensity).toBeGreaterThan(mild.intensity)
    for (const m of [mild, strong]) expect(m.intensity).toBeGreaterThanOrEqual(0.35)
    expect(strong.intensity).toBeLessThanOrEqual(1)
  })

  it('every gaze target has a Room look', () => {
    expect(gazeToLook(undefined)).toBe('user')
    expect(gazeToLook({ kind: 'user' })).toBe('user')
    expect(gazeToLook({ kind: 'camera' })).toBe('screen')
    expect(gazeToLook({ kind: 'object', objectId: 'monitor' })).toBe('screen')
    expect(gazeToLook({ kind: 'point', position: [0, 1, 2] })).toBe('screen')
    expect(gazeToLook({ kind: 'away', direction: 'left' })).toBe('window')
    expect(gazeToLook({ kind: 'away', direction: 'right' })).toBe('window')
    expect(gazeToLook({ kind: 'away', direction: 'up' })).toEqual({ x: 0, y: 0.6 })
    expect(gazeToLook({ kind: 'away', direction: 'down' })).toEqual({ x: 0, y: -0.6 })
  })

  it('asleep follows the idle profile or the sleep posture', () => {
    expect(liveToRoom(live({ idle: 'asleep' })).asleep).toBe(true)
    expect(liveToRoom(live({ posture: 'sleep' })).asleep).toBe(true)
    expect(liveToRoom(live({ idle: 'sleepy' })).asleep).toBe(false)
  })
})

describe('createDraftStage applies only what changed', () => {
  it('first update sets expression and look, later identical updates set nothing', () => {
    const calls: unknown[] = []
    const draft = createDraftStage((p) => calls.push(p))
    draft.update(live({ mood: { valence: 0.6, arousal: 0.3, dominance: 0.7, label: 'happy' }, gaze: { kind: 'user' } }))
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ emotion: 'happy', lookAt: 'user' })
    draft.update(live({ mood: { valence: 0.6, arousal: 0.3, dominance: 0.7, label: 'happy' }, gaze: { kind: 'user' } }))
    expect(calls).toHaveLength(1)
    draft.update(live({ mood: { valence: 0.6, arousal: 0.3, dominance: 0.7, label: 'happy' }, gaze: { kind: 'away', direction: 'left' } }))
    expect(calls).toHaveLength(2)
    expect(calls[1]).toEqual({ lookAt: 'window' })
  })

  it('leaves the Room alone while the stage backend is off, and does not force "awake" on first contact', () => {
    const calls: unknown[] = []
    const draft = createDraftStage((p) => calls.push(p))
    draft.update(live({ enabled: false, mood: null }))
    expect(calls).toEqual([])
    draft.update(live({ idle: 'attentive' }))
    expect(calls[0]).not.toHaveProperty('asleep') // the Room's own quiet-hours guess stands until the backend changes it
    draft.update(live({ idle: 'asleep' }))
    expect(calls[calls.length - 1]).toMatchObject({ asleep: true })
    draft.update(live({ idle: 'attentive' }))
    expect(calls[calls.length - 1]).toEqual({ asleep: false })
  })

  it('the live feed the daemon publishes is exactly what the adapter reads', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stage-draft-'))
    const d = await makeStageDaemon({ dataDir: dir, listen: false })
    try {
      d.hub.mood!.apply({ type: 'good_news', magnitude: 2 })
      const l = d.hub.live()
      expect(StageLive.safeParse(l).success).toBe(true)
      const patch: unknown[] = []
      createDraftStage((p) => patch.push(p)).update(l)
      expect(patch).toHaveLength(1)
      expect(patch[0]).toHaveProperty('emotion')
    } finally {
      await d.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('the stage CLI', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it('prints the stage token from secrets.json (on purpose) and rotates it on request', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stage-cli-'))
    dirs.push(dir)
    const d = await makeStageDaemon({ dataDir: dir, listen: false })
    const token = d.stageToken
    await d.stop()
    const cli = resolve(fileURLToPath(new URL('../src/stage/cli.ts', import.meta.url)))
    const run = (...args: string[]) => execFileSync(process.execPath, ['--import', 'tsx', cli, ...args], { env: { ...process.env, DATA_DIR: dir }, cwd: resolve(fileURLToPath(new URL('..', import.meta.url))), encoding: 'utf8' }).trim()
    expect(run('token')).toBe(token)
    const rotated = run('token', '--rotate')
    expect(rotated).not.toBe(token)
    expect(readSecretsFile(dir)?.stageToken).toBe(rotated)
    expect(() => run('nonsense')).toThrow()
    // an empty data dir has no token to print
    const empty = mkdtempSync(join(tmpdir(), 'stage-cli-empty-'))
    dirs.push(empty)
    expect(() => execFileSync(process.execPath, ['--import', 'tsx', cli, 'token'], { env: { ...process.env, DATA_DIR: empty }, cwd: resolve(fileURLToPath(new URL('..', import.meta.url))), stdio: 'pipe' })).toThrow()
  }, 30_000)
})
