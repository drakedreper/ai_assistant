# PC test kit (Windows)

Status: optional, updated 2026-11-01. Nothing the project needs next depends on it, and nothing here has been run on the user's PC yet.

- To see the real daemon and the embedded terminal run on Windows, paste [KICKOFF-PROMPT.md](KICKOFF-PROMPT.md) into Claude Code on the PC (about 15 minutes, no GPU), or enable Remote Control for a folder in the Claude desktop app and have the cloud session run it. Background, a 5-minute quick start and the terminal checks are in [docs/PC-BRINGUP.md](../../docs/PC-BRINGUP.md).
- GPU voice, time to first token, the camera page and the engine spike are parked in [PARKED.md](PARKED.md) until the voice milestone or an engine decision.
- `collect-system-info.ps1` is a read-only inventory (GPU, driver, CUDA, Unreal and Unity installs, build tools) for when the engine work starts.

Results go in `results/` (git-ignored). Do not paste secrets or full environment dumps.
