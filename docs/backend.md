# 後端流程（services/）

## 1. LRCLIB（`services/lrclib.py`）

- `GET /api/search?q=<query>` 或 `?track_name=&artist_name=`，回傳陣列，欄位：`id, trackName, artistName, albumName, duration, instrumental, plainLyrics, syncedLyrics`。
- 加 `User-Agent: lyric-player/0.1 (local personal use)`（LRCLIB 要求）。
- 使用者輸入支援 `歌手 - 歌名` 或自由文字。有 ` - ` 就拆成 artist/track 查，否則用 `q`。
- 候選排序：有 `syncedLyrics` 優先 → 非羅馬拼音 → 時長資料合理 → 標題/歌手字串相似度；排除 `instrumental: true`。
- 羅馬拼音版（`romanized`）：歌詞非拉丁字母比例 ≤ 5%，**且**同一首歌（`same_name` 比對歌名與歌手）另有一筆 ≥ 30% 的上傳（韓文 / 日文 / 中文）。相對判定，所以英文歌不受影響。LRCLIB 常有和原文時間戳完全相同的拼音版上傳。

## 2. LRC 解析（`services/lrc_parser.py`）— 要有完整單元測試

- 支援 `[mm:ss]`、`[mm:ss.xx]`、`[mm:ss.xxx]`。
- 一行多個時間戳 `[00:12.00][01:30.00]text` → 展開成多行。
- metadata tag（`[ar:]`, `[ti:]`, `[al:]`, `[by:]`, `[length:]`）忽略；`[offset:+/-ms]` 要套用到所有時間。
- 結果依時間排序。
- 只有時間戳沒有文字的行 = 間奏標記，不輸出成行，但讓下一行 `break_before = true`。
- **段落對齊**：LRCLIB 的 `syncedLyrics` 通常沒有空行，但 `plainLyrics` 有。若兩者都有，把 plain 的非空行和 synced 的行用正規化文字（去空白、標點、小寫）依序對齊，plain 裡出現空行的位置 → 對應 synced 行標 `break_before`。對齊失敗（行數差太多）時退回規則：與前一行間隔 > 4 秒就斷段。
- 只有 `plainLyrics`：`t = null`，`synced = false`，段落照 plain 的空行。

## 3. YouTube（`services/youtube.py`）

- `yt_dlp.YoutubeDL({"quiet": True, "extract_flat": True, "skip_download": True})`，`extract_info(f"ytsearch8:{artist} {title}", download=False)`。
- 打分（寫成純函式方便測試）：
  - 與 LRCLIB duration 差距：±3 秒內大加分，差越多扣越多（**時間軸能不能對上主要看這個**）。
  - 標題含歌名、頻道含歌手或為 `- Topic` 頻道 / 官方頻道：加分。
  - 標題含 `cover`、`dance practice`、`live`、`lyrics`、`sped up`、`reaction`：扣分。
- 設定項 `video_preference`: `"sync"`（預設，選時長最接近的，常常是 audio / Topic 版）或 `"mv"`（偏好 MV，時間可能需要 offset 調整）。
- 先用 LRCLIB 的歌手/歌名搜尋；若最佳影片與 LRCLIB duration 差超過 5 秒（或沒結果），再用使用者原始輸入搜一次，兩次結果合併（依 video id 去重）後重新打分，取最高者。
- 前 5 名存到 `alternatives`，UI 可以換影片。

## 4. 翻譯（`services/translator.py`）

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

## 5. Library（`services/library.py`）

- `list_tree()` → `[{artist, artist_slug, songs: [{title, title_slug, synced}]}]`，歌手和歌曲都依名稱排序。
- `get_song`, `save_song`, `delete_song`, `move_song`（改歌手名時搬資料夾，空資料夾刪掉）。
- 存檔前檢查同名歌曲已存在 → 回傳既有的，不重做（除非 `force=true`）。
