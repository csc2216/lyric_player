// Song toolbar panels: change video, edit artist/title, replace lyrics, retranslate all, delete.

import * as api from "./api.js";
import { videoThumb } from "./create.js";
import { formatTime } from "./sync.js";
import { button, el, status, toast } from "./ui.js";
import { parseYoutubeId } from "./util.js";

export class SongBar {
  /**
   * @param {object} opts
   * @param {() => {artist_slug: string, title_slug: string, song: object}|null} opts.current
   * @param {() => Promise<void>} opts.beforeChange save pending edits (offset) before changing the song
   * @param {(res: object, change: "video"|"info"|"lines") => void} opts.onUpdated server returned a new song
   * @param {() => void} opts.onDeleted
   */
  constructor({ current, beforeChange, onUpdated, onDeleted }) {
    this.current = current;
    this.beforeChange = beforeChange;
    this.onUpdated = onUpdated;
    this.onDeleted = onDeleted;
    this.panel = document.getElementById("song-panel");
    this.openName = null;
    document.getElementById("video-button").addEventListener("click", (e) => this.#toggle("video", e));
    document.getElementById("info-button").addEventListener("click", (e) => this.#toggle("info", e));
    document.getElementById("lyrics-button").addEventListener("click", (e) => this.#toggle("lyrics", e));
    document.getElementById("retranslate-all-button").addEventListener("click", (e) => {
      e.currentTarget.blur();
      this.#retranslateAll();
    });
    document.getElementById("delete-button").addEventListener("click", (e) => {
      e.currentTarget.blur();
      this.#delete();
    });
  }

  close() {
    this.openName = null;
    this.panel.hidden = true;
    this.panel.replaceChildren();
  }

  #toggle(name, e) {
    e.currentTarget.blur();
    if (this.openName === name) return this.close();
    this.open(name);
  }

  /** Open a panel: "video" | "info" | "lyrics". */
  open(name) {
    this.openName = name;
    const panels = { video: () => this.#videoPanel(), info: () => this.#infoPanel(), lyrics: () => this.#lyricsPanel() };
    this.panel.replaceChildren(panels[name]());
    this.panel.hidden = false;
    // The center column scrolls on its own: bring the panel into view there.
    this.panel.scrollIntoView({ block: "nearest", behavior: "smooth" });
    this.panel.querySelector("input, textarea")?.focus({ preventScroll: true });
  }

  async #patch(patch, change, okText) {
    await this.beforeChange();
    const cur = this.current();
    try {
      const res = await api.patchSong(cur.artist_slug, cur.title_slug, patch);
      this.onUpdated(res, change);
      toast(okText, "ok");
      return true;
    } catch (err) {
      toast(`儲存失敗：${err.message}`, "error", 4000);
      return false;
    }
  }

  // ---- change video ----

  #videoPanel() {
    const { song } = this.current();
    const yt = song.youtube;
    const wrap = el("div", "panel-video");
    wrap.append(el("h3", "", "換影片"));
    const list = el("div", "video-list");
    const videos = yt ? [yt, ...yt.alternatives] : [];
    const target = song.lrclib?.duration;
    for (const v of videos) {
      const row = el("div", "video-option" + (v.video_id === yt.video_id ? " selected" : ""));
      row.append(videoThumb(v.video_id));
      const info = el("div", "video-info");
      info.append(el("div", "video-title", v.title || v.video_id));
      const diff = v.duration != null && target != null ? Math.round(v.duration - target) : null;
      const meta = [v.channel, formatTime(v.duration)].filter(Boolean).join(" · ");
      const metaEl = el("div", "video-meta", meta + (diff === null ? "" : `（${diff >= 0 ? "+" : ""}${diff} 秒）`));
      if (diff !== null && Math.abs(diff) > 3) metaEl.classList.add("warn-text");
      info.append(metaEl);
      row.append(info);
      if (v.video_id === yt.video_id) row.append(el("span", "tag accent", "使用中"));
      else row.append(button("使用", "small", () => this.#useVideo(v.video_id)));
      list.append(row);
    }
    if (!videos.length) list.append(el("p", "hint", "沒有其他候選影片"));
    wrap.append(list);

    const form = el("form", "inline-form");
    const input = el("input");
    input.placeholder = "或貼上 YouTube 網址 / 影片 ID";
    const submit = button("使用", "", null);
    submit.type = "submit";
    form.append(input, submit);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const id = parseYoutubeId(input.value);
      if (!id) return toast("看不懂這個網址或 ID", "error");
      this.#useVideo(id);
    });
    wrap.append(form);
    if (target != null) wrap.append(el("p", "hint", `歌詞時長 ${formatTime(target)}；時間差大的影片可能需要調 offset（[ / ]）。`));
    return wrap;
  }

  async #useVideo(videoId) {
    if (await this.#patch({ video_id: videoId }, "video", "已換影片")) this.close();
  }

  // ---- edit artist / title ----

  #infoPanel() {
    const { song } = this.current();
    const form = el("form", "panel-info");
    form.append(el("h3", "", "編輯歌手 / 歌名"));
    const artist = el("input");
    artist.value = song.artist;
    artist.required = true;
    const title = el("input");
    title.value = song.title;
    title.required = true;
    const row = (label, input) => {
      const l = el("label", "field");
      l.append(el("span", "", label), input);
      return l;
    };
    form.append(row("歌手", artist), row("歌名", title));
    form.append(el("p", "hint", "歌手名稱若與既有歌手相同（括號內別名不計），會併入該歌手並沿用其顯示名稱。"));
    const actions = el("div", "panel-actions");
    const save = button("儲存", "", null);
    save.type = "submit";
    actions.append(save, button("取消", "small", () => this.close()));
    form.append(actions);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const patch = {};
      if (artist.value.trim() !== song.artist) patch.artist = artist.value.trim();
      if (title.value.trim() !== song.title) patch.title = title.value.trim();
      if (!Object.keys(patch).length) return this.close();
      if (await this.#patch(patch, "info", "已更新歌手 / 歌名")) this.close();
    });
    return form;
  }

  // ---- replace lyrics (e.g. Korean for a romanized LRCLIB upload) ----

  #lyricsPanel() {
    const { song } = this.current();
    const form = el("form", "panel-lyrics");
    form.append(el("h3", "", "替換原文歌詞"));
    form.append(
      el(
        "p",
        "hint",
        song.synced
          ? "從 Spotify 等處複製原文歌詞貼上（例如 LRCLIB 只有羅馬拼音版時）。會沿用現有的時間軸逐行對齊，並整首重新翻譯；空行 = 分段。"
          : "貼上原文歌詞，整首重新翻譯；之後用「打點同步」對時間。空行 = 分段。",
      ),
    );
    const text = el("textarea");
    text.rows = 10;
    text.required = true;
    text.placeholder = "一行一句歌詞";
    form.append(text);
    const actions = el("div", "panel-actions");
    const save = button(song.synced ? "對齊並重翻" : "儲存並重翻", "", null);
    save.type = "submit";
    actions.append(save, button("取消", "small", () => this.close()));
    form.append(actions);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      // unsynced songs have no timing to carry over
      this.#replaceLyrics(text.value, !song.synced, actions);
    });
    return form;
  }

  async #replaceLyrics(text, allowUnsynced, actions) {
    const cur = this.current();
    if (!cur || !text.trim()) return;
    await this.beforeChange();
    status.set("busy", `替換歌詞並重新翻譯中：${cur.song.title}`);
    try {
      const res = await api.replaceLyrics(cur.artist_slug, cur.title_slug, text, allowUnsynced);
      this.close();
      this.onUpdated(res, "lines");
      const parts = [];
      if (res.retime) parts.push(`已對齊 ${res.retime.matched} / ${res.retime.total} 行（其餘依前後行推算）`);
      else parts.push("已存成未同步，可以用「打點同步」對時間");
      if (res.missing_translations.length) parts.push(`${res.missing_translations.length} 行翻譯失敗`);
      status.set(res.missing_translations.length ? "error" : "ok", parts.join("；"));
    } catch (err) {
      status.set("error", `替換歌詞失敗：${err.message}`);
      if (err.status === 400 && !allowUnsynced && !actions.querySelector(".unsynced")) {
        const fallback = button("存成未同步（之後用打點同步）", "small unsynced", () =>
          this.#replaceLyrics(text, true, actions),
        );
        actions.append(fallback);
      }
    }
  }

  // ---- retranslate all / delete ----

  async #retranslateAll() {
    const cur = this.current();
    if (!cur) return;
    if (!confirm(`重新翻譯整首「${cur.song.title}」？目前的翻譯（含手動修改）會被覆蓋。`)) return;
    await this.beforeChange();
    status.set("busy", `重新翻譯中：${cur.song.title}（${cur.song.lines.length} 行）`);
    try {
      const res = await api.retranslate(cur.artist_slug, cur.title_slug);
      this.onUpdated(res, "lines");
      if (res.missing_translations.length) status.set("error", `完成，但有 ${res.missing_translations.length} 行失敗（保留原翻譯）。`);
      else status.set("ok", "重新翻譯完成");
    } catch (err) {
      status.set("error", `重新翻譯失敗：${err.message}`);
    }
  }

  async #delete() {
    const cur = this.current();
    if (!cur) return;
    if (!confirm(`確定刪除「${cur.song.artist} – ${cur.song.title}」？此動作無法復原。`)) return;
    await this.beforeChange();
    try {
      await api.deleteSong(cur.artist_slug, cur.title_slug);
      toast("已刪除", "ok");
      this.close();
      this.onDeleted();
    } catch (err) {
      toast(`刪除失敗：${err.message}`, "error", 4000);
    }
  }
}
