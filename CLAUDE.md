# Lyric Player — 開發規格（給 Claude Code）

本地使用的歌詞翻譯播放網站。輸入歌名 → 自動找 YouTube 影片 + LRCLIB 同步歌詞 → LLM 逐行翻成繁體中文 → 存檔並依歌手分類。播放時每一行歌詞是可點擊的按鈕，點了從該行開始播，當前行 highlight，可選自動捲動，空白鍵播放/暫停。

**只在本機跑（localhost），單一使用者，不需要登入、部署、版權處理。**

## 工作方式（重要）

- 依「里程碑」順序實作，**每完成一個里程碑就停下來**，列出：改了哪些檔案、怎麼手動驗證、已知問題。等我確認再繼續。
- 不確定的設計決定：照本文件做；本文件沒寫到的，選最簡單的做法並在回報中說明。
- 測試 fixture 一律用自己編的假歌詞（例如 `"line one"`, `"第二行"`），不要放真實歌詞。
- 程式碼識別字用英文，UI 文字用繁體中文。

## 技術棧

| 部分 | 選擇 | 理由 |
|---|---|---|
| Python 環境 | `uv` | 快、乾淨 |
| 後端 | FastAPI + uvicorn | 同時 serve API 和靜態前端 |
| YouTube 搜尋 | `yt-dlp`（`ytsearchN:` + `extract_flat`） | 不需要 API key、沒有配額 |
| 歌詞 | LRCLIB API（`https://lrclib.net/api`） | 免費、有時間戳 |
| 翻譯 | `claude -p` CLI（預設，走 Claude 訂閱）或 `anthropic` Python SDK（API key） | 使用者沒有 API key |
| HTTP client | `httpx` | |
| 儲存 | 磁碟上的 JSON 檔，依歌手分資料夾 | 人類可讀、可用 git 版控 |
| 前端 | 原生 HTML + CSS + ES modules，**無 build step** | 簡單、好改 |
| 播放器 | YouTube IFrame Player API | |
| 測試 | pytest | |

設定放 `.env`（用 `python-dotenv` 或 pydantic-settings 讀）：

```
TRANSLATOR_BACKEND=claude_cli   # 或 api
CLAUDE_CLI_PATH=claude          # 找不到 claude 時填完整路徑
ANTHROPIC_API_KEY=               # 只有 api 後端需要
TRANSLATE_MODEL=claude-sonnet-5-5
LIBRARY_DIR=./library
PORT=8765
```

`.env` 和 `library/` 以外的東西進 git；附 `.env.example`。

## 專案結構

```
lyric-player/
├── CLAUDE.md
├── pyproject.toml
├── .env.example
├── app/
│   ├── main.py            # FastAPI app，掛 /api 和 static
│   ├── config.py
│   ├── models.py          # Pydantic schemas
│   ├── services/
│   │   ├── lrclib.py      # LRCLIB client
│   │   ├── lrc_parser.py  # LRC 解析 + 段落對齊
│   │   ├── youtube.py     # yt-dlp 搜尋 + 打分
│   │   ├── translator.py  # LLM 翻譯
│   │   ├── library.py     # 讀寫 JSON、建 tree
│   │   ├── pipeline.py    # resolve / build / patch / retranslate 流程（routes 只做轉接）
│   │   └── text.py        # 共用文字正規化、相似度
│   └── api/
│       └── routes.py
├── static/
│   ├── index.html
│   ├── style.css
│   └── js/
│       ├── main.js
│       ├── api.js
│       ├── library.js     # 側邊欄 tree
│       ├── player.js      # YT IFrame 包裝
│       ├── lyrics.js      # 歌詞渲染、highlight、捲動
│       └── keyboard.js
├── tests/
│   ├── fixtures/          # 假的 LRC / LRCLIB 回應
│   ├── test_lrc_parser.py
│   ├── test_youtube_scoring.py
│   └── test_library.py
└── library/               # 使用者資料（gitignore）
    └── <artist_slug>/
        └── <title_slug>.json
```

測試：後端 `uv run pytest`；前端純函式 `node --test "tests/js/*.test.mjs"`（Node 22 的 `--test` 不吃資料夾，要給 glob；WSL 上沒裝 node 時可用 Windows 的 `node.exe`）。

