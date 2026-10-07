import * as api from "./api.js";
import { installKeyboard } from "./keyboard.js";
import { LibraryTree } from "./library.js";
import { LyricsView, SyncLoop } from "./lyrics.js";
import { PLAYER_ERRORS, Player } from "./player.js";
import { formatTime } from "./sync.js";

const $ = (id) => document.getElementById(id);

const state = {
  current: null, // {artist_slug, title_slug, song}
  busy: false,
};

// ---- status line ------------------------------------------------------------

const status = {
  timer: null,
  /** kind: "busy" | "ok" | "error" | "info"; busy shows a spinner and elapsed seconds. */
  set(kind, text) {
    clearInterval(this.timer);
    const box = $("status");
    box.hidden = false;
    box.className = `status ${kind}`;
    box.replaceChildren();
    if (kind === "busy") box.append(Object.assign(document.createElement("span"), { className: "spinner" }));
    const label = Object.assign(document.createElement("span"), { textContent: text });
    box.append(label);
    if (kind === "busy") {
      const started = Date.now();
      const elapsed = Object.assign(document.createElement("span"), { className: "elapsed", textContent: "0 秒" });
      box.append(elapsed);
      this.timer = setInterval(() => {
        elapsed.textContent = `${Math.floor((Date.now() - started) / 1000)} 秒`;
      }, 250);
    }
  },
  hide() {
    clearInterval(this.timer);
    $("status").hidden = true;
  },
};

// ---- player + lyrics ----------------------------------------------------

const lyrics = new LyricsView($("lyrics"), (seconds) => player.seekAndPlay(seconds));
const player = new Player("player", {
  onPlayingChange: (playing) => (playing ? loop.start() : loop.stop()),
  onError: (code) => status.set("error", `影片無法播放：${PLAYER_ERRORS[code] ?? `錯誤碼 ${code}`}`),
});
const loop = new SyncLoop(
  () => player.currentTime(),
  (now) => lyrics.update(now),
);

installKeyboard({ togglePlay: () => player.togglePlay() });

// Handle for poking at things from the browser console.
window.lyricPlayer = { player, lyrics, state };

$("shrink-button").addEventListener("click", (e) => {
  const small = $("player-wrap").classList.toggle("shrunk");
  e.currentTarget.textContent = small ? "放大影片" : "縮小影片";
  e.currentTarget.blur();
});

// ---- library tree ---------------------------------------------------------

const tree = new LibraryTree($("tree"), $("tree-filter"), (a, t) => {
  location.hash = songHash(a, t);
});

async function refreshTree() {
  try {
    tree.setTree(await api.getLibrary());
  } catch (err) {
    status.set("error", `讀取歌曲庫失敗：${err.message}`);
  }
}

// ---- song loading (hash routing: #/song/<artist_slug>/<title_slug>) ------

const songHash = (a, t) => `#/song/${encodeURIComponent(a)}/${encodeURIComponent(t)}`;

function parseHash() {
  const m = location.hash.match(/^#\/song\/([^/]+)\/([^/]+)$/);
  return m ? [decodeURIComponent(m[1]), decodeURIComponent(m[2])] : null;
}

async function openFromHash() {
  const slugs = parseHash();
  if (!slugs) return;
  const [a, t] = slugs;
  if (state.current && state.current.artist_slug === a && state.current.title_slug === t) return;
  try {
    showSong(await api.getSong(a, t));
  } catch (err) {
    status.set("error", `無法載入歌曲：${err.message}`);
  }
}

function showSong(data) {
  state.current = data;
  const { song } = data;
  $("welcome").hidden = true;
  $("song").hidden = false;
  $("song-title").textContent = `${song.artist} – ${song.title}`;
  const meta = [song.synced ? "同步歌詞" : "未同步", `${song.lines.length} 行`];
  if (song.youtube?.duration) meta.push(formatTime(song.youtube.duration));
  if (song.offset_ms) meta.push(`offset ${song.offset_ms > 0 ? "+" : ""}${song.offset_ms} ms`);
  $("song-meta").textContent = meta.join(" · ");

  const notice = $("song-notice");
  notice.hidden = song.synced;
  notice.textContent = song.synced ? "" : "這首歌沒有同步時間，無法點行跳播（之後會加入手動打點同步）。";

  lyrics.render(song);
  tree.setCurrent(data.artist_slug, data.title_slug);
  document.title = `${song.title} – 歌詞播放器`;
  $("main").scrollTop = 0;

  if (song.youtube?.video_id) {
    player.load(song.youtube.video_id).catch((err) => status.set("error", err.message));
  }
}

window.addEventListener("hashchange", openFromHash);

// ---- create flow ----------------------------------------------------------

function setBusy(busy) {
  state.busy = busy;
  $("create-button").disabled = busy;
  $("create-input").disabled = busy;
}

$("create-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const query = $("create-input").value.trim();
  if (!query || state.busy) return;
  hideCandidates();
  setBusy(true);
  status.set("busy", `搜尋中：在 LRCLIB 找歌詞、在 YouTube 找影片…`);
  try {
    const res = await api.resolve(query);
    console.debug("resolve", res.reason, res);
    if (!res.candidates.length) {
      status.set("error", `找不到「${query}」的歌詞，試試「歌手 - 歌名」的格式。`);
      return;
    }
    const pick = res.candidates[0];
    if (res.auto_ok && pick.video) {
      await buildSong(pick, pick.video);
    } else {
      status.set("info", `找到 ${res.candidates.length} 個候選，請選一個。`);
      showCandidates(res);
    }
  } catch (err) {
    status.set("error", `搜尋失敗：${err.message}`);
  } finally {
    setBusy(false);
  }
});

