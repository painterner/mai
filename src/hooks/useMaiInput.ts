import { useEffect, useRef } from 'react';
import { useStdin, type Key } from 'ink';

type InputHandler = (input: string, key: Key) => void;

/**
 * Ink 5 does not understand the CSI-u keyboard protocol. Terminals using
 * that protocol therefore hand Ink an apparently ordinary string such as
 * `[13;2u` for Shift+Enter. Normalize those events before the rest of the
 * application sees them.
 */
export function useMaiInput(inputHandler: InputHandler, options: { isActive?: boolean } = {}) {
  const { internal_eventEmitter: eventEmitter, setRawMode } = useStdin();
  const buffered = useRef('');
  const handlerRef = useRef(inputHandler);
  handlerRef.current = inputHandler;

  useEffect(() => {
    if (options.isActive === false) return;
    setRawMode(true);
    return () => setRawMode(false);
  }, [options.isActive, setRawMode]);

  useEffect(() => {
    if (options.isActive === false) return;
    const queue: Array<{ input: string; key: Key }> = [];
    let active = true;
    let draining = false;

    const drain = () => {
      if (!active) return;
      const event = queue.shift();
      if (!event) {
        draining = false;
        return;
      }
      handlerRef.current(event.input, event.key);
      // CSI-u can deliver several complete key events in one stdin chunk.
      // Yield between them so React commits the first edit before the next
      // handler reads the controlled input value.
      if (queue.length) setImmediate(drain);
      else draining = false;
    };

    const handleData = (chunk: string | Buffer) => {
      const decoded = decodeTerminalInput(buffered.current + chunk.toString());
      buffered.current = decoded.remainder;
      queue.push(...decoded.events);
      if (!draining) {
        draining = true;
        setImmediate(drain);
      }
    };
    eventEmitter.on('input', handleData);
    return () => {
      active = false;
      queue.length = 0;
      eventEmitter.removeListener('input', handleData);
    };
  }, [eventEmitter, options.isActive]);
}

interface DecodedInput {
  events: Array<{ input: string; key: Key }>;
  remainder: string;
}

/**
 * Decode stdin ourselves instead of using Ink 5's `useInput`. Ink can set
 * `input` to undefined for valid CSI-u events and then calls
 * `input.startsWith(...)`, crashing before an application wrapper runs.
 */
export function decodeTerminalInput(raw: string): DecodedInput {
  const events: DecodedInput['events'] = [];
  let offset = 0;

  while (offset < raw.length) {
    if (raw[offset] !== '\u001b') {
      const nextEscape = raw.indexOf('\u001b', offset);
      const end = nextEscape === -1 ? raw.length : nextEscape;
      events.push(parseRawKeypress(raw.slice(offset, end)));
      offset = end;
      continue;
    }

    if (raw[offset + 1] === '[') {
      const final = findCsiFinal(raw, offset + 2);
      if (final === -1) return { events, remainder: raw.slice(offset) };
      events.push(parseRawKeypress(raw.slice(offset, final + 1)));
      offset = final + 1;
      continue;
    }

    if (raw[offset + 1] === 'O') {
      if (offset + 2 >= raw.length) return { events, remainder: raw.slice(offset) };
      events.push(parseRawKeypress(raw.slice(offset, offset + 3)));
      offset += 3;
      continue;
    }

    // A lone ESC is a complete key event. ESC followed by an ordinary
    // character is the legacy Alt/meta encoding.
    const length = offset + 1 < raw.length ? 2 : 1;
    events.push(parseRawKeypress(raw.slice(offset, offset + length)));
    offset += length;
  }

  return { events, remainder: '' };
}

function findCsiFinal(value: string, start: number): number {
  for (let index = start; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0x40 && code <= 0x7e) return index;
  }
  return -1;
}

