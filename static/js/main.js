import * as api from "./api.js";
import { Calibrator } from "./calibrator.js";
import { setupCreate } from "./create.js";
import { installKeyboard } from "./keyboard.js";
import { LibraryTree } from "./library.js";
import { LyricsView, SyncLoop } from "./lyrics.js";
import { PLAYER_ERRORS, Player } from "./player.js";
import { AutoScroller } from "./scroll.js";
import { loadSettings, normalizeSettings, saveSettings } from "./settings.js";
import { SongBar } from "./songbar.js";
import { formatTime } from "./sync.js";
import { status, toast } from "./ui.js";
import { OFFSET_STEP_MS, clampOffset, formatOffset, formatOffsetSeconds } from "./util.js";

const $ = (id) => document.getElementById(id);

const state = {
  current: null, // {artist_slug, title_slug, song}
  settings: loadSettings(),
};

// ---- player, lyrics, sync, auto-scroll ------------------------------------

const player = new Player("player", {
  onPlayingChange: (playing) => (playing ? loop.start() : loop.stop()),
  onError: (code) =>
    status.set("error", `影片無法播放：${PLAYER_ERRORS[code] ?? `錯誤碼 ${code}`}。可以按「換影片」選別的。`),
});

const lyrics = new LyricsView($("lyrics"), {
  onSeek: (seconds, play) => (play ? player.seekAndPlay(seconds) : player.seek(seconds)),
  onCurrentChange: () => scroller.follow(),
  onEditTranslation: async (index, tr) => {
    const cur = state.current;
    try {
      await api.patchSong(cur.artist_slug, cur.title_slug, { lines: [{ index, tr }] });
      toast("已儲存翻譯", "ok");
    } catch (err) {
      toast(`翻譯儲存失敗：${err.message}`, "error", 4000);
      throw err;
    }
  },
  onRetranslate: retranslateLine,
  onSelectTarget: (index) => calibrator.select(index),
});

const loop = new SyncLoop(
  () => player.currentTime(),
  (now) => lyrics.update(now),
);

const scroller = new AutoScroller({
  main: $("lyrics-col"),
  coverEl: () => null, // nothing overlaps the lyrics column any more
  currentEl: () => lyrics.currentEl,
  onOffscreen: (show) => ($("jump-button").hidden = !show),
});

$("jump-button").addEventListener("click", (e) => {
  e.currentTarget.blur();
  scroller.center();
});

// ---- expanded video (covers center + lyrics) / collapsible sidebar ----------

function setVideoExpanded(expanded) {
  document.body.classList.toggle("video-expanded", expanded);
  $("expand-button").textContent = expanded ? "還原影片" : "放大影片";
}
const videoExpanded = () => document.body.classList.contains("video-expanded");
$("expand-button").addEventListener("click", (e) => {
  e.currentTarget.blur();
  setVideoExpanded(!videoExpanded());
});
$("expand-close").addEventListener("click", (e) => {
  e.currentTarget.blur();
  setVideoExpanded(false);
});

const narrowScreen = matchMedia("(max-width: 999px)");

function setSidebarCollapsed(collapsed) {
  document.documentElement.classList.toggle("sidebar-collapsed", collapsed);
  const button = $("sidebar-toggle");
  button.textContent = collapsed ? "»" : "«";
  button.title = collapsed ? "展開歌曲庫（B）" : "收合歌曲庫（B）";
  button.setAttribute("aria-expanded", String(!collapsed));
}
function toggleSidebar() {
  const collapsed = !document.documentElement.classList.contains("sidebar-collapsed");
  setSidebarCollapsed(collapsed);
  updateSettings({ sidebarCollapsed: collapsed });
}
$("sidebar-toggle").addEventListener("click", (e) => {
  e.currentTarget.blur();
  toggleSidebar();
});
// Narrow screens start collapsed (the saved preference is for wide layouts).
setSidebarCollapsed(narrowScreen.matches || state.settings.sidebarCollapsed);

async function retranslateLine(index) {
  const cur = state.current;
  if (!cur) return;
  await flushOffset();
  lyrics.setLineBusy(index, true);
  try {
    const res = await api.retranslate(cur.artist_slug, cur.title_slug, [index]);
    if (state.current?.song !== cur.song) return; // switched songs meanwhile
    if (res.missing_translations.includes(index)) toast("這行重翻失敗，保留原翻譯", "error", 3000);
    else {
      lyrics.setTranslation(index, res.song.lines[index].tr);
      toast("已重新翻譯", "ok");
    }
  } catch (err) {
    toast(`重翻失敗：${err.message}`, "error", 4000);
  } finally {
    lyrics.setLineBusy(index, false);
  }
}

// ---- settings ---------------------------------------------------------------

