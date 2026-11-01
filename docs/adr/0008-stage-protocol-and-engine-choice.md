# ADR 0008: Stage protocol and engine choice

Status: Proposed (draft, 2026-10-31). Decision 1 (the backend owns the character, engines are replaceable stages) is implemented and reviewed as of 2026-11-01 (see the update at the end). The Unity vs Unreal choice (decision 3) was made by the owner on 2026-11-01: Unity first (see the last update); the spike on the RTX 5070 Ti is still to be run.

## Context

After the Phase 0a mockup the user set a new priority: a much more realistic, "maximally alive" 3D assistant. The environment matters less. The backend matters most: a character that persists, has persistent memory, can be selected and dressed (wardrobe), lives in a scene the user can furnish with objects ("VTube Studio, but in 3D"), and performs live (speech, face, gaze, gesture, posture). The long-term bar is an AION 2 level character creator. VTuber-class models (VRM) are acceptable for the draft. The user is considering Unity or Unreal Engine and runs Windows with an RTX 5070 Ti (16 GB).

The current room is a three.js scene in the browser. It stays as a draft stage, not the target.

## Decision (proposed)

1. **The backend owns the character; engines are replaceable "stages".** The daemon holds identity, appearance parameters, wardrobe, scene, mood, memory and the live performance plan. A stage (Unreal, Unity, the web room, or a headless simulator) renders it and reports what happened. The contract is `packages/shared/src/stage.ts` (`mira-stage/1`): JSON commands down, JSON events up, binary frames for audio and face weights, one shared stage clock.
2. **Faces are driven by ARKit-style blendshape weights**, the common denominator across VRM "perfect sync", MetaHuman and Character Creator rigs and NVIDIA Audio2Face-3D. The stage declares in `hello` whether it computes the face from audio itself (uLipSync, a runtime lip-sync plugin) or expects `FaceFrame`s from the backend.
3. **Recommendation (superseded by the owner's choice of Unity on 2026-11-01, see the last update):** Unreal Engine 5.6+ as the realism target (same engine class as AION 2, MetaHuman integrated, the better-supported way to embed the render in the dashboard); Unity remains a strong option if the VTuber/VRM ecosystem and faster iteration matter more than top-end realism. Because of decision 1, the backend work is identical either way.
4. **Assets carry their licence** (personal use, commercial use, redistribution, VRM adult-expression flag). The backend refuses to equip or share an asset whose licence forbids it.

## Evidence (web search level, not primary-document level)

| Topic | Finding | Source |
|---|---|---|
| MetaHuman licence | Since UE 5.6 (June 2025) MetaHuman is part of the engine and characters may be used in other engines such as Unity and Godot; revenue thresholds apply; AI may be used in workflows but not to train models. Verify current terms on the licence page before committing. | [CG Channel](https://www.cgchannel.com/2025/06/you-can-now-sell-metahumans-or-use-them-in-unity-or-godot/), [Digital Production](https://digitalproduction.com/2025/06/05/metahumans-graduate-ready-for-unity-godot-and-the-fab-cash-register/), [metahuman.com/license](https://www.metahuman.com/license) |
| Audio to face | NVIDIA open-sourced Audio2Face-3D (networks, SDK, training framework). Output is ARKit blendshapes over bidirectional gRPC. Licence wording conflicts between sources (NGC says non-commercial, the model card says commercial): check before any distribution. Runs on NVIDIA GPUs, which suits the RTX 5070 Ti. | [model card](https://build.nvidia.com/nvidia/audio2face-3d/modelcard), [arXiv 2508.16401](https://arxiv.org/abs/2508.16401v1) |
| Unreal live lip sync | Epic's own xADA is not built for streamed TTS audio; community plugins (Runtime MetaHuman Lip Sync, Runtime Audio-to-Face) accept streamed PCM and drive MetaHumans. Forum-level evidence: test in a packaged build. | [UE forum](https://forums.unrealengine.com/t/community-tutorial-metahuman-ai-lip-sync-with-local-text-to-speech-in-ue-5-6/2555407) |
| Unity side | UniVRM loads VRM 1.0 at runtime; uLipSync does Burst-compiled lip sync into blendshapes. No source found for a ready clothing-swap workflow (outfits would be separate meshes rebound to the skeleton). Warudo (Unity-based) shows the VTuber scene/props/blueprint model, including WebSocket control. | [vrm.dev](https://vrm.dev/api/runtime-import), [uLipSync](https://github.com/hecomi/uLipSync), [Warudo](https://store.steampowered.com/app/2079120/Warudo/) |
| Embedding the render | Unreal Pixel Streaming 2 (UE 5.5+) streams the render to a browser over WebRTC with input back. Unity Render Streaming has reportedly stalled and its WebRTC package is deprecated (Aug 2026 note). | [Eagle 3D](https://www.eagle3dstreaming.com/blog/pixel-streaming-vs-pixel-streaming-2-in-unreal-engine-5-the-beginner-guide), [Issoh](https://www.issoh.co.jp/tech/details/1476/) |
| Target realism | AION 2 is reported to run on a heavily modified UE5 with 200+ adjustable character features (mostly secondary sources). | [GamesBeat](https://gamesbeat.com/?p=325933) |
| Character tools | Reallusion Character Creator exports to Unreal and Unity; store content may need separate export licences. | [ProVideo Coalition](https://www.provideocoalition.com/character-creator-update-unreal-unity/) |
| Cost on the GPU | No benchmark found for the 5070 Ti. User reports put strand-hair grooms at a few ms of render-thread time per character and several hundred MB of VRAM across many characters; cards are 20-30% cheaper. Measure on the real machine. | [UE forum](https://forums.unrealengine.com/t/high-render-thread-cost-of-groom-bindings-even-on-rigid-mode/2725272) |

## Consequences

- Unity-vs-Unreal no longer blocks backend work. The character, wardrobe, scene, mood, behaviour and speech services are built and tested against a headless simulator stage first.
- Realism work (character creation pipeline, hair, skin, cloth, Audio2Face) happens in the engine stage and is measured on the user's PC.
- Two things the backend must supply well to feel alive: a mood model that evolves over time and events, and a behaviour director that never repeats itself mechanically (cooldowns, variation, attention to the user).
- Licence metadata on assets is mandatory from day one, because VTuber and store assets differ widely.

## Open questions for the user

- Reference material (coming): the target look and the character-creation depth.
- Unity vs Unreal after seeing the references and a spike on the RTX 5070 Ti.
- Does the stage run in its own window, or must the render appear inside the dashboard's Room panel (Pixel Streaming on Unreal)?
- Whether Audio2Face-3D licence terms suit the intended use.

## Update 2026-10-31: references and the cerebral space

The user supplied six reference screenshots (a character creator stage, with DLSS visible) and a brief: an empty "cerebral space" where a representation of the user and the second brain live, connected to the terminal; a character that is athletic and intelligent, meeting in authority. The concept, the art direction read from the references and the mapping from app data to space objects are in [docs/CEREBRAL-SPACE.md](../CEREBRAL-SPACE.md). The contract gained `DataConstruct` (knowledge graph, session orbit, terminal pane and others), `Atmosphere` (the void look), a `user` character role and `PresenceStyle`. The references look like an Unreal-class pipeline, which strengthens the Unreal recommendation, but the decision still waits for a spike on the RTX 5070 Ti.

## Update 2026-11-01: the backend side of decision 1 is built

`packages/stage-core` (pure logic, no engine) and its wiring in `apps/daemon/src/stage` implement the contract: asset catalog with enforced licences, characters with adult-bounded morph ranges, wardrobe with a clothed baseline and an OutfitDirector, the cerebral-void scene and its six camera shots, data constructs (knowledge graph, session orbit and others) with a deterministic layout, a mood model and a behaviour director shaped by the presence style, a speech pipeline (text to audio and ARKit-52 face frames over one clock), her character memory, and the `/ws/stage` socket with its own token. A headless `SimulatorStage` and a reusable conformance suite (`runStageConformance`) stand in for an engine; any Unreal or Unity stage has to pass the same suite. An adversarial review of the contract and the services found no critical flaw and all findings are closed ([review record](../reviews/2026-11-01-terminal-and-stage.md)).

What this does not decide or prove: the engine, the realism of anything on screen, whether a stage can hold the frame budget on the RTX 5070 Ti, how a real TTS or Audio2Face-3D provider behaves behind the `TtsProvider` and `FaceProvider` seams (only deterministic fakes exist), and Windows behaviour. Known limits of the contract: there is no `character.unload` command (a stage keeps a character until it disconnects), and the adult envelope judges visible metadata only, so it assumes content packs the user chose to install (the seed catalog is metadata only and ships no binary assets).

The engine decision still follows the order in the open questions above: the user's reference material, then a spike on the RTX 5070 Ti with the proposed gates (60 fps at 1440p with one character and a small scene, outfit swap under 1 s, audio-to-lip latency under about 120 ms).

## Update 2026-11-01: the owner chose Unity as the first engine stage

The owner decided: "I think unity engine is a good start. I want to essentially run a model and environment built in Unity, in the assistant room and character", and asked for the backend to run in Docker (done, [ADR 0009](0009-container-mode.md)) and to be prepared for building with Unity. This settles decision 3 for now: **Unity 6 with VRM 1.0 (UniVRM) is the first engine stage; Unreal and MetaHuman remain the later realism route.** Decision 1 is why this is cheap to revisit: the backend does not change with the engine.

Costs accepted with the choice:

- No Pixel Streaming equivalent (Unity Render Streaming has stalled), so the Unity stage runs in its own window and the browser room stays the draft stage. Embedding the render in the dashboard is dropped for now.
- The realism ceiling of VRM with URP is below MetaHuman. It is judged again on the spike's measurements, not before.
- Wardrobe on VRM means separate meshes rebound to the skeleton, which UniVRM does not solve. The first stage wears the clothes baked into the model (so the clothed baseline holds) and reports the seed wardrobe pieces as `asset.failed` until content exists.

What was prepared without Unity (verified by tests, see [docs/UNITY.md](../UNITY.md)): the C# stage client in `unity/Packages/com.mira.stage` (the whole protocol, reconnect, credentials), golden fixtures shared with the zod contract (every command and event, recorded real traffic, constants, 3,069 locator cases), live tests against the real daemon, a C# port of the locator rules, and the ARKit-52 to VRM 1.0 expression arithmetic. Decided with it: the locator scheme stays content-pack-relative paths; the Unity stage maps them onto a content folder on the PC (`MIRA_CONTENT_DIR`) and the room `environments/cerebral-void` is built in the Unity project and registered under that name; a stage must succeed `character.load` whenever the base model loads (a failed one makes the session treat the character as not loaded).

What this does not decide or prove: that the runtime compiles under Unity's compiler, that UniVRM loads the seed model, any frame rate, how the expressions look, the audio path. The gates are unchanged (60 fps at 1440p, outfit swap under 1 s, audio to lip under about 120 ms) and are measured on the PC by the session started from [spikes/unity/KICKOFF-PROMPT.md](../../spikes/unity/KICKOFF-PROMPT.md). Reopen the choice if the spike misses them, or when MetaHuman-class realism is wanted: a second stage then costs a new renderer, not a new backend.
