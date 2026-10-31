# @ai-assistant/stage-core

The backend of the live 3D assistant, as pure logic. The daemon owns the character (identity, appearance parameters,
wardrobe, scene, mood, memory, performance) and talks to replaceable "stages" (Unreal, Unity, the web room or the
headless simulator) over the `mira-stage/1` contract in `packages/shared/src/stage.ts`.

No HTTP, no SQLite, no engine code, no globals: every clock, timer, RNG and id source is injected, and persistence is
behind repository interfaces the daemon implements later (all synchronous, copy-safe; in-memory versions are provided).
Everything is zod-validated at its edges. `pnpm --filter @ai-assistant/stage-core typecheck && pnpm --filter
@ai-assistant/stage-core test`.

## Modules (`src/`)

| Module | What it gives you |
|---|---|
| `assets/` | `AssetManifest` (asset.json), `AssetCatalog` (add/get/list/filter, directory reader), `canUse(asset, intent)` licence enforcement, `validateLocator`, `SEED_ASSETS` (metadata only) |
| `characters/` | `CharacterService` over `CharacterRepo`, morph-parameter validation, the adult envelope (`evaluateAdultEnvelope`) |
| `wardrobe/` | `WardrobeService` (equip/unequip, slot conflicts, hidden-region masks, presets, clothed baseline), `OutfitDirector`, `SEED_OUTFIT_PRESETS` |
| `scene/` | `SceneService` over `SceneRepo`, the cerebral void (`buildCerebralVoid`) with six camera shots, transform maths |
| `constructs/` | `buildKnowledgeGraph` + seeded 3D layout, `sessionOrbit`, `timelineRibbon`, `TerminalBindings`, diff helpers (`ConstructDataSync`) |
| `affect/` | `MoodEngine` (valence/arousal/dominance, decays to the PresenceStyle baseline) |
| `behavior/` | `BehaviorDirector` (`tick(now)` loop), `CameraDirector`, `InterruptionBudget`, `GestureSelector` + `DEFAULT_GESTURES` |
| `speech/` | `SpeechPipeline`, `TtsProvider`/`FakeTtsProvider`, `FaceProvider`/`FakeFaceProvider` |
| `protocol/` | binary frame codec, `StageTransport` (+ in-memory pair), `StageSession`, `StageMirror` |
| `memory/` | `CharacterMemory` over `MemoryRepo`, `createStageToolBindings` for `STAGE_TOOL_SURFACE` |
| `sim/` | `SimulatorStage`, `runStageConformance` |

## Injected dependencies

- `Clock { now() }` (epoch ms) and `Timers { setTimeout, clearTimeout }`: use `systemClock`/`systemTimers` in the daemon,
  `createVirtualTime(startMs)` in tests (`advance(ms)` fires due timers in order).
- `Rng`: `createRng(seed)` (mulberry32). Behaviour variation is reproducible for a seed.
- `IdGenerator`: `(prefix) => id`. `createSequentialIds()` for tests.
- Repos: `CharacterRepo`, `SceneRepo`, `MemoryRepo`. Local time (quiet hours, time of day) is the process time zone.
- Providers: `TtsProvider.synthesize({text, voice, emotion, sampleRate, signal})` returns s16 PCM;
  `FaceProvider.frames({pcm, sampleRate, fps, ...})` returns 52-float ARKit frames. Fakes are included.

## Conventions

- Coordinates: metres, Y up, right-handed. The character stands at the origin facing +Z. A camera looks down its own -Z.
  Quaternions are `[x, y, z, w]`. Constructs hang in front of her (+Z); in the knowledge graph local z is depth (core 0,
  inbox farthest).
- `Equipped` in the shared contract is an EXHAUSTIVE record under zod 4 (all 16 slots must be present, `null` for empty).
  Use `emptyEquipped()` / `normalizeEquipped()`.
- Colour parameters are declared with `min 0, max 16777215` and an integer default (0xRRGGBB); values are accepted as
  `#rgb`, `#rrggbb` or an integer and stored as `#rrggbb`.
- Services return `Result` values (`{ok: true, value}` / `{ok: false, code, error}`) for expected failures and never throw
  on bad input. The commands a change implies are returned as `CommandDraft`s (no id); `StageSession` assigns ids.

## Content rules (enforced in code)

- Every character is an adult. Seed bases declare slider ranges inside the adult envelope
  (`characters/adult-policy.ts`: age floor 25, height floor 158 cm, bounded head scale, jaw definition, eye size,
  roundness, leg length, and a combined youthfulness limit), values are clamped into the base's ranges, the whole parameter
  set is judged as a combination, and a base whose declared ranges leave the envelope (or lacks `adult: true`) is refused.
