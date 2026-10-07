# 行動裝置與訪客（Tailscale、PWA、離線）

**連線與身分**（`app/auth.py`）
- 其他裝置透過 `tailscale serve --bg 8765`（HTTPS，tailnet 內）連進來；`scripts/tailscale_serve.sh` 由一鍵啟動呼叫，未安裝 Tailscale 時略過並提示。
- 「直接本機」= TCP peer 是 loopback **且** Host 是 localhost/127.0.0.1/[::1] **且** 沒有任何 proxy（X-Forwarded-*、Forwarded）或 Tailscale-User-* header → owner。serve 也從 127.0.0.1 連進來，所以單看 loopback 不夠。
- `Tailscale-User-Login` 只在 peer 是 loopback 時採信（= serve 轉來的）。等於 `OWNER_LOGIN`（不分大小寫）→ owner；其他帳號 → 訪客（key = `ts:<login>`）。
- 沒有身分 → 有 `lp_guest` cookie（`POST /api/auth/pin` 驗 `GUEST_PIN` 後發的隨機 token，存 `DATA_DIR/guests.json`）→ 訪客；否則 401 `pin_required`（沒設 GUEST_PIN 則 403）。
- **uvicorn 必須用 `--no-proxy-headers`**：預設會把 loopback peer 換成 X-Forwarded-For 位址，身分 header 就被忽略。不可改成「信任 100.x 網段」：tailnet 裝置能繞過 serve 直連 8765 並自帶假 header。
- 是否真的有 header 要實測：`GET /api/me` 回傳 `headers`（收到哪些身分 / proxy header）與 `note`（被忽略時的原因）。
- 權限：訪客可 GET 歌曲、resolve、build（非 force；只計成功新建的歌，每人每日 `GUEST_DAILY_BUILDS`，超過 429 `quota_exceeded`）；PATCH / retranslate / DELETE 一律 403 `forbidden`。錯誤 JSON 帶 `code`。

**PWA**：`static/manifest.json`、`static/icons/*`（`scripts/make_icons.py` 產生的原創圖示）、`static/sw.js`。Service worker 只快取 app shell（`SHELL` 清單；`tests/test_pwa.py` 檢查每個 `static/js/*.js` 都在清單裡），策略為 network-first（3 秒逾時、`cache: "no-cache"` 重新驗證）→ 失敗用快取；`/api/*` 與 YouTube 不經快取。

**單一歌曲庫 + 離線**（`static/js/library-sync.js` 純函式、`data.js`、`store.js`）
- 每首歌在 IndexedDB 一筆 record：`server`（最後收到的伺服器版本）+ `local`（本機 offset、翻譯 `{index: {text, tr}}`、打點 `{index: {text, t}}`）+ `pending` + `localUpdatedAt`。顯示時 `mergeSong`；本機翻譯 / 時間只在該行原文仍相同時套用。
- 同步：`/api/library` 的每首歌帶 `updated_at`；`planSync` 算出要抓的（新的 / updated_at 不同）、要刪的（伺服器沒有的）、owner 要推的（pending 且比伺服器新）。啟動、重新連線、建立後、每 2 分鐘同步。
- 編輯：owner 且在線 → PATCH；owner 離線 → 存本機 pending，連回後若比伺服器新就 PATCH，否則丟棄；訪客 → 永遠只存本機，伺服器更新時保留。
- 離線判定：請求失敗、逾時，或 serve 回 502–504 → 離線模式（`body.offline`、上方橫幅），每 20 秒重試 `/api/me`。離線時停用建立、重翻、換影片、刪除、改名；播放、點行、highlight、自動捲動、offset、編輯翻譯、校準、打點都可用（存本機）。
- 訪客 / 離線時影片無法嵌入只在本次換片，不寫回伺服器。

**音量**：工具列有自己的音量滑桿 + 靜音鍵（`player.setVolume` / `mute`，存 settings 的 `volume` / `muted`，每秒跟隨 YouTube 自己控制項的變更）。原因（實測）：新版 YouTube 嵌入播放器的音量是頂部圖示 + 往下展開的直式滑桿；播放器高度 < 約 320px 或寬度 < 約 500px（small mode）時，滑桿會壓到底部進度列，滑鼠往下移到滑桿途中就收起來。觸控裝置隱藏（用實體音量鍵，iOS 也不接受 setVolume）。

**離線提示**：寬螢幕是上方置中的浮動橫幅；< 1000px 改成側邊欄標題列右側的小標籤「離線 · N 首」（點了用 toast 顯示完整說明），不遮影片和歌詞。

**觸控與版面**
- `(pointer: coarse)`：歌詞欄右下角浮動 ⏮ ⏯ ⏭（`#touch-controls`，和「回到目前歌詞」疊在同一個 sticky 容器）；自動捲動的可見區扣掉浮動按鈕（`AutoScroller` 的 `coverBottomEl`）。點擊區加大、輸入框 16px（避免 iOS 放大）、`touch-action: manipulation`。
- 觸控時點翻譯立即跳播（不等雙擊）；長按 550ms 編輯翻譯（移動 >10px 取消，放開後的 click 不跳播）。
- < 1000px（手機、iPad 直向）：三列 grid（側邊欄條 / 控制區最高 48dvh 自己捲動、影片 sticky 置頂並縮小 / 歌詞 1fr），整頁不捲動。觸控裝置寬 < 1200px 時側邊欄預設收合。iOS 主畫面模式用 `viewport-fit=cover` + safe-area padding。
