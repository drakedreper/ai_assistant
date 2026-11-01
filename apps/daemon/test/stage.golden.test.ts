import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ARKIT_52, STAGE_PROTOCOL, StageCommand, StageEvent, WardrobeSlot } from '@ai-assistant/shared'
import {
  ARKIT_COUNT,
  AUDIO_SAMPLE_RATE,
  decodeFrame,
  FACE_FPS,
  FACE_FRAME_BYTES,
  FRAME_HEADER_BYTES,
  MAX_AUDIO_PAYLOAD_BYTES,
  MAX_FACE_FRAMES_PER_MESSAGE,
  MAX_FRAME_BYTES,
} from '@ai-assistant/stage-core'

/**
 * The golden frames of the stage protocol: one example of EVERY command and EVERY event, as JSON files under
 * unity/Packages/com.mira.stage/Tests~/golden. They are the shared truth between this TypeScript contract (zod, in
 * packages/shared/src/stage.ts) and the C# client for Unity:
 *
 *   - here, each example must parse with the real schema, and the set of examples must cover every variant, so adding a
 *     command or an event to the contract fails this test until a golden example exists (and so until the C# side is told);
 *   - in the C# tests (Tests~), the client must understand every command example and its own events must equal the event
 *     examples, key for key.
 */
const golden = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../unity/Packages/com.mira.stage/Tests~/golden')
const read = (dir: string): Array<{ file: string; value: unknown }> =>
  readdirSync(path.join(golden, dir))
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((file) => ({ file, value: JSON.parse(readFileSync(path.join(golden, dir, file), 'utf8')) as unknown }))

const variantTypes = (union: { options: ReadonlyArray<{ shape: { type: { value: string } } }> }): string[] => union.options.map((o) => o.shape.type.value).sort()

// NOT skipped when the fixtures are missing: a silent skip once hid that a "*~" line in .gitignore kept the whole Tests~
// folder out of git, so a fresh checkout would have run none of this.
describe('the golden frames of the stage protocol', () => {
  it('the fixtures are checked in (a missing folder means .gitignore or a partial checkout dropped Tests~)', () => {
    expect(existsSync(path.join(golden, 'commands')), `${golden}/commands`).toBe(true)
    expect(existsSync(path.join(golden, 'events')), `${golden}/events`).toBe(true)
    expect(existsSync(path.join(golden, 'recorded')), `${golden}/recorded`).toBe(true)
  })

  it('every command example is accepted by the real schema, and the examples cover every command', () => {
    const examples = read('commands')
    for (const e of examples) {
      const r = StageCommand.safeParse(e.value)
      expect(r.success, `${e.file}: ${r.success ? '' : JSON.stringify(r.error.issues[0])}`).toBe(true)
    }
    const types = [...new Set(examples.map((e) => (e.value as { type: string }).type))].sort()
    expect(types).toEqual(variantTypes(StageCommand as never))
  })

  it('every command example is named after its type', () => {
    for (const e of read('commands')) expect(e.file).toBe(`${(e.value as { type: string }).type}.json`)
  })

  it('every event example is accepted by the real schema, and the examples cover every event', () => {
    const examples = read('events')
    for (const e of examples) {
      const r = StageEvent.safeParse(e.value)
      expect(r.success, `${e.file}: ${r.success ? '' : JSON.stringify(r.error.issues[0])}`).toBe(true)
    }
    const types = [...new Set(examples.map((e) => (e.value as { type: string }).type))].sort()
    expect(types).toEqual(variantTypes(StageEvent as never))
  })

  it('the protocol constants the C# client hard-codes equal the TypeScript ones (golden/constants.json: version, frame sizes, ARKit order, wardrobe slots)', () => {
    const live = {
      protocol: STAGE_PROTOCOL,
      frameHeaderBytes: FRAME_HEADER_BYTES,
      arkitCount: ARKIT_COUNT,
      faceFrameBytes: FACE_FRAME_BYTES,
      faceFps: FACE_FPS,
      audioSampleRate: AUDIO_SAMPLE_RATE,
      maxFrameBytes: MAX_FRAME_BYTES,
      maxAudioPayloadBytes: MAX_AUDIO_PAYLOAD_BYTES,
      maxFaceFramesPerMessage: MAX_FACE_FRAMES_PER_MESSAGE,
      arkit52: [...ARKIT_52],
      wardrobeSlots: [...WardrobeSlot.options],
    }
    const file = JSON.parse(readFileSync(path.join(golden, 'constants.json'), 'utf8')) as unknown
    // A change of the order of ARKIT_52 would scramble every face frame on a stage that still has the old table.
    expect(file).toEqual(live)
  })

  it('the events the Unity stage declares in its hello fit the schema it must satisfy (Unity v0: VRM 1.0, no constructs)', () => {
    const hello = read('events').find((e) => e.file === 'hello.json')?.value as { capabilities: { engine: string; rigFamilies: string[]; constructs: string[] } }
    expect(hello.capabilities.engine).toBe('unity')
    expect(hello.capabilities.rigFamilies).toEqual(['vrm1'])
    expect(hello.capabilities.constructs).toEqual([])
  })
})

describe('traffic recorded from the real daemon (scripts/record-stage-golden.ts)', () => {
  const dir = path.join(golden, 'recorded')

  it('every recorded command is still accepted by the schema (a failure means the fixtures are stale: record them again)', () => {
    const files = readdirSync(dir).filter((f) => /^\d+-.*\.json$/.test(f))
    expect(files.length).toBeGreaterThan(3)
    const types = new Set<string>()
    for (const f of files) {
      const value = JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as { type: string }
      const r = StageCommand.safeParse(value)
      expect(r.success, `${f}: ${r.success ? '' : JSON.stringify(r.error.issues[0])}`).toBe(true)
      types.add(value.type)
    }
    for (const needed of ['character.load', 'scene.load', 'perform.speak']) expect([...types], `no ${needed} was recorded`).toContain(needed)
  })

  it('every recorded binary frame decodes with the reference decoder, and is the kind its name says', () => {
    const framesDir = path.join(dir, 'frames')
    expect(existsSync(framesDir), framesDir).toBe(true)
    const files = readdirSync(framesDir).filter((f) => f.endsWith('.b64'))
    expect(files.length).toBeGreaterThan(0)
    for (const f of files) {
      const bytes = Buffer.from(readFileSync(path.join(framesDir, f), 'utf8').trim(), 'base64')
      const r = decodeFrame(bytes)
      expect(r.ok, `${f}: ${r.ok ? '' : r.error}`).toBe(true)
      if (r.ok) expect(r.frame.kind, f).toBe(f.includes('-audio') ? 1 : 2)
    }
  })
})
