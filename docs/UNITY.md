# The Unity stage

Status: written 2026-11-01. The owner chose Unity as the first engine stage ([ADR 0008](adr/0008-stage-protocol-and-engine-choice.md), update of the same date). **What exists is the backend side and an engine-free C# client, verified without Unity. The Unity project itself (the room, the model, the screen) is not built yet: it is built on the owner's PC, where Unity can run, using [spikes/unity/KICKOFF-PROMPT.md](../spikes/unity/KICKOFF-PROMPT.md).** Nothing here has been seen in a Unity Editor or on a GPU.

## The picture

```
   your PC (Windows, RTX 5070 Ti)                              backend (native, or in Docker)
 +------------------------------------+                  +------------------------------------+
 | Unity (Editor or built player)     |                  | daemon: character, wardrobe, scene,|
 |   Mira.Stage (C# client, this repo)|== ws://127.0.0.1 =| mood, memory, speech (audio + ARKit|
 |   + Unity layer (built on the PC)  |   :7421/ws/stage | face frames), Claude, terminal     |
 |   VRM model, room, cameras, audio  |   stage token    |                                    |
 +------------------------------------+                  +------------------------------------+
```

The daemon owns the character; Unity renders it and reports back (`mira-stage/1`, [packages/shared/src/stage.ts](../packages/shared/src/stage.ts)). The same daemon runs natively (`start.cmd`) or in Docker ([DOCKER.md](DOCKER.md)): Unity only needs the URL and the token.

## What is verified, and what is not

Verified in the Linux sandbox (and again by [`.github/workflows/unity-stage.yml`](../.github/workflows/unity-stage.yml) on a clean Linux runner):

| | how |
|---|---|
| The C# client speaks the protocol: handshake, every command, every event, binary audio and face frames, reconnect with backoff | 165 xunit tests (`dotnet test`, .NET 8) over golden JSON for every one of the 19 commands and 15 events, plus traffic recorded from the real daemon |
| The C# client works against the real daemon process (not a mock) | 4 live tests: look delivered (two characters, the void), a chat answered with audio and face frames, 401 wrong token, 409 second stage, 403 stage off, reconnect after a daemon restart |
| The C# and TypeScript sides agree on constants, the ARKit order, the wardrobe slots | `golden/constants.json`, checked from both sides |
| The locator rules (what a manifest may point at) are the daemon's rules | C# port of `validateLocator` replayed against 3,069 cases produced by the TypeScript one |
| ARKit-52 to VRM 1.0 expression arithmetic, and mood to presets | 28 tests; the factors are a plain starting point, never looked at on a face |

Mutation-checked: each of these suites fails when the code it guards is broken (client without hello, without reconnect, daemon accepting a second stage, seven ways to break the locator port, eight ways to break the expression mapper).

