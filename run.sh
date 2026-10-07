#!/usr/bin/env bash
# Development server inside WSL (auto-reload on code changes).
# Usage: ./run.sh [extra uvicorn args]
# Bound to 127.0.0.1 only: Windows reaches it via WSL's localhost forwarding,
# other devices via tailscale serve (see README).
cd "$(dirname "$0")" || exit 1
export PATH="$HOME/.local/bin:$PATH"
# --no-proxy-headers: see app/auth.py (identity headers from tailscale serve)
exec uv run uvicorn app.main:app --host 127.0.0.1 --port "${PORT:-8765}" --reload --no-proxy-headers "$@"
