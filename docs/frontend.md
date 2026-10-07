# 前端（版面、歌詞行、同步、鍵盤、播放器錯誤）

## 版面

CSS grid 三欄（不用 JS 算寬高）：

- 左：歌曲庫 tree（歌手可展開/收合，上方有過濾搜尋框），點歌曲載入。標題列有 « 收合按鈕；收合後縮成約 40px 細條只剩 »。動畫約 150ms（`grid-template-columns` transition），狀態存 localStorage（`sidebarCollapsed`），快捷鍵 B。
- 中：固定寬約 440px（側邊欄收合時約 520px），由上而下：輸入框＋建立按鈕＋⚙ 設定（右上角）、狀態訊息、影片、歌名資訊列、功能按鈕列（可換行）、自動 offset 提示、校準面板、換影片 / 編輯資訊面板。內容超出時中間欄自己捲動。
- 右：歌詞欄，佔滿視窗高度、獨立捲動；歌詞內容最大寬約 720px（同一行排版約 920px），在欄內置中偏左（左側留白 = 剩餘寬度的 1/3）。建立流程的候選清單、歡迎訊息也顯示在這欄。
- 自動捲動、C、「回到目前歌詞」浮動按鈕都以歌詞欄為捲動容器；浮動按鈕在歌詞欄右下角。
- 「放大影片」：影片暫時以 `position: fixed` 蓋住中＋右欄（不搬動 iframe，避免重新載入），再按一次、右上「還原」或 Esc 還原。Esc 一次只處理一件事：先還原影片，再取消校準 / 關面板。
- 視窗寬 < 1000px：上下堆疊（側邊欄 → 影片區 → 歌詞），側邊欄預設收合，歌詞欄維持獨立捲動（高 75vh）。
- 設定 popover：自動捲動開關、排版模式（原文翻譯同一行 / 上下兩行）、主題（跟隨系統 / 淺色 / 深色）、點行提早秒數。設定存 `localStorage`。

## 歌詞行

- 每一行（原文 + 翻譯）整塊是一個可點擊元素：用 `<div role="button" tabindex="-1">`，**不要用 `<button>`**（避免 focus 後空白鍵觸發 click）。
- 點擊：`player.seekTo(max(0, t + offset_ms/1000 - PREROLL), true)` 然後 `playVideo()`。`PREROLL = 0.15` 秒（常數，設定可調）。
- `t == null` 的行不可點、樣式變淡。
- 翻譯文字用次要顏色；`break_before` 的行上方加間距。
- 翻譯可雙擊編輯（contenteditable），Enter 儲存（PATCH），Esc 取消。

## 同步 / highlight

- 播放中用 `requestAnimationFrame` 迴圈（節流到約 50ms）讀 `getCurrentTime()`；暫停時停止迴圈。
- 找目前行：最後一個 `t + offset ≤ now` 的行（二分搜尋）。只在 index 改變時更新 DOM class。
- 時間相關純函式放 `static/js/sync.js`（`buildTimeline`、`findCurrentIndex`、`seekTarget`、`applyHold`），測試在 `tests/js/`。點行後先 seek 到 `t - PREROLL`，這 0.15 秒內用 hold 讓被點的行維持 highlight，避免閃回上一行。
- 自動捲動（可關）：目前行不在視窗中間 40% 區域時 `scrollIntoView({block: "center", behavior: "smooth"})`。使用者手動捲動（wheel / touchmove / 拖捲軸）後暫停自動捲動 3 秒。

## 鍵盤

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

## 播放器錯誤

- `onError` 收到 101 / 150（禁止嵌入）或 100（影片不存在）→ 自動換 `alternatives` 下一個，並 PATCH 存回；全部失敗則顯示錯誤和「換影片」選單。
  - 實作（M5）：本次載入歌曲期間試過的 video id 記在 `triedVideos`（換歌時清空），`util.js pickNextVideo` 挑第一個沒試過的 alternative；PATCH 後舊影片會進 alternatives 開頭，靠 `triedVideos` 避免繞回來。其他錯誤碼（2、5）只顯示訊息。
