// Thin fetch wrappers for the backend API. Errors carry the server's Chinese message.

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function request(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError("無法連線到後端，server 有在跑嗎？", 0);
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
    throw new ApiError(detail || `HTTP ${res.status}`, res.status);
  }
  return data;
}

const songPath = (a, t) => `/api/songs/${encodeURIComponent(a)}/${encodeURIComponent(t)}`;

export const getLibrary = () => request("GET", "/api/library");
export const getSong = (artistSlug, titleSlug) => request("GET", songPath(artistSlug, titleSlug));
export const resolve = (query) => request("POST", "/api/resolve", { query });
export const build = (lrclibId, videoId, force = false) =>
  request("POST", "/api/build", { lrclib_id: lrclibId, video_id: videoId, force });
export const patchSong = (artistSlug, titleSlug, patch) => request("PATCH", songPath(artistSlug, titleSlug), patch);
export const retranslate = (artistSlug, titleSlug, lineIndices) =>
  request("POST", `${songPath(artistSlug, titleSlug)}/retranslate`, lineIndices ? { line_indices: lineIndices } : {});
export const deleteSong = (artistSlug, titleSlug) => request("DELETE", songPath(artistSlug, titleSlug));
