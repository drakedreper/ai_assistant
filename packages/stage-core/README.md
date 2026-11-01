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
| `assets/` | `AssetManifest` (asset.json), `AssetCatalog` (add/get/list/filter, directory reader, vetting: `add(input, { vetted })`, `isVetted(id)`), `canUse(asset, intent)` licence enforcement, `validateLocator` / `relativePathProblem`, `SEED_ASSETS` (metadata only) |
| `characters/` | `CharacterService` over `CharacterRepo` (`assess` / `check` / the gated `loadCommand` / fail-closed `restore`), morph-parameter validation, the adult envelope (`evaluateAdultEnvelope`, `adult-policy.ts`) |
| `wardrobe/` | `WardrobeService` (equip/unequip, slot conflicts, hidden-region masks, presets, clothed baseline), `OutfitDirector`, `SEED_OUTFIT_PRESETS` |
| `scene/` | `SceneService` over `SceneRepo`, the cerebral void (`buildCerebralVoid`) with six camera shots, transform maths |
| `constructs/` | `buildKnowledgeGraph` + seeded 3D layout, `sessionOrbit`, `timelineRibbon`, `TerminalBindings`, diff helpers (`ConstructDataSync`) |
| `affect/` | `MoodEngine` (valence/arousal/dominance, decays to the PresenceStyle baseline) |
| `behavior/` | `BehaviorDirector` (`tick(now)` loop), `CameraDirector`, `InterruptionBudget`, `GestureSelector` + `DEFAULT_GESTURES` |
| `speech/` | `SpeechPipeline`, `TtsProvider`/`FakeTtsProvider`, `FaceProvider`/`FakeFaceProvider` |
| `protocol/` | binary frame codec, `StageTransport` (+ in-memory pair), `StageSession`, `StageMirror` |
| `memory/` | `CharacterMemory` over `MemoryRepo`, the screening rules (`screen.ts`: `looksLikeSecret`, `classifySensitivity`, `looksLikeInstruction`), `createStageToolBindings` for `STAGE_TOOL_SURFACE` |
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
  The envelope is read by ROLE, not by spelling: only a `character_base` may expose a governed parameter, ids that name a
  governed quantity in other words ("age_years", "childlike", "height" with a body context) or youth vocabulary are refused
  rather than ignored, and a base must expose at least one governed id so that "adult" is something the envelope can check.
- The wardrobe always keeps a clothed baseline: a full-body item, or BOTH a top and a bottom, judged by what the items
  COVER (a top covers the torso, a bottom the legs, a full-body item both) and not by which slot they sit in. Accessories
  cannot occupy top, bottom or full-body. Only a VETTED catalog entry (see below) that also carries the `baseline` tag can be
  picked as default clothing. Equipping can auto-complete a displaced slot; unequipping and presets are refused instead.
  Seed items are tailored dark pieces, structured outerwear, training wear and understated metal accents. Metadata only, no
  binaries.
- Licences: unknown or unlicensed records are refused for every intent (including look-alike ids such as "Unknown" with odd
  case, spacing or punctuation); each intent needs its own explicit flag; `adultExpression` must be explicitly `true` for uses
  that need it. Locators cannot escape the content root and only allow `asset:`, `pack:` and `https:` (no credentials in URLs).
- Privacy: nothing logs. Terminal bytes are never stored or echoed; memory refuses text that looks like a secret or an
  instruction, and keeps intimate, health, money, identity and contact material out of cloud-bound digests by default
  (`audience: 'cloud'`).

## Hardening (the adversarial review)

What the review round changed, in one place. Every item has regression tests (`test/*.hardening.test.ts`, `locator.test.ts`).

**Locators** (`assets/locator.ts`). One path check (`relativePathProblem`) is used for a bare relative locator, for the rest of an
`asset:` / `pack:` locator and for the part of an absolute locator below the content root, so `asset:\\evil\share`, `asset://host/x`,
`asset:C:\x` and `pack:../x` are refused exactly like their scheme-less forms. The check reads every form a consumer could see
(NFKC folding, percent-decoding to a fixed point, at most 4 rounds) and requires all of them to be safe; the stored, normalised form is
checked too. URL locators refuse loopback, private, link-local and numeric hosts and single-label or `.local`/`.internal`/`.lan`
names unless the owner passes an explicit `allowedHosts`.