啟動：
- 開發（WSL 內）：`./run.sh`（= `uv run uvicorn app.main:app --port 8765 --reload --no-proxy-headers`；`--no-proxy-headers` 必要，見「行動裝置與訪客」），瀏覽器開 `http://localhost:8765`。
- 一鍵啟動（Windows）：雙擊專案根目錄的 `start-lyric-player.bat`（可建桌面捷徑，見 README）。它透過 `wsl.exe --cd` 執行 `scripts/serve_windows.sh`：背景啟動 `uvicorn --host 127.0.0.1 --port 8765 --no-proxy-headers`（不 reload；只聽 127.0.0.1：Windows 靠 WSL localhost 轉發、其他裝置靠 tailscale serve，不需要也不該開放其他介面）→ 等 `/api/library` 有回應 → 用預設瀏覽器開網頁；8765 已有伺服器在跑時只開瀏覽器；關閉視窗（wsl.exe 結束 → SIGHUP / stdin EOF）時伺服器跟著停。wsl.exe 是非 login shell，不會讀 `~/.profile`，所以腳本自己把 `~/.local/bin` 加進 PATH 找 `uv`。`LYRIC_PLAYER_PORT` 環境變數可改 port；參數 `--no-browser` 不開瀏覽器（測試用）。
（IFrame API 必須在 http origin 下跑，不能用 file://。）

## 資料格式

`library/<artist_slug>/<title_slug>.json`：

```json
{
  "schema_version": 1,
  "artist": "原始歌手名（顯示用）",
  "title": "原始歌名（顯示用）",
  "album": "專輯名或 null",
  "created_at": "ISO8601",
  "updated_at": "ISO8601",
  "youtube": {
    "video_id": "xxxxxxxxxxx",
    "title": "影片標題",
    "channel": "頻道名",
    "duration": 215.0,
    "alternatives": [ { "video_id": "...", "title": "...", "channel": "...", "duration": 230.0 } ]
  },
  "lrclib": { "id": 123456, "duration": 214.0 },
  "synced": true,
  "offset_ms": 0,
  "lines": [
    { "t": 12.34, "text": "原文", "tr": "翻譯", "break_before": false }
  ],
  "translator": { "model": "claude-sonnet-5-5", "prompt_version": 1 }
}
```

- `t`：該行開始時間（秒，float），沒有同步歌詞時為 `null`。
- `break_before`：這行之前要空一行（段落分隔），用來做出分段排版。
- 只存有文字的行；空行用 `break_before` 表示。
- slug：保留韓文/中文/日文字元，去掉檔名不合法字元 `/\:*?"<>|`，空白轉 `-`，全部小寫英文。原名存在 JSON 裡，slug 只用於檔名。
- 寫檔用「先寫暫存檔再 rename」，避免寫到一半壞檔。

## 後端流程

### 1. LRCLIB（`services/lrclib.py`）

- `GET /api/search?q=<query>` 或 `?track_name=&artist_name=`，回傳陣列，欄位：`id, trackName, artistName, albumName, duration, instrumental, plainLyrics, syncedLyrics`。
- 加 `User-Agent: lyric-player/0.1 (local personal use)`（LRCLIB 要求）。
- 使用者輸入支援 `歌手 - 歌名` 或自由文字。有 ` - ` 就拆成 artist/track 查，否則用 `q`。
- 候選排序：有 `syncedLyrics` 優先 → 標題/歌手字串相似度 → 排除 `instrumental: true`。

### 2. LRC 解析（`services/lrc_parser.py`）— 要有完整單元測試

- 支援 `[mm:ss]`、`[mm:ss.xx]`、`[mm:ss.xxx]`。
- 一行多個時間戳 `[00:12.00][01:30.00]text` → 展開成多行。
- metadata tag（`[ar:]`, `[ti:]`, `[al:]`, `[by:]`, `[length:]`）忽略；`[offset:+/-ms]` 要套用到所有時間。
- 結果依時間排序。
- 只有時間戳沒有文字的行 = 間奏標記，不輸出成行，但讓下一行 `break_before = true`。
- **段落對齊**：LRCLIB 的 `syncedLyrics` 通常沒有空行，但 `plainLyrics` 有。若兩者都有，把 plain 的非空行和 synced 的行用正規化文字（去空白、標點、小寫）依序對齊，plain 裡出現空行的位置 → 對應 synced 行標 `break_before`。對齊失敗（行數差太多）時退回規則：與前一行間隔 > 4 秒就斷段。
- 只有 `plainLyrics`：`t = null`，`synced = false`，段落照 plain 的空行。

### 3. YouTube（`services/youtube.py`）

