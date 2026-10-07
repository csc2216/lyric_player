# API

| Method | Path | 說明 |
|---|---|---|
| GET | `/api/library` | tree |
| GET | `/api/songs/{artist_slug}/{title_slug}` | 單首完整資料 |
| POST | `/api/resolve` | body `{query}` → 回傳 LRCLIB 候選 + 每個候選的最佳 YT 影片 + `auto_ok`（布林） |
| POST | `/api/build` | body `{lrclib_id, video_id, force?}` → 翻譯、存檔、回傳 song |
| PATCH | `/api/songs/{a}/{t}` | 改 `offset_ms`、`youtube.video_id`、單行 `tr`、`artist`、`title`、`lines[*].t` |
| POST | `/api/songs/{a}/{t}/retranslate` | body `{line_indices?}`，不給就全部重翻 |
| DELETE | `/api/songs/{a}/{t}` | 刪除 |

`auto_ok = true` 的條件：第一名 LRCLIB 候選有 synced 歌詞、不是羅馬拼音版、且明顯領先第二名、且最佳影片時長差 ≤ 3 秒。

實作細節（M2）：
- LRCLIB 常有同一首歌的多筆重複上傳（同分但 duration 不同）。同分群組只含 synced / romanized / duration_ok 都和第一名相同的候選，所以拼音版不會靠時長搶到第一。「同分」= 分數差 ≤ 0.02 且歌名/歌手相似度 ≥ 0.85（同一首歌）；在同分群組中選「最佳 YouTube 影片分數最高」的那筆（即時長最吻合）。
- 「明顯領先」只跟**不同歌**比（同一首歌的其他版本不算對手），領先 ≥ 0.1；結果裡全是同一首歌時視為領先。
- `/resolve` 回傳 `{query, auto_ok, reason, checks, candidates}`；`candidates[0]` 是選中的，每個候選帶 `video`（最佳影片 + `duration_diff`）、`preview`（前 3 行）、`line_count`。`reason` 是給人看的除錯字串（例如 `auto: all 8 results are the same song; tie broken by duration (5 tied, picked 253s); video +0.7s`），`checks` 是結構化版本。
- resolve 的影片排名暫存在記憶體（依 lrclib_id），`/build` 用它補影片資訊與 alternatives；沒命中（例如 server 重啟過）就重搜。
- 歌曲相關 endpoint（GET/PATCH/build/retranslate）都回傳 `{artist_slug, title_slug, song, created?, missing_translations}`，改名後前端用回傳的新 slug。
- 所有 route 都是一般 `def`（FastAPI 丟 threadpool），因為底層 httpx / yt-dlp / `claude -p` / 檔案 IO 全是同步的。
- 同一首歌的 build / patch / retranslate 用 per-song lock 串行化；build 時若等過別人的鎖且歌已存在，直接回傳既有結果（即使 `force=true`），連按兩次不會翻兩次。
- 錯誤對應：找不到 404、同名衝突 409、參數錯誤 400、LRCLIB / YouTube / 翻譯失敗 502，body 皆為 `{"detail": "中文訊息"}`。
前端在 `auto_ok` 時直接呼叫 `/build`（全自動）；否則顯示候選讓我選。
