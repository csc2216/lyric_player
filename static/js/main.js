import * as api from "./api.js";
import { Calibrator } from "./calibrator.js";
import { setupCreate } from "./create.js";
import { SongData } from "./data.js";
import { installKeyboard } from "./keyboard.js";
import { LibraryTree } from "./library.js";
import { LyricsView, SyncLoop } from "./lyrics.js";
import { PLAYER_ERRORS, Player } from "./player.js";
import { AutoScroller } from "./scroll.js";
import { loadSettings, normalizeSettings, saveSettings } from "./settings.js";
import { SongBar } from "./songbar.js";
import { formatTime } from "./sync.js";
import { Tapper } from "./tapper.js";
import { status, toast } from "./ui.js";
import {
  OFFSET_STEP_MS,
  SWITCHABLE_PLAYER_ERRORS,
  clampOffset,
  formatOffset,
  formatOffsetSeconds,
  pickNextVideo,
} from "./util.js";

const $ = (id) => document.getElementById(id);

const RECONNECT_INTERVAL_MS = 20000; // while offline: try the server again
const RESYNC_INTERVAL_MS = 120000; // while online: pick up changes from other devices

const state = {
  current: null, // {artist_slug, title_slug, song} (song = server copy merged with this device's edits)
  settings: loadSettings(),
  me: null, // /api/me response
};

const data = new SongData();
const isOwner = () => data.role === "owner";

if ("serviceWorker" in navigator) {
  // app shell cache: lets the app open when the server can't be reached
  navigator.serviceWorker.register("/sw.js").catch((err) => console.warn("service worker:", err));
}

// ---- player, lyrics, sync, auto-scroll ------------------------------------

const player = new Player("player", {
  onPlayingChange: (playing) => {
    $("touch-play").textContent = playing ? "⏸" : "▶";
    playing ? loop.start() : loop.stop();
  },
  onError: (code) => handlePlayerError(code),
});

const lyrics = new LyricsView($("lyrics"), {
  onSeek: (seconds, play) => (play ? player.seekAndPlay(seconds) : player.seek(seconds)),
  onCurrentChange: () => scroller.follow(),
  onEditTranslation: async (index, tr) => {
    try {
      const { saved } = await saveEdit({ tr: { index, tr } });
      toast(savedText(saved, "翻譯"), "ok", saved === "server" ? 1800 : 3000);
    } catch (err) {
      toast(`翻譯儲存失敗：${err.message}`, "error", 4000);
      throw err;
    }
  },
  onRetranslate: retranslateLine,
  onSelectTarget: (index) => {
    if (calibrator.active) calibrator.select(index);
  },
});

const loop = new SyncLoop(
  () => player.currentTime(),
  (now) => lyrics.update(now),
);

const touchControls = $("touch-controls");
const scroller = new AutoScroller({
  main: $("lyrics-col"),
  coverEl: () => null, // nothing overlaps the top of the lyrics column
  // the floating touch buttons cover the bottom: keep the current line above them
  coverBottomEl: () => (touchControls.offsetParent !== null ? touchControls : null),
  currentEl: () => lyrics.currentEl,
  onOffscreen: (show) => ($("jump-button").hidden = !show),
});

$("jump-button").addEventListener("click", (e) => {
  e.currentTarget.blur();
  scroller.center();
});

$("touch-play").addEventListener("click", () => onCommand("togglePlay"));
$("touch-prev").addEventListener("click", () => onCommand("prevLine"));
$("touch-next").addEventListener("click", () => onCommand("nextLine"));

/** Human text for where an edit was saved. */
function savedText(saved, what) {
  if (saved === "server") return `已儲存${what}`;
  if (isOwner()) return `離線中：${what}先存在這台裝置，連上伺服器後會自動同步`;
  return `${what}已存在這台裝置（不會改到伺服器上的歌）`;
}

