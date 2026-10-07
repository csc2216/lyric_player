// Song toolbar panels: change video, edit artist/title, retranslate all, delete.

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

  /** Open a panel: "video" | "info". */
  open(name) {
    this.openName = name;
    this.panel.replaceChildren(name === "video" ? this.#videoPanel() : this.#infoPanel());
    this.panel.hidden = false;
    // The center column scrolls on its own: bring the panel into view there.
    this.panel.scrollIntoView({ block: "nearest", behavior: "smooth" });
    this.panel.querySelector("input")?.focus({ preventScroll: true });
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
