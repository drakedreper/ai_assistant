# ADR 0009: Container mode (running the backend in Docker)

Status: Accepted 2026-11-01, at the owner's request ("run this in a Docker container"). Implemented and tested; the image itself is verified by `.github/workflows/docker.yml` (the development sandbox has no Docker daemon).

## Context

The daemon was written to listen on `127.0.0.1` and nothing else, and `config.ts` said so in capital letters: "There is deliberately no way to configure this." Docker does not fit that without a change, for two reasons:

1. A port published by Docker only reaches a process that listens on the container's own interface (`0.0.0.0` inside the container). A daemon bound to the container's `127.0.0.1` is unreachable from the host.
2. Docker, and Docker Desktop on Windows, hand every published-port connection to the container from the bridge's gateway address (a private address such as `172.17.0.1`), never from `127.0.0.1`. The stage socket had a second lock, "the peer address is loopback", which therefore refuses every engine process outside the container.

## Decision

One switch, named for what it is: **`MIRA_CONTAINER=1`**. The Dockerfile sets it and nothing else does. With it:

- the daemon listens on `0.0.0.0` (all interfaces of the container) instead of `127.0.0.1`;
- the stage socket's peer lock accepts loopback **and private** addresses (RFC 1918, link-local, unique-local), never a public one (`apps/daemon/src/net/peer.ts`; refusal code `peer_not_allowed`);
- the banner says it is in container mode, repeats the rule below, and warns when nothing says this is a container (`/.dockerenv`, `/run/.containerenv`), because then the daemon would be reachable from the network.

Without it nothing changes, and no other setting can move the address: `DAEMON_HOST`, `DAEMON_BIND`, `HOST` and the like are not read (a test pins that).

**What keeps the daemon private is how the port is published, and `docker-compose.yml` publishes it on the PC's `127.0.0.1` only** (`127.0.0.1:7421:7421`, never `7421:7421`). The CI job checks it twice: `docker compose port` must say `127.0.0.1:...`, and the host's listening socket must not be on `0.0.0.0`, `*` or `[::]`.

## What does not change

Host allowlist (`127.0.0.1:PORT`, `localhost:PORT`, so the published port must equal `DAEMON_PORT`), Origin allowlist for mutations, the session cookie, the separate hook and stage tokens, terminal tickets and the pairing proof, no secrets in logs or the database, the daemon never reading Claude OAuth tokens, finance read-only, adults only. A test shows a private peer address still needs the token and a foreign Host is still refused.

## What does change, said plainly

- Inside the container the HTTP surface is bound to every container interface. If someone publishes the port on all interfaces (`-p 7421:7421`), the whole network can reach it, and only the secrets stand in the way: the one-time sign-in code, the cookie, the tokens. The Host check does not help against a network client, who controls that header; it only protects against browsers and DNS rebinding.
- The stage socket's "peer is loopback" lock is one notch weaker (private is accepted). It was a second lock behind Host, Origin and the token, not the first.

## Consequences and limits

- Unity and the browser stay on the host and use the published port. Unity cannot run in this container (no GPU window), and Docker adds nothing for it.
- **Terminals run inside the container.** "New shell" is a Linux shell with no access to the PC's files and no `claude` of yours (Claude Code's login lives on the host). That is a sandbox, which may be what you want, but it is not the native terminal.
- **API-key mode only.** `local-login` would need the host's Claude Code credentials inside the container, and the daemon does not read or proxy them. Pass `ANTHROPIC_API_KEY` through the shell that runs `docker compose` (compose never writes it to a file).
- `OPEN_BROWSER` cannot open the host's browser from inside a container; `start-docker.cmd` does it on the host.
- The sign-in code is made when the daemon starts, so the helper restarts the container once to give a fresh link.
- Image size is about a gigabyte: it keeps the dev dependencies because the daemon runs TypeScript through `tsx`. A smaller image (`pnpm deploy`, `tsx` as a runtime dependency) is possible later.

## Verification

Unit and real-socket tests (`net.peer.test.ts`, `container.mode.test.ts`: a private peer address is accepted with the token and refused without it, a public one gets 403, the default daemon is not reachable on any other address), each removed once to watch it fail. The real image is built and run on a Linux runner with Docker and checked from the host (`scripts/docker-smoke.ts`: non-root user, port on 127.0.0.1 only, sign-in, snapshot, a stage connecting over the real Docker bridge, the token and the data surviving a restart, the logs free of the token). **Not verified:** Docker Desktop on Windows itself (the runner is Linux Docker; Docker Desktop's forwarding should look the same to the container, from a private gateway address, but nobody has run it there).

## Alternatives rejected

- `network_mode: host`: not available on Docker Desktop for Windows and macOS by default, and on Linux it would let the container see the host's loopback services.
- A forwarding sidecar so the daemon could stay on the container's loopback: the connection would still arrive from a private address, so the peer lock changes anyway, and it adds a moving part.
- Trusting `X-Forwarded-For`: there is no proxy to set it, and a client could.