/** Edit the current song through the data layer (server for the owner online, else this device). */
async function saveEdit(edit) {
  const cur = state.current;
  const result = await data.edit(cur, edit);
  if (state.current?.song === cur.song) {
    // keep the same song object (views hold references); take the merged values
    Object.assign(state.current.song, result.data.song);
    state.current.artist_slug = result.data.artist_slug;
    state.current.title_slug = result.data.title_slug;
  }
  return result;
}

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

const startCollapsed = matchMedia("(max-width: 999px), (pointer: coarse) and (max-width: 1199px)");

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
// Narrow / touch screens start collapsed (the saved preference is for wide layouts).
setSidebarCollapsed(startCollapsed.matches || state.settings.sidebarCollapsed);

async function retranslateLine(index) {
  const cur = state.current;
  if (!cur || !serverActionsAllowed("重翻")) return;
  await flushOffset();
  lyrics.setLineBusy(index, true);
  try {
    const res = await api.retranslate(cur.artist_slug, cur.title_slug, [index]);
    const merged = await data.storeServer(res);
    if (state.current?.song !== cur.song) return; // switched songs meanwhile
    if (res.missing_translations.includes(index)) toast("這行重翻失敗，保留原翻譯", "error", 3000);
    else {
      lyrics.setTranslation(index, merged.song.lines[index].tr);
      toast("已重新翻譯", "ok");
    }
  } catch (err) {
    toast(`重翻失敗：${err.message}`, "error", 4000);
  } finally {
    lyrics.setLineBusy(index, false);
  }
}

/** Server-changing actions need the owner and a connection; explain otherwise. */
function serverActionsAllowed(what) {
  if (!data.online) {
    toast(`離線模式不能${what}`, "error");
    return false;
  }
  if (!isOwner()) {
    toast(`訪客不能${what}`, "error");
    return false;
  }
  return true;
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
let pendingOffset = null; // {cur, value, timer}

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
  pendingOffset = { cur, value, timer: setTimeout(flushOffset, OFFSET_SAVE_DELAY_MS) };
}

async function flushOffset() {
  if (!pendingOffset) return;
  const { cur, value, timer } = pendingOffset;
  clearTimeout(timer);
  pendingOffset = null;
  try {
    const { saved } = await data.edit(cur, { offset_ms: value });
    if (saved === "server") toast(`offset ${formatOffset(value)} 已儲存`, "ok", 1200);
    else toast(`offset ${formatOffset(value)}：${savedText(saved, "")}`, "ok", 2500);
  } catch (err) {
    toast(`offset 儲存失敗：${err.message}`, "error", 4000);
  }
}

