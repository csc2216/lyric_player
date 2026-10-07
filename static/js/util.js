// Small pure helpers (no DOM) — unit tested with `node --test`.

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/** Video id from a YouTube URL or a bare 11-character id; null if not recognised. */
export function parseYoutubeId(input) {
  const text = String(input ?? "").trim();
  if (VIDEO_ID_RE.test(text)) return text;
  let url;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www|m|music)\./, "");
  let id = null;
  if (host === "youtu.be") {
    id = url.pathname.split("/")[1];
  } else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    id = url.searchParams.get("v");
    if (!id) {
      const m = url.pathname.match(/^\/(?:embed|shorts|live|v)\/([^/?#]+)/);
      id = m?.[1] ?? null;
    }
  }
  return id && VIDEO_ID_RE.test(id) ? id : null;
}

export const OFFSET_STEP_MS = 100;
export const OFFSET_LIMIT_MS = 60000;

export function clampOffset(ms) {
  return Math.max(-OFFSET_LIMIT_MS, Math.min(OFFSET_LIMIT_MS, Math.round(ms)));
}

/** "+100 ms", "0 ms", "−250 ms" */
export function formatOffset(ms) {
  if (!ms) return "0 ms";
  return `${ms > 0 ? "+" : "−"}${Math.abs(ms)} ms`;
}
