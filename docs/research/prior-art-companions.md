# Research digest: prior-art-companions

Status: digest of one researcher's structured output, as of 2026-10-31. Tags: [verified] or [unverified] as reported. Star counts and activity come from page scrapes; the GitHub API was blocked in the research sandbox.

## Question

Which open-source AI companion and avatar-assistant projects exist (AIRI, Open-LLM-VTuber, Amica, SillyTavern, Claude Code avatar overlays), and what should the app borrow versus build?

## Key findings

1. [verified] Project AIRI (moeru-ai/airi) is the most active and complete: MIT, about 51.0k stars, v0.14.1 on 2026-10-30, self-described "early stage", several releases a week. Apps: stage-web, stage-tamagotchi (desktop), stage-pocket (experimental mobile). Windows supported. Sources: https://github.com/moeru-ai/airi, https://github.com/moeru-ai/airi/releases
2. [verified] AIRI avatar and voice: VRM through three.js (TresJS, package `stage-ui-three`, AEIOU lip-sync mapped to aa, ee, ih, oh, ou), plus Live2D, MMD, Tachie and Spine; auto blink, look-at, idle eye movement; a `model-driver-mediapipe` package for webcam tracking. Voice: client-side ASR through `@xsai`, `@huggingface/transformers` and `onnxruntime-web`; TTS local Kokoro plus ElevenLabs, Azure, OpenAI-compatible, Alibaba; per-character wake words and push-to-talk (v0.12.0); continuous voice calls (v0.14.0). No dedicated VAD library listed. Sources: https://github.com/moeru-ai/airi/tree/main/packages/stage-ui-three, https://raw.githubusercontent.com/moeru-ai/airi/main/apps/stage-tamagotchi/package.json
3. [verified] AIRI's desktop shell is Electron (electron-builder, electron-vite, electron-updater, `build:win`). It migrated from Tauri around October 2025; its 2025-10-20 DevLog reportedly describes about three months fighting Tauri's WebKit runtime, Web Audio and DevTools. Caveat: Tauri uses WebView2 (Chromium) on Windows, so the pain was mostly macOS and Linux WebKit; the quote comes from a search excerpt. Source: https://deploy-preview-636--airi-docs.netlify.app/en/blog/devlog-2025.10.20
4. [verified] AIRI memory is immature ("Memory Alaya" WIP; DuckDB WASM, pglite, a pgvector package; long-term memories in IndexedDB since v0.14.0). Open issues #879, #2005 and #2433 show the design is undecided. There is no knowledge base or second brain. Source: https://github.com/moeru-ai/airi/issues?q=is%3Aissue+memory+alaya
5. [verified] AIRI has an external surface (`@proj-airi/server-sdk`, MIT, WebSocket client with `input:text` and `output:gen-ai:chat:message`; a plugin protocol) but its brain is its own. Claude is supported only as an API-key provider through xsai; there is no Claude Code or Agent SDK path. Embedding AIRI would mean writing a bridge; handshake details are undocumented. Sources: https://github.com/moeru-ai/airi/tree/main/packages/server-sdk, https://github.com/moeru-ai/airi/tree/main/packages/plugin-protocol
6. [verified] Open-LLM-VTuber (about 14.5k stars): Python backend plus a web or Electron frontend; Live2D only; broad ASR and TTS options; Silero VAD; hands-free interruption; v1.2.0 (2025-08-03) added Letta memory and MCP (the README still says memory is removed, so it is inconsistent). Sources: https://github.com/Open-LLM-VTuber/Open-LLM-VTuber, https://github.com/Open-LLM-VTuber/Open-LLM-VTuber-Web
7. [verified] Open-LLM-VTuber is effectively frozen: last release v1.2.1 (2025-08-26); a README notice (2026-01-11) says the team is focusing on a v2.0 rewrite. Licence is split: backend MIT; frontend "Open-LLM-VTuber License 1.0" (Apache-2.0 plus a commercial restriction on paid SaaS, redistribution and embedding). Fine for personal use, a poor embed target. Source: https://github.com/Open-LLM-VTuber/Open-LLM-VTuber/blob/main/LICENSE
8. [verified] Amica (semperai/amica, about 1.6k stars, MIT, assets carry their own licences): fork of Pixiv's ChatVRM; three.js with `@pixiv/three-vrm`; Whisper, Silero VAD, many TTS and LLM backends; Next.js wrapped by Tauri. Release tags stale since 2023-12-23; recent commit activity unverified. Source: https://github.com/semperai/amica
9. [unverified] SillyTavern (AGPL-3.0, about 35.2k stars, v1.19.0 on 2026-09-14): a chat front end with character cards, lorebooks, summarisation and vector memory; no VRM or Live2D on the main page. Its memory feature specifics are from the researcher's own knowledge (docs unreachable). Reference only, never copy. Source: https://github.com/SillyTavern/SillyTavern
10. [verified] Several tiny open-source projects bridge Claude Code to an on-screen avatar using the same pattern (hooks post to a localhost server that drives speech and poses): claudes-body (MIT, 18 stars, three-vrm, Kokoro, Stop hook to 127.0.0.1:7777), V1R4 (MIT, 27 stars, Tauri, Windows hooks via WSL), avatar-mcp (MIT, MCP tools `speak(text, emotion)` and `start_listening()`), varie-claude-avatar (MIT, Electron plus Spine, macOS only). None uses the Agent SDK. Sources: https://github.com/SkyeShark/claudes-body, https://github.com/Kunnatam/V1R4, https://github.com/shesanth/avatar-mcp, https://github.com/varie-ai/varie-claude-avatar
11. [verified] Other references: Persona Engine (C# Live2D, barge-in with a fast and a large Whisper model, needs NVIDIA CUDA; licence not visible); Z-Waif (Python, rolling summaries and lorebooks; licence not visible); Mate-Engine (Unity VRM, AGPL-3.0 plus custom); Utsuwa (SvelteKit and Tauri, memory inspector and graph, AGPL-3.0-or-later after v0.12.0). Source: https://www.github.com/proj-airi/awesome-ai-vtubers
12. [verified] Rendering blocks: `@pixiv/three-vrm` is MIT, about 2.3k stars, v3.5.5 on 2026-07-09 and v3.6.0-beta.0 on 2026-09-29; the WebGPU MToon path needs three r167 or later. pixi-live2d-display (MIT) needs PixiJS 6 and covers Cubism 2.1 and 4 only. Live2D Cubism Core is proprietary; Live2D's terms exempt small-scale users but not "Expandable Applications" such as avatar systems. Sources: https://github.com/pixiv/three-vrm, https://www.live2d.com/products/releaselicense
13. [verified] Convergence across projects: Kokoro as local TTS; a Whisper-family STT nearly everywhere; Silero VAD; barge-in implemented in Open-LLM-VTuber, Persona Engine and AIRI's voice controller; memory is chat history, vector or RAG style, never a knowledge base or second brain. That differentiator must be built.

## Options considered

| Option | Verdict |
|---|---|
| A. Embed or fork AIRI | Fastest talking avatar, but it owns the agent loop, persona and memory; large churning Vue monorepo; Claude is API-key only; its UI cannot become the dashboard |
| B. Build on Open-LLM-VTuber | Live2D only, v1 frozen, frontend licence restricts commercial use, second runtime |
| C. Build our own Room module, referencing AIRI and the overlays | Recommended |
| D. Run AIRI beside the app through its server SDK | Two apps, two memories, two personas; undocumented protocol |

## Recommendation

Option C. Use AIRI as the primary reference (MIT, so selected code can be lifted with attribution) and the Claude-Code avatar overlays as references for the Claude link. Borrow: three plus `@pixiv/three-vrm` with VRMA idle animations and AIRI's VRM lifecycle and lip-sync approach; a small typed avatar event bus (`speak{text, emotion}`, `pose{state}`, `lookAt`, `expression`) and the hook-to-pose mappings from claudes-body and avatar-mcp; Kokoro, Whisper-family STT and Silero VAD with the barge-in design from Persona Engine; memory built ourselves (borrow UX only: Utsuwa's inspector and graph, Z-Waif's rolling summaries); MediaPipe face landmarks for presence (video understanding is separate). Skip Live2D at first. For the shell, AIRI proves an Electron transparent overlay on Windows; validate Web Audio and DevTools parity early or choose Electron.

## MVP versus later

MVP: a static or looping image or a three-vrm sample in the quarter-screen room with idle, blink, simple expressions and a speech bubble, with fake chat; then a VRM room module with idle, blink, look-at and emotion-tag expressions, Kokoro with amplitude or AEIOU lip-sync, text chat through the Agent SDK, hook or stream events driving avatar states, push-to-talk STT. Later: always-on VAD with barge-in and wake word, webcam presence through MediaPipe, an optional transparent overlay, proactive behaviour driven by the second brain, a memory inspector or graph, custom room scenes, Live2D only if licensing is acceptable.

## Risks

- Licence traps: SillyTavern, Mate-Engine and Utsuwa (AGPL), Open-LLM-VTuber frontend (commercial restriction), Live2D Cubism Core (proprietary).
- Churn and abandonment: AIRI changes daily; Open-LLM-VTuber v1 is frozen; Amica's tags are stale; the overlays are tiny.
- Bridge fragility: nobody uses the Agent SDK; AIRI's handshake is undocumented.
- Windows and GPU assumptions (several stacks need NVIDIA CUDA).
- Shell mismatch between a Linux dev box (WebKitGTK for Tauri) and Windows (WebView2).
- Uncanny valley and effort sink; the avatar can crowd out the second brain.
- Companion ethics: keep data local, give memory controls, avoid manipulative engagement loops.
- Evidence quality: star counts and activity from scrapes.

## Open questions

- Unreachable domains (airi.moeru.ai, docs.llmvtuber.com, docs.heyamica.com, docs.sillytavern.app and others), so official docs were not read; the AIRI DevLog quote and Amica memory detail came from excerpts.
- Can AIRI be driven end to end by an external brain without its own LLM provider? Undocumented; needs a spike or source read.
- The user's GPU and VRAM; VRM 3D versus Live2D 2D preference (VRM chosen); whether the room is a fixed pane or a detachable overlay (fixed pane in v1).
- Anthropic's terms for subscription use were not researched here (see [claude-integration.md](claude-integration.md) and [critic.md](critic.md)).

## Decisions that followed

[ADR 0006](../adr/0006-avatar-vrm-and-voice-stack.md), [ADR 0002](../adr/0002-browser-first-then-electron.md), [PERSONA.md](../PERSONA.md).
