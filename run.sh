#!/usr/bin/env bash
# Development server inside WSL (auto-reload on code changes).
# Usage: ./run.sh [extra uvicorn args, e.g. --host 0.0.0.0]
cd "$(dirname "$0")" || exit 1
export PATH="$HOME/.local/bin:$PATH"
exec uv run uvicorn app.main:app --port "${PORT:-8765}" --reload "$@"
