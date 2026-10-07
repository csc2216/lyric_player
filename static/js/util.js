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

/**
 * Offset suggested by the video/lyrics duration difference: the difference when
 * the video is >= 1 s longer (longer intro), else 0. Same rule as the backend's
 * default_offset_ms (app/services/pipeline.py).
 */
export function estimateOffsetMs(videoDuration, lyricsDuration) {
  if (typeof videoDuration !== "number" || typeof lyricsDuration !== "number") return 0;
  const diff = videoDuration - lyricsDuration;
  return diff >= 1 ? Math.round(diff * 1000) : 0;
}

/** "+3.5 秒", "0 秒", "−0.2 秒" */
export function formatOffsetSeconds(ms) {
  if (!ms) return "0 秒";
  const s = (Math.abs(ms) / 1000).toFixed(1).replace(/\.0$/, "");
  return `${ms > 0 ? "+" : "−"}${s} 秒`;
}

/** YouTube player error codes that mean "this video can't be played here": try another one. */
export const SWITCHABLE_PLAYER_ERRORS = new Set([100, 101, 150]);

/** Next alternative video not tried yet (alternatives are in ranking order), or null. */
export function pickNextVideo(youtube, tried) {
  for (const video of youtube?.alternatives ?? []) {
    if (!tried.has(video.video_id)) return video;
  }
  return null;
}
