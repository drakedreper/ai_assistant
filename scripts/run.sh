#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ -f .venv/bin/activate ]]; then
  # shellcheck disable=SC1091
  source .venv/bin/activate
fi

export PYTHONPATH="$ROOT/backend:${PYTHONPATH:-}"
exec uvicorn app.main:app --app-dir "$ROOT/backend" --host 127.0.0.1 --port 8000 --reload
