// Calibration mode UI: drives the pure state machine in calibration.js and
// performs its effects on the player / lyrics / offset.

import { IDLE, LEAD_IN_S, REPLAY_LEAD_S, calibrate, defaultTarget } from "./calibration.js";
import { button, el, toast } from "./ui.js";
import { estimateOffsetMs, formatOffset, formatOffsetSeconds } from "./util.js";

export class Calibrator {
  /**
   * @param {object} opts
   * @param {import("./lyrics.js").LyricsView} opts.lyrics
   * @param {import("./player.js").Player} opts.player
   * @param {import("./scroll.js").AutoScroller} opts.scroller
   * @param {() => object|null} opts.song current song object
   * @param {(ms: number) => void} opts.setOffset apply locally (not saved)
   * @param {(ms: number) => Promise<void>} opts.saveOffset persist
   * @param {() => void} opts.onEnter e.g. close other panels
   */
  constructor(opts) {
    this.o = opts;
    this.state = IDLE;
    this.panel = document.getElementById("calib-panel");
    this.toggleButton = document.getElementById("calibrate-button");
    this.toggleButton.addEventListener("click", (e) => {
      e.currentTarget.blur();
      this.toggle();
    });
  }

  get active() {
    return this.state.phase !== "idle";
  }

  get phase() {
    return this.state.phase;
  }

  toggle() {
    if (this.active) this.dispatch({ type: "cancel" });
    else this.enter();
  }

  enter() {
    const song = this.o.song();
    if (!song) return;
    if (!song.synced) {
      toast("這首歌沒有同步時間，無法校準", "error");
      return;
    }
    const target = defaultTarget(this.o.lyrics.timeline);
    if (target === null) return;
    this.o.onEnter();
    this.dispatch({ type: "enter", target, t: song.lines[target].t, offset: song.offset_ms || 0 });
  }

  select(index) {
    const t = this.o.song()?.lines[index]?.t;
    if (typeof t === "number") this.dispatch({ type: "select", target: index, t });
  }

  pressS() {
    this.dispatch({ type: "s", now: this.o.player.currentTime() });
  }

  confirm() {
    this.dispatch({ type: "confirm" });
  }

  cancel() {
    if (this.active) this.dispatch({ type: "cancel" });
  }

  /** Leave without touching anything (song is being replaced). */
  reset() {
    this.state = IDLE;
    this.#render();
  }

  dispatch(event) {
    const before = this.state;
    const { state, effects } = calibrate(before, event);
    this.state = state;
    for (const effect of effects) this.#perform(effect);
    this.#render();
    if (state.phase !== "idle" && state.target !== before.target) {
      this.o.scroller.centerOn(this.o.lyrics.lineEls[state.target]);
    }
  }

  #perform(effect) {
    const { player, lyrics } = this.o;
    switch (effect.type) {
      case "play":
        lyrics.hold = null;
        player.seekAndPlay(effect.at);
        break;
      case "pause":
        player.pause();
        break;
      case "setOffset":
        this.o.setOffset(effect.ms);
        break;
      case "save":
        this.o.saveOffset(effect.ms);
        break;
    }
  }

  #render() {
    const { lyrics } = this.o;
    const s = this.state;
    const active = this.active;
    lyrics.selectMode = active;
    lyrics.setTarget(active ? s.target : -1);
    document.body.classList.toggle("calibrating", active);
    this.toggleButton.classList.toggle("on", active);
    this.toggleButton.textContent = active ? "結束校準" : "校準時間";
    this.panel.hidden = !active;
    if (!active) {
      this.panel.replaceChildren();
      return;
    }

    const song = this.o.song();
    const lineText = song.lines[s.target]?.text ?? "";
    const head = el("div", "calib-head");
    head.append(el("strong", "", "校準時間"));
    head.append(el("span", "calib-target-text", `目標：「${lineText}」`));
    head.append(el("span", "hint", "（點其他行可改選）"));

    const msg = el("div", "calib-msg");
    const actions = el("div", "calib-actions");
    const cancel = button("取消", "small", () => this.cancel());
    cancel.append(el("kbd", "", "Esc"));

    if (s.phase === "armed") {
      msg.append(
        el(
          "div",
          "",
          `目前 offset ${formatOffset(s.original)}` + (s.guess !== s.original ? `（上次量到 ${formatOffset(s.guess)}）` : "") + "。",
        ),
        el("div", "", `按 S 從目標句前約 ${LEAD_IN_S} 秒開始播放，聽到這句開始唱時再按一次 S。`),
      );
      const start = button("開始", "", () => this.pressS());
      start.append(el("kbd", "", "S"));
      actions.append(start);
      const est = estimateOffsetMs(song.youtube?.duration, song.lrclib?.duration);
      if (song.youtube?.duration != null && song.lrclib?.duration != null) {
        actions.append(
          button(`依時長差估計：${formatOffsetSeconds(est)}`, "small", () => this.dispatch({ type: "estimate", ms: est }),
            "影片比歌詞長多少，就把歌詞延後多少（影片較短時為 0）；直接套用並存檔"),
        );
      }
    } else if (s.phase === "listening") {
      msg.classList.add("listening");
      msg.append(el("div", "calib-big", `聽到「${lineText}」開始唱時按 S`));
      const now = button("現在！", "", () => this.pressS());
      now.append(el("kbd", "", "S"));
      actions.append(now);
    } else if (s.phase === "confirming") {
      const diff = s.proposed - s.original;
      msg.append(
        el("div", "calib-values", `舊 ${formatOffset(s.original)} → 新 ${formatOffset(s.proposed)}（差 ${formatOffset(diff)}）`),
        el("div", "hint", `正在用新 offset 從目標句前 ${REPLAY_LEAD_S} 秒重播，確認目標句是否準時亮起。`),
      );
      const ok = button("確定", "", () => this.confirm());
      ok.append(el("kbd", "", "Enter"));
      const retry = button("重來", "small", () => this.dispatch({ type: "retry" }));
      retry.append(el("kbd", "", "S"));
      actions.append(ok, retry);
    }
    actions.append(cancel);
    this.panel.replaceChildren(head, msg, actions);
  }
}
