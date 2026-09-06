import assert from 'node:assert/strict';
import test from 'node:test';

import {
  insertAtCursor,
  isShiftEnterInput,
  moveCursorVertically,
  normalizeLineBreaks,
} from '../src/input-edit.js';
import { decodeTerminalInput, normalizeEnhancedKeypress } from '../src/hooks/useMaiInput.js';
import type { Key } from 'ink';

const emptyKey: Key = {
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

test('Shift+Enter edit inserts a newline at the cursor without submitting text', () => {
  assert.deepEqual(insertAtCursor('firstsecond', 5, '\n'), {
    value: 'first\nsecond',
    cursor: 6,
  });
  assert.equal(isShiftEnterInput('', true), true);
  assert.equal(isShiftEnterInput('\n', false), true);
  assert.equal(isShiftEnterInput('\u001b[13;2u', false), true);
  assert.equal(isShiftEnterInput('[27;2;13~', false), true);
  assert.equal(isShiftEnterInput('', false), false);
});

test('enhanced terminal key sequences distinguish Shift+Enter from Enter', () => {
  const shiftedKitty = normalizeEnhancedKeypress('[13;2u', emptyKey);
  assert.equal(shiftedKitty.key.return, true);
  assert.equal(shiftedKitty.key.shift, true);

  const plainKitty = normalizeEnhancedKeypress('[13;1u', emptyKey);
  assert.equal(plainKitty.key.return, true);
  assert.equal(plainKitty.key.shift, false);

  const shiftedXterm = normalizeEnhancedKeypress('[27;2;13~', emptyKey);
  assert.equal(shiftedXterm.key.return, true);
  assert.equal(shiftedXterm.key.shift, true);
});

test('enhanced key parsing preserves typing and application shortcuts', () => {
  assert.deepEqual(normalizeEnhancedKeypress('[97;1;97u', emptyKey), {
    input: 'a',
    key: emptyKey,
  });

  const uppercase = normalizeEnhancedKeypress('[97;2;65u', emptyKey);
  assert.equal(uppercase.input, 'A');
  assert.equal(uppercase.key.shift, true);

  const ctrlC = normalizeEnhancedKeypress('[99;5u', emptyKey);
  assert.equal(ctrlC.input, 'c');
  assert.equal(ctrlC.key.ctrl, true);

  const escape = normalizeEnhancedKeypress('[27u', emptyKey);
  assert.equal(escape.input, '');
  assert.equal(escape.key.escape, true);
});

test('VS Code xterm.js CSI-u input accepts an empty modifier field', () => {
  const slash = normalizeEnhancedKeypress('[47;;47u', emptyKey);
  assert.equal(slash.input, '/');
  assert.equal(slash.key.shift, false);
  assert.equal(slash.key.ctrl, false);

  const doubled = ['[47;;47u', '[47;;47u']
    .map((sequence) => normalizeEnhancedKeypress(sequence, emptyKey).input)
    .join('');
  assert.equal(doubled, '//');
});

test('raw input decoder bypasses Ink for VS Code CSI-u events', () => {
  const decoded = decodeTerminalInput('\u001b[47;;47u\u001b[47;;47u\u001b[13;2u');
  assert.equal(decoded.remainder, '');
  assert.deepEqual(decoded.events.map((event) => event.input), ['/', '/', '']);
  assert.equal(decoded.events[2].key.return, true);
  assert.equal(decoded.events[2].key.shift, true);
});

test('kitty modifier-only and functional keys never become private-use text', () => {
  const alt = normalizeEnhancedKeypress('[57443;3u', emptyKey);
  assert.equal(alt.input, '');
  assert.equal(alt.key.meta, true);

  const control = normalizeEnhancedKeypress('[57441;5u', emptyKey);
  assert.equal(control.input, '');
  assert.equal(control.key.ctrl, true);

  const decoded = decodeTerminalInput('\u001b[57443;3u\u001b[57441;5u');
  assert.deepEqual(decoded.events.map((event) => event.input), ['', '']);
  assert.ok(decoded.events.every((event) => !/[\ue000-\uf8ff]/u.test(event.input)));
});

test('raw input decoder keeps legacy terminal navigation and shortcuts', () => {
  assert.equal(decodeTerminalInput('\r').events[0].key.return, true);
  assert.equal(decodeTerminalInput('\u001b[A').events[0].key.upArrow, true);
  assert.equal(decodeTerminalInput('\u001b[1;2B').events[0].key.shift, true);
  assert.deepEqual(decodeTerminalInput('\u0003').events[0], {
    input: 'c',
    key: { ...emptyKey, ctrl: true },
  });
  assert.equal(decodeTerminalInput('pasted text').events[0].input, 'pasted text');
});

test('pasted multiline input preserves lines and normalizes terminal line endings', () => {
  assert.equal(normalizeLineBreaks('one\r\ntwo\rthree\n'), 'one\ntwo\nthree\n');
  assert.deepEqual(insertAtCursor('beforeafter', 6, normalizeLineBreaks('one\r\ntwo')), {
    value: 'beforeone\ntwoafter',
    cursor: 13,
  });
});

test('up and down move the cursor between multiline input rows', () => {
  const value = 'abcd\nxy\n12345';
  assert.equal(moveCursorVertically(value, 3, 1), 7);
  assert.equal(moveCursorVertically(value, 7, 1), 10);
  assert.equal(moveCursorVertically(value, 10, -1), 7);
  assert.equal(moveCursorVertically('\nabc', 0, 1), 1);
});