- `yt_dlp.YoutubeDL({"quiet": True, "extract_flat": True, "skip_download": True})`，`extract_info(f"ytsearch8:{artist} {title}", download=False)`。
- 打分（寫成純函式方便測試）：
  - 與 LRCLIB duration 差距：±3 秒內大加分，差越多扣越多（**時間軸能不能對上主要看這個**）。
  - 標題含歌名、頻道含歌手或為 `- Topic` 頻道 / 官方頻道：加分。
  - 標題含 `cover`、`dance practice`、`live`、`lyrics`、`sped up`、`reaction`：扣分。
- 設定項 `video_preference`: `"sync"`（預設，選時長最接近的，常常是 audio / Topic 版）或 `"mv"`（偏好 MV，時間可能需要 offset 調整）。
- 先用 LRCLIB 的歌手/歌名搜尋；若最佳影片與 LRCLIB duration 差超過 5 秒（或沒結果），再用使用者原始輸入搜一次，兩次結果合併（依 video id 去重）後重新打分，取最高者。
- 前 5 名存到 `alternatives`，UI 可以換影片。

### 4. 翻譯（`services/translator.py`）

- 兩種後端，由 `TRANSLATOR_BACKEND` 切換，介面都是 `complete(system, user) -> str`；去重、驗證、重試邏輯共用：
  - `claude_cli`（預設）：subprocess 呼叫 `claude -p --output-format json --model <TRANSLATE_MODEL> --system-prompt <prompt> --tools "" --no-session-persistence --strict-mcp-config --setting-sources ""`，user message 走 stdin，取回應 JSON 的 `result`。timeout 120 秒；子程序環境變數移除 `ANTHROPIC_API_KEY`（確保走訂閱額度）；cwd 用空的暫存目錄（避免讀到 CLAUDE.md）；不可用 `--bare`（它不讀 OAuth 登入）。找不到 `claude` 指令、逾時、`is_error: true` 都轉成清楚的錯誤訊息。
  - `api`：`anthropic` SDK，需要 `ANTHROPIC_API_KEY`。
- 去重：重複的行（副歌）只翻一次，保證一致又省錢。
- 送給模型：完整歌詞（給上下文）+ 帶 id 的去重行清單。
- 要求回傳純 JSON：`{"translations": [{"id": 0, "tr": "..."}]}`。
- System prompt 要點：
  - 翻成**台灣慣用的繁體中文**，自然口語、像歌詞，不要逐字直譯。
  - 英文句子也要翻；純擬聲/無意義的 ad-lib（ooh, la la, yeah）保留原樣或極簡。
  - 每個 id 都必須有對應翻譯，不可合併或拆分行。
  - 只輸出 JSON，不要 markdown fence。
