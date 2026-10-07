# 歌詞播放器（Lyric Player）

本機用的歌詞翻譯播放網站：輸入歌名 → 自動找 YouTube 影片與 LRCLIB 同步歌詞 → 逐行翻成繁體中文 → 存進歌曲庫。開發規格見 `CLAUDE.md`。

## 需求

- WSL（Ubuntu）裡裝好 [uv](https://docs.astral.sh/uv/)：`curl -LsSf https://astral.sh/uv/install.sh | sh`
- 翻譯預設用 Claude 訂閱：WSL 裡要能執行 `claude` 並已登入（或在 `.env` 設 `TRANSLATOR_BACKEND=api` 與 `ANTHROPIC_API_KEY`）
- 第一次：`cp .env.example .env`、`uv sync`

## 啟動

**Windows 一鍵啟動**：雙擊專案根目錄的 `start-lyric-player.bat`。

- 會在背景啟動伺服器，好了之後自動用預設瀏覽器開 http://localhost:8765
- 伺服器已經在跑（另一個視窗或 `./run.sh`）時，只會開瀏覽器，不會重複啟動
- 視窗顯示「伺服器運行中」；**關閉這個視窗伺服器就會停止**

建立桌面捷徑：

1. 在檔案總管網址列輸入 `\\wsl.localhost\Ubuntu\home\<你的帳號>\lyric_player`（或在 WSL 裡執行 `explorer.exe .`）
2. 在 `start-lyric-player.bat` 上按右鍵 →「顯示其他選項」→「傳送到」→「桌面（建立捷徑）」
3. （可選）捷徑按右鍵 → 內容：「變更圖示」換個圖示；「執行」選「最小化」可以讓視窗縮在工作列

**開發用（WSL 內）**：`./run.sh`（有 `--reload`，改程式自動重載）

## 快捷鍵

| 鍵 | 動作 |
|---|---|
| Space | 播放 / 暫停 |
| ← / → | 上一行 / 下一行 |
| [ / ] | 歌詞 offset −/+ 100 ms（停手 1 秒後自動存檔） |
| C | 把目前的歌詞行捲回畫面中央 |
| A | 開關自動捲動 |
| Esc | 關閉面板 |

雙擊翻譯可修改（Enter 存、Esc 取消）；滑到某行時右側 ↻ 可單獨重翻。

## 測試

```bash
uv run pytest                          # 後端
node --test "tests/js/*.test.mjs"      # 前端純函式（WSL 沒裝 node 時可用 Windows 的 node.exe）
```

## 疑難排解

- **YouTube 搜尋壞掉**（yt-dlp 跟不上 YouTube 改版）：`uv lock --upgrade-package yt-dlp && uv sync`
- **翻譯失敗：找不到 claude 指令**：在 WSL 裡安裝 Claude Code 並執行一次 `claude` 登入
- **影片無法嵌入播放**：按「換影片」選別的候選，或貼上其他 YouTube 網址
