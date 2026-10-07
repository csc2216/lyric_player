// Global keyboard shortcuts (see the table in CLAUDE.md).

function isTyping(target) {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

// [code, shift] -> command. Shift matters only where listed with true.
const COMMANDS = {
  Space: "togglePlay",
  ArrowLeft: "prevLine",
  ArrowRight: "nextLine",
  KeyA: "toggleAutoScroll",
  KeyC: "centerCurrent",
  KeyB: "toggleSidebar",
  KeyS: "calibrateKey",
  "Shift+KeyS": "calibrateToggle",
  BracketLeft: "offsetDown",
  BracketRight: "offsetUp",
  "Shift+BracketLeft": "offsetDownBig",
  "Shift+BracketRight": "offsetUpBig",
  Enter: "confirm",
};
// Fallback by character for keyboards that don't report KeyboardEvent.code.
const KEY_TO_CODE = {
  " ": "Space", a: "KeyA", A: "KeyA", b: "KeyB", B: "KeyB", c: "KeyC", C: "KeyC", s: "KeyS", S: "KeyS",
  "[": "BracketLeft", "]": "BracketRight", "{": "BracketLeft", "}": "BracketRight",
  ArrowLeft: "ArrowLeft", ArrowRight: "ArrowRight", Enter: "Enter",
};

/** Command name for a keydown, or null. Exported for clarity; uses only event fields. */
export function commandFor(e) {
  const code = COMMANDS[e.code] || COMMANDS[`Shift+${e.code}`] ? e.code : KEY_TO_CODE[e.key];
  if (!code) return null;
  if (e.shiftKey && COMMANDS[`Shift+${code}`]) return COMMANDS[`Shift+${code}`];
  return COMMANDS[code] ?? null;
}

/**
 * @param {(command: string, event: KeyboardEvent) => boolean} onCommand
 *   returns true when the command was handled (the key's default is then prevented)
 * @param {() => void} onEscape
 */
export function installKeyboard(onCommand, onEscape) {
  let swallowKeyUp = null;

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      onEscape();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
    const command = commandFor(e);
    if (!command) return;
    // Enter on a focused button should keep working as a click.
    if (command === "confirm" && e.target instanceof HTMLElement && e.target.tagName === "BUTTON") return;
    if (e.repeat && command !== "offsetDown" && command !== "offsetUp") {
      e.preventDefault(); // holding Space/S must not flicker; [ ] may auto-repeat
      return;
    }
    if (!onCommand(command, e)) return;
    e.preventDefault(); // no page scroll on Space / arrows
    // A focused <button> would also fire a click on keyup (Space); drop focus instead.
    if (e.target instanceof HTMLElement && e.target.tagName === "BUTTON") {
      e.target.blur();
      swallowKeyUp = e.code;
    }
  });

  document.addEventListener("keyup", (e) => {
    if (swallowKeyUp && e.code === swallowKeyUp) {
      e.preventDefault();
      swallowKeyUp = null;
    }
  });
}