function parseRawKeypress(raw: string): { input: string; key: Key } {
  if (/^\u001b\[[0-9:;]+u$/.test(raw) || /^\u001b\[27;\d+;\d+~$/.test(raw)) {
    return normalizeEnhancedKeypress(raw, { ...EMPTY_KEY });
  }

  const key: Key = { ...EMPTY_KEY };
  if (raw === '\r') return { input: '', key: { ...key, return: true } };
  if (raw === '\u001b') return { input: '', key: { ...key, escape: true, meta: true } };
  if (raw === '\t') return { input: '', key: { ...key, tab: true } };
  if (raw === '\u001b[Z') return { input: '', key: { ...key, tab: true, shift: true } };
  if (raw === '\b') return { input: '', key: { ...key, backspace: true } };
  if (raw === '\u007f') return { input: '', key: { ...key, delete: true } };

  const cursor = /^\u001b(?:\[1;(\d+))?[\[O]?([ABCD])$/.exec(raw);
  if (cursor) {
    const modifier = decodeModifiers(cursor[1] ? Number(cursor[1]) : 1);
    return {
      input: '',
      key: {
        ...key,
        upArrow: cursor[2] === 'A',
        downArrow: cursor[2] === 'B',
        rightArrow: cursor[2] === 'C',
        leftArrow: cursor[2] === 'D',
        shift: modifier.shift,
        ctrl: modifier.ctrl,
        meta: modifier.alt,
      },
    };
  }

  const tilde = /^\u001b\[(\d+)(?:;(\d+))?~$/.exec(raw);
  if (tilde) {
    const modifier = decodeModifiers(tilde[2] ? Number(tilde[2]) : 1);
    return {
      input: '',
      key: {
        ...key,
        delete: tilde[1] === '3',
        pageUp: tilde[1] === '5',
        pageDown: tilde[1] === '6',
        shift: modifier.shift,
        ctrl: modifier.ctrl,
        meta: modifier.alt,
      },
    };
  }

  if (raw.length === 1 && raw.charCodeAt(0) >= 1 && raw.charCodeAt(0) <= 26) {
    return {
      input: String.fromCharCode(raw.charCodeAt(0) + 96),
      key: { ...key, ctrl: true },
    };
  }
  if (raw.startsWith('\u001b') && raw.length > 1) {
    return { input: raw.slice(1), key: { ...key, meta: true } };
  }
  return { input: raw, key };
}

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

export function normalizeEnhancedKeypress(input: string, inkKey: Key): { input: string; key: Key } {
  const sequence = input.startsWith('\u001b') ? input.slice(1) : input;

  // xterm modifyOtherKeys level 2: CSI 27 ; modifier ; codepoint ~
  const xterm = /^\[27;(\d+);(\d+)~$/.exec(sequence);
  if (xterm) {
    const modifier = decodeModifiers(Number(xterm[1]));
    return normalized(Number(xterm[2]), '', modifier, inkKey, false);
  }

  // kitty keyboard protocol:
  // CSI key[:shifted[:base]] ; modifiers[:event] ; text[:] u
  // xterm.js uses an empty modifier field when associated text is present,
  // for example `/` is `CSI 47;;47u`. The protocol explicitly permits
  // omitted/empty optional fields, so do not require digits after the first
  // semicolon.
  const kitty = /^\[([0-9]+)(?::[0-9]*?){0,2}(?:;([0-9]*)(?::[123])?)?(?:;([0-9:]+))?u$/.exec(sequence);
  if (!kitty) return { input, key: inkKey };

  const modifier = decodeModifiers(kitty[2] ? Number(kitty[2]) : 1);
  const text = decodeCodepoints(kitty[3]);
  const codepoint = Number(kitty[1]);
  return normalized(codepoint, text, modifier, inkKey, isKittyFunctionalKey(codepoint));
}

interface Modifiers {
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
}

function decodeModifiers(encoded: number): Modifiers {
  const bits = Math.max(0, encoded - 1);
  return {
    shift: Boolean(bits & 1),
    alt: Boolean(bits & 2),
    ctrl: Boolean(bits & 4),
  };
}

function decodeCodepoints(value: string | undefined): string {
  if (!value) return '';
  try {
    return value.split(':').map((part) => String.fromCodePoint(Number(part))).join('');
  } catch {
    return '';
  }
}

function isKittyFunctionalKey(codepoint: number): boolean {
  // The kitty protocol reserves this Unicode private-use range for
  // non-text keys, including Shift, Ctrl, Alt, Super and media keys.
  return codepoint >= 57344 && codepoint <= 63743;
}

function normalized(
  codepoint: number,
  text: string,
  modifier: Modifiers,
  inkKey: Key,
  functionalKey: boolean,
) {
  const key: Key = {
    ...inkKey,
    return: codepoint === 13,
    escape: codepoint === 27,
    tab: codepoint === 9,
    backspace: codepoint === 8 || codepoint === 127,
    ctrl: modifier.ctrl,
    shift: modifier.shift,
    meta: modifier.alt,
  };

  if (functionalKey || key.return || key.escape || key.tab || key.backspace) return { input: '', key };
  if (text) return { input: text, key };

  // Shortcut keys do not carry associated text. Preserve the key name so
  // handlers such as Ctrl+C and approval y/n continue to work.
  if (codepoint > 0 && codepoint <= 0x10ffff) {
    const value = String.fromCodePoint(codepoint);
    return { input: modifier.shift ? value.toUpperCase() : value, key };
  }
  return { input: '', key };
}
