// User preferences kept in localStorage.

const KEY = "lyricPlayer.settings";

export const DEFAULTS = Object.freeze({
  autoScroll: true,
  layout: "stacked", // "stacked" (原文/翻譯上下) | "inline" (同一行)
  theme: "auto", // "auto" | "light" | "dark"
  preroll: 0.15, // seconds to start before a clicked line
  sidebarCollapsed: false,
  volume: 100, // our own volume control (YouTube's popup slider is unusable in small players)
  muted: false,
});

/** Fill defaults and drop invalid values. Pure. */
export function normalizeSettings(raw) {
  const s = { ...DEFAULTS };
  if (!raw || typeof raw !== "object") return s;
  if (typeof raw.autoScroll === "boolean") s.autoScroll = raw.autoScroll;
  if (typeof raw.sidebarCollapsed === "boolean") s.sidebarCollapsed = raw.sidebarCollapsed;
  if (typeof raw.muted === "boolean") s.muted = raw.muted;
  const v = Number(raw.volume);
  if (raw.volume !== null && raw.volume !== "" && Number.isFinite(v)) s.volume = Math.round(Math.min(100, Math.max(0, v)));
  if (["stacked", "inline"].includes(raw.layout)) s.layout = raw.layout;
  if (["auto", "light", "dark"].includes(raw.theme)) s.theme = raw.theme;
  const p = Number(raw.preroll);
  if (raw.preroll !== null && raw.preroll !== "" && Number.isFinite(p)) s.preroll = Math.min(2, Math.max(0, p));
  return s;
}

export function loadSettings() {
  try {
    return normalizeSettings(JSON.parse(localStorage.getItem(KEY) || "null"));
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // private mode / storage blocked: settings just won't persist
  }
}
