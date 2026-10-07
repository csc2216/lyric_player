# 資料格式（library JSON）

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
