#!/usr/bin/env bash
# Run Mira's backend in Docker: build the image, start it, print the one-time sign-in link and open it in a browser.
# Needs Docker running. Everything uses the fake Claude (no network, no tokens) unless ANTHROPIC_API_KEY and
# CLAUDE_BACKEND=sdk are set in this shell first. See docs/DOCKER.md.
set -e
cd "$(dirname "$0")/.."

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is not installed: https://docs.docker.com/get-docker/"
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "Docker is installed but not running. Start it, then run this again."
  exit 1
fi

echo "Building and starting the Mira backend in Docker (the first build takes a few minutes)..."
docker compose up -d --build
# The sign-in code is single use and is made when the daemon starts, so start it once more to get a fresh link.
docker compose restart daemon >/dev/null

link=""
for _ in $(seq 1 60); do
  link="$(docker compose logs --no-color --since 3m daemon 2>&1 | grep -Eo 'http://127\.0\.0\.1:[0-9]+/\?code=[A-Za-z0-9_-]+(#tp=[A-Za-z0-9_-]+)?' | tail -n 1 || true)"
  [ -n "$link" ] && break
  sleep 2
done
if [ -z "$link" ]; then
  echo "The backend did not print a sign-in link within two minutes. The last log lines:"
  docker compose logs --no-color --tail 40 daemon
  exit 1
fi

echo
echo "Sign in (one time, 15 minutes): $link"
if command -v xdg-open >/dev/null 2>&1; then xdg-open "$link" >/dev/null 2>&1 || true
elif command -v open >/dev/null 2>&1; then open "$link" >/dev/null 2>&1 || true
fi
echo
echo "The backend keeps running in Docker. Stop it with: docker compose down   (your data stays in the mira-data volume)"
echo "To connect Unity, print the stage token with: docker compose exec daemon node --import tsx src/stage/cli.ts token"
