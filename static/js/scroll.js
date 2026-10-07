// Auto-scroll and "back to current line" logic.
// lineStatus / centerDelta are pure (unit tested); AutoScroller wires them to the DOM.

/** Middle share of the visible area a current line may sit in without scrolling. */
export const CENTER_BAND = 0.4;
/** Auto-scroll pauses this long after the user scrolls by hand. */
export const MANUAL_SCROLL_PAUSE_MS = 3000;

/**
 * Where a line sits relative to the visible lyrics region.
 * @param {{top: number, bottom: number}} line
 * @param {{top: number, bottom: number}} region same coordinate space
 * @returns {"center"|"visible"|"offscreen"}
 */
export function lineStatus(line, region, band = CENTER_BAND) {
  const height = region.bottom - region.top;
  if (height <= 0 || line.bottom <= region.top || line.top >= region.bottom) return "offscreen";
  const lineMid = (line.top + line.bottom) / 2;
  const regionMid = (region.top + region.bottom) / 2;
  return Math.abs(lineMid - regionMid) <= (band * height) / 2 ? "center" : "visible";
}

/** Pixels to scroll so the line's middle lands on the region's middle. */
export function centerDelta(line, region) {
  return (line.top + line.bottom) / 2 - (region.top + region.bottom) / 2;
}

const USER_SCROLL_KEYS = new Set(["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown"]);

export class AutoScroller {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.main scroll container on wide screens (window scrolls on narrow ones)
   * @param {() => HTMLElement|null} opts.coverEl sticky element covering the top of the region
   * @param {() => HTMLElement|null} opts.currentEl the highlighted line
   * @param {(show: boolean) => void} opts.onOffscreen show/hide the "back to current" button
   */
  constructor({ main, coverEl, currentEl, onOffscreen }) {
    this.main = main;
    this.coverEl = coverEl;
    this.currentEl = currentEl;
    this.onOffscreen = onOffscreen;
    this.enabled = true;
    this.pausedUntil = 0;
    this.buttonShown = false;
    this.pending = false;

    const pause = () => this.pauseForUser();
    for (const target of [main, window]) {
      target.addEventListener("wheel", pause, { passive: true });
      target.addEventListener("touchmove", pause, { passive: true });
    }
    // Dragging a scrollbar: mousedown lands on the scrolling element itself, past its content width.
    main.addEventListener("mousedown", (e) => {
      if (e.target === main && e.offsetX >= main.clientWidth) pause();
    });
    document.addEventListener("mousedown", (e) => {
      const root = document.documentElement;
      if (e.target === root && e.clientX >= root.clientWidth) pause();
    });
    document.addEventListener("keydown", (e) => {
      if (USER_SCROLL_KEYS.has(e.key) && !e.defaultPrevented) pause();
    });
    const onScroll = () => this.scheduleCheck();
    main.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
  }

  pauseForUser() {
    this.pausedUntil = performance.now() + MANUAL_SCROLL_PAUSE_MS;
  }

  /** Visible lyrics region in viewport coordinates (below the sticky player). */
  region() {
    const usesMain = this.#scroller() === this.main;
    const box = usesMain ? this.main.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
    let top = Math.max(box.top, 0);
    const cover = this.coverEl();
    if (cover && cover.offsetParent !== null) top = Math.max(top, cover.getBoundingClientRect().bottom);
    return { top, bottom: Math.min(box.bottom, window.innerHeight) };
  }

  /** Called when the highlighted line changes. */
  follow() {
    const el = this.currentEl();
    if (el && this.enabled && performance.now() >= this.pausedUntil) {
      if (lineStatus(el.getBoundingClientRect(), this.region()) !== "center") this.#scrollTo(el, true);
    }
    this.scheduleCheck();
  }

  /** "C" / button: bring the current line to the middle regardless of settings. */
  center() {
    const el = this.currentEl();
    if (!el) return false;
    this.pausedUntil = 0;
    this.#scrollTo(el, true);
    return true;
  }

  scheduleCheck() {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      const el = this.currentEl();
      const show = Boolean(el) && lineStatus(el.getBoundingClientRect(), this.region()) === "offscreen";
      if (show !== this.buttonShown) {
        this.buttonShown = show;
        this.onOffscreen(show);
      }
    });
  }

  #scroller() {
    const style = getComputedStyle(this.main);
    const scrollable = /(auto|scroll)/.test(style.overflowY) && this.main.scrollHeight > this.main.clientHeight + 1;
    return scrollable ? this.main : window;
  }

  #scrollTo(el, smooth) {
    const delta = centerDelta(el.getBoundingClientRect(), this.region());
    this.#scroller().scrollBy({ top: delta, behavior: smooth ? "smooth" : "auto" });
  }
}
