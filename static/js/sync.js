// Pure timing helpers (no DOM, no player) — unit tested with `node --test`.

// Seek this many seconds before a line so its first syllable isn't clipped.
export const PREROLL = 0.15;

// Float tolerance when comparing line start times with the player clock.
const EPS = 1e-6;

/**
 * Lines that have a time, in time order.
 * @param {{t: number|null}[]} lines
 * @returns {{times: number[], indices: number[]}} times[k] belongs to lines[indices[k]]
 */
export function buildTimeline(lines) {
  const timed = [];
  lines.forEach((line, index) => {
    if (typeof line.t === "number" && Number.isFinite(line.t)) timed.push({ t: line.t, index });
  });
  // Stable sort: equal times keep file order.
  timed.sort((a, b) => a.t - b.t);
  return { times: timed.map((x) => x.t), indices: timed.map((x) => x.index) };
}

/**
 * Index (into the original lines) of the line playing at `now`:
 * the last line with t + offset <= now. -1 before the first line.
 * Binary search, O(log n).
 */
export function findCurrentIndex(timeline, now, offsetMs = 0) {
  const { times, indices } = timeline;
  const shifted = now - offsetMs / 1000 + EPS;
  let lo = 0;
  let hi = times.length; // first k with times[k] > shifted
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (times[mid] <= shifted) lo = mid + 1;
    else hi = mid;
  }
  return lo === 0 ? -1 : indices[lo - 1];
}

/** Player time to seek to when a line is clicked. */
export function seekTarget(t, offsetMs = 0, preroll = PREROLL) {
  return Math.max(0, t + offsetMs / 1000 - preroll);
}

/**
 * After clicking a line we seek PREROLL early, so for a moment the clock is
 * still inside the previous line. A "hold" keeps the clicked line highlighted
 * until its real start time is reached.
 *
 * @param {number} computed index from findCurrentIndex
 * @param {{index: number, from: number, until: number}|null} hold
 *   from = seek target, until = line start (both in player time)
 * @param {number} now player time
 * @returns {{index: number, hold: object|null}} hold is null once expired
 */
export function applyHold(computed, hold, now) {
  if (!hold) return { index: computed, hold: null };
  // Reached the line, or the user jumped somewhere else (back past the seek point).
  if (now >= hold.until || now < hold.from - 1) return { index: computed, hold: null };
  return { index: hold.index, hold };
}

/** "m:ss" for durations/time stamps; "?" when unknown. */
export function formatTime(seconds) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return "?";
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Line to jump to with ←/→ (dir -1 / +1), following time order.
 * From "before the first line" (-1), → goes to the first line and ← stays put.
 * @returns {number|null} line index, or null when there is nowhere to go
 */
export function adjacentLine(timeline, currentIndex, dir) {
  const { indices } = timeline;
  if (!indices.length) return null;
  const k = indices.indexOf(currentIndex);
  if (k === -1) return dir > 0 ? indices[0] : null;
  const next = k + (dir > 0 ? 1 : -1);
  return next >= 0 && next < indices.length ? indices[next] : null;
}
