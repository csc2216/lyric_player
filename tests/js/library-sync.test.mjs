// Run: node --test "tests/js/*.test.mjs"
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  applyServerSong,
  hasLocalEdits,
  mergeSong,
  pendingPatch,
  planSync,
  songKey,
  treeFromRecords,
  withLocalEdit,
} from "../../static/js/library-sync.js";

const T0 = "2026-10-07T10:00:00Z";
const T1 = "2026-10-07T11:00:00Z";
const T2 = "2026-10-07T12:00:00Z";

function serverSong(updated_at = T0, extra = {}) {
  return {
    artist: "Test Artist",
    title: "Paper Moon",
    updated_at,
    offset_ms: 0,
    synced: true,
    lines: [
      { t: 1, text: "line one", tr: "第一行" },
      { t: 2, text: "line two", tr: "第二行" },
    ],
    ...extra,
  };
}

const record = (song = serverSong()) => applyServerSong(undefined, song, "test-artist", "paper-moon", "guest");

describe("mergeSong / withLocalEdit", () => {
  test("no local edits = server copy", () => {
    const rec = record();
    assert.deepEqual(mergeSong(rec), rec.server);
    assert.notEqual(mergeSong(rec), rec.server); // a copy, not the same object
    assert.equal(hasLocalEdits(rec.local), false);
  });

  test("offset and translation edits", () => {
    let rec = withLocalEdit(record(), { offset_ms: 700 }, { pending: false, now: T1 });
    rec = withLocalEdit(rec, { tr: { index: 1, text: "line two", tr: "我的翻譯" } }, { pending: false, now: T1 });
    const song = mergeSong(rec);
    assert.equal(song.offset_ms, 700);
    assert.equal(song.lines[1].tr, "我的翻譯");
    assert.equal(song.lines[0].tr, "第一行");
    assert.equal(rec.localUpdatedAt, T1);
    assert.equal(hasLocalEdits(rec.local), true);
  });

  test("translation edit is ignored if the server line text changed", () => {
    let rec = withLocalEdit(record(), { tr: { index: 1, text: "line two", tr: "我的翻譯" } }, { pending: false, now: T1 });
    rec = applyServerSong(rec, serverSong(T2, { lines: [{ t: 1, text: "line one", tr: "a" }, { t: 2, text: "other text", tr: "b" }] }), "test-artist", "paper-moon", "guest");
    assert.equal(mergeSong(rec).lines[1].tr, "b");
  });

  test("tap-sync times", () => {
    const unsynced = record(serverSong(T0, { synced: false, lines: [{ t: null, text: "a", tr: "" }, { t: null, text: "b", tr: "" }] }));
    const rec = withLocalEdit(unsynced, { times: [{ index: 0, text: "a", t: 1.5 }, { index: 1, text: "b", t: 3 }], synced: true }, { pending: false, now: T1 });
    const song = mergeSong(rec);
    assert.deepEqual(song.lines.map((l) => l.t), [1.5, 3]);
    assert.equal(song.synced, true);
  });
});

describe("applyServerSong", () => {
  test("visitor keeps local offset and translations, other fields follow the server", () => {
    let rec = withLocalEdit(record(), { offset_ms: 700 }, { pending: false, now: T1 });
    rec = withLocalEdit(rec, { tr: { index: 0, text: "line one", tr: "我的" } }, { pending: false, now: T1 });
    rec = applyServerSong(rec, serverSong(T2, { offset_ms: 300, title: "New Title" }), "test-artist", "paper-moon", "guest");
    const song = mergeSong(rec);
    assert.equal(song.offset_ms, 700);
    assert.equal(song.lines[0].tr, "我的");
    assert.equal(song.title, "New Title");
    assert.equal(rec.server.offset_ms, 300);
  });

  test("owner: newer pending edit survives, older is dropped", () => {
    const pending = withLocalEdit(record(), { offset_ms: 700 }, { pending: true, now: T1 });
    const kept = applyServerSong(pending, serverSong(T0), "test-artist", "paper-moon", "owner");
    assert.equal(mergeSong(kept).offset_ms, 700);
    assert.equal(kept.pending, true);
    const dropped = applyServerSong(pending, serverSong(T2, { offset_ms: 300 }), "test-artist", "paper-moon", "owner");
    assert.equal(mergeSong(dropped).offset_ms, 300);
    assert.equal(dropped.pending, false);
    assert.deepEqual(dropped.local, {});
  });

  test("owner without pending edits just takes the server copy", () => {
    const rec = applyServerSong(record(), serverSong(T1, { offset_ms: 50 }), "test-artist", "paper-moon", "owner");
    assert.equal(mergeSong(rec).offset_ms, 50);
  });
});

