# ADR 0006: Avatar (VRM) and voice stack

Status: Accepted for the avatar and the voice order; engine choices for STT and TTS are provisional until spike (c) measures them on the user's GPU. Date: 2026-10-31.

## Context

The Room is a window into a 3D room where Mira lives, about a quarter of the screen. The user chose a 3D anime character and English only, on a Windows 11 PC with an NVIDIA GPU (model and VRAM unknown). Research: [research/avatar-voice-room.md](../research/avatar-voice-room.md), [research/prior-art-companions.md](../research/prior-art-companions.md), [research/critic.md](../research/critic.md).

Verified inputs:

- `@pixiv/three-vrm` 3.5.5 (MIT; 3.6.0-beta.0 exists) supports VRM 1.0 expressions: emotions `happy`, `angry`, `sad`, `relaxed`, `surprised`; mouth shapes `aa`, `ih`, `ou`, `ee`, `oh`; blink and look presets. The WebGPU path needs three r167 or later and may break more often. `@pixiv/three-vrm-animation` implements VRMA clips.
- Live2D Cubism Core is proprietary; avatar systems count as "Expandable Applications" excluded from the small-scale exemption, so any distribution needs a contract (search excerpts; primary pages unreachable). VRM avoids this. Each VRM model carries its own licence.
- Ready Player Me (the default avatar format of some libraries) was acquired by Netflix and its services were scheduled to end around 2026-01-31; depend on nothing that uses it.
- AIRI (MIT) is the most complete companion project; its desktop shell is Electron. No surveyed project uses the Agent SDK, and none implements a second brain. Mate-Engine, SillyTavern and Utsuwa are AGPL; the Open-LLM-VTuber frontend has a commercial restriction.
- Local speech: Kokoro-82M (Apache-2.0, American and British English among its languages), whisper.cpp (MIT; CUDA, Vulkan, HIP, OpenVINO; Windows builds), Moonshine (MIT, streaming, English-centric, vendor benchmarks only), Silero VAD (MIT) through `@ricky0123/vad-web`. Kokoro speed varies by an order of magnitude between sources (one benchmark gives a real-time factor of 0.2 to 0.4 on WebGPU and about 1.1 on WASM; another on-device benchmark measured about 3.7 s to first audio; first load takes 3 to 5 s), so it must be measured.
- Licences to avoid: F5-TTS weights (CC-BY-NC), XTTS-v2 weights (non-commercial; secondary evidence), Piper (GPL-3.0), Chatterbox (MIT but watermarks output).
- MediaPipe Tasks (Apache-2.0) processes input on device but sends usage metrics to Google by default; self-host assets and check egress. It gives blendshape scores, not emotion labels.

## Decision

Avatar and room
1. Three.js with `@pixiv/three-vrm` 3.5.x on the WebGL path, a licence-checked VRM 1.0 model (original design preferred; VRoid Studio or a Booth model with terms read), a low-poly GLB room, day and night from computed solar elevation, weather from Open-Meteo, and props bound to app data (wall calendar to Life, desk monitor to Work, bookshelf to Brain, ledger to Money).
2. A behaviour state machine bound to daemon events: `idle`, `listening`, `thinking`, `speaking`, `working` (typing at the desk while Claude sessions are active), `sleeping` (the `AssistantState` enum). Three to five VRMA clips; procedural blink and look-at; the five emotion presets. Cap at 30 fps and pause rendering when hidden.
3. The mockup uses a procedural placeholder character and the same event contract ([PERSONA.md](../PERSONA.md) defines `AvatarEvent` and the emotion tags). Swapping in the VRM is a Phase 3 task and changes nothing upstream.
4. No Live2D, custom or commissioned models, outfits or weather particles until the core works.

Voice, built in this order
5. Text first. Then TTS behind a `TtsProvider` interface: Kokoro locally by default; ElevenLabs only as an explicit, off-by-default cloud option (every sentence leaves the PC). Sentence-chunked streaming: synthesise sentence N+1 while N plays.
6. Then push-to-talk STT: a whisper.cpp server as a managed child process (CUDA on the NVIDIA GPU; Vulkan as the cross-vendor option). Moonshine is a candidate for English-only streaming if spike (c) favours it.
7. Then VAD with `@ricky0123/vad-web`, with headphones first. Hands-free barge-in without headphones needs acoustic echo cancellation and is out of scope until proven.
8. Lip-sync is amplitude: an AnalyserNode RMS driving the `aa` preset, smoothed, with an emotion-aware mouth override. Viseme lip-sync (wLipSync, HeadAudio) is deferred; neither was verified on VRM.
9. The model emits a closed set of emotion tags; tags are parsed from the stream, stripped before TTS, and applied when that sentence's audio starts. When it will use tools, the persona says a short acknowledgement first so TTS can start while tools run.

