// Run: node --test "tests/js/*.test.mjs"
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { IDLE, LEAD_IN_S, REPLAY_LEAD_S, calibrate, defaultTarget } from "../../static/js/calibration.js";
import { buildTimeline } from "../../static/js/sync.js";
import { estimateOffsetMs, formatOffsetSeconds } from "../../static/js/util.js";

/** Run events in order; returns final state and all effects. */
function run(events, state = IDLE) {
  const effects = [];
  for (const e of events) {
    const r = calibrate(state, e);
    state = r.state;
    effects.push(...r.effects);
  }
  return { state, effects };
}

const enter = { type: "enter", target: 1, t: 20, offset: 500 };

describe("defaultTarget", () => {
  test("second timed line", () => {
    assert.equal(defaultTarget(buildTimeline([{ t: 0.5 }, { t: null }, { t: 20 }, { t: 25 }])), 2);
  });
  test("only one timed line", () => {
    assert.equal(defaultTarget(buildTimeline([{ t: null }, { t: 3 }])), 1);
  });
  test("no timed lines", () => {
    assert.equal(defaultTarget(buildTimeline([{ t: null }])), null);
  });
});

describe("calibrate: happy path", () => {
  test("enter -> armed", () => {
    const { state, effects } = run([enter]);
    assert.deepEqual(state, { phase: "armed", target: 1, t: 20, original: 500, guess: 500, proposed: null });
    assert.deepEqual(effects, []);
  });

  test("first S plays from t + offset - 8s", () => {
    const { state, effects } = run([enter, { type: "s" }]);
    assert.equal(state.phase, "listening");
    assert.deepEqual(effects, [{ type: "play", at: 20 + 0.5 - LEAD_IN_S }]);
  });

  test("start time never below 0", () => {
    const { effects } = run([{ type: "enter", target: 0, t: 3, offset: -1000 }, { type: "s" }]);
    assert.deepEqual(effects, [{ type: "play", at: 0 }]);
  });

  test("second S measures offset = now - t and replays 3s before", () => {
    const { state, effects } = run([enter, { type: "s" }, { type: "s", now: 22.345 }]);
    assert.equal(state.phase, "confirming");
    assert.equal(state.proposed, 2345);
    assert.deepEqual(effects.slice(1), [
      { type: "setOffset", ms: 2345 },
      { type: "play", at: 20 + 2.345 - REPLAY_LEAD_S },
    ]);
  });

  test("negative offsets (singing earlier than LRC says)", () => {
    const { state } = run([enter, { type: "s" }, { type: "s", now: 19.2 }]);
    assert.equal(state.proposed, -800);
  });

  test("confirm saves and returns to idle", () => {
    const { state, effects } = run([enter, { type: "s" }, { type: "s", now: 21 }, { type: "confirm" }]);
    assert.equal(state, IDLE);
    assert.deepEqual(effects.at(-1), { type: "save", ms: 1000 });
  });
});

describe("calibrate: retry / cancel / select / estimate", () => {
  const confirming = run([enter, { type: "s" }, { type: "s", now: 23 }]).state;

  test("S while confirming = retry: back to armed, original offset restored", () => {
    const { state, effects } = calibrate(confirming, { type: "s" });
    assert.equal(state.phase, "armed");
    assert.equal(state.guess, 3000); // next listen starts near the new estimate
    assert.equal(state.original, 500);
    assert.deepEqual(effects, [
      { type: "setOffset", ms: 500 },
      { type: "pause" },
    ]);
    // and the next S starts from t + guess - 8
    assert.deepEqual(calibrate(state, { type: "s" }).effects, [{ type: "play", at: 20 + 3 - LEAD_IN_S }]);
  });

  test("retry button behaves like S", () => {
    assert.deepEqual(calibrate(confirming, { type: "retry" }), calibrate(confirming, { type: "s" }));
  });

  for (const phase of ["armed", "listening", "confirming"]) {
    test(`cancel from ${phase} restores the original offset`, () => {
      const events = { armed: [enter], listening: [enter, { type: "s" }], confirming: [enter, { type: "s" }, { type: "s", now: 23 }] };
      const { state } = run(events[phase]);
      assert.deepEqual(calibrate(state, { type: "cancel" }), {
        state: IDLE,
        effects: [{ type: "setOffset", ms: 500 }],
      });
    });
  }

  test("select another line while armed just changes target", () => {
    const { state, effects } = calibrate(run([enter]).state, { type: "select", target: 4, t: 40 });
    assert.equal(state.phase, "armed");
    assert.equal(state.target, 4);
    assert.equal(state.t, 40);
    assert.deepEqual(effects, []);
  });

  test("select while listening pauses and re-arms", () => {
    const listening = run([enter, { type: "s" }]).state;
    const { state, effects } = calibrate(listening, { type: "select", target: 4, t: 40 });
    assert.equal(state.phase, "armed");
    assert.deepEqual(effects, [{ type: "pause" }]);
  });

  test("select while confirming restores the offset first", () => {
    const { state, effects } = calibrate(confirming, { type: "select", target: 4, t: 40 });
    assert.equal(state.phase, "armed");
    assert.equal(state.proposed, null);
    assert.deepEqual(effects, [{ type: "setOffset", ms: 500 }, { type: "pause" }]);
  });

  test("estimate applies and saves", () => {
    assert.deepEqual(calibrate(run([enter]).state, { type: "estimate", ms: 3500 }), {
      state: IDLE,
      effects: [
        { type: "setOffset", ms: 3500 },
        { type: "save", ms: 3500 },
      ],
    });
  });
});

