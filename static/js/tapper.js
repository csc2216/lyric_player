// Tap-sync mode UI for songs without timestamps: drives tapping.js and saves the result.

import { IDLE, tapSync, tapTimesToLines } from "./tapping.js";
import { button, el, toast } from "./ui.js";

export class Tapper {
  /**
   * @param {object} opts
   * @param {import("./lyrics.js").LyricsView} opts.lyrics
   * @param {import("./player.js").Player} opts.player
   * @param {import("./scroll.js").AutoScroller} opts.scroller
   * @param {() => object|null} opts.song
   * @param {(lines: {index: number, t: number}[]) => Promise<boolean>} opts.save PATCH lines + synced
   * @param {() => void} opts.onEnter close other panels
   */
  constructor(opts) {
    this.o = opts;
    this.state = IDLE;
    this.saving = false;
    this.panel = document.getElementById("tap-panel");
    document.getElementById("tap-button").addEventListener("click", (e) => {
      e.currentTarget.blur();
      this.active ? this.cancel() : this.start();
    });
  }

  get active() {
    return this.state.phase !== "idle";
  }

  start() {
    const song = this.o.song();
    if (!song?.lines.length || this.saving) return;
    this.o.onEnter();
    this.dispatch({ type: "start", count: song.lines.length });
  }

  tap() {
    this.dispatch({ type: "tap", now: this.o.player.currentTime() });
  }

  back() {
    this.dispatch({ type: "back" });
  }

  cancel() {
    if (this.active) {
      this.dispatch({ type: "cancel" });
      toast("已取消打點，沒有存檔");
    }
  }

  reset() {
    this.state = IDLE;
    this.#render();
  }

  dispatch(event) {
    const { state, effects } = tapSync(this.state, event);
    this.state = state;
    for (const effect of effects) this.#perform(effect);
    this.#render();
  }

  async #perform(effect) {
    const { player } = this.o;
    switch (effect.type) {
      case "play":
        player.seekAndPlay(effect.at);
        break;
      case "seek":
        player.seekAndPlay(effect.at);
        break;
      case "pause":
        player.pause();
        break;
      case "reject":
        toast("這一下比上一行還早，沒有記錄", "error");
        break;
      case "done": {
        this.saving = true;
        const song = this.o.song();
        const ok = await this.o.save(tapTimesToLines(effect.times, song?.offset_ms || 0));
        this.saving = false;
        if (ok) toast("打點完成，已存檔；現在可以點行跳播了", "ok", 3000);
        break;
      }
    }
  }

  #render() {
    const { lyrics, scroller } = this.o;
    const active = this.active;
    lyrics.selectMode = active; // clicks don't seek / edit while tapping
    lyrics.setTapProgress(active ? this.state.index : -1);
    document.body.classList.toggle("tapping", active);
    const toggle = document.getElementById("tap-button");
    toggle.textContent = active ? "結束打點" : "打點同步";
    toggle.classList.toggle("on", active);
    this.panel.hidden = !active;
    if (!active) {
      this.panel.replaceChildren();
      return;
    }
    const { index, count } = this.state;
    const song = this.o.song();
    const head = el("div", "calib-head");
    head.append(el("strong", "", "打點同步"), el("span", "hint", `第 ${index + 1} / ${count} 行`));
    const next = el("div", "calib-big", `下一行：「${song.lines[index].text}」`);
    const help = el("div", "hint", "這一行開始唱的時候按 Enter 或 S；按錯了按 Backspace 退回上一行重打。打完最後一行自動存檔。");
    const actions = el("div", "calib-actions");
    const tapButton = button("打點", "", () => this.tap());
    tapButton.append(el("kbd", "", "Enter"));
    const backButton = button("退回", "small", () => this.back());
    backButton.append(el("kbd", "", "Backspace"));
    const cancelButton = button("取消", "small", () => this.cancel());
    cancelButton.append(el("kbd", "", "Esc"));
    actions.append(tapButton, backButton, cancelButton);
    this.panel.replaceChildren(head, next, help, actions);
    scroller.centerOn(lyrics.lineEls[index]);
  }
}
