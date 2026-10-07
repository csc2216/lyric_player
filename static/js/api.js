// Thin fetch wrappers for the backend API. Errors carry the server's Chinese message.

export class ApiError extends Error {
  /**
   * @param {string} message Chinese message for the UI
   * @param {number} status HTTP status; 0 = server unreachable
   * @param {string|null} code "pin_required" | "forbidden" | "quota_exceeded" | null
   */
  constructor(message, status, code = null) {
    super(message);
    this.status = status;
    this.code = code;
  }

  get offline() {
    return this.status === 0;
  }
}

/** Called with every ApiError whose code needs global handling (PIN, unreachable). */
let errorListener = null;
export function onApiError(listener) {
  errorListener = listener;
}

async function request(method, path, body, { timeoutMs = 0, silent = false } = {}) {
  const controller = new AbortController();
  const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      cache: "no-store",
    });
  } catch {
    const err = new ApiError("連不到伺服器（電腦沒開、或沒連上網路 / Tailscale）", 0);
    if (!silent) errorListener?.(err);
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 204) return null;
  let data = null;
  try {
    data = await res.json();
  } catch {
    // non-JSON error page
  }
  if (!res.ok) {
    let detail = data?.detail;
    if (Array.isArray(detail)) detail = detail.map((d) => d.msg).join("；"); // 422 validation
    // 502/503/504 without our JSON = the proxy (tailscale serve) can't reach the server
    const status = !data && res.status >= 502 && res.status <= 504 ? 0 : res.status;
    const err = new ApiError(status === 0 ? "連不到伺服器（伺服器沒有在執行）" : detail || `HTTP ${res.status}`, status, data?.code ?? null);
    if (!silent) errorListener?.(err);
    throw err;
  }
  return data;
}

const songPath = (a, t) => `/api/songs/${encodeURIComponent(a)}/${encodeURIComponent(t)}`;

export const getLibrary = () => request("GET", "/api/library", undefined, { timeoutMs: 10000 });
export const getSong = (artistSlug, titleSlug) =>
  request("GET", songPath(artistSlug, titleSlug), undefined, { timeoutMs: 10000 });
export const resolve = (query) => request("POST", "/api/resolve", { query });
export const build = (lrclibId, videoId, force = false) =>
  request("POST", "/api/build", { lrclib_id: lrclibId, video_id: videoId, force });
export const patchSong = (artistSlug, titleSlug, patch) => request("PATCH", songPath(artistSlug, titleSlug), patch);
export const retranslate = (artistSlug, titleSlug, lineIndices) =>
  request("POST", `${songPath(artistSlug, titleSlug)}/retranslate`, lineIndices ? { line_indices: lineIndices } : {});
export const deleteSong = (artistSlug, titleSlug) => request("DELETE", songPath(artistSlug, titleSlug));
export const me = () => request("GET", "/api/me", undefined, { timeoutMs: 6000 });
// silent: a wrong PIN (401 pin_required) must not re-trigger the global "ask for PIN" handling
export const submitPin = (pin) => request("POST", "/api/auth/pin", { pin }, { silent: true });