- 解析時剝掉可能出現的 ``` fence；驗證每個 id 都在。缺漏 → 只針對缺的 id 重試一次；仍失敗則該行 `tr` 留空並在回應中回報。
- `prompt_version` 常數，改 prompt 時 +1。

### 5. Library（`services/library.py`）

- `list_tree()` → `[{artist, artist_slug, songs: [{title, title_slug, synced}]}]`，歌手和歌曲都依名稱排序。
- `get_song`, `save_song`, `delete_song`, `move_song`（改歌手名時搬資料夾，空資料夾刪掉）。
- 存檔前檢查同名歌曲已存在 → 回傳既有的，不重做（除非 `force=true`）。

## API

| Method | Path | 說明 |
|---|---|---|
| GET | `/api/library` | tree |
| GET | `/api/songs/{artist_slug}/{title_slug}` | 單首完整資料 |
| POST | `/api/resolve` | body `{query}` → 回傳 LRCLIB 候選 + 每個候選的最佳 YT 影片 + `auto_ok`（布林） |
| POST | `/api/build` | body `{lrclib_id, video_id, force?}` → 翻譯、存檔、回傳 song |
| PATCH | `/api/songs/{a}/{t}` | 改 `offset_ms`、`youtube.video_id`、單行 `tr`、`artist`、`title`、`lines[*].t` |
| POST | `/api/songs/{a}/{t}/retranslate` | body `{line_indices?}`，不給就全部重翻 |
| DELETE | `/api/songs/{a}/{t}` | 刪除 |

`auto_ok = true` 的條件：第一名 LRCLIB 候選有 synced 歌詞、且明顯領先第二名、且最佳影片時長差 ≤ 3 秒。

實作細節（M2）：
- LRCLIB 常有同一首歌的多筆重複上傳（同分但 duration 不同）。「同分」= 分數差 ≤ 0.02 且歌名/歌手相似度 ≥ 0.85（同一首歌）；在同分群組中選「最佳 YouTube 影片分數最高」的那筆（即時長最吻合）。
- 「明顯領先」只跟**不同歌**比（同一首歌的其他版本不算對手），領先 ≥ 0.1；結果裡全是同一首歌時視為領先。
- `/resolve` 回傳 `{query, auto_ok, reason, checks, candidates}`；`candidates[0]` 是選中的，每個候選帶 `video`（最佳影片 + `duration_diff`）、`preview`（前 3 行）、`line_count`。`reason` 是給人看的除錯字串（例如 `auto: all 8 results are the same song; tie broken by duration (5 tied, picked 253s); video +0.7s`），`checks` 是結構化版本。
- resolve 的影片排名暫存在記憶體（依 lrclib_id），`/build` 用它補影片資訊與 alternatives；沒命中（例如 server 重啟過）就重搜。
- 歌曲相關 endpoint（GET/PATCH/build/retranslate）都回傳 `{artist_slug, title_slug, song, created?, missing_translations}`，改名後前端用回傳的新 slug。
- 所有 route 都是一般 `def`（FastAPI 丟 threadpool），因為底層 httpx / yt-dlp / `claude -p` / 檔案 IO 全是同步的。
- 同一首歌的 build / patch / retranslate 用 per-song lock 串行化；build 時若等過別人的鎖且歌已存在，直接回傳既有結果（即使 `force=true`），連按兩次不會翻兩次。
- 錯誤對應：找不到 404、同名衝突 409、參數錯誤 400、LRCLIB / YouTube / 翻譯失敗 502，body 皆為 `{"detail": "中文訊息"}`。
前端在 `auto_ok` 時直接呼叫 `/build`（全自動）；否則顯示候選讓我選。

## 前端

### 版面

CSS grid 三欄（不用 JS 算寬高）：

- 左：歌曲庫 tree（歌手可展開/收合，上方有過濾搜尋框），點歌曲載入。標題列有 « 收合按鈕；收合後縮成約 40px 細條只剩 »。動畫約 150ms（`grid-template-columns` transition），狀態存 localStorage（`sidebarCollapsed`），快捷鍵 B。
- 中：固定寬約 440px（側邊欄收合時約 520px），由上而下：輸入框＋建立按鈕＋⚙ 設定（右上角）、狀態訊息、影片、歌名資訊列、功能按鈕列（可換行）、自動 offset 提示、校準面板、換影片 / 編輯資訊面板。內容超出時中間欄自己捲動。
- 右：歌詞欄，佔滿視窗高度、獨立捲動；歌詞內容最大寬約 720px（同一行排版約 920px），在欄內置中偏左（左側留白 = 剩餘寬度的 1/3）。建立流程的候選清單、歡迎訊息也顯示在這欄。
- 自動捲動、C、「回到目前歌詞」浮動按鈕都以歌詞欄為捲動容器；浮動按鈕在歌詞欄右下角。
- 「放大影片」：影片暫時以 `position: fixed` 蓋住中＋右欄（不搬動 iframe，避免重新載入），再按一次、右上「還原」或 Esc 還原。Esc 一次只處理一件事：先還原影片，再取消校準 / 關面板。
- 視窗寬 < 1000px：上下堆疊（側邊欄 → 影片區 → 歌詞），側邊欄預設收合，歌詞欄維持獨立捲動（高 75vh）。
- 設定 popover：自動捲動開關、排版模式（原文翻譯同一行 / 上下兩行）、主題（跟隨系統 / 淺色 / 深色）、點行提早秒數。設定存 `localStorage`。

### 歌詞行

- 每一行（原文 + 翻譯）整塊是一個可點擊元素：用 `<div role="button" tabindex="-1">`，**不要用 `<button>`**（避免 focus 後空白鍵觸發 click）。
- 點擊：`player.seekTo(max(0, t + offset_ms/1000 - PREROLL), true)` 然後 `playVideo()`。`PREROLL = 0.15` 秒（常數，設定可調）。
- `t == null` 的行不可點、樣式變淡。
- 翻譯文字用次要顏色；`break_before` 的行上方加間距。
- 翻譯可雙擊編輯（contenteditable），Enter 儲存（PATCH），Esc 取消。

### 同步 / highlight

- 播放中用 `requestAnimationFrame` 迴圈（節流到約 50ms）讀 `getCurrentTime()`；暫停時停止迴圈。
- 找目前行：最後一個 `t + offset ≤ now` 的行（二分搜尋）。只在 index 改變時更新 DOM class。
- 時間相關純函式放 `static/js/sync.js`（`buildTimeline`、`findCurrentIndex`、`seekTarget`、`applyHold`），測試在 `tests/js/`。點行後先 seek 到 `t - PREROLL`，這 0.15 秒內用 hold 讓被點的行維持 highlight，避免閃回上一行。
- 自動捲動（可關）：目前行不在視窗中間 40% 區域時 `scrollIntoView({block: "center", behavior: "smooth"})`。使用者手動捲動（wheel / touchmove / 拖捲軸）後暫停自動捲動 3 秒。

### 鍵盤

| 鍵 | 動作 |
|---|---|
| Space | 播放 / 暫停 |
| ← / → | 跳到上一行 / 下一行開頭 |
| A | 切換自動捲動 |
| [ / ] | offset −/+ 100ms（顯示目前值，停止按 1 秒後 PATCH 存檔） |
| Shift+[ / Shift+] | offset −/+ 1 秒（同上） |
| Shift+S | 進入 / 離開校準模式 |
| S | 校準模式中：第一下開始播放、第二下記錄時間；確認階段 = 重來。打點模式中 = 記錄這一行 |
| Enter | 校準確認階段：確定並存檔。打點模式中 = 記錄這一行 |
| Backspace | 打點模式中：退回上一行重打 |
| C | 把目前播放的那行捲到畫面中央（不論自動捲動是否開啟） |
| B | 收合 / 展開左側歌曲庫 |
| Esc | 依序：還原放大的影片 → 取消打點（不存）/ 校準（恢復原 offset）→ 關閉設定 / 換影片 / 編輯資訊面板 |

- 「回到目前歌詞」浮動按鈕：目前行完全不在可見範圍（含被 sticky 影片蓋住）時，顯示在歌詞區右下角；點了效果同 C，回到畫面內後自動消失。

- `keydown` 監聽在 `document`；焦點在 input / textarea / contenteditable 時不處理。
- 處理到的鍵要 `preventDefault()`（避免空白鍵捲動頁面）。
- 已知限制：焦點在 YouTube iframe 內時事件不會傳到父頁面（YouTube 自己也會處理空白鍵，所以行為一致）。播放器載入時設 `playerVars: { disablekb: 0, rel: 0, modestbranding: 1 }`。

### 播放器錯誤

- `onError` 收到 101 / 150（禁止嵌入）或 100（影片不存在）→ 自動換 `alternatives` 下一個，並 PATCH 存回；全部失敗則顯示錯誤和「換影片」選單。
  - 實作（M5）：本次載入歌曲期間試過的 video id 記在 `triedVideos`（換歌時清空），`util.js pickNextVideo` 挑第一個沒試過的 alternative；PATCH 後舊影片會進 alternatives 開頭，靠 `triedVideos` 避免繞回來。其他錯誤碼（2、5）只顯示訊息。

## Offset 預設值與校準模式（M4.1）

- 建立歌曲時：影片時長比 LRCLIB 時長長 ≥ 1 秒 → `offset_ms` = 時長差（毫秒），並存 `auto_offset_ms` 記錄自動設定的值；影片較短或差 < 1 秒 → 0、`auto_offset_ms = null`。換影片不會自動改 offset。前後端規則各一份：`pipeline.default_offset_ms`、`util.js estimateOffsetMs`。
- `offset_ms == auto_offset_ms` 時，歌曲畫面顯示「已依時長差自動設定 offset +N 秒，不準可用校準修正」；改過 offset 後提示消失。
- 校準模式（toolbar「校準時間」或 Shift+S）：
  - 目標預設為第二個有時間戳的行；校準中點其他行改選目標（不跳播）。
  - 第一下 S：從 `max(0, t + offset − 8 秒)` 播放；第二下 S：新 offset = `round((getCurrentTime() − t) × 1000)`。
  - 確認階段：顯示舊值 / 新值 / 差值，套用新 offset 從目標行前 3 秒重播。Enter / 確定 → 存檔離開；S / 重來 → 回到等第一下 S（下次從新估計值前 8 秒開始）；Esc / 取消 → 恢復原 offset 離開。
  - 「依時長差估計」按鈕：用同一規則算出 offset，直接套用並存檔（適合已存在的舊歌）。
  - 校準中停用點行跳播、←/→、[ ]、雙擊編輯；空白鍵照常。
  - 狀態機 idle → armed → listening → confirming 是純函式 `static/js/calibration.js`（effects 交給 `calibrator.js` 執行），測試在 `tests/js/calibration.test.mjs`。

## 沒有同步歌詞時：手動打點模式

- `synced = false` 的歌顯示「打點同步」按鈕。
- 進入模式：從頭播放，第一行高亮為「下一個要打點的行」，每按一次 `Enter`（或 `S`）把目前時間記為該行的 `t` 並前進一行；`Backspace` 退回上一行重打。
- 完成後 PATCH 存 `lines[*].t`、`synced = true`。
- 實作（M5）：「打點同步」按鈕只在 `synced = false` 時出現（「校準時間」只在 synced 時出現）。狀態機是純函式 `static/js/tapping.js`（測試 `tests/js/m5.test.mjs`），UI 在 `tapper.js`，面板在中間欄。
  - 每一下必須晚於上一下，否則拒收並提示。`Backspace` 退回上一行，並從「上上一下的時間 − 1 秒」重播；在第一行時從頭播。
  - 存的 `t` = 播放器時間 − `offset_ms`，取到 0.01 秒；打完最後一行自動存檔。`Esc` / 取消 = 不存。
  - 打點中停用點行跳播、←/→、[ ]、編輯翻譯；空白鍵照常。

## 行動裝置與訪客（Tailscale、PWA、離線）

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

**觸控與版面**
- `(pointer: coarse)`：歌詞欄右下角浮動 ⏮ ⏯ ⏭（`#touch-controls`，和「回到目前歌詞」疊在同一個 sticky 容器）；自動捲動的可見區扣掉浮動按鈕（`AutoScroller` 的 `coverBottomEl`）。點擊區加大、輸入框 16px（避免 iOS 放大）、`touch-action: manipulation`。
- 觸控時點翻譯立即跳播（不等雙擊）；長按 550ms 編輯翻譯（移動 >10px 取消，放開後的 click 不跳播）。
- < 1000px（手機、iPad 直向）：三列 grid（側邊欄條 / 控制區最高 48dvh 自己捲動、影片 sticky 置頂並縮小 / 歌詞 1fr），整頁不捲動。觸控裝置寬 < 1200px 時側邊欄預設收合。iOS 主畫面模式用 `viewport-fit=cover` + safe-area padding。

