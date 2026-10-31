# Research digest: avatar-voice-room

Status: digest of one researcher's structured output, as of 2026-10-31. Tags: [verified] or [unverified] as reported. Figures marked (e) are the researcher's estimates, not measurements. Several primary hosts (live2d.com, vroid.com, huggingface.co, developers.google.com, open-meteo.com) were unreachable, so those facts rest on search excerpts or secondary sources.

## Question

What tech stack gives a "window into a room" living assistant: rendering, character assets, voice (STT, VAD, TTS), lip-sync and emotion, webcam, Claude latency and a total latency budget, with an MVP versus later split?

## Key findings

1. [verified] Rendering: `@pixiv/three-vrm` 3.5.5 (MIT, peer three 0.137 or later; 3.6.0-beta.0 on 29 Sep adds `VRMC_springBone_limit`). The WebGPU and TSL path (MToonNodeMaterial) needs three r167 or later and may break more often, so use WebGL for the MVP. `@pixiv/three-vrm-animation` 3.5.5 implements VRMA clips. VRM 1.0 presets: emotions `happy`, `angry`, `sad`, `relaxed`, `surprised`; mouth `aa`, `ih`, `ou`, `ee`, `oh`; `blink`, `blinkLeft`, `blinkRight`; look presets; `neutral`. `overrideMouth`, `overrideBlink` and `overrideLookAt` let an emotion suppress procedural motion. Sources: https://registry.npmjs.org/@pixiv/three-vrm/latest, https://github.com/pixiv/three-vrm/releases, https://github.com/vrm-c/vrm-specification/blob/master/specification/VRMC_vrm-1.0/expressions.md
2. [unverified] Live2D: individuals and Small-Scale Enterprises (under about 10M JPY annual sales) are exempt from the SDK release licence except "Expandable Applications"; a per-work contract is still described as required; a web app is described as covered; middle-scale about 600k JPY one-time, large about 3.6M JPY (sources not fully consistent; pages unreachable). Feasible for a private, non-distributed app but a proprietary dependency. Sources: https://www.live2d.com/en/sdk/license/, https://help.live2d.com/en/?p=2558
3. [verified] Character assets: VRoid Studio is a free anime-style creator that exports VRM; VRM 1.0 exports carry separate "Corporate Use" and "Commercial Use by Individuals" fields plus extra religious, political and antisocial-use items. Booth.pm sells premade VRMs whose listings allow commercial and streaming use but prohibit redistribution; read each listing. AI image-to-VRM services are vendor marketing only. Do not build on Ready Player Me (Netflix acquisition announced 19 Dec 2025; services scheduled to end 31 Jan 2026). Sources: https://developer.vroid.com/en/guidelines/conditions_of_use.html, https://booth.pm/en/items/8827361, https://genies.com/blog/ready-player-me-shutdown, https://www.pocketgamer.biz/netflix-acquires-avatar-creation-platform-ready-player-me
4. [verified] Prior art to study: AIRI (MIT, Electron desktop), Amica (MIT, three-vrm, Whisper, Silero, Tauri build), AITuberKit (custom licence; commercial use needs a separate one), Open-LLM-VTuber (Live2D; v2 in planning). None is a second brain or dashboard. Sources: https://github.com/moeru-ai/airi, https://github.com/semperai/amica, https://github.com/tegnike/aituber-kit
5. [verified] Claude backend for voice: the SDK streaming-input mode is a long-lived process accepting queued messages, images and `interrupt()`; `includePartialMessages` yields `text_delta` events that you accumulate. `--bare` needs an API key. Haiku 5.5 (`claude-haiku-5-5`) is "Fastest" from 0.10 USD input and 0.50 USD output per million tokens, default effort medium; Sonnet 5.5 (`claude-sonnet-5-5`) is "Fast" at 2 and 10, default effort high, and does not accept thinking disabled (adaptive only). The docs recommend Haiku 5.5 at `output_config.effort='low'` for time-critical use. Prompt-cache minimum is 512 tokens for Haiku and Sonnet 5.5 (5-minute TTL, 1-hour option, reads at 0.05 to 0.1 times). Published time-to-first-token numbers do not exist; user reports say a fresh headless `claude -p` adds roughly 0.6 to 0.8 s before the first stream event, a project `SessionStart` hook can stall a trivial call 30 to 60 s, and each call loads about 27k tokens of prompt and tools (anecdotal). Sources: https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode, https://platform.claude.com/docs/en/models/overview, https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/reduce-latency, https://platform.claude.com/docs/en/build-with-claude/prompt-caching, https://claudeissues.com/issue/87652-bug-headless-first-stream-latency-regresses-between-2-1-197-and-2-1-200-on-linux
6. [verified] Webcam: Claude image input accepts JPEG, PNG, GIF and WebP; cost is `ceil(w/28) * ceil(h/28)` visual tokens, so 640x480 is 414 tokens (about 0.00004 USD on Haiku 5.5, about 0.0008 USD on Sonnet 5.5, by the researcher's arithmetic). Models from 4.7 onwards have a high-resolution tier, so downscale. Base64 images are re-sent every turn; use the Files API or pre-resize. MediaPipe Face Landmarker (`@mediapipe/tasks-vision` 1.2.0, Apache-2.0) outputs 478 landmarks, 52 blendshape scores and a transform matrix, but no emotion labels. MediaPipe processes on device but sends usage metrics to Google by default: self-host the assets and check egress. Sources: https://platform.claude.com/docs/en/build-with-claude/vision, https://registry.npmjs.org/@mediapipe/tasks-vision/latest, https://github.com/google-ai-edge/mediapipe
7. [verified] STT: Moonshine (MIT, streaming, English-centric) vendor benchmark per utterance: Medium Streaming 59 ms on a MacBook Pro and 269 ms on Linux x86; Whisper Large v3 11,286 ms and 16,919 ms on the same machines (vendor numbers). whisper.cpp (MIT) supports CUDA, Vulkan, HIP and OpenVINO, builds on Windows, has a mic demo and Silero-based `--vad`; v1.9.5 (year not shown). faster-whisper (MIT) needs CUDA 12 cuBLAS and cuDNN 9 on Windows. sherpa-onnx (Apache-2.0) can host Whisper, Moonshine, Silero VAD and TTS on Windows x64 with Node bindings. Parakeet TDT 0.6B v3 is fast in batch but NVIDIA and NeMo oriented. Sources: https://github.com/moonshine-ai/moonshine/blob/main/docs/moonshine-vs-whisper.md, https://github.com/ggml-org/whisper.cpp, https://github.com/SYSTRAN/faster-whisper, https://github.com/k2-fsa/sherpa-onnx
8. [verified] VAD and turn-taking: Silero VAD (MIT, about 2 MB, under 1 ms per chunk on one CPU thread). `@ricky0123/vad-web` 0.0.31 (ISC) offers `MicVAD` with `onSpeechStart` and `onSpeechEnd` (16 kHz Float32Array for STT); use `onSpeechStart` during playback as the barge-in trigger. Pipecat's Smart Turn v3 predicts end of turn (12 ms CPU per Daily) and allows cutting silence timeout to about 200 to 300 ms. Pipecat itself is Python 3.11 or later with unstated Windows support. Sources: https://github.com/snakers4/silero-vad, https://registry.npmjs.org/@ricky0123/vad-web/latest, https://github.com/pipecat-ai/smart-turn
9. [verified] TTS, local: Kokoro-82M (Apache-2.0); `kokoro-js` 1.2.1 runs it in the browser; `kokoro-onnx` for desktop. Languages: American and British English, Spanish, French, Hindi, Italian, Japanese, Brazilian Portuguese, Mandarin (no Nordic). No emotion control. Speed varies widely: RTF 0.2 to 0.4 on WebGPU fp32 (M2 Air) and about 1.1 on WASM q8 in one benchmark; about 3.7 s first audio in another; 3 to 5 s first load. Chatterbox (MIT) has cloning and paralinguistic tags but watermarks output and its "sub-200ms" claim is for the hosted service. F5-TTS weights are CC-BY-NC. Piper (piper1-gpl) is GPL-3.0. XTTS-v2 weights are, to the researcher's recollection, non-commercial (unverified). Sources: https://github.com/hexgrad/kokoro, https://registry.npmjs.org/kokoro-js/latest, https://github.com/thewh1teagle/kokoro-onnx, https://offlinetts.pages.dev/blog/browser-tts-showdown-kokoro-piper-kitten/, https://picovoice.ai/blog/on-device-tts/, https://github.com/resemble-ai/chatterbox, https://github.com/SWivid/F5-TTS, https://github.com/OHF-Voice/piper1-gpl
10. [verified] TTS, cloud: ElevenLabs Flash v2.5 is marketed at about 75 ms model latency; Vapi's 50-trial streaming benchmark measured a median 197 ms to first audio; the free plan is evaluation only. OpenAI gpt-4o-mini-tts about 0.015 USD per minute; a third-party p50 shows about 1.0 s. Cloud TTS sends every reply sentence to a third party. Sources: https://humannessindex.vapi.ai/models/elevenlabs-flash-v2-5, https://www.activepieces.com/blog/elevenlabs-pricing-2026-plans-credits-and-costs.md
11. [verified] Lip-sync and emotion: VRM 1.0 has exactly five mouth presets. Options: AnalyserNode RMS driving `aa`; wLipSync (MIT, WASM in an AudioWorklet, needs a profile calibrated in Unity's uLipSync); HeadAudio (MIT, 15 Oculus visemes, 50 to 100 ms latency, less accurate than text-driven sync). Neither was verified end to end on VRM. Emotion-tag driving is an established pattern (AITuberKit, Amica) but there is no canonical tag format. Sources: https://github.com/mrxz/wlipsync, https://github.com/met4citizen/HeadAudio
12. [verified] Room data: Open-Meteo needs no key, is free for non-commercial use (contact them above about 10,000 requests per day), data is CC BY 4.0 (attribution required), server code AGPL-3.0. Day and night can be computed offline from latitude, longitude and local time. Sources: https://github.com/open-meteo/open-meteo

## Options considered

| Option | Verdict |
|---|---|
| A. Three.js plus three-vrm, 3D VRM in a low-poly room | Recommended |
| B. Live2D over a layered 2.5D room | Polished and cheap on GPU, but proprietary core and rigging cost |
| C. Layered 2D sprites with state swaps | Quickest static mockup technique; limited expressiveness |
| D. Pre-rendered video loops | Cannot respond to live speech; ambient layers only |
| E. Local voice pipeline (Silero VAD, whisper.cpp or Moonshine, Claude, Kokoro) | Audio never leaves the PC; Kokoro voice not emotional, speed varies |
| F. Hybrid (local VAD and STT, cloud streaming TTS) | Best voice quality and about 200 ms first audio; sends sentences to a third party |

## Recommendation

Option A with a licence-checked VRM 1.0 from VRoid Studio (commission a custom one later). One Chromium renderer around a Stage module: a low-poly GLB room with sun and moon from computed solar elevation and Open-Meteo weather; data-bound props that are clickable; a behaviour state machine (idle, listening, thinking, speaking, working, sleeping); lip-sync, blink, gaze and emotion layered on VRMA body clips; capped at 30 fps and paused when hidden.

LLM contract: a closed emotion vocabulary (about 8: neutral, happy, sad, angry, relaxed, surprised, shy, thinking, plus optional gesture ids); each sentence starts with a tag; parse the stream, strip tags before TTS, apply the expression when that sentence's audio starts; a short spoken acknowledgement first when tools will run; persona and memory digest in a cached prefix.

Claude lane: a long-lived SDK session in streaming-input mode with `includePartialMessages` and `interrupt()`, separate from long work sessions, minimal config, Haiku 5.5 at low effort for fast turns. In Phase 0 measure TTFT through the persistent session. If it exceeds about 1.0 to 1.2 s versus a direct Messages API call, add a direct Messages fast lane (needs an API key). Listening and speaking: `@ricky0123/vad-web` with push-to-talk fallback; whisper.cpp (Vulkan or CUDA) as a sidecar, or Moonshine Medium Streaming for English only; Kokoro with sentence-chunked streaming behind a `TtsProvider` so ElevenLabs can be a premium option; amplitude lip-sync. Webcam: off by default, always-visible indicator, in-memory frames, MediaPipe local with self-hosted assets for presence only, a frame to Claude only on request and downscaled to about 768 px.

End-to-end latency budget, stop talking to first audible syllable ((e) marks the researcher's estimates):
- Endpointing (VAD plus Smart Turn): 250 to 600 ms (e).
- Final STT: 60 to 300 ms (Moonshine vendor numbers); Whisper-class on GPU about 200 to 500 ms (e).
- Prompt assembly and IPC: 10 to 50 ms (e).
- Claude TTFT direct, Haiku 5.5 low effort: about 400 to 800 ms (e). Persistent Agent SDK session adds about 200 to 600 ms (e). A cold `claude -p` adds a user-reported 0.6 to 0.8 s.
- Wait for the first clause: 100 to 250 ms (e).
- TTS first audio: cloud about 200 to 400 ms; local Kokoro 150 ms to several seconds, benchmark it.
- Audio buffer, device and lip-sync alignment: 30 to 100 ms.
- Totals: best case about 1.1 to 1.5 s; typical local-first about 1.8 to 2.6 s; through the Agent SDK about 2.5 to 3.5 s. Tool-using turns run 5 to 30 s and need masking (thinking pose, cached backchannel, short acknowledgement). 1.5 to 2 s feels like a thoughtful assistant; above 3 s with no feedback feels broken.

## MVP versus later

MVP (first 4 to 6 weeks of the voice and avatar track, after the mockup): a CSS or 2.5D room to validate layout; Three.js plus three-vrm 3.5.5 loading one VRoid VRM 1.0 with 6 to 10 VRMA clips, procedural blink and gaze, five emotion presets, a GLB room with computed day and night and weather; VAD with push-to-talk fallback, whisper.cpp or Moonshine, sentence-chunked Kokoro, amplitude lip-sync, emotion tags from the stream; a persistent SDK persona session with TTFT instrumentation; webcam opt-in with local presence only. Later: viseme lip-sync, a custom VRM or Live2D if licensing passes, expressive local TTS or an ElevenLabs voice, Smart Turn and echo cancellation for hands-free barge-in, Parakeet or Moonshine through sherpa-onnx, WebGPU renderer, ambient awareness with local gating, wake word, and second-brain-driven proactive behaviour.

## Risks

- Claude latency is the biggest unknown; mitigate with a persistent session, a separate persona lane and a direct-API fallback.
- Anthropic terms for SDK and subscription use; decide auth early.
- Licensing: Live2D, F5-TTS weights, Piper, XTTS weights, Chatterbox watermark, per-model VRM terms, AITuberKit.
- Ready Player Me is gone; avoid libraries that depend on it.
- Webcam and mic privacy: local-only is not automatic (MediaPipe metrics); images re-sent each turn inflate cost and stored imagery.
- GPU contention between rendering, STT, TTS and MediaPipe.
- Lip-sync accuracy; benchmark data quality (vendor claims, an order of magnitude spread for Kokoro).
- Companion-persona risks: dependency, over-trust, speech aloud in front of others.
- Facial emotion detection is unreliable; any mood signal is a soft hint.

## Open questions

- Unreachable primary hosts; release dates for three-vrm and whisper.cpp show no year (assumed 2026); AIRI's migration reason not retrieved.
- Language: Kokoro, Moonshine streaming and Parakeet lack Nordic languages. The user later locked English only.
- PC hardware: GPU vendor and VRAM (NVIDIA is known).
- Local-only versus cloud-allowed voice; whether a webcam frame may go to Anthropic on request.
- Auth model (see [claude-integration.md](claude-integration.md)).
- Art direction and budget; original character design.
- Whether hands-free full-duplex barge-in is in scope (needs echo cancellation).
- The partner persona's boundaries, proactivity and data scopes (answered in [PERSONA.md](../PERSONA.md)).
- Exact TTFT for Haiku 5.5 and Sonnet 5.5 (spike (a)).

## Decisions that followed

[ADR 0006](../adr/0006-avatar-vrm-and-voice-stack.md), [PERSONA.md](../PERSONA.md), [PRIVACY.md](../PRIVACY.md), [spikes/](../../spikes/README.md).
