#!/usr/bin/env bash
# Make sure `tailscale serve` publishes the app over HTTPS on the tailnet, and print its URL.
# Optional: without Tailscale the app simply stays local. Never fails the launch.
#
# Usage: scripts/tailscale_serve.sh [PORT]
PORT="${1:-8765}"
export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

if ! command -v tailscale >/dev/null 2>&1; then
  echo "（沒有安裝 Tailscale：只能在這台電腦使用。要給 iPad / 室友用，請看 README「行動裝置與訪客」）"
  exit 0
fi

# --bg keeps serving after this script exits (and across restarts); re-running is harmless.
# stdin from /dev/null + timeout: never hang on an interactive prompt.
if ! out=$(timeout 20 tailscale serve --bg "$PORT" </dev/null 2>&1); then
  echo "Tailscale serve 沒有啟動成功："
  echo "$out" | sed 's/^/  /'
  echo "  常見原因：還沒登入（sudo tailscale up）、需要先執行一次 sudo tailscale set --operator=\$USER、"
  echo "  或 tailnet 還沒開啟 HTTPS（照上面訊息的網址開啟）。其他裝置暫時連不到，這台電腦照常可用。"
  exit 0
fi

url=$(tailscale serve status 2>/dev/null | grep -o 'https://[^ ]*' | head -1)
echo "其他裝置（Tailscale）：${url:-（執行 tailscale serve status 查看網址）}"
