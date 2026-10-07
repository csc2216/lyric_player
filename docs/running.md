# 啟動方式

- 開發（WSL 內）：`./run.sh`（= `uv run uvicorn app.main:app --port 8765 --reload --no-proxy-headers`；`--no-proxy-headers` 必要，見 `docs/mobile-guests-offline.md`），瀏覽器開 `http://localhost:8765`。
- 一鍵啟動（Windows）：雙擊專案根目錄的 `start-lyric-player.bat`（可建桌面捷徑，見 README）。它透過 `wsl.exe --cd` 執行 `scripts/serve_windows.sh`：背景啟動 `uvicorn --host 127.0.0.1 --port 8765 --no-proxy-headers`（不 reload；只聽 127.0.0.1：Windows 靠 WSL localhost 轉發、其他裝置靠 tailscale serve，不需要也不該開放其他介面）→ 等 `/api/library` 有回應 → 用預設瀏覽器開網頁；8765 已有伺服器在跑時只開瀏覽器；關閉視窗（wsl.exe 結束 → SIGHUP / stdin EOF）時伺服器跟著停。wsl.exe 是非 login shell，不會讀 `~/.profile`，所以腳本自己把 `~/.local/bin` 加進 PATH 找 `uv`。`LYRIC_PLAYER_PORT` 環境變數可改 port；參數 `--no-browser` 不開瀏覽器（測試用）。
（IFrame API 必須在 http origin 下跑，不能用 file://。）
