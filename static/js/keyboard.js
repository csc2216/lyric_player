// Global keyboard shortcuts. M3: Space = play/pause.

function isTyping(target) {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

/**
 * @param {{togglePlay: () => void}} actions
 */
export function installKeyboard(actions) {
  let swallowSpaceUp = false;

  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
    if (e.code === "Space" || e.key === " ") {
      e.preventDefault(); // no page scroll
      // A focused <button> would also fire a click on keyup; drop focus instead.
      if (e.target instanceof HTMLElement && e.target.tagName === "BUTTON") {
        e.target.blur();
        swallowSpaceUp = true;
      }
      if (!e.repeat) actions.togglePlay();
    }
  });

  document.addEventListener("keyup", (e) => {
    if (swallowSpaceUp && (e.code === "Space" || e.key === " ")) {
      e.preventDefault();
      swallowSpaceUp = false;
    }
  });
}
