// Offset calibration state machine. Pure (no DOM / player) — unit tested with `node --test`.
//
//   idle ──enter──▶ armed ──S──▶ listening ──S──▶ confirming ──Enter──▶ idle (save)
//                    ▲                                 │
//                    └──────────── S / retry ──────────┘
//   any active state ──Esc──▶ idle (restore original offset)
//   any active state ──select line──▶ armed (new target)
//   any active state ──estimate──▶ idle (apply + save duration-based offset)
//
// calibrate(state, event) returns {state, effects}; the caller performs the effects:
//   {type: "play", at}        seek to `at` (player seconds) and play
//   {type: "pause"}
//   {type: "setOffset", ms}   apply offset locally (highlight), not saved
//   {type: "save", ms}        persist offset_ms

/** Seconds of lead-in before the target line when listening for it. */
export const LEAD_IN_S = 8;
/** Seconds before the target line when replaying with the new offset. */
export const REPLAY_LEAD_S = 3;

export const IDLE = Object.freeze({ phase: "idle" });

/** Default target: the 2nd timed line (the 1st often overlaps the intro), else the 1st. */
export function defaultTarget(timeline) {
  return timeline.indices[1] ?? timeline.indices[0] ?? null;
}

const same = (state) => ({ state, effects: [] });

/**
 * @param {object} state  IDLE or {phase, target, t, original, guess, proposed}
 *   target: line index; t: its LRC time; original: offset when calibration began;
 *   guess: offset used to pick where listening starts; proposed: measured offset
 * @param {object} event
 *   {type: "enter", target, t, offset} | {type: "select", target, t} | {type: "s", now}
 *   | {type: "retry"} | {type: "confirm"} | {type: "cancel"} | {type: "estimate", ms}
 */
export function calibrate(state, event) {
  const active = state.phase !== "idle";
  switch (event.type) {
    case "enter":
      if (active || event.target === null || event.target === undefined) return same(state);
      return {
        state: { phase: "armed", target: event.target, t: event.t, original: event.offset, guess: event.offset, proposed: null },
        effects: [],
      };

    case "select": {
      if (!active) return same(state);
      const effects = [];
      if (state.phase === "confirming") effects.push({ type: "setOffset", ms: state.original });
      if (state.phase !== "armed") effects.push({ type: "pause" });
      return { state: { ...state, phase: "armed", target: event.target, t: event.t, proposed: null }, effects };
    }

    case "s":
      if (state.phase === "armed") {
        const at = Math.max(0, state.t + state.guess / 1000 - LEAD_IN_S);
        return { state: { ...state, phase: "listening" }, effects: [{ type: "play", at }] };
      }
      if (state.phase === "listening") {
        const proposed = Math.round((event.now - state.t) * 1000);
        const at = Math.max(0, state.t + proposed / 1000 - REPLAY_LEAD_S);
        return {
          state: { ...state, phase: "confirming", proposed },
          effects: [
            { type: "setOffset", ms: proposed },
            { type: "play", at },
          ],
        };
      }
      if (state.phase === "confirming") return calibrate(state, { type: "retry" });
      return same(state);

    case "retry":
      if (state.phase !== "confirming") return same(state);
      // Next attempt starts listening around the new estimate.
      return {
        state: { ...state, phase: "armed", guess: state.proposed, proposed: null },
        effects: [
          { type: "setOffset", ms: state.original },
          { type: "pause" },
        ],
      };

    case "confirm":
      if (state.phase !== "confirming") return same(state);
      return { state: IDLE, effects: [{ type: "save", ms: state.proposed }] };

    case "cancel":
      if (!active) return same(state);
      return { state: IDLE, effects: [{ type: "setOffset", ms: state.original }] };

    case "estimate":
      if (!active) return same(state);
      return {
        state: IDLE,
        effects: [
          { type: "setOffset", ms: event.ms },
          { type: "save", ms: event.ms },
        ],
      };

    default:
      return same(state);
  }
}
