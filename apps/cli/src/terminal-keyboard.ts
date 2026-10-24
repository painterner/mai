interface TerminalOutput {
  isTTY?: boolean;
  write(chunk: string): unknown;
}

// Ask modern terminals to report every key using unambiguous CSI-u events,
// including the otherwise indistinguishable Shift+Enter combination. The
// associated-text flag keeps normal Unicode/IME input intact.
const ENABLE_KITTY_KEYBOARD = '\u001b[>25u';
const RESTORE_KITTY_KEYBOARD = '\u001b[<u';

// xterm's older protocol is a useful fallback for terminals that do not
// implement CSI-u. Unsupported control sequences are safely ignored.
const ENABLE_XTERM_KEYS = '\u001b[>4;2m';
const RESTORE_XTERM_KEYS = '\u001b[>4;0m';

/** Enables enhanced key reporting and returns an idempotent restore hook. */
export function enableEnhancedKeyboard(output: TerminalOutput): () => void {
  if (!output.isTTY) return () => {};

  output.write(ENABLE_KITTY_KEYBOARD + ENABLE_XTERM_KEYS);
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    output.write(RESTORE_XTERM_KEYS + RESTORE_KITTY_KEYBOARD);
  };
}
