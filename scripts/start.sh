#!/usr/bin/env bash
# Run Mira from a clone: install, build the web app, start the daemon and open the app in your browser.
# Everything runs locally with the fake Claude (no network, no tokens) unless you set CLAUDE_BACKEND=sdk first.
set -e
cd "$(dirname "$0")/.."

node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=14)?0:1)' 2>/dev/null || {
  echo "Node.js 22.14 or newer is needed (https://nodejs.org/). You have: $(node -v 2>/dev/null || echo none)"
  exit 1
}
if ! command -v pnpm >/dev/null 2>&1; then
  echo "Enabling pnpm..."
  corepack enable 2>/dev/null || npm install -g pnpm
fi

echo "Installing dependencies (a few minutes the first time)..."
pnpm install --frozen-lockfile
pnpm --filter @ai-assistant/daemon check-native
echo "Building the app..."
pnpm --filter @ai-assistant/web build
echo "Starting Mira. Press Ctrl+C to stop her."
OPEN_BROWSER="${OPEN_BROWSER:-1}" exec pnpm --filter @ai-assistant/daemon start
