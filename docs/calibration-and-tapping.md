# Offset、校準模式、手動打點

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
