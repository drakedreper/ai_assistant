#!/usr/bin/env bash
# One command that checks everything, and prints a short table instead of pages of output.
#
#   scripts/verify.sh          full run (about 6 minutes): typecheck, every unit suite, the C# stage client (when dotnet is installed),
#                              the web build, the mockup smoke test,
#                              the three end-to-end scripts (real daemon processes, real Chromium), orphaned terminal hosts
#   scripts/verify.sh quick    typecheck and the unit suites (and the C# client when dotnet is installed) only (about 1 to 2 minutes)
#
# Details go to .verify.log (git-ignored). Linux, macOS or Git Bash. The end-to-end scripts need Playwright's Chromium
# (npx playwright install chromium) and are run one at a time on purpose: they start daemons on random ports.
set -u
cd "$(dirname "$0")/.." || exit 2
LOG="$PWD/.verify.log"
MODE="${1:-full}"
: > "$LOG"
FAIL=0

row() { printf '%-14s %s\n' "$1" "$2"; }
step() { echo "=== $1 ($(date +%T))" >> "$LOG"; }

run() { # run <name> <command...>
  local name="$1"
  shift
  step "$name"
  if "$@" >> "$LOG" 2>&1; then row "$name" PASS; else row "$name" FAIL; FAIL=1; fi
}

e2e() { # e2e <name> <script> : counts the PASS and FAIL lines the script prints
  local name="$1" script="$2" out rc=0
  out="$(mktemp)"
  step "$name"
  node "$script" > "$out" 2>&1 || rc=1
  cat "$out" >> "$LOG"
  local p f
  p=$(grep -c '^PASS' "$out")
  f=$(grep -c '^FAIL' "$out")
  rm -f "$out"
  if [ "$rc" -eq 0 ]; then row "$name" "PASS ($p checks)"; else row "$name" "FAIL ($p passed, $f failed; see .verify.log)"; FAIL=1; fi
}

run typecheck pnpm -r typecheck
run unit pnpm test
# per-package test counts, from the log
UNIT=$(grep -E 'test: +Tests +[0-9]+ passed' "$LOG" | sed -E 's/.*Tests +([0-9]+) passed.*/\1/' | awk '{s+=$1; n=n" "$1} END{print s" (" n " )"}')
row "  unit tests" "$UNIT"

# the C# stage client for Unity (unity/Packages/com.mira.stage): needs the .NET 8 SDK, and node for its live tests, which
# start the real daemon; skipped, not failed, on a machine without dotnet
if command -v dotnet > /dev/null 2>&1; then
  run unity-stage dotnet test unity/Packages/com.mira.stage/Tests~/Tests/Mira.Stage.Tests.csproj -nologo -v q
  CS=$(grep -E '(Passed|Failed)! ' "$LOG" | tail -1 | sed -E 's/.*Total: *([0-9]+).*/\1/')
  row "  c# tests" "${CS:-?}"
else
  row "unity-stage" "SKIP (no dotnet SDK: the C# client tests did not run)"
fi

if [ "$MODE" != "quick" ]; then
  run build pnpm --filter @ai-assistant/web build

  # the mockup smoke test needs a preview server
  step "smoke"
  ( cd apps/web && exec node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 4173 --strictPort >> "$LOG" 2>&1 ) &
  PREVIEW=$!
  for _ in $(seq 1 60); do (echo > /dev/tcp/127.0.0.1/4173) 2>/dev/null && break; sleep 0.5; done
  BASE_URL=http://127.0.0.1:4173 SHOTS_DIR=./screenshots e2e smoke apps/web/scripts/smoke.mjs
  kill "$PREVIEW" 2>/dev/null

  e2e e2e-daemon apps/web/scripts/e2e-daemon.mjs
  e2e e2e-terminal apps/web/scripts/e2e-terminal.mjs
  e2e e2e-stage apps/web/scripts/e2e-stage.mjs

  if [ "$(uname -s)" = "Linux" ]; then
    N=$(ps -eo pid,args | grep -c '[p]tyHost')
    if [ "$N" -eq 0 ]; then row "orphan hosts" "PASS (none left behind)"; else row "orphan hosts" "FAIL ($N PTY host processes still running)"; FAIL=1; fi
  fi
fi

echo
if [ "$FAIL" -eq 0 ]; then echo "ALL GREEN (log: .verify.log)"; else echo "SOMETHING FAILED (log: .verify.log)"; fi
exit "$FAIL"
