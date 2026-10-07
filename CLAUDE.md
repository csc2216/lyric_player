# Lyric Player — 開發規格（給 Claude Code）

本地使用的歌詞翻譯播放網站。輸入歌名 → 自動找 YouTube 影片 + LRCLIB 同步歌詞 → LLM 逐行翻成繁體中文 → 存檔並依歌手分類。播放時每一行歌詞是可點擊的按鈕，點了從該行開始播，當前行 highlight，可選自動捲動，空白鍵播放/暫停。

**主要在本機跑（localhost），單一 owner；其他裝置透過 Tailscale 以訪客身分連入。不需要部署、版權處理。**

## 工作方式（重要）

- 依「里程碑」順序實作，**每完成一個里程碑就停下來**，列出：改了哪些檔案、怎麼手動驗證、已知問題。等我確認再繼續。（M0–M5 已完成，見 `docs/milestones.md`。）
- 不確定的設計決定：照本文件與 `docs/` 做；沒寫到的，選最簡單的做法並在回報中說明。
- **改動某功能前先讀對應的 `docs/*.md`**（見下方索引）；行為改了就同步更新那份文件。CLAUDE.md 只放總覽與跨功能規則。
- 測試 fixture 一律用自己編的假歌詞（例如 `"line one"`, `"第二行"`），不要放真實歌詞。
- 程式碼識別字用英文，UI 文字用繁體中文。

## 細節文件索引

| 文件 | 內容 |
|---|---|
| `docs/running.md` | 開發啟動、Windows 一鍵啟動（`.bat` → `scripts/serve_windows.sh`） |
| `docs/data-format.md` | `library/*.json` schema、slug 規則、原子寫檔 |
| `docs/backend.md` | LRCLIB、LRC 解析 + 段落對齊、YouTube 搜尋打分、翻譯（claude CLI / API）、library |
| `docs/api.md` | 所有 endpoint、`auto_ok` 規則、resolve/build 細節、lock、錯誤碼 |
| `docs/frontend.md` | 三欄版面、歌詞行、同步 / highlight、自動捲動、鍵盤快捷鍵、播放器錯誤自動換片 |
| `docs/calibration-and-tapping.md` | offset 預設值、校準模式狀態機、手動打點模式 |
| `docs/mobile-guests-offline.md` | Tailscale 身分 / 訪客權限、PWA / service worker、IndexedDB 離線同步、音量、觸控版面 |
| `docs/milestones.md` | M0–M5 範圍與驗收 |

## 技術棧

uv、FastAPI + uvicorn（同時 serve API 與靜態前端）、yt-dlp（YouTube 搜尋，不用 API key）、LRCLIB API（同步歌詞）、翻譯用 `claude -p` CLI（預設，走訂閱）或 `anthropic` SDK、httpx、磁碟 JSON 儲存、原生 HTML + CSS + ES modules（**無 build step**）、YouTube IFrame Player API、pytest + `node --test`。

設定放 `.env`（附 `.env.example`；`.env` 和 `library/` 不進 git）：

```
TRANSLATOR_BACKEND=claude_cli   # 或 api
CLAUDE_CLI_PATH=claude          # 找不到 claude 時填完整路徑
ANTHROPIC_API_KEY=               # 只有 api 後端需要
TRANSLATE_MODEL=claude-sonnet-5-5
LIBRARY_DIR=./library
PORT=8765
```

（訪客相關設定 `OWNER_LOGIN`、`GUEST_PIN`、`GUEST_DAILY_BUILDS`、`DATA_DIR` 見 `docs/mobile-guests-offline.md`。）

## 專案結構

```
app/
  main.py, config.py, models.py, auth.py   # auth = owner / 訪客判定
  api/routes.py                            # 只做轉接，流程在 pipeline
  services/  lrclib, lrc_parser, youtube, translator, library, pipeline, text
static/
  index.html, style.css, manifest.json, sw.js, icons/
  js/  main, api, data, store, library-sync, library, create, player, lyrics,
       sync, scroll, keyboard, settings, songbar, ui, util,
       calibration (純函式) / calibrator (effects), tapping (純函式) / tapper (UI)
tests/       pytest（test_*.py、fixtures/）+ js/*.test.mjs
scripts/     try_pipeline.py, serve_windows.sh, tailscale_serve.sh, make_icons.py
docs/        各功能細節
library/     使用者資料（gitignore）：<artist_slug>/<title_slug>.json
```

## 指令

- 開發：`./run.sh`（= `uv run uvicorn app.main:app --port 8765 --reload --no-proxy-headers`），開 `http://localhost:8765`（IFrame API 需要 http origin，不能 file://）。
- 後端測試：`uv run pytest`
- 前端純函式測試：`node --test "tests/js/*.test.mjs"`（Node 22 的 `--test` 不吃資料夾，要給 glob；WSL 上沒裝 node 時可用 Windows 的 `node.exe`）。

## 跨功能規則（容易踩到的）

- uvicorn **必須** `--no-proxy-headers`，且只聽 127.0.0.1；不可改成信任 100.x 網段（理由見 `docs/mobile-guests-offline.md`）。
- 新增 `static/js/*.js` 要加進 `static/sw.js` 的 `SHELL` 清單（`tests/test_pwa.py` 會檢查）。
- 時間 / 狀態機邏輯寫成純函式（`sync.js`、`calibration.js`、`tapping.js`、`library-sync.js`、`util.js`），DOM / 播放器副作用放另一個模組，純函式要有 `tests/js/` 測試。
- 歌詞行用 `<div role="button" tabindex="-1">`，**不要用 `<button>`**（空白鍵會觸發 click）。
- 所有 route 用一般 `def`（底層全同步）；錯誤 body 一律 `{"detail": "中文訊息"}`（訪客相關錯誤另帶 `code`）。
- 寫 library 檔用「先寫暫存檔再 rename」。
- 改翻譯 prompt 時 `prompt_version` +1。
- 前後端各有一份的規則要一起改（例如 `pipeline.default_offset_ms` ↔ `util.js estimateOffsetMs`）。

## 其他注意

- LRCLIB / yt-dlp / 翻譯（claude CLI 或 Anthropic API）呼叫都要有 timeout 和清楚的錯誤訊息回到前端。未預期的例外由 `main.py` 的 catch-all handler 轉成 500 + 中文 `detail`（traceback 只寫伺服器 log）。
- `claude` 找不到時（例如 .bat 啟動的非互動 shell 沒有 nvm/npm 的 PATH），用 `.env` 的 `CLAUDE_CLI_PATH` 指定完整路徑。
- yt-dlp 偶爾會因 YouTube 改版壞掉：README 註明 `uv lock --upgrade-package yt-dlp`。
- 不要把 API key 傳到前端。
