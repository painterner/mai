import type { Key } from 'ink';
import { normalizeEnhancedKeypress } from './hooks/useMaiInput.js';
import { enableEnhancedKeyboard } from './terminal-keyboard.js';

const EMPTY_KEY: Key = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
};

export interface CapturedKey {
  hex: string;
  escaped: string;
  return: boolean;
  shift: boolean;
}

export function describeKeypress(buffer: Buffer): CapturedKey {
  const raw = buffer.toString('utf8');
  // Ink removes one leading ESC before invoking useInput.
  const inkInput = raw.startsWith('\u001b') ? raw.slice(1) : raw === '\r' ? '' : raw;
  const inkKey = { ...EMPTY_KEY, return: raw === '\r' };
  const parsed = normalizeEnhancedKeypress(inkInput, inkKey);
  return {
    hex: [...buffer].map((byte) => byte.toString(16).padStart(2, '0')).join(' '),
    escaped: JSON.stringify(raw),
    return: parsed.key.return,
    shift: parsed.key.shift,
  };
}

/** Interactive raw-byte check for terminal-specific Shift+Enter behavior. */
export async function runKeyboardDiagnostic(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stdin.setRawMode) {
    throw new Error('mai --key-test must be run directly in an interactive terminal.');
  }

  const restoreKeyboard = enableEnhancedKeyboard(process.stdout);
  const previousRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();

  const captured: CapturedKey[] = [];
  process.stdout.write(
    `Terminal: TERM=${process.env.TERM ?? ''} TERM_PROGRAM=${process.env.TERM_PROGRAM ?? ''} ` +
      `TMUX=${process.env.TMUX ? 'yes' : 'no'}\r\n`,
  );
  process.stdout.write('Keyboard test 1/2: press Enter\r\n');

  try {
    await new Promise<void>((resolve) => {
      const onData = (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        captured.push(describeKeypress(buffer));
        if (captured.length === 1) {
          process.stdout.write(`Enter:       ${captured[0].hex}  ${captured[0].escaped}\r\n`);
          process.stdout.write('Keyboard test 2/2: press Shift+Enter\r\n');
          return;
        }
        process.stdin.off('data', onData);
        resolve();
      };
      process.stdin.on('data', onData);
    });
  } finally {
    process.stdin.setRawMode(previousRaw ?? false);
    process.stdin.pause();
    restoreKeyboard();
  }

  process.stdout.write(`Shift+Enter: ${captured[1].hex}  ${captured[1].escaped}\n`);
  if (captured[1].return && captured[1].shift) {
    process.stdout.write('Result: supported — Mai can distinguish Shift+Enter.\n');
  } else if (captured[0].hex === captured[1].hex) {
    process.stdout.write(
      'Result: unsupported by this terminal/session — both keys produced identical bytes.\n',
    );
  } else {
    process.stdout.write('Result: the terminal sent an unrecognized Shift+Enter sequence.\n');
  }
}
