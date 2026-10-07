// The song library as this device sees it: server when reachable, IndexedDB copy otherwise.
// Decides whether an edit goes to the server (owner, online) or stays on the device.

import * as api from "./api.js";
import {
  applyServerSong,
  hasLocalEdits,
  mergeSong,
  pendingPatch,
  planSync,
  songKey,
  treeFromRecords,
  withLocalEdit,
} from "./library-sync.js";
import { Store } from "./store.js";

export class SongData {
  constructor() {
    this.store = new Store();
    this.records = new Map();
    this.role = "guest"; // "owner" | "guest"
    this.online = false;
    this.available = true; // false if IndexedDB can't be used (e.g. private mode)
  }

  async init() {
    try {
      await this.store.open();
      for (const rec of await this.store.allSongs()) this.records.set(rec.key, rec);
      this.role = (await this.store.getMeta("role")) ?? "guest";
    } catch (err) {
      console.warn("IndexedDB unavailable; offline library disabled", err);
      this.available = false;
    }
  }

  get count() {
    return this.records.size;
  }

  async setRole(role) {
    this.role = role;
    if (this.available) await this.store.setMeta("role", role).catch(() => {});
  }

  async #put(rec) {
    this.records.set(rec.key, rec);
    if (this.available) await this.store.putSong(rec).catch((err) => console.warn("save failed", err));
  }

  async #remove(key) {
    this.records.delete(key);
    if (this.available) await this.store.deleteSong(key).catch(() => {});
  }

  /** Store a server song response ({artist_slug, title_slug, song}); returns the merged view. */
  async storeServer(res) {
    const key = songKey(res.artist_slug, res.title_slug);
    const rec = applyServerSong(this.records.get(key), res.song, res.artist_slug, res.title_slug, this.role);
    await this.#put(rec);
    return { artist_slug: res.artist_slug, title_slug: res.title_slug, song: mergeSong(rec) };
  }

  async forget(artistSlug, titleSlug) {
    await this.#remove(songKey(artistSlug, titleSlug));
  }

  tree() {
    return treeFromRecords(this.records);
  }

  /**
   * Bring the device copy in line with the server: push the owner's newer offline
   * edits, fetch new/changed songs, drop deleted ones. Returns the server tree.
   */
  async sync(onProgress) {
    const tree = await api.getLibrary();
    const plan = planSync(this.records, tree, this.role);
    for (const key of plan.push) {
      const rec = this.records.get(key);
      try {
        await this.storeServer(await api.patchSong(rec.artist_slug, rec.title_slug, pendingPatch(rec)));
      } catch (err) {
        console.warn("push failed", key, err);
      }
    }
    const toFetch = plan.fetch.filter((key) => !plan.push.includes(key));
    let done = 0;
    for (const key of toFetch) {
      const [a, t] = key.split("/");
      await this.storeServer(await api.getSong(a, t));
      onProgress?.(++done, toFetch.length);
    }
    for (const key of plan.remove) await this.#remove(key);
    if (this.available) await this.store.setMeta("lastSync", new Date().toISOString()).catch(() => {});
    return tree;
  }

  async lastSync() {
    return this.available ? this.store.getMeta("lastSync").catch(() => null) : null;
  }

  /** Song for display. Online: fresh from the server (and stored). Offline: the device copy. */
  async getSong(artistSlug, titleSlug) {
    if (this.online) {
      try {
        return await this.storeServer(await api.getSong(artistSlug, titleSlug));
      } catch (err) {
        if (err.status !== 0) throw err; // real error; network errors fall back to the device copy
      }
    }
    const rec = this.records.get(songKey(artistSlug, titleSlug));
    if (!rec) throw new api.ApiError("離線中，而且這台裝置上沒有這首歌", 0);
    return { artist_slug: artistSlug, title_slug: titleSlug, song: mergeSong(rec) };
  }

  /** Edits go to the server only for the owner while online. */
  get editsGoToServer() {
    return this.role === "owner" && this.online;
  }

  /**
   * Apply an edit. Owner online -> PATCH (returns merged song from the response).
   * Otherwise saved on this device (owner: pending, pushed on next sync; visitor: kept locally).
   * @param {object} cur {artist_slug, title_slug, song}
   * @param {object} edit {offset_ms} | {tr: {index, tr}} | {times: [{index, t}], synced}
   */
  async edit(cur, edit) {
    const key = songKey(cur.artist_slug, cur.title_slug);
    if (this.editsGoToServer) {
      const patch = {};
      if (edit.offset_ms !== undefined) patch.offset_ms = edit.offset_ms;
      if (edit.tr) patch.lines = [{ index: edit.tr.index, tr: edit.tr.tr }];
      if (edit.times) {
        patch.lines = edit.times.map(({ index, t }) => ({ index, t }));
        patch.synced = edit.synced;
      }
      return { saved: "server", data: await this.storeServer(await api.patchSong(cur.artist_slug, cur.title_slug, patch)) };
    }
    let rec = this.records.get(key);
    if (!rec) rec = applyServerSong(undefined, cur.song, cur.artist_slug, cur.title_slug, this.role);
    const withText = structuredClone(edit);
    if (withText.tr) withText.tr.text = cur.song.lines[edit.tr.index].text;
    if (withText.times) for (const x of withText.times) x.text = cur.song.lines[x.index].text;
    rec = withLocalEdit(rec, withText, { pending: this.role === "owner", now: new Date().toISOString() });
    await this.#put(rec);
    return { saved: "device", data: { artist_slug: cur.artist_slug, title_slug: cur.title_slug, song: mergeSong(rec) } };
  }

  hasLocalEdits(artistSlug, titleSlug) {
    return hasLocalEdits(this.records.get(songKey(artistSlug, titleSlug))?.local);
  }
}
