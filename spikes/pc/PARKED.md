# Parked: GPU, voice and engine checks

Status: parked on 2026-11-01. These were steps 5 to 8 of the first PC kickoff prompt. No current milestone needs them, so they are not part of the default PC check ([KICKOFF-PROMPT.md](KICKOFF-PROMPT.md)). Pick them up when we start the voice milestone or choose an engine (Unreal or Unity). The prompts below are for Claude Code on the PC, in the same style and with the same rules as the kickoff prompt (ask before changing the machine, no secrets, results under `spikes\pc\results\`, numbers not adjectives).

## Time to first token (`spikes/ttft/README.md`)

Only with `ANTHROPIC_API_KEY` set by the user in that shell session. Run it and report p50 and p95 for the direct call and for the Agent SDK session. The gate is p50 of about 1.2 s or less. It decides whether a separate voice lane exists.

## GPU voice (`spikes/voice/README.md`)

Ask before downloading or building anything. Measure whisper.cpp (CUDA) and Kokoro on the GPU in English: model, milliseconds for speech-to-text after the end of speech, first-audio milliseconds for text-to-speech, and VRAM from `nvidia-smi` while both are loaded. The RTX 5070 Ti is a Blackwell consumer card (compute capability 12.0): from general knowledge it needs a recent driver and CUDA 12.8 or newer, and some prebuilt ML wheels only support it from builds made for that CUDA. Report the exact versions that worked. 16 GB of VRAM is shared by the 3D stage, the speech models and everything else; always record VRAM with the stage and each model loaded.

## Browser and camera (`spikes/webgl-camera/index.html`)

Open it in the default browser, say which checks need permission (camera, microphone) and paste the report it shows. Confirm WebGL2 runs on the real GPU, not in software, and measure audio latency.

## Engine stage spike (after the user's references and the engine decision)

A minimal Unreal or Unity scene with one character, measured on the 5070 Ti: frame time with strand hair on and off, VRAM, time to swap an outfit at runtime, streamed-TTS lip-sync latency (audio in to mouth movement), and Audio2Face-3D throughput if its licence suits. Proposed gates: 60 fps at 1440p with one character and a small scene, outfit swap under 1 s, audio-to-lip latency under about 120 ms. See [ADR 0008](../../docs/adr/0008-stage-protocol-and-engine-choice.md).

A cheaper first step that needs no engine: a VRM character in the browser room, which the user's browser runs on the GPU through WebGL (see [docs/PLAN.md](../../docs/PLAN.md)).
