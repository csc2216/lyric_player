#!/usr/bin/env bash
# Started by start-lyric-player.bat (Windows side, via wsl.exe).
# Runs uvicorn, opens the browser once it answers, and stops the server when
# the console window is closed (the terminal hangs up / stdin reaches EOF).
#
# Usage: scripts/serve_windows.sh [PORT] [--no-browser]
set -u

PORT="${1:-8765}"
OPEN_BROWSER=1
for arg in "$@"; do
  [ "$arg" = "--no-browser" ] && OPEN_BROWSER=0
done

cd "$(dirname "$0")/.." || exit 1
# wsl.exe runs a non-login shell: ~/.profile is not read, so uv may not be on PATH.
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
if ! command -v uv >/dev/null 2>&1; then
  echo "找不到 uv。請先在 WSL 安裝：curl -LsSf https://astral.sh/uv/install.sh | sh"
  exit 1
fi

# --no-proxy-headers: keep the real peer address. tailscale serve relays from
# 127.0.0.1; the app trusts its identity headers only from loopback (app/auth.py).
uv run uvicorn app.main:app --host 0.0.0.0 --port "$PORT" --no-proxy-headers &
SERVER_PID=$!

cleanup() {
  kill "$SERVER_PID" 2>/dev/null
  wait "$SERVER_PID" 2>/dev/null
}
trap cleanup EXIT
trap 'exit 0' HUP INT TERM

ready=0
for _ in $(seq 1 120); do
  if curl -sf -o /dev/null "http://127.0.0.1:$PORT/api/library"; then
    ready=1
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "伺服器啟動失敗（看上面的錯誤訊息）。"
    exit 1
  fi
  sleep 0.5
done
if [ "$ready" != 1 ]; then
  echo "伺服器 60 秒內沒有回應。"
  exit 1
fi

echo
echo "伺服器運行中：http://localhost:$PORT"
bash scripts/tailscale_serve.sh "$PORT"
echo "關閉此視窗即停止伺服器。"
if [ "$OPEN_BROWSER" = 1 ]; then
  # cmd.exe complains about UNC working directories, so run it from C:
  (cd /mnt/c && cmd.exe /c start "" "http://localhost:$PORT") >/dev/null 2>&1
fi

# Wait while the server runs. read returns >128 on timeout and 1 on EOF
# (window closed); closing the window usually also sends SIGHUP (trap above).
while kill -0 "$SERVER_PID" 2>/dev/null; do
  read -r -t 1 _
  rc=$?
  if [ "$rc" -ne 0 ] && [ "$rc" -le 128 ]; then
    break
  fi
done
