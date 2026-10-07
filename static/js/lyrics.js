// Lyric list rendering, current-line highlight, translation editing and the playback sync loop.

import { PREROLL, adjacentLine, applyHold, buildTimeline, findCurrentIndex, seekTarget } from "./sync.js";
import { el } from "./ui.js";

const TICK_MS = 50; // ~20 updates per second is plenty for line-level sync
// A click on the translation waits this long to see whether it becomes a double-click (edit).
const DBLCLICK_WAIT_MS = 250;
const MISSING_TR = "（沒有翻譯，雙擊編輯）";

export class LyricsView {
  /**
   * @param {HTMLElement} container
   * @param {object} handlers
   * @param {(seconds: number, play: boolean) => void} handlers.onSeek player time to jump to
   * @param {(index: number) => void} handlers.onCurrentChange highlighted line changed
   * @param {(index: number, tr: string) => Promise<void>} handlers.onEditTranslation save an edit
   * @param {(index: number) => void} handlers.onRetranslate retranslate one line
   * @param {(index: number) => void} handlers.onSelectTarget calibration: a line was clicked
   */
  constructor(container, handlers) {
    this.container = container;
    this.handlers = handlers;
    this.song = null;
    this.timeline = buildTimeline([]);
    this.lineEls = [];
    this.current = -1;
    this.hold = null;
    this.preroll = PREROLL;
    this.clickTimer = null;
    // Calibration: clicks pick the target line instead of seeking; editing is off.
    this.selectMode = false;
    this.target = -1;
    container.addEventListener("click", (e) => this.#onClick(e));
    container.addEventListener("dblclick", (e) => this.#onDblClick(e));
  }

  get offsetMs() {
    return this.song?.offset_ms ?? 0;
  }

  render(song) {
    this.song = song;
    this.timeline = buildTimeline(song.lines);
    this.current = -1;
    this.hold = null;
    this.target = -1;
    this.lineEls = song.lines.map((line, i) => this.#renderLine(line, i));
    this.container.replaceChildren(...this.lineEls);
  }

  #renderLine(line, i) {
    const div = el("div", "line");
    if (line.break_before) div.classList.add("break");
    if (typeof line.t === "number") {
      // div, not <button>: a focused button would also react to Space
      div.setAttribute("role", "button");
      div.tabIndex = -1;
    } else {
      div.classList.add("untimed");
    }
    div.dataset.index = String(i);
    const tr = el("div", "tr");
    this.#fillTranslation(tr, line.tr);
    tr.title = "雙擊編輯翻譯";
    const actions = el("div", "line-actions");
    const redo = el("button", "icon", "↻");
    redo.type = "button";
    redo.title = "重新翻譯這一行";
    redo.dataset.action = "retranslate";
    actions.append(redo);
    div.append(el("div", "orig", line.text), tr, actions);
    return div;
  }

  #fillTranslation(trEl, text) {
    trEl.textContent = text || MISSING_TR;
    trEl.classList.toggle("missing", !text);
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
    this.handlers.onCurrentChange?.(index);
  }

  get currentEl() {
    return this.lineEls[this.current] ?? null;
  }

  /** Jump to line `index` (must have a time). play=false keeps the player paused. */
  jumpTo(index, play = true) {
    const t = this.song?.lines[index]?.t;
    if (typeof t !== "number") return false;
    const target = seekTarget(t, this.offsetMs, this.preroll);
    this.hold = { index, from: target, until: t + this.offsetMs / 1000 };
    this.setCurrent(index);
    this.handlers.onSeek(target, play);
    return true;
  }

  /** ←/→ */
  step(dir, play) {
    const index = adjacentLine(this.timeline, this.current, dir);
    return index === null ? false : this.jumpTo(index, play);
  }

  setTranslation(index, text) {
    if (!this.song) return;
    this.song.lines[index].tr = text;
    const trEl = this.lineEls[index]?.querySelector(".tr");
    if (trEl && !trEl.isContentEditable) this.#fillTranslation(trEl, text);
  }

  /** Mark the calibration target line (-1 = none). */
  setTarget(index) {
    this.lineEls[this.target]?.classList.remove("calib-target");
    this.target = index;
    this.lineEls[index]?.classList.add("calib-target");
  }

  setLineBusy(index, busy) {
    this.lineEls[index]?.classList.toggle("busy", busy);
  }

  #onClick(e) {
    if (e.target.closest("[contenteditable]")) return;
    const lineEl = e.target.closest(".line");
    if (!lineEl || !this.song) return;
    const index = Number(lineEl.dataset.index);
    if (this.selectMode) {
      if (typeof this.song.lines[index]?.t === "number") this.handlers.onSelectTarget?.(index);
      return;
    }
    if (e.target.closest('[data-action="retranslate"]')) {
      e.target.blur();
      this.handlers.onRetranslate?.(index);
      return;
    }
    clearTimeout(this.clickTimer);
    if (e.target.closest(".tr")) {
      // Might be the first half of a double-click (edit): wait before seeking.
      if (e.detail === 1) this.clickTimer = setTimeout(() => this.jumpTo(index), DBLCLICK_WAIT_MS);
      return;
    }
    this.jumpTo(index);
  }

  #onDblClick(e) {
    const trEl = e.target.closest(".tr");
    if (!trEl || trEl.isContentEditable || !this.song || this.selectMode) return;
    clearTimeout(this.clickTimer);
    this.#startEdit(trEl, Number(trEl.closest(".line").dataset.index));
  }

  #startEdit(trEl, index) {
    const original = this.song.lines[index].tr || "";
    let done = false;
    trEl.textContent = original;
    trEl.classList.remove("missing");
    trEl.classList.add("editing");
    trEl.contentEditable = "plaintext-only";
    if (trEl.contentEditable !== "plaintext-only") trEl.contentEditable = "true"; // older browsers
    trEl.focus();
    const range = document.createRange();
    range.selectNodeContents(trEl);
    getSelection().removeAllRanges();
    getSelection().addRange(range);

    const finish = async (save) => {
      if (done) return;
      done = true;
      trEl.removeEventListener("keydown", onKey);
      trEl.removeEventListener("blur", onBlur);
      const text = trEl.textContent.replace(/\s*\n\s*/g, " ").trim();
      trEl.removeAttribute("contenteditable");
      trEl.classList.remove("editing");
      this.#fillTranslation(trEl, original);
      if (save && text !== original) {
        trEl.classList.add("saving");
        this.#fillTranslation(trEl, text);
        try {
          await this.handlers.onEditTranslation(index, text);
          this.song.lines[index].tr = text;
        } catch {
          this.#fillTranslation(trEl, original); // caller already showed the error
        } finally {
          trEl.classList.remove("saving");
        }
      }
    };
    const onKey = (e) => {
      if (e.isComposing || e.keyCode === 229) return; // IME is still composing (Chinese input)
      if (e.key === "Enter") {
        e.preventDefault();
        finish(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      }
    };
    // Clicking elsewhere keeps what was typed.
    const onBlur = () => finish(true);
    trEl.addEventListener("keydown", onKey);
    trEl.addEventListener("blur", onBlur);
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