- The wardrobe always keeps a clothed baseline: a full-body item, or BOTH a top and a bottom. Stricter than "not both
  empty". Equipping can auto-complete a displaced slot; unequipping and presets are refused instead. Seed items are tailored
  dark pieces, structured outerwear, training wear and understated metal accents. Metadata only, no binaries.
- Licences: unknown or unlicensed records are refused for every intent; each intent needs its own explicit flag;
  `adultExpression` must be explicitly `true` for uses that need it. Locators cannot escape the content root and only
  allow `asset:`, `pack:` and `https:` (no credentials in URLs).
- Privacy: nothing logs. Terminal bytes are never stored or echoed; memory refuses text that looks like a secret and keeps
  intimate or health material out of cloud-bound digests by default (`audience: 'cloud'`).

## Binary frames

`[kind:u8][utteranceIdHash:u32][tStartMs:f64][payload]`, little-endian, 13-byte header (`protocol/frames.ts`).
`utteranceIdHash` is FNV-1a 32-bit over the UTF-8 bytes of the utteranceId (the contract only said "u32"; this is the
definition engine stages must use). Audio is s16le mono 24 kHz, about 20 ms per frame. A face message carries `k >= 1`
frames of 52 f32 (208 bytes each), frame `i` at `tStartMs + i*1000/30`. `decodeFrame` never throws and rejects truncated,
oversized, unknown-kind, non-finite or misaligned input.

## Wiring (what the daemon does)

`test/day-in-the-void.test.ts` is the reference wiring. In short:

```ts
const session = createStageSession({ transport, clock, timers, newId, mirror })   // one per connection; mirror outlives it
await session.ready()                                                               // refuses a protocol mismatch
const pipeline = new SpeechPipeline({ sink: session, tts, face, voice, clock, timers, newId })
session.onEvent((e) => { pipeline.handleStageEvent(e); /* behaviour/user.presence/clicks */ })
// loop: session.send(cmd, { ack: false }) for behavior.tick() and camera.update(); await session.send(...) for loads
```

`StageSession` adapts to the stage's `hello` (skips constructs it cannot draw, checks rigs and `maxCharacters`, picks
backend face frames vs the stage's own audio-to-face), estimates the stage clock offset (`stageNow()`), bounds in-flight
commands, times out unanswered ones, holds binary back under back-pressure and, after a reconnect, replays the
`StageMirror` (`character.load`, `scene.load`, construct data, current look). The mirror only knows what the stage
acknowledged, so a daemon that changed things while the stage was away should rebuild from its services instead
(`resumeCommands: () => [...characters.loadCommand, ...scenes.loadCommand, ...mirror.replayLook()]`) and call
`ConstructDataSync.reset()`. Wire `wardrobe.onChange` to
`OutfitDirector.handleChange` so every change counts for its cooldown and explicit user choices are remembered.

## Plugging an engine stage in

1. Implement the stage side of `mira-stage/1`: send `hello` first; answer every command with exactly one `command.done` or
   `command.failed` (with a reason); validate input; report `asset.loaded`/`asset.failed`, `speak.started`/`speak.ended`.
2. Connect it to the daemon's `/ws/stage` and adapt the socket to `StageTransport` (`sendText`, `sendBinary`, `onText`,
   `onBinary`, `close`, optionally `onClose` and `bufferedAmount`).
3. Run the conformance suite against it.

## Running the conformance suite

```ts
import { describe, it, expect } from 'vitest'
import { runStageConformance } from '@ai-assistant/stage-core'

runStageConformance(async () => ({
  transport,            // backend end of a connection to the stage under test
  clock, timers,        // virtual for the simulator, system clock for an engine
  start: () => stage.start(),
  advance: async (ms) => { /* virtual: vt.advance(ms); real: await sleep(ms) */ },
  dispose: () => stage.stop(),
}), { describe, it, expect })
```

`test/sim.conformance.test.ts` runs it against the `SimulatorStage` (and a limited-capability variant) and checks that the
suite fails broken stages. It reads the stage's capabilities from `hello` and skips what the stage declares it cannot do.

## Additive changes made to `packages/shared/src/stage.ts`

`GraphNode.size` and `GraphNode.brightness` (optional importance hints; without them a validating stage would strip the
hints), `scene.data.remove` (optional `{nodes, edges, items}` so diffs can remove things in `merge` mode), and a comment
documenting the frame hash and face payload. Nothing existing was renamed, removed or retyped.

## What is verified, and what is not

Verified here (Linux, Node 22, virtual time): every module's behaviour by unit and property tests, the codec, the session
against the simulator, and the whole day-in-the-void script. NOT verified: Windows path handling beyond Windows-style
strings in unit tests, live Claude, any real engine, a GPU, real WebSocket timing, real TTS or audio-to-face. The seed
licence records are placeholders for metadata-only entries.