function applySettings() {
  const s = state.settings;
  if (s.theme === "auto") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = s.theme;
  document.body.classList.toggle("layout-inline", s.layout === "inline");
  scroller.enabled = s.autoScroll;
  lyrics.preroll = s.preroll;
  $("set-autoscroll").checked = s.autoScroll;
  for (const r of document.querySelectorAll('input[name="layout"]')) r.checked = r.value === s.layout;
  for (const r of document.querySelectorAll('input[name="theme"]')) r.checked = r.value === s.theme;
  if (document.activeElement !== $("set-preroll")) $("set-preroll").value = String(s.preroll);
}

function updateSettings(patch) {
  state.settings = normalizeSettings({ ...state.settings, ...patch });
  saveSettings(state.settings);
  applySettings();
}

$("set-autoscroll").addEventListener("change", (e) => {
  updateSettings({ autoScroll: e.target.checked });
  if (e.target.checked) scroller.follow();
});
for (const r of document.querySelectorAll('input[name="layout"], input[name="theme"]')) {
  r.addEventListener("change", (e) => updateSettings({ [e.target.name]: e.target.value }));
}
$("set-preroll").addEventListener("change", (e) => updateSettings({ preroll: e.target.value }));

function setSettingsOpen(open) {
  $("settings-panel").hidden = !open;
  $("settings-button").setAttribute("aria-expanded", String(open));
}
$("settings-button").addEventListener("click", (e) => {
  e.currentTarget.blur();
  setSettingsOpen($("settings-panel").hidden);
});
document.addEventListener("click", (e) => {
  if (!e.target.closest(".settings")) setSettingsOpen(false);
});

applySettings();

// ---- offset ([ / ]) ----------------------------------------------------------

const OFFSET_SAVE_DELAY_MS = 1000;
let pendingOffset = null; // {artistSlug, titleSlug, value, timer}

/** Apply an offset locally: display, notice and highlight (not saved). */
function setOffsetLocal(ms) {
  state.current.song.offset_ms = ms;
  showOffset();
  showNotice();
  lyrics.update(player.currentTime()); // re-highlight right away, even when paused
}

function nudgeOffset(delta) {
  const cur = state.current;
  if (!cur || calibrator.active) return;
  const value = clampOffset((cur.song.offset_ms || 0) + delta);
  setOffsetLocal(value);
  toast(`offset ${formatOffset(value)}`, "info", 1200);
  if (pendingOffset) clearTimeout(pendingOffset.timer);
  pendingOffset = {
    artistSlug: cur.artist_slug,
    titleSlug: cur.title_slug,
    value,
    timer: setTimeout(flushOffset, OFFSET_SAVE_DELAY_MS),
  };
}

async function flushOffset() {
  if (!pendingOffset) return;
  const { artistSlug, titleSlug, value, timer } = pendingOffset;
  clearTimeout(timer);
  pendingOffset = null;
  try {
    await api.patchSong(artistSlug, titleSlug, { offset_ms: value });
    toast(`offset ${formatOffset(value)} 已儲存`, "ok", 1200);
  } catch (err) {
    toast(`offset 儲存失敗：${err.message}`, "error", 4000);
  }
}

/** Calibration result: save right away (replaces any pending [ ] change). */
async function saveOffsetNow(ms) {
  const cur = state.current;
  if (pendingOffset) clearTimeout(pendingOffset.timer);
  pendingOffset = null;
  try {
    await api.patchSong(cur.artist_slug, cur.title_slug, { offset_ms: ms });
    toast(`offset 已設為 ${formatOffset(ms)}`, "ok", 2000);
  } catch (err) {
    toast(`offset 儲存失敗：${err.message}`, "error", 4000);
  }
}

function showOffset() {
  $("offset-value").textContent = formatOffset(state.current?.song.offset_ms || 0);
}

const calibrator = new Calibrator({
  lyrics,
  player,
  scroller,
  song: () => state.current?.song ?? null,
  setOffset: setOffsetLocal,
  saveOffset: saveOffsetNow,
  onEnter: () => {
    songBar.close();
    setSettingsOpen(false);
  },
});

$("offset-minus").addEventListener("click", (e) => {
  e.currentTarget.blur();
  nudgeOffset(-OFFSET_STEP_MS);
});
$("offset-plus").addEventListener("click", (e) => {
  e.currentTarget.blur();
  nudgeOffset(+OFFSET_STEP_MS);
});

// ---- keyboard -------------------------------------------------------------

function onCommand(command) {
  const calibrating = calibrator.active;
  const synced = Boolean(state.current?.song.synced);
  switch (command) {
    case "togglePlay":
      player.togglePlay();
      return true;
    case "prevLine":
    case "nextLine":
      // disabled while calibrating (still swallowed so the page doesn't scroll)
      if (!calibrating && synced) lyrics.step(command === "nextLine" ? +1 : -1, player.isPlaying());
      return true;
    case "offsetDown":
    case "offsetUp":
    case "offsetDownBig":
    case "offsetUpBig": {
      const step = command.endsWith("Big") ? 1000 : OFFSET_STEP_MS;
      nudgeOffset(command.startsWith("offsetDown") ? -step : step);
      return true;
    }
    case "toggleAutoScroll":
      updateSettings({ autoScroll: !state.settings.autoScroll });
      toast(`自動捲動：${state.settings.autoScroll ? "開" : "關"}`);
      if (state.settings.autoScroll) scroller.follow();
      return true;
    case "toggleSidebar":
      toggleSidebar();
      return true;
    case "centerCurrent":
      if (!scroller.center()) toast("還沒有正在播放的歌詞行");
      return true;
    case "calibrateToggle":
      if (!state.current) return false;
      calibrator.toggle();
      return true;
    case "calibrateKey":
      if (!calibrating) return false;
      calibrator.pressS();
      return true;
    case "confirm":
      if (calibrator.phase !== "confirming") return false;
      calibrator.confirm();
      return true;
    default:
      return false;
  }
}

