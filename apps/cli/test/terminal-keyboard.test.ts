import assert from 'node:assert/strict';
import test from 'node:test';

import { enableEnhancedKeyboard } from '../src/terminal-keyboard.js';

test('enhanced terminal keyboard mode is enabled and restored exactly once', () => {
  const writes: string[] = [];
  const restore = enableEnhancedKeyboard({ isTTY: true, write: (chunk) => writes.push(chunk) });

  assert.equal(writes.length, 1);
  assert.match(writes[0], /\u001b\[>25u/);
  assert.match(writes[0], /\u001b\[>4;2m/);

  restore();
  restore();
  assert.equal(writes.length, 2);
  assert.match(writes[1], /\u001b\[>4;0m/);
  assert.match(writes[1], /\u001b\[<u/);
});

test('keyboard control sequences are not written to redirected output', () => {
  const writes: string[] = [];
  enableEnhancedKeyboard({ isTTY: false, write: (chunk) => writes.push(chunk) })();
  assert.deepEqual(writes, []);
});
