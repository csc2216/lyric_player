// Shared DOM helpers: element builder, status line, toast.

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

export function button(text, className, onClick, title) {
  const b = el("button", className, text);
  b.type = "button";
  if (title) b.title = title;
  if (onClick) b.addEventListener("click", onClick);
  return b;
}

/** Status line under the create box. "busy" shows a spinner and a running seconds counter. */
export const status = {
  timer: null,
  set(kind, text) {
    clearInterval(this.timer);
    const box = document.getElementById("status");
    box.hidden = false;
    box.className = `status ${kind}`;
    box.replaceChildren();
    if (kind === "busy") box.append(el("span", "spinner"));
    box.append(el("span", "", text));
    if (kind === "busy") {
      const started = Date.now();
      const elapsed = el("span", "elapsed", "0 秒");
      box.append(elapsed);
      this.timer = setInterval(() => {
        elapsed.textContent = `${Math.floor((Date.now() - started) / 1000)} 秒`;
      }, 250);
    }
  },
  hide() {
    clearInterval(this.timer);
    document.getElementById("status").hidden = true;
  },
};

let toastTimer = null;

/** Short message at the bottom of the screen (offset value, saved, errors). */
export function toast(text, kind = "info", ms = 1800) {
  const box = document.getElementById("toast");
  box.textContent = text;
  box.className = `toast ${kind} show`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.remove("show"), ms);
}
