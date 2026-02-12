import { playBeep } from "./scanner";

export function createKeyboardScanner(onScan) {
  let enabled = false;
  let buffer = "";
  let lastAt = 0;
  let clearTimer = null;

  function reset() {
    buffer = "";
    lastAt = 0;
    if (clearTimer) {
      clearTimeout(clearTimer);
      clearTimer = null;
    }
  }

  function keydownHandler(event) {
    if (!enabled) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;

    const target = event.target;
    if (
      target &&
      (target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT" ||
        target.isContentEditable)
    ) {
      return;
    }

    if (event.key === "Enter") {
      if (buffer.length >= 6) {
        onScan(buffer);
        event.preventDefault();
        playBeep();
      }
      reset();
      return;
    }

    if (event.key.length !== 1) return;
    const now = Date.now();
    if (lastAt > 0 && now - lastAt > 120) {
      buffer = "";
    }
    lastAt = now;
    buffer += event.key;

    if (clearTimer) clearTimeout(clearTimer);
    clearTimer = setTimeout(reset, 180);
  }

  window.addEventListener("keydown", keydownHandler);

  return {
    setEnabled(value) {
      enabled = Boolean(value);
      if (!enabled) reset();
    },
    dispose() {
      window.removeEventListener("keydown", keydownHandler);
      reset();
    }
  };
}
