// Global keyboard shortcuts (see the table in CLAUDE.md).

function isTyping(target) {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

/**
 * @param {object} actions
 * @param {() => void} actions.togglePlay      Space
 * @param {(dir: number) => void} actions.step ← / →
 * @param {() => void} actions.toggleAutoScroll A
 * @param {(deltaMs: number) => void} actions.nudgeOffset [ / ]
 * @param {() => void} actions.centerCurrent   C
 * @param {() => void} actions.escape          Esc (close panels)
 */
export function installKeyboard(actions) {
  const bindings = {
    Space: () => actions.togglePlay(),
    ArrowLeft: () => actions.step(-1),
    ArrowRight: () => actions.step(+1),
    KeyA: () => actions.toggleAutoScroll(),
    BracketLeft: () => actions.nudgeOffset(-100),
    BracketRight: () => actions.nudgeOffset(+100),
    KeyC: () => actions.centerCurrent(),
  };
  // Fallback by character for keyboards that don't report KeyboardEvent.code.
  const byKey = { " ": "Space", "[": "BracketLeft", "]": "BracketRight", a: "KeyA", A: "KeyA", c: "KeyC", C: "KeyC" };
  let swallowKeyUp = null;

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      actions.escape();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
    const code = bindings[e.code] ? e.code : byKey[e.key];
    const action = bindings[code];
    if (!action) return;
    e.preventDefault(); // no page scroll on Space / arrows
    // A focused <button> would also fire a click on keyup (Space); drop focus instead.
    if (e.target instanceof HTMLElement && e.target.tagName === "BUTTON") {
      e.target.blur();
      swallowKeyUp = code;
    }
    if (code === "Space" && e.repeat) return; // holding Space must not flicker play/pause
    action();
  });

  document.addEventListener("keyup", (e) => {
    if (swallowKeyUp && (e.code === swallowKeyUp || byKey[e.key] === swallowKeyUp)) {
      e.preventDefault();
      swallowKeyUp = null;
    }
  });
}
