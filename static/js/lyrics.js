// Lyric list rendering, current-line highlight and the playback sync loop.

import { applyHold, buildTimeline, findCurrentIndex, seekTarget } from "./sync.js";

const TICK_MS = 50; // ~20 updates per second is plenty for line-level sync

export class LyricsView {
  /**
   * @param {HTMLElement} container
   * @param {(seconds: number) => void} onSeek called with the player time to jump to
   */
  constructor(container, onSeek) {
    this.container = container;
    this.onSeek = onSeek;
    this.song = null;
    this.timeline = buildTimeline([]);
    this.lineEls = [];
    this.current = -1;
    this.hold = null;
    container.addEventListener("click", (e) => this.#onClick(e));
  }

  get offsetMs() {
    return this.song?.offset_ms ?? 0;
  }

  render(song) {
    this.song = song;
    this.timeline = buildTimeline(song.lines);
    this.current = -1;
    this.hold = null;
    this.lineEls = song.lines.map((line, i) => {
      const div = document.createElement("div");
      div.className = "line";
      if (line.break_before) div.classList.add("break");
      const timed = typeof line.t === "number";
      if (timed) {
        // div, not <button>: a focused button would also react to Space
        div.setAttribute("role", "button");
        div.tabIndex = -1;
      } else {
        div.classList.add("untimed");
      }
      div.dataset.index = String(i);
      const orig = document.createElement("div");
      orig.className = "orig";
      orig.textContent = line.text;
      const tr = document.createElement("div");
      tr.className = "tr";
      tr.textContent = line.tr || "";
      if (!line.tr) tr.classList.add("missing");
      div.append(orig, tr);
      return div;
    });
    this.container.replaceChildren(...this.lineEls);
  }

  clear() {
    this.song = null;
    this.lineEls = [];
    this.current = -1;
    this.container.replaceChildren();
  }

  /** Update the highlight for player time `now` (touches the DOM only on change). */
  update(now) {
    if (!this.song) return;
    const computed = findCurrentIndex(this.timeline, now, this.offsetMs);
    const { index, hold } = applyHold(computed, this.hold, now);
    this.hold = hold;
    this.setCurrent(index);
  }

  setCurrent(index) {
    if (index === this.current) return;
    this.lineEls[this.current]?.classList.remove("current");
    this.current = index;
    this.lineEls[index]?.classList.add("current");
  }

  #onClick(e) {
    const lineEl = e.target.closest(".line");
    if (!lineEl || !this.song) return;
    const index = Number(lineEl.dataset.index);
    const t = this.song.lines[index]?.t;
    if (typeof t !== "number") return;
    const target = seekTarget(t, this.offsetMs);
    this.hold = { index, from: target, until: t + this.offsetMs / 1000 };
    this.setCurrent(index);
    this.onSeek(target);
  }
}

/** Calls tick(now) about every TICK_MS while running, via requestAnimationFrame. */
export class SyncLoop {
  constructor(getTime, tick) {
    this.getTime = getTime;
    this.tick = tick;
    this.frame = null;
    this.last = 0;
  }

  start() {
    if (this.frame !== null) return;
    const step = (ts) => {
      if (ts - this.last >= TICK_MS) {
        this.last = ts;
        this.tick(this.getTime());
      }
      this.frame = requestAnimationFrame(step);
    };
    this.frame = requestAnimationFrame(step);
  }

  stop() {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    // one last update so the highlight matches where playback stopped
    this.tick(this.getTime());
  }
}
