# ADR 0008: Stage protocol and engine choice

Status: Proposed (draft, 2026-10-31). Decision on Unity vs Unreal is pending the user's reference material and a Windows GPU spike.

## Context

After the Phase 0a mockup the user set a new priority: a much more realistic, "maximally alive" 3D assistant. The environment matters less. The backend matters most: a character that persists, has persistent memory, can be selected and dressed (wardrobe), lives in a scene the user can furnish with objects ("VTube Studio, but in 3D"), and performs live (speech, face, gaze, gesture, posture). The long-term bar is an AION 2 level character creator. VTuber-class models (VRM) are acceptable for the draft. The user is considering Unity or Unreal Engine and runs Windows with an RTX 5070 Ti (16 GB).

The current room is a three.js scene in the browser. It stays as a draft stage, not the target.

## Decision (proposed)

1. **The backend owns the character; engines are replaceable "stages".** The daemon holds identity, appearance parameters, wardrobe, scene, mood, memory and the live performance plan. A stage (Unreal, Unity, the web room, or a headless simulator) renders it and reports what happened. The contract is `packages/shared/src/stage.ts` (`mira-stage/1`): JSON commands down, JSON events up, binary frames for audio and face weights, one shared stage clock.
2. **Faces are driven by ARKit-style blendshape weights**, the common denominator across VRM "perfect sync", MetaHuman and Character Creator rigs and NVIDIA Audio2Face-3D. The stage declares in `hello` whether it computes the face from audio itself (uLipSync, a runtime lip-sync plugin) or expects `FaceFrame`s from the backend.
3. **Recommendation, to be confirmed by the user:** Unreal Engine 5.6+ as the realism target (same engine class as AION 2, MetaHuman integrated, the better-supported way to embed the render in the dashboard); Unity remains a strong option if the VTuber/VRM ecosystem and faster iteration matter more than top-end realism. Because of decision 1, the backend work is identical either way.
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