async function buildSong(candidate, video) {
  setBusy(true);
  status.set("busy", `翻譯中：${candidate.artist_name} – ${candidate.track_name}（${candidate.line_count} 行，約需 5–10 秒）`);
  try {
    const res = await api.build(candidate.id, video.video_id);
    hideCandidates();
    $("create-input").value = "";
    await refreshTree();
    if (res.created === false) status.set("info", "這首歌已經在歌曲庫裡，直接載入。");
    else if (res.missing_translations.length) {
      status.set("error", `完成，但有 ${res.missing_translations.length} 行翻譯失敗（留空）。`);
    } else status.set("ok", "完成！點任一行歌詞開始播放。");
    state.current = null; // force reload even if the hash is unchanged
    const hash = songHash(res.artist_slug, res.title_slug);
    if (location.hash === hash) showSong(res);
    else location.hash = hash;
  } catch (err) {
    status.set("error", `建立失敗：${err.message}`);
  } finally {
    setBusy(false);
  }
}

// ---- candidate picker -----------------------------------------------------

function hideCandidates() {
  $("candidates").hidden = true;
  $("candidates").replaceChildren();
}

function showCandidates(res) {
  const box = $("candidates");
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };

  const head = el("div", "candidates-head");
  head.append(el("h2", "", "選擇要建立的歌曲"));
  const cancel = el("button", "small", "取消");
  cancel.type = "button";
  cancel.addEventListener("click", () => {
    hideCandidates();
    status.hide();
  });
  head.append(cancel);
  const why = el("details", "reason");
  why.append(el("summary", "", "為什麼沒有自動建立？"), el("code", "", res.reason));
  box.replaceChildren(head, why);

  res.candidates.forEach((c, i) => {
    const card = el("article", "candidate");
    const title = el("div", "cand-title");
    title.append(el("strong", "", `${c.artist_name} – ${c.track_name}`));
    if (i === 0) title.append(el("span", "tag accent", "推薦"));
    card.append(title);

    const meta = [formatTime(c.duration), c.synced ? "同步歌詞" : "無同步（只有純文字）", `${c.line_count} 行`];
    if (c.album_name) meta.push(c.album_name);
    const metaEl = el("div", "cand-meta", meta.join(" · "));
    if (!c.duration_ok) metaEl.append(el("span", "tag warn", "時長資料可疑"));
    if (!c.synced) metaEl.classList.add("warn-text");
    card.append(metaEl);

    const preview = el("div", "cand-preview");
    for (const line of c.preview) preview.append(el("div", "", line));
    card.append(preview);

    const videoRow = el("div", "cand-video");
    if (c.video) {
      const thumb = el("img", "thumb");
      thumb.src = `https://i.ytimg.com/vi/${encodeURIComponent(c.video.video_id)}/mqdefault.jpg`;
      thumb.alt = "";
      thumb.loading = "lazy";
      const info = el("div", "video-info");
      info.append(el("div", "video-title", c.video.title || c.video.video_id));
      const diff = c.video.duration_diff;
      const diffText = diff === null ? "" : `（${diff >= 0 ? "+" : ""}${Math.round(diff)} 秒）`;
      const vmeta = el("div", "video-meta", `${c.video.channel} · ${formatTime(c.video.duration)}${diffText}`);
      if (diff !== null && Math.abs(diff) > 3) vmeta.classList.add("warn-text");
      info.append(vmeta);
      videoRow.append(thumb, info);
    } else {
      videoRow.append(el("div", "warn-text", "找不到配對的 YouTube 影片"));
    }
    card.append(videoRow);

    const choose = el("button", "", "用這個建立");
    choose.type = "button";
    choose.disabled = !c.video;
    choose.addEventListener("click", () => {
      if (!state.busy) buildSong(c, c.video);
    });
    card.append(choose);
    box.append(card);
  });
  box.hidden = false;
}

// ---- start --------------------------------------------------------------

await refreshTree();
await openFromHash();