describe("calibrate: ignored events", () => {
  test("nothing happens in idle", () => {
    for (const e of [{ type: "s", now: 1 }, { type: "confirm" }, { type: "cancel" }, { type: "retry" }, { type: "select", target: 1, t: 1 }, { type: "estimate", ms: 1 }]) {
      assert.deepEqual(calibrate(IDLE, e), { state: IDLE, effects: [] });
    }
  });

  test("enter without a target or while active is ignored", () => {
    assert.deepEqual(calibrate(IDLE, { type: "enter", target: null, t: null, offset: 0 }).state, IDLE);
    const armed = run([enter]).state;
    assert.equal(calibrate(armed, { ...enter, target: 9 }).state, armed);
  });

  test("confirm / retry only while confirming", () => {
    const listening = run([enter, { type: "s" }]).state;
    assert.equal(calibrate(listening, { type: "confirm" }).state, listening);
    assert.equal(calibrate(listening, { type: "retry" }).state, listening);
  });

  test("unknown event", () => {
    assert.deepEqual(calibrate(IDLE, { type: "bogus" }), { state: IDLE, effects: [] });
  });
});

describe("estimateOffsetMs / formatOffsetSeconds", () => {
  test("same rule as the backend", () => {
    assert.equal(estimateOffsetMs(217.5, 214), 3500);
    assert.equal(estimateOffsetMs(215, 214), 1000);
    assert.equal(estimateOffsetMs(214.9, 214), 0);
    assert.equal(estimateOffsetMs(210, 214), 0);
    assert.equal(estimateOffsetMs(null, 214), 0);
  });

  test("format", () => {
    assert.equal(formatOffsetSeconds(3500), "+3.5 秒");
    assert.equal(formatOffsetSeconds(1000), "+1 秒");
    assert.equal(formatOffsetSeconds(-200), "−0.2 秒");
    assert.equal(formatOffsetSeconds(0), "0 秒");
  });
});

describe("keyboard commandFor", async () => {
  const { commandFor } = await import("../../static/js/keyboard.js");
  const k = (code, key, shiftKey = false) => commandFor({ code, key, shiftKey });

  test("plain keys", () => {
    assert.equal(k("Space", " "), "togglePlay");
    assert.equal(k("KeyS", "s"), "calibrateKey");
    assert.equal(k("BracketLeft", "["), "offsetDown");
    assert.equal(k("BracketRight", "]"), "offsetUp");
    assert.equal(k("Enter", "Enter"), "confirm");
    assert.equal(k("KeyC", "c"), "centerCurrent");
    assert.equal(k("KeyB", "b"), "toggleSidebar");
    assert.equal(k("Backspace", "Backspace"), "back");
    assert.equal(k("", "b"), "toggleSidebar");
  });

  test("Shift variants", () => {
    assert.equal(k("KeyS", "S", true), "calibrateToggle");
    assert.equal(k("BracketLeft", "{", true), "offsetDownBig");
    assert.equal(k("BracketRight", "}", true), "offsetUpBig");
    assert.equal(k("KeyA", "A", true), "toggleAutoScroll"); // no Shift binding: same as plain
  });

  test("falls back to the character when code is missing", () => {
    assert.equal(k("", "{", true), "offsetDownBig");
    assert.equal(k("", "s"), "calibrateKey");
    assert.equal(k("", "x"), null);
  });

  test("unbound keys", () => {
    assert.equal(k("KeyZ", "z"), null);
    assert.equal(k("Tab", "Tab"), null);
  });
});
