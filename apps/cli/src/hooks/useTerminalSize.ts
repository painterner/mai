import { useEffect, useState } from 'react';
import { useStdout } from 'ink';

export interface TerminalSize {
  columns: number;
  rows: number;
}

/**
 * Zooming a terminal in/out fires a burst of `resize` events (one per
 * intermediate size), so settle for a beat before reporting a new size —
 * every consumer of this reacts by repainting the whole screen, and doing
 * that once per intermediate step is exactly the flicker we're trying to
 * avoid.
 */
const SETTLE_MS = 80;

/** Terminal dimensions, debounced, re-read on every `resize` event. */
export function useTerminalSize(): TerminalSize {
  const { stdout } = useStdout();
  const [size, setSize] = useState<TerminalSize>(() => readSize(stdout));

  useEffect(() => {
    if (!stdout) return;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const onResize = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const next = readSize(stdout);
        // Only churn React when something actually changed — a resize event
        // that reports the same geometry (some emulators fire one on focus)
        // shouldn't trigger a repaint.
        setSize((prev) => (prev.columns === next.columns && prev.rows === next.rows ? prev : next));
      }, SETTLE_MS);
    };

    stdout.on('resize', onResize);
    return () => {
      if (timer) clearTimeout(timer);
      stdout.off('resize', onResize);
    };
  }, [stdout]);

  return size;
}

function readSize(stdout: NodeJS.WriteStream | undefined): TerminalSize {
  // Same fallbacks Ink itself uses when stdout isn't a TTY.
  return { columns: stdout?.columns || 80, rows: stdout?.rows || 24 };
}