describe("pendingPatch", () => {
  test("combines offset, translations, times", () => {
    let rec = withLocalEdit(record(), { offset_ms: 700 }, { pending: true, now: T1 });
    rec = withLocalEdit(rec, { tr: { index: 1, text: "line two", tr: "x" } }, { pending: true, now: T1 });
    rec = withLocalEdit(rec, { times: [{ index: 1, text: "line two", t: 2.5 }, { index: 0, text: "line one", t: 1 }], synced: true }, { pending: true, now: T1 });
    assert.deepEqual(pendingPatch(rec), {
      offset_ms: 700,
      lines: [
        { index: 0, t: 1 },
        { index: 1, tr: "x", t: 2.5 },
      ],
      synced: true,
    });
  });

  test("nothing pending", () => {
    assert.deepEqual(pendingPatch(record()), {});
  });
});

describe("planSync", () => {
  const tree = [
    { artist: "A", artist_slug: "a", songs: [{ title: "One", title_slug: "one", updated_at: T1 }, { title: "Two", title_slug: "two", updated_at: T0 }] },
  ];
  const rec = (key, updated_at, extra = {}) => [key, { key, server: { updated_at }, local: {}, pending: false, localUpdatedAt: null, ...extra }];

  test("fetch new and changed, remove deleted, skip unchanged", () => {
    const records = new Map([rec("a/two", T0), rec("a/one", T0), rec("gone/song", T0)]);
    assert.deepEqual(planSync(records, tree, "guest"), { push: [], fetch: ["a/one"], remove: ["gone/song"] });
    assert.deepEqual(planSync(new Map(), tree, "guest"), { push: [], fetch: ["a/one", "a/two"], remove: [] });
  });

  test("owner pushes pending edits newer than the server, then refetches", () => {
    const records = new Map([rec("a/one", T1, { pending: true, localUpdatedAt: T2 }), rec("a/two", T0, { pending: true, localUpdatedAt: "2026-10-07T09:00:00Z" })]);
    const plan = planSync(records, tree, "owner");
    assert.deepEqual(plan.push, ["a/one"]);
    assert.deepEqual(plan.fetch, ["a/one", "a/two"]); // a/two: older pending edit gets replaced by the server copy
  });

  test("visitor never pushes", () => {
    const records = new Map([rec("a/one", T1, { pending: true, localUpdatedAt: T2 })]);
    assert.deepEqual(planSync(records, tree, "guest").push, []);
  });
});

describe("treeFromRecords", () => {
  test("groups and sorts like the server, with merged synced flag", () => {
    const records = new Map();
    const add = (a, t, artist, title, synced) => {
      const r = applyServerSong(undefined, serverSong(T0, { artist, title, synced }), a, t, "guest");
      records.set(songKey(a, t), r);
      return r;
    };
    add("b", "z", "beta", "Zed", true);
    add("a", "y", "Alpha", "y song", false);
    const tapped = add("a", "x", "Alpha", "X Song", false);
    records.set("a/x", withLocalEdit(tapped, { times: [], synced: true }, { pending: false, now: T1 }));
    assert.deepEqual(
      treeFromRecords(records).map((a) => [a.artist, a.songs.map((s) => [s.title, s.synced])]),
      [
        ["Alpha", [["X Song", true], ["y song", false]]],
        ["beta", [["Zed", true]]],
      ],
    );
  });
});
