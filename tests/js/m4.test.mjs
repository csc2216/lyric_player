// Run: node --test "tests/js/*.test.mjs"
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { centerDelta, lineStatus } from "../../static/js/scroll.js";
import { DEFAULTS, normalizeSettings } from "../../static/js/settings.js";
import { adjacentLine, buildTimeline } from "../../static/js/sync.js";
import { clampOffset, formatOffset, parseYoutubeId } from "../../static/js/util.js";

describe("adjacentLine", () => {
  const tl = buildTimeline([{ t: 1 }, { t: null }, { t: 5 }, { t: 9 }]);

  test("steps through timed lines, skipping untimed", () => {
    assert.equal(adjacentLine(tl, 0, +1), 2);
    assert.equal(adjacentLine(tl, 2, +1), 3);
    assert.equal(adjacentLine(tl, 3, -1), 2);
    assert.equal(adjacentLine(tl, 2, -1), 0);
  });

  test("edges", () => {
    assert.equal(adjacentLine(tl, 3, +1), null);
    assert.equal(adjacentLine(tl, 0, -1), null);
  });

  test("before the first line", () => {
    assert.equal(adjacentLine(tl, -1, +1), 0);
    assert.equal(adjacentLine(tl, -1, -1), null);
  });

  test("empty timeline", () => {
    assert.equal(adjacentLine(buildTimeline([{ t: null }]), -1, +1), null);
  });
});

describe("lineStatus / centerDelta", () => {
  const region = { top: 400, bottom: 900 }; // height 500, middle 650, band ±100

  test("center band", () => {
    assert.equal(lineStatus({ top: 630, bottom: 670 }, region), "center");
    assert.equal(lineStatus({ top: 530, bottom: 570 }, region), "center"); // mid 550 = edge of band
  });

  test("visible but off-center", () => {
    assert.equal(lineStatus({ top: 410, bottom: 450 }, region), "visible");
    assert.equal(lineStatus({ top: 380, bottom: 420 }, region), "visible"); // partly under the player
  });

  test("offscreen above (under sticky player) and below", () => {
    assert.equal(lineStatus({ top: 350, bottom: 400 }, region), "offscreen");
    assert.equal(lineStatus({ top: 900, bottom: 950 }, region), "offscreen");
  });

  test("degenerate region", () => {
    assert.equal(lineStatus({ top: 0, bottom: 10 }, { top: 500, bottom: 500 }), "offscreen");
  });

  test("delta to center", () => {
    assert.equal(centerDelta({ top: 840, bottom: 860 }, region), 200);
    assert.equal(centerDelta({ top: 90, bottom: 110 }, region), -550);
  });
});

describe("parseYoutubeId", () => {
  const id = "6744glqD6lk";
  for (const input of [
    id,
    ` ${id} `,
    `https://www.youtube.com/watch?v=${id}`,
    `https://www.youtube.com/watch?list=PL1&v=${id}&t=30s`,
    `youtube.com/watch?v=${id}`,
    `https://m.youtube.com/watch?v=${id}`,
    `https://music.youtube.com/watch?v=${id}`,
    `https://youtu.be/${id}?si=abc`,
    `https://www.youtube.com/embed/${id}`,
    `https://www.youtube.com/shorts/${id}`,
    `https://www.youtube-nocookie.com/embed/${id}`,
  ]) {
    test(input, () => assert.equal(parseYoutubeId(input), id));
  }

  for (const bad of ["", "short", "https://example.com/watch?v=6744glqD6lk", "https://youtube.com/watch?v=bad", null]) {
    test(`rejects ${bad}`, () => assert.equal(parseYoutubeId(bad), null));
  }
});

describe("offset helpers", () => {
  test("format", () => {
    assert.equal(formatOffset(0), "0 ms");
    assert.equal(formatOffset(100), "+100 ms");
    assert.equal(formatOffset(-250), "−250 ms");
  });

  test("clamp", () => {
    assert.equal(clampOffset(99999), 60000);
    assert.equal(clampOffset(-99999), -60000);
    assert.equal(clampOffset(100.4), 100);
  });
});

describe("normalizeSettings", () => {
  test("defaults for missing or broken data", () => {
    assert.deepEqual(normalizeSettings(null), DEFAULTS);
    assert.deepEqual(normalizeSettings("x"), DEFAULTS);
  });

  test("keeps valid values, drops invalid", () => {
    const s = normalizeSettings({ autoScroll: false, layout: "inline", theme: "neon", preroll: "0.3", extra: 1 });
    assert.deepEqual(s, { autoScroll: false, layout: "inline", theme: "auto", preroll: 0.3 });
  });

  test("preroll is clamped and validated", () => {
    assert.equal(normalizeSettings({ preroll: 9 }).preroll, 2);
    assert.equal(normalizeSettings({ preroll: -1 }).preroll, 0);
    assert.equal(normalizeSettings({ preroll: "abc" }).preroll, DEFAULTS.preroll);
    assert.equal(normalizeSettings({ preroll: "" }).preroll, DEFAULTS.preroll);
  });
});
