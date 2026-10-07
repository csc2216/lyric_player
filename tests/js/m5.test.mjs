// Run: node --test "tests/js/*.test.mjs"
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { BACK_LEAD_S, IDLE, tapSync, tapTimesToLines } from "../../static/js/tapping.js";
import { pickNextVideo } from "../../static/js/util.js";

function run(events, state = IDLE) {
  const effects = [];
  for (const e of events) {
    const r = tapSync(state, e);
    state = r.state;
    effects.push(...r.effects);
  }
  return { state, effects };
}

describe("tapSync", () => {
  test("start plays from the beginning, first line is next", () => {
    const { state, effects } = run([{ type: "start", count: 3 }]);
    assert.deepEqual(state, { phase: "tapping", index: 0, count: 3, times: [] });
    assert.deepEqual(effects, [{ type: "play", at: 0 }]);
  });

  test("taps record times and advance; last tap finishes", () => {
    const { state, effects } = run([
      { type: "start", count: 3 },
      { type: "tap", now: 5.1 },
      { type: "tap", now: 9.4 },
      { type: "tap", now: 14 },
    ]);
    assert.equal(state, IDLE);
    assert.deepEqual(effects.at(-1), { type: "done", times: [5.1, 9.4, 14] });
  });

  test("a tap not after the previous one is rejected", () => {
    const mid = run([{ type: "start", count: 3 }, { type: "tap", now: 5 }]).state;
    assert.deepEqual(tapSync(mid, { type: "tap", now: 5 }), { state: mid, effects: [{ type: "reject" }] });
    assert.deepEqual(tapSync(mid, { type: "tap", now: 4 }).effects, [{ type: "reject" }]);
  });

  test("back drops the last tap and seeks a bit before the line before it", () => {
    const { state, effects } = run([
      { type: "start", count: 4 },
      { type: "tap", now: 5 },
      { type: "tap", now: 9 },
      { type: "tap", now: 13 },
      { type: "back" },
    ]);
    assert.equal(state.index, 2); // re-tap line 2
    assert.deepEqual(state.times, [5, 9]);
    assert.deepEqual(effects.at(-1), { type: "seek", at: 9 - BACK_LEAD_S });
  });

  test("back to the first line seeks to 0", () => {
    const { state, effects } = run([{ type: "start", count: 3 }, { type: "tap", now: 5 }, { type: "back" }]);
    assert.equal(state.index, 0);
    assert.deepEqual(state.times, []);
    assert.deepEqual(effects.at(-1), { type: "seek", at: 0 });
  });

  test("back on the first line restarts", () => {
    const start = run([{ type: "start", count: 2 }]).state;
    assert.deepEqual(tapSync(start, { type: "back" }), { state: start, effects: [{ type: "seek", at: 0 }] });
  });

  test("back near the start never seeks negative", () => {
    const { effects } = run([{ type: "start", count: 3 }, { type: "tap", now: 0.4 }, { type: "tap", now: 2 }, { type: "back" }]);
    assert.deepEqual(effects.at(-1), { type: "seek", at: 0 });
  });

  test("cancel discards and pauses", () => {
    const mid = run([{ type: "start", count: 3 }, { type: "tap", now: 5 }]).state;
    assert.deepEqual(tapSync(mid, { type: "cancel" }), { state: IDLE, effects: [{ type: "pause" }] });
  });

  test("ignored events", () => {
    for (const e of [{ type: "tap", now: 1 }, { type: "back" }, { type: "cancel" }, { type: "nope" }]) {
      assert.deepEqual(tapSync(IDLE, e), { state: IDLE, effects: [] });
    }
    assert.deepEqual(tapSync(IDLE, { type: "start", count: 0 }).state, IDLE);
    const mid = run([{ type: "start", count: 3 }]).state;
    assert.equal(tapSync(mid, { type: "start", count: 9 }).state, mid);
  });

  test("tapTimesToLines subtracts the offset and rounds", () => {
    assert.deepEqual(tapTimesToLines([5.123, 9.456], 500), [
      { index: 0, t: 4.62 },
      { index: 1, t: 8.96 },
    ]);
    assert.deepEqual(tapTimesToLines([0.2], 1000), [{ index: 0, t: 0 }]);
  });
});

describe("pickNextVideo", () => {
  const yt = { video_id: "a", alternatives: [{ video_id: "b" }, { video_id: "c" }] };

  test("first untried alternative", () => {
    assert.equal(pickNextVideo(yt, new Set(["a"])).video_id, "b");
    assert.equal(pickNextVideo(yt, new Set(["a", "b"])).video_id, "c");
  });

  test("none left", () => {
    assert.equal(pickNextVideo(yt, new Set(["a", "b", "c"])), null);
    assert.equal(pickNextVideo({ video_id: "a", alternatives: [] }, new Set(["a"])), null);
    assert.equal(pickNextVideo(null, new Set()), null);
  });
});