Webcam
10. Off by default, with an always-visible in-app indicator in addition to the camera LED. Frames stay in memory and are never persisted. MediaPipe Face Landmarker, if used, runs locally with self-hosted WASM and model files. A frame goes to Claude only when the user presses "look at this", downscaled (about 768 px maximum, JPEG). No continuous frames and no mood inference.

Latency budget (end of speech to first audible syllable). Figures marked (e) are the researcher's estimates, not measurements; spike (c) replaces them.

| Stage | Estimate |
|---|---|
| Endpointing (VAD hangover plus optional Smart Turn) | 250 to 600 ms (e) |
| Final STT | 60 to 300 ms (Moonshine vendor numbers) or 200 to 500 ms (e) for Whisper-class on GPU |
| Prompt assembly and IPC | 10 to 50 ms (e) |
| Claude TTFT, direct API, Haiku 5.5, low effort | about 400 to 800 ms (e; no published figure) |
| Persistent Agent SDK session overhead on top | about 200 to 600 ms (e) |
| Wait for the first clause | 100 to 250 ms (e) |
| TTS first audio | cloud about 200 to 400 ms; local Kokoro 150 ms to several seconds, benchmark it |
| Audio buffer, device and lip-sync alignment | 30 to 100 ms |
| Totals | best case about 1.1 to 1.5 s; typical local-first about 1.8 to 2.6 s; through the Agent SDK about 2.5 to 3.5 s |

A turn that calls tools can run 5 to 30 s, so it needs masking: `thinking` on VAD end, a cached backchannel clip, a short spoken acknowledgement before tools run. Roughly 1.5 to 2 s feels like a thoughtful assistant; above 3 s without feedback feels broken.

## Consequences

- The avatar is a thin, replaceable front end for the secretary and the second brain, which keeps the differentiator where it belongs.
- Animation polish is a hidden time sink and an uncanny avatar harms the product; the phase scope is deliberately small.
- GPU contention is real (render, STT, TTS, MediaPipe on one GPU): run STT and TTS in workers or sidecars and size models to the hardware.
- English only removes the Nordic-language gap the critic flagged for Kokoro, Moonshine and Parakeet, but it is a user decision to revisit if the language changes.
- Each VRM model's usage conditions must be read, including any sexual-expression permission flag (from memory, unverified) given the partner persona.
- Local voice needs Kokoro model files downloaded once (network at install, not at runtime); the mockup does no speech.

## Alternatives considered

| Option | Verdict |
|---|---|
| Live2D Cubism over a 2.5D room | Polished and cheap on GPU, but proprietary core, rigging cost, fixed angle; blocks distribution |
| Layered 2.5D sprites with state swaps | Fastest for a mockup, but limited expressiveness; used only as a fallback technique |
| Pre-rendered video loops | Cannot respond to live speech; ambient layers only |
| Embed or fork AIRI | Owns the agent loop, persona and memory; large fast-moving Vue monorepo; its Claude path is API-key only; the 25 percent room layout would be a fork |
| Build on Open-LLM-VTuber | Live2D only; v1 frozen; frontend licence restricts commercial use |
| Pipecat as the voice pipeline | Python 3.11 or later; Windows support not stated; a second runtime |
| Speech-to-speech models | Out of scope for the MVP; revisit if the cascaded loop is too slow |
| Cloud-first TTS (ElevenLabs Flash v2.5, about 197 ms median measured by a third party) | Best quality but sends every sentence to a third party and needs internet; kept behind `TtsProvider` |

## Sources

- https://github.com/pixiv/three-vrm and https://registry.npmjs.org/@pixiv/three-vrm/latest
- https://github.com/vrm-c/vrm-specification/blob/master/specification/VRMC_vrm-1.0/expressions.md
- https://github.com/moeru-ai/airi
- https://github.com/hexgrad/kokoro and https://registry.npmjs.org/kokoro-js/latest
- https://github.com/ggml-org/whisper.cpp
- https://github.com/moonshine-ai/moonshine/blob/main/docs/moonshine-vs-whisper.md
- https://github.com/snakers4/silero-vad and https://github.com/ricky0123/vad
- https://github.com/google-ai-edge/mediapipe and https://registry.npmjs.org/@mediapipe/tasks-vision/latest
- https://platform.claude.com/docs/en/build-with-claude/vision
- https://www.live2d.com/en/sdk/license/ (search excerpts only; page unreachable)
- https://genies.com/blog/ready-player-me-shutdown
- https://humannessindex.vapi.ai/models/elevenlabs-flash-v2-5

## Update 2026-10-31

The avatar renderer is no longer assumed to be three.js in the browser. See [ADR 0008](0008-stage-protocol-and-engine-choice.md): the backend owns the character and talks to a replaceable "stage" (Unreal, Unity, the web room, or a simulator) through the `mira-stage/1` protocol. The three-vrm room stays as a draft stage. The voice stack decisions in this ADR still apply.
