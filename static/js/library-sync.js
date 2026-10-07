// Device copy of the song library: merge rules and sync planning. Pure — unit tested with `node --test`.
//
// A record (one per song, kept in IndexedDB):
//   {
//     key: "artist_slug/title_slug", artist_slug, title_slug,
//     server: <song as last received from the server>,
//     local: { offset_ms?, tr?: {[index]: {text, tr}}, t?: {[index]: {text, t}}, synced? },
//     pending: boolean,        // owner: local edits made offline, to push back
//     localUpdatedAt: ISO|null // when `local` last changed
//   }
//
// Visitors' local edits stay on the device forever (pending=false) and survive
// server updates. The owner's offline edits are pending: on the next sync they
// are pushed if newer than the server copy, otherwise dropped.

export const songKey = (artistSlug, titleSlug) => `${artistSlug}/${titleSlug}`;

const time = (iso) => (iso ? Date.parse(iso) : 0);

export function emptyLocal() {
  return {};
}

export function hasLocalEdits(local) {
  return Boolean(
    local &&
      (local.offset_ms !== undefined ||
        Object.keys(local.tr ?? {}).length ||
        Object.keys(local.t ?? {}).length ||
        local.synced !== undefined),
  );
}

/** Song to display: server copy with local edits applied (only where the line text still matches). */
export function mergeSong(record) {
  const song = structuredClone(record.server);
  const local = record.local ?? {};
  if (local.offset_ms !== undefined) song.offset_ms = local.offset_ms;
  for (const [i, edit] of Object.entries(local.tr ?? {})) {
    const line = song.lines[Number(i)];
    if (line && line.text === edit.text) line.tr = edit.tr;
  }
  for (const [i, edit] of Object.entries(local.t ?? {})) {
    const line = song.lines[Number(i)];
    if (line && line.text === edit.text) line.t = edit.t;
  }
  if (local.synced !== undefined) song.synced = local.synced;
  return song;
}

/**
 * Record after a local edit.
 * @param {object} edit {offset_ms} | {tr: {index, text, tr}} | {times: [{index, text, t}], synced}
 * @param {{pending: boolean, now: string}} opts
 */
export function withLocalEdit(record, edit, { pending, now }) {
  const local = structuredClone(record.local ?? {});
  if (edit.offset_ms !== undefined) local.offset_ms = edit.offset_ms;
  if (edit.tr) {
    local.tr = local.tr ?? {};
    local.tr[edit.tr.index] = { text: edit.tr.text, tr: edit.tr.tr };
  }
  if (edit.times) {
    local.t = local.t ?? {};
    for (const { index, text, t } of edit.times) local.t[index] = { text, t };
    if (edit.synced !== undefined) local.synced = edit.synced;
  }
  return { ...record, local, pending: record.pending || pending, localUpdatedAt: now };
}

/** PATCH body that pushes an owner's pending edits to the server. */
export function pendingPatch(record) {
  const local = record.local ?? {};
  const patch = {};
  if (local.offset_ms !== undefined) patch.offset_ms = local.offset_ms;
  const lines = new Map();
  for (const [i, edit] of Object.entries(local.tr ?? {})) lines.set(Number(i), { index: Number(i), tr: edit.tr });
  for (const [i, edit] of Object.entries(local.t ?? {})) {
    lines.set(Number(i), { ...(lines.get(Number(i)) ?? { index: Number(i) }), t: edit.t });
  }
  if (lines.size) patch.lines = [...lines.values()].sort((a, b) => a.index - b.index);
  if (local.synced !== undefined) patch.synced = local.synced;
  return patch;
}

/** Record for a song just received from the server (keeps what must survive). */
export function applyServerSong(record, song, artistSlug, titleSlug, role) {
  const key = songKey(artistSlug, titleSlug);
  if (!record) return { key, artist_slug: artistSlug, title_slug: titleSlug, server: song, local: {}, pending: false, localUpdatedAt: null };
  const base = { ...record, key, artist_slug: artistSlug, title_slug: titleSlug, server: song };
  if (role === "owner") {
    // An owner's pending edit survives only if it's newer than this server copy (it's then pushed).
    const keep = record.pending && time(record.localUpdatedAt) > time(song.updated_at);
    return keep ? base : { ...base, local: {}, pending: false, localUpdatedAt: null };
  }
  return base; // visitor: local offset / translations / taps always stay
}

/** Flatten the server's /api/library tree to {key: updated_at}. */
export function indexFromTree(tree) {
  const index = new Map();
  for (const artist of tree) {
    for (const song of artist.songs) index.set(songKey(artist.artist_slug, song.title_slug), song.updated_at);
  }
  return index;
}

/**
 * What a sync has to do.
 * @param {Map<string, object>} records device records by key
 * @param {Array} tree server /api/library response
 * @param {"owner"|"guest"} role
 * @returns {{push: string[], fetch: string[], remove: string[]}}
 */
export function planSync(records, tree, role) {
  const index = indexFromTree(tree);
  const push = [];
  const fetch = [];
  for (const [key, updatedAt] of index) {
    const rec = records.get(key);
    if (role === "owner" && rec?.pending && time(rec.localUpdatedAt) > time(updatedAt)) push.push(key);
    if (!rec || rec.server?.updated_at !== updatedAt || (role === "owner" && rec.pending)) fetch.push(key);
  }
  const remove = [...records.keys()].filter((key) => !index.has(key));
  return { push, fetch, remove };
}

/** Same shape as the server's /api/library, built from device records (for offline use). */
export function treeFromRecords(records) {
  const artists = new Map();
  for (const rec of records.values()) {
    const song = mergeSong(rec);
    if (!artists.has(rec.artist_slug)) artists.set(rec.artist_slug, { artist: song.artist, artist_slug: rec.artist_slug, songs: [] });
    artists.get(rec.artist_slug).songs.push({
      title: song.title,
      title_slug: rec.title_slug,
      synced: song.synced,
      updated_at: rec.server.updated_at,
    });
  }
  const byName = (a, b) => a.localeCompare(b, undefined, { sensitivity: "base" });
  const tree = [...artists.values()].sort((a, b) => byName(a.artist, b.artist));
  for (const artist of tree) artist.songs.sort((a, b) => byName(a.title, b.title));
  return tree;
}
