// Manual tap-sync for songs without timestamps. Pure — unit tested with `node --test`.
//
//   idle ──start──▶ tapping(index 0, plays from 0:00)
//   tapping ──tap(now)──▶ tapping(index+1) … last line ──▶ idle + {done, times}
//   tapping ──back──▶ tapping(index-1), seek a little before the previous tap
//   tapping ──cancel──▶ idle (nothing saved)
//
// Effects: {type:"play", at} | {type:"seek", at} | {type:"pause"} | {type:"reject"} | {type:"done", times}

/** After Backspace, resume this many seconds before the previous line's tap. */
export const BACK_LEAD_S = 1;

export const IDLE = Object.freeze({ phase: "idle" });

const same = (state) => ({ state, effects: [] });

/**
 * @param {object} state IDLE or {phase: "tapping", index, count, times}
 *   index: line to tap next; times[i]: player time recorded for line i (< index)
 * @param {object} event {type: "start", count} | {type: "tap", now} | {type: "back"} | {type: "cancel"}
 */
export function tapSync(state, event) {
  const tapping = state.phase === "tapping";
  switch (event.type) {
    case "start":
      if (tapping || !(event.count > 0)) return same(state);
      return { state: { phase: "tapping", index: 0, count: event.count, times: [] }, effects: [{ type: "play", at: 0 }] };

    case "tap": {
      if (!tapping) return same(state);
      const prev = state.times[state.index - 1];
      // Lines must be in time order; a tap at/before the previous one is a mistake.
      if (prev !== undefined && event.now <= prev) return { state, effects: [{ type: "reject" }] };
      const times = [...state.times, event.now];
      if (state.index + 1 >= state.count) return { state: IDLE, effects: [{ type: "done", times }] };
      return { state: { ...state, index: state.index + 1, times }, effects: [] };
    }

    case "back": {
      if (!tapping) return same(state);
      if (state.index === 0) return { state, effects: [{ type: "seek", at: 0 }] };
      const index = state.index - 1;
      const times = state.times.slice(0, index);
      const at = index > 0 ? Math.max(0, times[index - 1] - BACK_LEAD_S) : 0;
      return { state: { ...state, index, times }, effects: [{ type: "seek", at }] };
    }

    case "cancel":
      if (!tapping) return same(state);
      return { state: IDLE, effects: [{ type: "pause" }] };

    default:
      return same(state);
  }
}

/** Recorded player times -> PATCH line updates (LRC time = player time − offset), centisecond precision. */
export function tapTimesToLines(times, offsetMs = 0) {
  return times.map((now, index) => ({ index, t: Math.max(0, Math.round((now - offsetMs / 1000) * 100) / 100) }));
}