**Not verified:** a Unity Editor or player (the runtime files are compiled by `dotnet` as C# 9 on .NET Standard 2.1, the language level Unity 6 has, but Unity's own compiler has not seen them), UniVRM, a GPU, frame rate, how any expression looks, the audio path in Unity, IL2CPP builds, Windows. The daemon side is also unmeasured against a real TTS or Audio2Face provider (only deterministic fakes exist).

## Layout

```
unity/
  .gitignore                          Unity and .NET output, and binary models (never committed)
  Packages/com.mira.stage/            the UPM package (Unity 6, "com.mira.stage")
    package.json
    Runtime/                          engine-free core, asmdef Mira.Stage (noEngineReferences)
      StageClient.cs                  connect, hello, command queue, reconnect, perf
      StageHandler.cs                 what the engine implements (IStageHandler, StageHandlerBase, IStageSink)
      StageCommands/Events/Types/Frames/Json/Protocol/Transport.cs   the contract in C#
      StageCredentials.cs             URL and token (env MIRA_STAGE_TOKEN, or the daemon's secrets.json)
      StageContent.cs, AssetLocator.cs   locator -> file inside the content folder, with the daemon's safety rules
      Vrm1Expressions.cs              ARKit-52 frame and mood -> VRM 1.0 expression weights
      HeadlessStageHandler.cs         a stage with no renderer (tests, and a smoke run)
      Unity/                          (to be added on the PC) asmdef Mira.Stage.Unity: main thread, VRM, room, audio
    Editor/                           (to be added on the PC) BuildScript with Builder.PerformBuild
    Tests~/                           not imported by Unity ("~"); .NET test projects and fixtures
      Core/  Tests/                   Mira.Stage.Core.csproj (netstandard2.1, the Runtime files) and the xunit tests
      golden/                         commands/ events/ recorded/ constants.json locators.json
```

## Connecting

The URL is `ws://127.0.0.1:7421/ws/stage` (`MIRA_STAGE_URL` to change it). The token is the stage token, a secret that opens only this door.

- Native daemon: the client finds it by itself in `secrets.json` of the data folder (`%APPDATA%\ai-assistant`; `MIRA_DATA_DIR` overrides).
- Docker: the data is in a volume, so print it and put it in the environment that starts Unity, not in a project file: `docker compose exec daemon node --import tsx src/stage/cli.ts token`, then `MIRA_STAGE_TOKEN`.
- Refusals: 401 token, 403 stage switched off in Settings, Stage (or a wrong Host), 409 another stage is connected. The client retries by itself, slower after a refusal.

## The content pack (models, environments)

The daemon keeps only metadata: a catalog entry names a **locator**, never a file. The files live in a folder on the PC, `MIRA_CONTENT_DIR` (default `%USERPROFILE%\Mira\content`). `StageContent.Resolve(root, locator)` turns a locator into a path inside it, and refuses anything that is unsafe by the daemon's rules or that leaves the folder (`..`, absolute paths, UNC, drive letters, reserved names, encoded tricks). Percent escapes are not decoded: a name is literal.

The locators the seed catalog uses (the first run sends these):

| locator | what the Unity layer does with it (proposal, to be confirmed on the PC) |
|---|---|
| `bases/vrm1/composed.vrm`, `bases/vrm1/presence-form.vrm` | a VRM 1.0 file in the content folder, loaded at run time (UniVRM). The two seeded characters are both `vrm1`. A VRM 0.x file or another rig family is refused with `command.failed` |
| `environments/cerebral-void` | the room built in the Unity project (a scene or prefab registered under that name), not a file |
| `wardrobe/<name>`, `hair/vrm1/<name>`, `props/<name>` | a glTF or VRM file next to the model (extension probed), or a prefab registered by name. Not needed for the first model: `character.load` carries the equipped assets, and a failed asset only fails its command |

No binary is committed anywhere in this repository. A VRM can be made in VRoid Studio or taken from a model whose licence allows it; the licence belongs in its catalog entry (the daemon refuses an asset whose licence forbids the use). All characters are adults and the default outfit is clothed: that is enforced in the daemon, not in Unity.

## Face and mood

The daemon sends 52 ARKit weights per 30 fps frame (one clock, audio first). A VRM 1.0 model has presets, not 52 shapes, unless it was exported with Perfect Sync. `Vrm1Expressions.Build(namesOfTheModelsExpressions)` returns a map: Perfect Sync models (40 or more ARKit names present, any case) are driven one to one, others get `aa ih ou ee oh`, `happy angry sad surprised`, `blinkLeft blinkRight` (or `blink`) and the four `look*` presets, only the ones they have. `Vrm1Expressions.FromAffect` turns the baseline mood into a preset weight; combine the two by taking the larger weight per expression. Tune the factors on a real model; confirm the direction of `lookLeft/lookRight` on screen.

## Building with Unity

Unity runs on the PC only. The cloud session this repository is developed in cannot reach that PC or Unity's downloads, so the Unity project is built by a Claude Code session on the PC, driven by [spikes/unity/KICKOFF-PROMPT.md](../spikes/unity/KICKOFF-PROMPT.md). That session can use the Unity CLI (`unity`, install editors, create the project, `unity build --execute-method Builder.PerformBuild`, `unity test`) and, once the `com.unity.pipeline` package is installed in the project, drive the open Editor live (`unity status`, `unity command`). A headless CI build later needs a Unity service account in repository secrets; it is not set up.

## Running the checks

```bash
dotnet test unity/Packages/com.mira.stage/Tests~/Tests/Mira.Stage.Tests.csproj    # needs the .NET 8 SDK, node and `pnpm install` (the live tests start the daemon)
pnpm --filter @ai-assistant/daemon exec vitest run test/stage.golden.test.ts       # fixtures vs the zod contract
pnpm --filter @ai-assistant/stage-core exec vitest run test/locator.golden.test.ts # locator corpus vs the TypeScript validator
```

Regenerate a fixture when the contract changes (the C# tests then show what to bring in line):

```bash
pnpm --filter @ai-assistant/daemon exec tsx ../../scripts/record-stage-golden.ts                                         # recorded/
UPDATE_GOLDEN=1 pnpm --filter @ai-assistant/stage-core exec vitest run test/locator.golden.test.ts                       # locators.json
```

If the live tests find no `node` or no installed dependencies they skip and say why; on a clean checkout CI runs them.

## The first spike, and what counts as done

The gates proposed in ADR 0008, measured on the RTX 5070 Ti with one character and a small scene: 60 fps at 1440p, an outfit swap under 1 s, audio to lip latency under about 120 ms. The Unity layer is done when a VRM stands in the room, the stage shows as connected in Settings, a chat message is answered with her voice and a moving mouth, and the numbers are written down here with their source.

## Known gaps

- No `character.unload` command in the contract: a stage keeps a character until it disconnects.
- No render streaming into the dashboard: Unity Render Streaming has stalled, so Unity runs in its own window and the browser room stays the draft stage.
- The daemon has no TTS or face provider beyond deterministic fakes, so the voice is a tone and the mouth follows its loudness.
- Locators for hair, wardrobe and props have no extension; the probing rule is a decision for the Unity layer.
- The locator port relies on `string.Normalize` (NFKC). It is exercised on .NET 8 with ICU; Unity's runtime has to be checked by an EditMode test that replays `golden/locators.json` (the kickoff asks for it).
