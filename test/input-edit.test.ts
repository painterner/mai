import assert from 'node:assert/strict';
import test from 'node:test';

import {
  insertAtCursor,
  isShiftEnterInput,
  moveCursorVertically,
  normalizeLineBreaks,
} from '../src/input-edit.js';

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