/** Calibration result: save right away (replaces any pending [ ] change). */
async function saveOffsetNow(ms) {
  if (pendingOffset) clearTimeout(pendingOffset.timer);
  pendingOffset = null;
  try {
    const { saved } = await saveEdit({ offset_ms: ms });
    toast(`offset 已設為 ${formatOffset(ms)}${saved === "server" ? "" : "（存在這台裝置）"}`, "ok", 2000);
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

const tapper = new Tapper({
  lyrics,
  player,
  scroller,
  song: () => state.current?.song ?? null,
  save: async (lines) => {
    try {
      const { saved, data: merged } = await saveEdit({ times: lines, synced: true });
      applyLinesUpdate(merged);
      if (saved !== "server") toast(savedText(saved, "打點結果"), "ok", 3500);
      return true;
    } catch (err) {
      toast(`打點結果存檔失敗：${err.message}`, "error", 6000);
      return false;
    }
  },
  onEnter: () => {
    songBar.close();
    setSettingsOpen(false);
  },
});

// ---- video can't be embedded / doesn't exist: try the next alternative ------

let triedVideos = new Set();
let switchingVideo = false;

async function handlePlayerError(code) {
  const cur = state.current;
  const reason = PLAYER_ERRORS[code] ?? `錯誤碼 ${code}`;
  if (!cur?.song.youtube) return;
  if (!SWITCHABLE_PLAYER_ERRORS.has(code)) {
    status.set("error", `影片無法播放：${reason}。${isOwner() && data.online ? "可以按「換影片」選別的。" : ""}`);
    return;
  }
  if (switchingVideo) return;
  const current = player.videoId ?? cur.song.youtube.video_id;
  triedVideos.add(current);
  const next = pickNextVideo(cur.song.youtube, triedVideos);
  if (!next) {
    if (isOwner() && data.online) {
      status.set("error", `影片無法播放（${reason}），候選影片也都不行。請在「換影片」貼上其他 YouTube 網址。`);
      songBar.open("video");
    } else {
      status.set("error", `影片無法播放（${reason}），候選影片也都不行。請主人換一部影片。`);
    }
    return;
  }
  switchingVideo = true;
  try {
    if (isOwner() && data.online) {
      // save the working video for everyone
      const res = await api.patchSong(cur.artist_slug, cur.title_slug, { video_id: next.video_id });
      const merged = await data.storeServer(res);
      if (state.current?.song !== cur.song) return; // switched songs meanwhile
      state.current = merged;
      showHeading();
    }
    // visitors / offline: just play the alternative this time
    status.set("info", `原影片無法播放（${reason}），已自動換成：${next.title || next.video_id}`);
    await player.load(next.video_id);
  } catch (err) {
    status.set("error", `影片無法播放，自動換片也失敗：${err.message}`);
  } finally {
    switchingVideo = false;
  }
}

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
  if (tapper.active) return onTapCommand(command);
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

/** While tap-syncing: S / Enter tap, Backspace goes back; seeking and offset keys are off. */
function onTapCommand(command) {
  switch (command) {
    case "togglePlay":
      player.togglePlay();
      return true;
    case "calibrateKey":
    case "confirm":
      tapper.tap();
      return true;
    case "back":
      tapper.back();
      return true;
    case "prevLine":
    case "nextLine":
    case "offsetDown":
    case "offsetUp":
    case "offsetDownBig":
    case "offsetUpBig":
    case "calibrateToggle":
      return true; // swallowed
    case "toggleSidebar":
      toggleSidebar();
      return true;
    case "toggleAutoScroll":
    case "centerCurrent":
      return true;
    default:
      return false;
  }
}

installKeyboard(onCommand, () => {
  if (videoExpanded()) return setVideoExpanded(false); // one thing per Esc
  if (tapper.active) return tapper.cancel();
  if (calibrator.active) calibrator.cancel();
  setSettingsOpen(false);
  songBar.close();
});

// Handle for poking at things from the browser console.
window.lyricPlayer = { player, lyrics, scroller, state, calibrator, tapper, data, handlePlayerError };

// ---- connection: online / offline, owner / visitor --------------------------

/** Reflect role and connection in the page (CSS hides what isn't available). */
function setMode({ online, role }) {
  const wasOnline = data.online;
  data.online = online;
  if (role) data.setRole(role);
  document.body.classList.toggle("offline", !online);
  document.body.classList.toggle("role-guest", data.role !== "owner");
  const banner = $("mode-banner");
  banner.hidden = online;
  if (!online) {
    banner.textContent = `離線模式 · 顯示這台裝置上最後同步的 ${data.count} 首歌；建立、重翻、換影片、刪除暫停使用`;
  }
  showSyncStatus();
  showQuota();
  if (wasOnline && !online) toast("連不到伺服器，切換到離線模式", "error", 3500);
}

function showSyncStatus(text) {
  const role = data.role === "owner" ? "" : "訪客 · ";
  $("sync-status").textContent = text ?? (data.online ? `${role}已同步 ${data.count} 首` : `${role}離線 · 這台裝置有 ${data.count} 首`);
}

function showQuota() {
  const box = $("build-quota");
  const left = state.me?.builds_left;
  box.hidden = !(data.online && data.role !== "owner" && typeof left === "number");
  if (!box.hidden) box.textContent = `訪客：今天還可以建立 ${left} 首新歌（每天 ${state.me.daily_limit} 首）`;
}

/** Ask the visitor for the PIN until the server accepts it. */
function askPin(message) {
  const dialog = $("pin-dialog");
  const error = $("pin-error");
  error.hidden = !message;
  error.textContent = message ?? "";
  $("pin-input").value = "";
  if (!dialog.open) dialog.showModal();
  return new Promise((resolve) => {
    const form = $("pin-form");
    const onSubmit = async (e) => {
      e.preventDefault();
      try {
        await api.submitPin($("pin-input").value);
        form.removeEventListener("submit", onSubmit);
        dialog.close();
        resolve();
      } catch (err) {
        error.hidden = false;
        error.textContent = err.offline ? err.message : "PIN 不正確，再試一次";
        $("pin-input").select();
      }
    };
    form.addEventListener("submit", onSubmit);
  });
}

/** Talk to the server: role, PIN, online/offline. Returns true when online. */
async function connect() {
  let me;
  try {
    me = await api.me();
    if (me.needs_pin) {
      await askPin();
      me = await api.me();
    }
  } catch (err) {
    if (err.offline) {
      setMode({ online: false });
      return false;
    }
    throw err;
  }
  if (!me.role) {
    // visitor without identity and the server doesn't allow PIN visitors
    $("blocked").hidden = false;
    $("blocked").textContent = me.error ?? "沒有使用權限";
    setMode({ online: false });
    return false;
  }
  state.me = me;
  setMode({ online: true, role: me.role });
  return true;
}

async function refreshMe() {
  try {
    state.me = await api.me();
    showQuota();
  } catch {
    // shown elsewhere
  }
}

let syncing = null;

/** Sync the device library with the server (one at a time) and redraw the tree. */
function syncLibrary() {
  if (!data.online) return Promise.resolve();
  syncing ??= (async () => {
    try {
      await data.sync((done, total) => showSyncStatus(`同步中 ${done} / ${total}…`));
      tree.setTree(data.tree());
      showSyncStatus();
    } catch (err) {
      if (!err.offline) status.set("error", `同步歌曲庫失敗：${err.message}`);
      tree.setTree(data.tree());
    } finally {
      syncing = null;
    }
  })();
  return syncing;
}

api.onApiError((err) => {
  if (err.offline && data.online) setMode({ online: false });
  if (err.code === "pin_required" && !$("pin-dialog").open) connect().then((ok) => ok && syncLibrary());
});

setInterval(async () => {
  if (document.hidden) return;
  if (!data.online) {
    if (await connect().catch(() => false)) {
      toast("已重新連上伺服器", "ok");
      await syncLibrary();
      // reload the open song from the server (its merged view may have changed)
      if (state.current) {
        const { artist_slug: a, title_slug: t } = state.current;
        state.current = null;
        await openSong(a, t);
      }
    }
  }
}, RECONNECT_INTERVAL_MS);

setInterval(() => {
  if (!document.hidden && data.online) syncLibrary();
}, RESYNC_INTERVAL_MS);

// ---- library tree -----------------------------------------------------------

const tree = new LibraryTree($("tree"), $("tree-filter"), (a, t) => {
  location.hash = songHash(a, t);
});

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
  await openSong(a, t);
}

async function openSong(a, t) {
  await flushOffset();
  try {
    showSong(await data.getSong(a, t));
  } catch (err) {
    status.set("error", `無法載入歌曲：${err.message}`);
  }
}

function showHeading() {
  const { song } = state.current;
  $("song-title").textContent = `${song.artist} – ${song.title}`;
  const meta = [song.synced ? "同步歌詞" : "未同步", `${song.lines.length} 行`];
  if (song.youtube?.duration) meta.push(formatTime(song.youtube.duration));
  if (data.hasLocalEdits(state.current.artist_slug, state.current.title_slug)) {
    meta.push(isOwner() ? "有尚未同步的修改" : "有本機修改");
  }
  $("song-meta").textContent = meta.join(" · ");
  document.title = `${song.title} – 歌詞播放器`;
  showOffset();
  // calibration needs timestamps; tap-sync is for songs without them
  $("calibrate-button").hidden = !song.synced;
  $("tap-button").hidden = song.synced;
}

function showNotice() {
  const song = state.current?.song;
  const notes = [];
  if (song && !song.synced) notes.push("這首歌沒有同步時間：按「打點同步」，跟著歌在每行開始時按一下，就能點行跳播。");
  if (song?.auto_offset_ms && song.offset_ms === song.auto_offset_ms) {
    notes.push(`已依時長差自動設定 offset ${formatOffsetSeconds(song.auto_offset_ms)}，不準可用「校準時間」修正。`);
  }
  $("song-notice").hidden = !notes.length;
  $("song-notice").textContent = notes.join(" ");
}

/** Display a song ({artist_slug, title_slug, song} with this device's edits merged). */
function showSong(view) {
  calibrator.reset(); // unsaved calibration / taps belong to the previous song
  tapper.reset();
  triedVideos = new Set();
  state.current = view;
  const { song } = view;
  songBar.close();
  $("welcome").hidden = true;
  $("song-area").hidden = false;
  showHeading();
  lyrics.render(song);
  showNotice();
  tree.setCurrent(view.artist_slug, view.title_slug);
  $("lyrics-col").scrollTop = 0;
  if (song.youtube?.video_id) {
    player.load(song.youtube.video_id).catch((err) => status.set("error", err.message));
  }
}

function showEmpty() {
  calibrator.reset();
  tapper.reset();
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

// ---- song toolbar (owner, online) ---------------------------------------------

const songBar = new SongBar({
  current: () => state.current,
  beforeChange: flushOffset,
  onUpdated: async (res, change) => {
    calibrator.cancel();
    tapper.reset();
    const old = state.current;
    if (change === "info" && (old.artist_slug !== res.artist_slug || old.title_slug !== res.title_slug)) {
      await data.forget(old.artist_slug, old.title_slug);
    }
    const merged = await data.storeServer(res);
    if (change === "lines") return applyLinesUpdate(merged);
    state.current = merged;
    showHeading();
    showNotice();
    if (change === "video") {
      player.load(merged.song.youtube.video_id).catch((err) => status.set("error", err.message));
    } else if (change === "info") {
      history.replaceState(null, "", songHash(merged.artist_slug, merged.title_slug));
      tree.setTree(data.tree());
      tree.setCurrent(merged.artist_slug, merged.title_slug);
    }
  },
  onDeleted: async () => {
    const { artist_slug: a, title_slug: t } = state.current;
    await data.forget(a, t);
    showEmpty();
    tree.setTree(data.tree());
    showSyncStatus();
  },
});

/** New line data (retranslate all / tap-sync): redraw lyrics, keep scroll and highlight. */
function applyLinesUpdate(view) {
  state.current = view;
  showHeading();
  showNotice();
  lyrics.render(view.song);
  lyrics.update(player.currentTime());
}

// ---- create flow ------------------------------------------------------------

setupCreate({
  blockedReason: () => (data.online ? null : "離線模式不能建立新歌（連不到伺服器）"),
  afterAttempt: () => {
    if (!isOwner()) refreshMe();
  },
  onBuilt: async (res) => {
    await flushOffset();
    const view = await data.storeServer(res);
    tree.setTree(data.tree());
    showSyncStatus();
    state.current = null; // force reload even if the hash is unchanged
    const hash = songHash(res.artist_slug, res.title_slug);
    if (location.hash === hash) showSong(view);
    else location.hash = hash;
  },
});

// ---- start --------------------------------------------------------------------

window.addEventListener("pagehide", () => {
  // best effort: don't lose an offset tweak made just before closing the tab
  if (pendingOffset && data.editsGoToServer) {
    const { cur, value } = pendingOffset;
    fetch(`/api/songs/${encodeURIComponent(cur.artist_slug)}/${encodeURIComponent(cur.title_slug)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ offset_ms: value }),
      keepalive: true,
    });
  }
});

await data.init();
tree.setTree(data.tree()); // instant: last synced copy on this device
showSyncStatus();
const online = await connect().catch((err) => {
  status.set("error", err.message);
  return false;
});
await openFromHash();
if (online) syncLibrary();
