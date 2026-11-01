# Running the backend in Docker

Status: written 2026-11-01. The image is built and checked on a Linux machine with Docker by `.github/workflows/docker.yml`; it has not been run on Docker Desktop for Windows by anyone yet. Why the daemon may listen on the container's interface at all: [ADR 0009](adr/0009-container-mode.md).

## What runs where

```
 your PC (Windows)                                   Docker
 ┌───────────────────────────────┐        ┌──────────────────────────────────────────┐
 │ browser  ── http://127.0.0.1:7421 ──────────▶ daemon + the built web app (this image) │
 │ Unity    ── ws://127.0.0.1:7421/ws/stage ───▶ stage socket, memory, character, speech │
 │ (Editor or built player, GPU)  │        │  data: the "mira-data" volume                │
 └───────────────────────────────┘        └──────────────────────────────────────────┘
```

The backend is the part that lives in Docker. The browser and Unity stay on your PC: Unity needs your GPU and a window, and it reaches the backend through the one published port, on `127.0.0.1` only.

## Start it

You need Docker Desktop running. Then, from the repository folder:

- Windows: double-click `start-docker.cmd`.
- macOS, Linux, Git Bash: `scripts/start-docker.sh`.

It builds the image (the first build takes a few minutes: it compiles the terminal's native addon), starts the container, prints the one-time sign-in link and opens it in your browser. By hand:

```bash
docker compose up -d --build
docker compose restart daemon
docker compose logs daemon
```

The restart is there because the sign-in code is made when the daemon starts and works once; the logs then show a fresh link. Everything runs with the fake Claude (scripted replies, no network, no tokens) until you pass a key, see below.

Stop it with `docker compose down`. Your data (database, `secrets.json`, the shell's home) stays in the `mira-data` volume; `docker compose down -v` deletes it too.

## The real Claude

Set the key in the shell that runs `docker compose`, never in a file:

```bash
# PowerShell
$env:ANTHROPIC_API_KEY = "sk-ant-..."; $env:CLAUDE_BACKEND = "sdk"; docker compose up -d
```

Only API-key mode works in the container. Your own Claude Code login lives on the host and the daemon does not read or proxy it (use the native `start.cmd` if you want `local-login`).

## Connecting Unity

Unity connects to `ws://127.0.0.1:7421/ws/stage` with the stage token. Print it with:

```bash
docker compose exec daemon node --import tsx src/stage/cli.ts token
```

The token is a secret (it opens the stage door, nothing else); it lives in the volume, stays the same across restarts, and is never in the logs. Set it as `MIRA_STAGE_TOKEN` in the environment that starts Unity rather than saving it in a project file. The stage switch itself is in Settings, Stage. What the Unity side is, what is tested and how it gets built: [UNITY.md](UNITY.md).

## What is different from running it natively

| | native (`start.cmd`) | Docker |
|---|---|---|
| Terminals | your own shell and your own `claude` | a Linux shell **inside the container**: no access to your files, no `claude` of yours (a sandbox) |
| Claude login | API key or your Claude Code login (`local-login`) | API key only |
| Opening the browser | the daemon does it | the helper script does it on your PC |
| Data | `%APPDATA%\ai-assistant` | the `mira-data` volume |
| Needs | Node 22.14+ and pnpm | Docker Desktop |
| Port | `DAEMON_PORT` | `DAEMON_PORT`, and it must be the same number on both sides of the mapping in `docker-compose.yml` |

## Rules that keep it private

- `docker-compose.yml` publishes the port as `127.0.0.1:7421:7421`. Never `7421:7421`: that publishes it on every network interface of your PC, and then only the sign-in code and the tokens stand between your network and the daemon.
- `MIRA_CONTAINER=1` is set by the image and by nothing else. Do not set it outside the image: it makes a native daemon listen on every interface (the daemon warns when it does not look like a container).

## Troubleshooting

- "Docker is installed but not running": start Docker Desktop and wait until it says it is running.
- The browser says it cannot sign in: the link is single use and lasts 15 minutes. Run `start-docker.cmd` again (it restarts the container to make a new one).
- 403 on every page: you changed one side of the port mapping. Keep `DAEMON_PORT` and the mapping equal.
- Unity gets 401: wrong or missing token. Print it again with the command above. 403: its `Host` header is not `127.0.0.1:PORT` or `localhost:PORT`. 409: another stage is connected (Settings, Stage has a Disconnect button).
- To see what the container is doing: `docker compose logs -f daemon`. It never prints the stage token, the hook token or your API key.

## Checking it yourself

With the container running, `pnpm --filter @ai-assistant/daemon exec tsx ../../scripts/docker-smoke.ts` runs the same checks the CI job runs (non-root user, port on 127.0.0.1 only, sign-in, snapshot, a stage connecting, the token and the data surviving a restart).