installKeyboard(onCommand, () => {
  if (videoExpanded()) return setVideoExpanded(false); // one thing per Esc
  if (calibrator.active) calibrator.cancel();
  setSettingsOpen(false);
  songBar.close();
});

// Handle for poking at things from the browser console.
window.lyricPlayer = { player, lyrics, scroller, state, calibrator };

// ---- library tree -----------------------------------------------------------

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

// ---- song loading (hash routing: #/song/<artist_slug>/<title_slug>) --------

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
  await flushOffset();
  try {
    showSong(await api.getSong(a, t));
  } catch (err) {
    status.set("error", `無法載入歌曲：${err.message}`);
  }
}

function showHeading() {
  const { song } = state.current;
  $("song-title").textContent = `${song.artist} – ${song.title}`;
  const meta = [song.synced ? "同步歌詞" : "未同步", `${song.lines.length} 行`];
  if (song.youtube?.duration) meta.push(formatTime(song.youtube.duration));
  $("song-meta").textContent = meta.join(" · ");
  document.title = `${song.title} – 歌詞播放器`;
  showOffset();
}

function showNotice() {
  const song = state.current?.song;
  const notes = [];
  if (song && !song.synced) notes.push("這首歌沒有同步時間，無法點行跳播（之後會加入手動打點同步）。");
  if (song?.auto_offset_ms && song.offset_ms === song.auto_offset_ms) {
    notes.push(`已依時長差自動設定 offset ${formatOffsetSeconds(song.auto_offset_ms)}，不準可用「校準時間」修正。`);
  }
  $("song-notice").hidden = !notes.length;
  $("song-notice").textContent = notes.join(" ");
}

/** Display a song (from GET/build). */
function showSong(data) {
  calibrator.reset(); // unsaved calibration belongs to the previous song
  state.current = data;
  const { song } = data;
  songBar.close();
  $("welcome").hidden = true;
  $("song-area").hidden = false;
  showHeading();
  lyrics.render(song);
  showNotice();
  tree.setCurrent(data.artist_slug, data.title_slug);
  $("lyrics-col").scrollTop = 0;
  if (song.youtube?.video_id) {
    player.load(song.youtube.video_id).catch((err) => status.set("error", err.message));
  }
}

function showEmpty() {
  calibrator.reset();
  state.current = null;
  player.stop();
  lyrics.clear();
  $("song-area").hidden = true;
  $("welcome").hidden = false;
  setVideoExpanded(false);
  $("jump-button").hidden = true;
  tree.current = null;
  tree.render();
  document.title = "歌詞播放器";
  history.replaceState(null, "", location.pathname);
}

window.addEventListener("hashchange", openFromHash);

// ---- song toolbar -----------------------------------------------------------

const songBar = new SongBar({
  current: () => state.current,
  beforeChange: flushOffset,
  onUpdated: (res, change) => {
    calibrator.cancel();
    state.current = res;
    showHeading();
    showNotice();
    if (change === "video") {
      player.load(res.song.youtube.video_id).catch((err) => status.set("error", err.message));
    } else if (change === "info") {
      history.replaceState(null, "", songHash(res.artist_slug, res.title_slug));
      refreshTree().then(() => tree.setCurrent(res.artist_slug, res.title_slug));
    } else if (change === "lines") {
      lyrics.render(res.song); // keeps scroll position; restore the highlight
      lyrics.update(player.currentTime());
    }
  },
  onDeleted: async () => {
    showEmpty();
    await refreshTree();
  },
});

// ---- create flow ------------------------------------------------------------

setupCreate({
  onBuilt: async (res) => {
    await refreshTree();
    await flushOffset();
    state.current = null; // force reload even if the hash is unchanged
    const hash = songHash(res.artist_slug, res.title_slug);
    if (location.hash === hash) showSong(res);
    else location.hash = hash;
  },
});

// ---- start --------------------------------------------------------------------

window.addEventListener("pagehide", () => {
  // best effort: don't lose an offset tweak made just before closing the tab
  if (pendingOffset) {
    const { artistSlug, titleSlug, value } = pendingOffset;
    fetch(`/api/songs/${encodeURIComponent(artistSlug)}/${encodeURIComponent(titleSlug)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ offset_ms: value }),
      keepalive: true,
    });
  }
});

await refreshTree();
await openFromHash();
