# syntax=docker/dockerfile:1
#
# Mira's backend (the daemon and the built web app) in one image. Run it with docker-compose.yml, which publishes the
# port on this PC's 127.0.0.1 ONLY. See docs/DOCKER.md and docs/adr/0009-container-mode.md.
#
# What is not in here: Unity (it runs on the host and connects to the published port), your own Claude Code login (it
# lives on the host), and any character assets (metadata only, by design).

# ---- build: install everything (node-pty has no Linux prebuilds and compiles here) and build the web app --------------
FROM node:22-bookworm-slim AS build
ENV CI=true
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable
WORKDIR /app
# Manifests first: this layer (the install) is cached until a dependency changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/daemon/package.json apps/daemon/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/agent-core/package.json packages/agent-core/
COPY packages/stage-core/package.json packages/stage-core/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @ai-assistant/web build

# ---- run: no compilers, not root ---------------------------------------------------------------------------------------
FROM node:22-bookworm-slim
# MIRA_CONTAINER=1 is container mode: the daemon listens on every interface of THIS container, which only the published
# port reaches. It is set here and nowhere else; outside the image nothing can move the daemon off 127.0.0.1.
ENV NODE_ENV=production \
    MIRA_CONTAINER=1 \
    DAEMON_PORT=7421 \
    DATA_DIR=/data \
    HOME=/data/home
RUN mkdir -p /data/home && chown -R node:node /data
WORKDIR /app
COPY --from=build --chown=node:node /app /app
USER node
WORKDIR /app/apps/daemon
EXPOSE 7421
VOLUME ["/data"]
# Any HTTP answer below 500 means the daemon is up (an unauthenticated /api/health is a 401 by design).
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.DAEMON_PORT||7421)+'/api/health').then(r=>process.exit(r.status<500?0:1),()=>process.exit(1))"
CMD ["node", "--import", "tsx", "src/main.ts"]
