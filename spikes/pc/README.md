# PC test kit (RTX 5070 Ti, Windows)

To run all of this with Claude Code on the PC, paste [KICKOFF-PROMPT.md](KICKOFF-PROMPT.md); background and risks are in [docs/PC-BRINGUP.md](../../docs/PC-BRINGUP.md).

Status: draft, updated 2026-11-01. Nothing here has been run on the user's PC yet. The agreed route (2026-10-31): the user runs Claude Code on the PC with the kickoff prompt, because the cloud session cannot reach it (Remote Control listed no computer). The fallback is the user running the commands and pasting the output.

## Order

1. **Inventory** (`collect-system-info.ps1`, read-only): GPU/driver/CUDA, Unreal and Unity installs, Visual Studio, Node, git, claude.
2. **Claude Code and hooks** (`spikes/hooks`, `spikes/ttft`): do http hooks from Windows reach the daemon, TTFT of a persistent SDK session.
3. **Voice on the GPU** (`spikes/voice`): whisper.cpp (CUDA) and Kokoro latency, English.
4. **Browser stage** (`spikes/webgl-camera`): WebGL2, camera, audio latency in the user's browser.
5. **Engine stage spike** (new, after the references arrive): a minimal Unreal or Unity scene with one character, measured on the 5070 Ti:
   frame time with strand hair on and off, VRAM, time to swap an outfit at runtime, streamed-TTS lip sync latency (audio in to mouth movement),
   Audio2Face-3D throughput if its licence suits. Pass/fail gates: 60 fps at 1440p with one character and a small scene, outfit swap under 1 s,
   audio-to-lip latency under about 120 ms.

## Things to check specifically for this GPU

- The RTX 5070 Ti is a Blackwell consumer card (compute capability 12.0). From general knowledge, CUDA 12.8 or newer and a recent driver are
  required, and some prebuilt ML wheels (for example PyTorch) only support it from builds made for CUDA 12.8. Confirm against the actual
  tools before assuming a benchmark result is representative. (Unverified here: no web check was made for this.)
- 16 GB of VRAM is shared by the 3D stage, local speech models and anything else. Record VRAM with the stage running and each model loaded.

## Results

Fill in `RESULTS.md` (not committed until a real run exists). Do not paste secrets or full environment dumps.