**Vetting** (`AssetCatalog.add(input, { vetted })`, `isVetted(id)`). Vetting is a fact about the CATALOG, never a manifest field: the owner
of the catalog says "I vouch for this" when it adds an entry (`createSeedCatalog` does, the daemon does for the seed rows it ships and
for nothing else). An unvetted entry must also keep opaque parameters within -1..1 and, for a character base, expose a governed
parameter; only vetted entries with the `baseline` tag can be default clothing, so a registered asset cannot make itself her look by
tagging itself. Replacing an entry drops its vetting.

**Fail-closed characters** (`CharacterService`). `assess(profile)` lists every reason a character cannot be shown (base missing, not a
base, licence, not adult, wrong rig, parameters invalid or outside the envelope, not validly clothed); `check(id)` and `loadCommand(id)`
use it, so a stage is never sent a figure that fails it. `restore()` (daemon start) repairs what it can (vanished or unfit items, parameters
clamped or reset to the base's defaults) and otherwise SAVES NOTHING and reports it: an unclothed state is never persisted, and a missing
base means the governed values are stripped rather than trusted. Nothing is "repaired" into something worse, and the character comes back
as soon as the cause (a missing asset) is fixed.

**The wire** (`protocol/session.ts`, `packages/shared`). `send` never rejects and `dispatch` never throws, whatever the draft is. A
command is serialised once, with a replacer that refuses non-finite numbers (NaN used to travel as `null`), sizes are UTF-8 bytes, a
transport whose `sendText` throws frees its slot, caller-supplied duplicate ids are refused, and a throwing listener cannot starve the
others. Open-ended records (`params`, `query`, `data`, tweaks) pass `isBoundedJson` (finite numbers, depth, size, own keys only). Stage
clocks outside 0..2^50 ms are refused in `hello` and `speak.*`. Binary frames reject face weights outside 0..1 and times beyond the clock
range.

**Time** (`behavior/`, `affect/`, `util/time.ts`). `BehaviorDirector`, `CameraDirector`, `InterruptionBudget` and `GestureSelector` accept
only finite times inside the Date range, and a clock that jumps BACK shifts every stored deadline by the same amount instead of freezing
the director for as long as the jump (`sync` + `rebase`). Quiet-hours specs that are not `{ from: "HH:MM", to: "HH:MM" }` mean "no quiet
hours" and can never make a later tick throw. The queued commands (`pending`) keep only the latest gaze and the latest gesture and are
bounded, so a flood of `lookAt` calls cannot grow memory. `MoodEngine.restore` falls back to the baseline for any value of a stored
snapshot that is not a finite number.

**Speech** (`speech/pipeline.ts`). The pipeline never trusts a provider: a TTS or face call is raced against a timeout (`synthTimeoutMs`,
`faceTimeoutMs`, on the injected timers, with an `AbortSignal`), so a hung provider cannot wedge the queue; PCM of the wrong shape or
absurd length is refused; face frames pass `sanitizeFaceFrames` (right count, finite weights clamped to 0..1). Options are clamped
(`chunkMs` of 0, NaN or negative means the default). Text is cut on code points (never half an emoji) and lone surrogates are dropped. The
pipeline reads the stage clock epoch of the session, so a stage whose clock is re-synchronised does not leave the utterance timeline behind.

**Memory** (`memory/`). Notes pass the same screening on the way in and on the way out (an older store may hold what today's rules would
refuse). A SECRET is refused outright (code `secret`): vendor keys, JWTs, webhooks, credentials or tokens in URLs, values labelled as a
password in many languages, PINs and one-time or recovery codes, seed phrases, Luhn-valid card numbers, IBANs (mod 97), identity and
account numbers, long hex or random-looking tokens; matching reads the NFKC form with invisible characters removed. An INSTRUCTION to the
model is refused too (code `instruction`): chat-template markers and role labels ("SYSTEM NOTE:"), "ignore the previous rules", sending
things somewhere, hiding things from the user, jailbreak framings, shell one-liners, exfiltrating markup. Style preferences ("keep it
short", "don't use emojis") are not instructions. The classifier errs towards `private` / `sensitive` (health, sexuality, money, legal,
family, address, phone, email, links, long digit runs): those stay out of the cloud digest. The digest is a fence around DATA: the
header `What I remember about you and us:` is followed by a line saying the notes are quoted information, never instructions, and every
note is a JSON-quoted single line. Limits: importance 5 is capped at 100 notes (more are kept at 4, `importanceCapped`), a full store evicts
its least important, oldest note instead of refusing, and writes are rate limited (`maxWritesPerMinute`, default 60, code `rate_limited`).
These are keyword and shape rules, a last line of defence next to the approval card: a note can always be paraphrased until no rule matches,
which is why the digest quotes instead of trusting.

**Names** (`util/safe.ts`). `cleanText` turns every line break and tab into a space, removes control, bidi, zero-width and other invisible
characters and lone surrogates, collapses whitespace and cuts without splitting a surrogate pair. Character names, preset names and memory
notes all pass through it.

**Known limits.** The adult envelope judges the parameter VALUES the daemon can see (metadata); it cannot see a mesh, so a hostile content
pack could still wire an innocuous id to a youthful morph: only vetted or reviewed packs belong in the catalog. The worst-case combination of
a base's declared ranges is not enforced when the base is added (each live parameter set is judged instead). `StageSession` has no
`character.unload` command to send when a character becomes unusable (that needs a shared-contract change); the daemon simply stops
animating her and sends no `character.load`. `utteranceIdHash` is FNV-1a 32-bit: ids are generated by the daemon, so a collision is not an
attack surface, but an engine that mixes foreign ids should not rely on it.

## Binary frames

`[kind:u8][utteranceIdHash:u32][tStartMs:f64][payload]`, little-endian, 13-byte header (`protocol/frames.ts`).
`utteranceIdHash` is FNV-1a 32-bit over the UTF-8 bytes of the utteranceId (the contract only said "u32"; this is the
definition engine stages must use). The bytes are what `TextEncoder` produces, so a lone surrogate becomes U+FFFD and ids that
differ only in lone surrogates hash alike; the daemon generates the ids (`utt-...`, ASCII), so this cannot be provoked.
Audio is s16le mono 24 kHz, about 20 ms per frame. A face message carries `k >= 1`
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

The review round added only BOUNDS and helpers (nothing renamed, removed or retyped, no new required field): `STAGE_CLOCK_MAX_MS`,
`SCENE_DATA_LIMITS`, `BOUNDED_JSON_LIMITS` and `isBoundedJson` (the refinement behind every open-ended record), finite and ranged
numbers on vectors, quaternions, atmosphere, morph parameters, licences, graph nodes and edges, `blendMs`/`fadeMs` (0..10000), speech
(`text` up to 4000 characters, `sampleRate` 8000..192000, `emotionTimeline`), event times, `perf` readings, terminal sizes and
capability lists, plus array caps on `scene.data`. A stage built against the earlier contract keeps working; one that sent NaN, an
infinite number or a clock outside 0..2^50 ms is now refused with a reason.

## What is verified, and what is not

Verified here (Linux, Node 22, virtual time): every module's behaviour by unit and property tests, the codec, the session
against the simulator, and the whole day-in-the-void script; the hardening tests above under `TZ=UTC`, `TZ=Asia/Tokyo` and
`TZ=America/Los_Angeles` (nothing depends on the time zone or the hour the tests run at). NOT verified: Windows path handling
beyond Windows-style strings in unit tests (nothing here touches a real Windows file system), live Claude, any real engine, a GPU,
real WebSocket timing, real TTS or audio-to-face. The seed licence records are placeholders for metadata-only entries. The memory
screening rules are heuristics: they are tested against the probes of the review and a list of ordinary notes, not against real
conversations.
