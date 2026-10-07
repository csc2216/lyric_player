// Run: node --test "tests/js/*.test.mjs"
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  PREROLL,
  applyHold,
  buildTimeline,
  findCurrentIndex,
  formatTime,
  seekTarget,
} from "../../static/js/sync.js";

const lines = [
  { t: 10, text: "line one" },
  { t: 14.5, text: "line two" },
  { t: 20, text: "第二行" },
  { t: 30, text: "line four" },
];
const tl = buildTimeline(lines);

describe("buildTimeline", () => {
  test("keeps timed lines in order", () => {
    assert.deepEqual(tl, { times: [10, 14.5, 20, 30], indices: [0, 1, 2, 3] });
  });

  test("skips lines without time", () => {
    const t = buildTimeline([{ t: null }, { t: 5 }, { t: undefined }, { t: 8 }, { t: NaN }]);
    assert.deepEqual(t, { times: [5, 8], indices: [1, 3] });
  });

  test("sorts out-of-order times, stable for equal times", () => {
    const t = buildTimeline([{ t: 9 }, { t: 3 }, { t: 3 }, { t: 1 }]);
    assert.deepEqual(t, { times: [1, 3, 3, 9], indices: [3, 1, 2, 0] });
  });

  test("empty", () => {
    assert.deepEqual(buildTimeline([]), { times: [], indices: [] });
  });
});

describe("findCurrentIndex", () => {
  test("before the first line", () => {
    assert.equal(findCurrentIndex(tl, 0), -1);
    assert.equal(findCurrentIndex(tl, 9.99), -1);
  });

  test("exactly at a line start selects that line", () => {
    assert.equal(findCurrentIndex(tl, 10), 0);
    assert.equal(findCurrentIndex(tl, 14.5), 1);
    assert.equal(findCurrentIndex(tl, 30), 3);
  });

  test("between lines selects the earlier one", () => {
    assert.equal(findCurrentIndex(tl, 12), 0);
    assert.equal(findCurrentIndex(tl, 14.49), 0);
    assert.equal(findCurrentIndex(tl, 29.9), 2);
  });

  test("after the last line stays on the last", () => {
    assert.equal(findCurrentIndex(tl, 9999), 3);
  });

  test("float noise at the boundary", () => {
    // 0.1 + 0.2 style rounding must not miss the line start
    const t = buildTimeline([{ t: 0.3 }]);
    assert.equal(findCurrentIndex(t, 0.1 + 0.2 - 1e-12), 0);
  });

  test("positive offset delays lines", () => {
    assert.equal(findCurrentIndex(tl, 10, 500), -1);
    assert.equal(findCurrentIndex(tl, 10.5, 500), 0);
  });

  test("negative offset makes lines earlier", () => {
    assert.equal(findCurrentIndex(tl, 9.5, -500), 0);
    assert.equal(findCurrentIndex(tl, 9.49, -500), -1);
  });

  test("maps back to original indices when some lines are untimed", () => {
    const t = buildTimeline([{ t: null }, { t: 5 }, { t: null }, { t: 8 }]);
    assert.equal(findCurrentIndex(t, 6), 1);
    assert.equal(findCurrentIndex(t, 8), 3);
  });

  test("duplicate times pick the last of them", () => {
    const t = buildTimeline([{ t: 1 }, { t: 2 }, { t: 2 }, { t: 3 }]);
    assert.equal(findCurrentIndex(t, 2.5), 2);
  });

  test("empty timeline", () => {
    assert.equal(findCurrentIndex(buildTimeline([]), 5), -1);
  });

  test("matches a linear scan on many points", () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ t: i * 1.37 }));
    const t = buildTimeline(many);
    for (let now = -1; now < 300; now += 0.173) {
      let expected = -1;
      many.forEach((l, i) => {
        if (l.t <= now + 1e-6) expected = i; // same tolerance as findCurrentIndex
      });
      assert.equal(findCurrentIndex(t, now), expected, `now=${now}`);
    }
  });
});

describe("seekTarget", () => {
  test("subtracts preroll and applies offset", () => {
    assert.equal(seekTarget(10, 0), 10 - PREROLL);
    assert.equal(seekTarget(10, 1000), 11 - PREROLL);
    assert.equal(seekTarget(10, -500, 0), 9.5);
  });

  test("never negative", () => {
    assert.equal(seekTarget(0.05, 0), 0);
    assert.equal(seekTarget(1, -2000), 0);
  });
});

describe("applyHold", () => {
  const hold = { index: 2, from: 19.85, until: 20 };

  test("no hold passes through", () => {
    assert.deepEqual(applyHold(1, null, 5), { index: 1, hold: null });
  });

  test("keeps the clicked line during preroll", () => {
    assert.deepEqual(applyHold(1, hold, 19.9), { index: 2, hold });
  });

  test("expires at the line start", () => {
    assert.deepEqual(applyHold(2, hold, 20), { index: 2, hold: null });
  });

  test("expires if the user jumps far back", () => {
    assert.deepEqual(applyHold(0, hold, 11), { index: 0, hold: null });
  });
});

describe("formatTime", () => {
  test("formats", () => {
    assert.equal(formatTime(0), "0:00");
    assert.equal(formatTime(253.32), "4:13");
    assert.equal(formatTime(59.6), "1:00");
    assert.equal(formatTime(null), "?");
  });
});