## 里程碑

**M0 骨架**：uv 專案、依賴、`.env.example`、FastAPI serve 一個 hello 頁面、`/api/library` 回空陣列。
驗收：`uv run uvicorn ...` 起得來，瀏覽器看得到頁面。

**M1 後端服務 + 測試**：`lrc_parser`（含段落對齊）、`youtube` 打分函式、`library` 讀寫與 slug、`lrclib` client、`translator`。
驗收：`uv run pytest` 全過；另附一個 `scripts/try_pipeline.py "歌手 - 歌名"`，在終端機印出 LRCLIB 候選、選到的影片、前 5 行翻譯結果（不存檔）。

**M2 API**：所有 routes。
驗收：用 `/docs`（Swagger）手動跑 resolve → build，`library/` 下出現正確的 JSON。

**M3 前端核心**：tree、輸入建立流程（含全自動與候選選擇）、播放器、點行跳播、highlight、空白鍵。
驗收：建立一首歌 → 點任一行從該行開始播 → highlight 跟著走。

**M4 互動完善**：自動捲動開關、offset 調整、←/→、編輯翻譯、重翻、換影片、刪除、排版模式、深色模式。

**M5 補強**：嵌入失敗自動換片、手動打點模式、錯誤訊息、README。

## 其他注意

- LRCLIB / yt-dlp / 翻譯（claude CLI 或 Anthropic API）呼叫都要有 timeout 和清楚的錯誤訊息回到前端。未預期的例外由 `main.py` 的 catch-all handler 轉成 500 + 中文 `detail`（traceback 只寫伺服器 log）。
- `claude` 找不到時（例如 .bat 啟動的非互動 shell 沒有 nvm/npm 的 PATH），用 `.env` 的 `CLAUDE_CLI_PATH` 指定完整路徑。
- yt-dlp 偶爾會因 YouTube 改版壞掉：README 註明 `uv lock --upgrade-package yt-dlp`。
- 不要把 API key 傳到前端。