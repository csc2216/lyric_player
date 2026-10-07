# 里程碑（M0–M5 已完成）

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
