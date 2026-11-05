// Run: node --test "tests/js/*.test.mjs"
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { normalizeSettings } from "../../static/js/settings.js";
import { pickNextSong } from "../../static/js/util.js";

const tree = [
  { artist_slug: "artist-a", songs: [{ title_slug: "one" }, { title_slug: "two" }, { title_slug: "three" }] },
  { artist_slug: "artist-b", songs: [{ title_slug: "solo" }] },
];
const at = (artist_slug, title_slug) => ({ artist_slug, title_slug });

describe("pickNextSong", () => {
  test("stop / unknown mode: nothing", () => {
    assert.equal(pickNextSong(tree, at("artist-a", "one"), "stop"), null);
    assert.equal(pickNextSong(tree, at("artist-a", "one"), "bogus"), null);
    assert.equal(pickNextSong(tree, null, "shuffle"), null);
  });

  test("artist: next song, wrapping around", () => {
    assert.deepEqual(pickNextSong(tree, at("artist-a", "one"), "artist"), at("artist-a", "two"));
    assert.deepEqual(pickNextSong(tree, at("artist-a", "three"), "artist"), at("artist-a", "one"));
  });

  test("artist: single song repeats itself", () => {
    assert.deepEqual(pickNextSong(tree, at("artist-b", "solo"), "artist"), at("artist-b", "solo"));
  });

  test("artist: current song not in the tree", () => {
    assert.equal(pickNextSong(tree, at("artist-a", "gone"), "artist"), null);
  });

  test("shuffle: never the current song while others exist", () => {
    const cur = at("artist-a", "two");
    const seen = new Set();
    for (const r of [0, 0.25, 0.5, 0.75, 0.999999]) {
      const next = pickNextSong(tree, cur, "shuffle", () => r);
      assert.notDeepEqual(next, cur);
      seen.add(`${next.artist_slug}/${next.title_slug}`);
    }
    assert.deepEqual([...seen].sort(), ["artist-a/one", "artist-a/three", "artist-b/solo"]);
  });

  test("shuffle: only one song in the library replays it", () => {
    const one = [{ artist_slug: "x", songs: [{ title_slug: "y" }] }];
    assert.deepEqual(pickNextSong(one, at("x", "y"), "shuffle", () => 0.5), at("x", "y"));
  });
});

test("settings endMode: default stop, invalid dropped", () => {
  assert.equal(normalizeSettings({}).endMode, "stop");
  assert.equal(normalizeSettings({ endMode: "shuffle" }).endMode, "shuffle");
  assert.equal(normalizeSettings({ endMode: "artist" }).endMode, "artist");
  assert.equal(normalizeSettings({ endMode: "loop" }).endMode, "stop");
});
