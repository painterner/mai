import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatShellResultForModel,
  shellCommandFromInput,
  toggleInputMode,
} from '../src/input-mode.js';
import { decodeTerminalInput } from '../src/hooks/useMaiInput.js';

test('Ctrl+X is decoded as the shell-mode shortcut', () => {
  const event = decodeTerminalInput('\u0018').events[0];
  assert.equal(event.input, 'x');
  assert.equal(event.key.ctrl, true);
});

test('prompt and shell modes toggle in both directions', () => {
  assert.equal(toggleInputMode('prompt'), 'shell');
  assert.equal(toggleInputMode('shell'), 'prompt');
});

test('shell mode executes the whole input and prompt mode supports one-shot bang commands', () => {
  assert.equal(shellCommandFromInput('pwd', 'shell'), 'pwd');
  assert.equal(shellCommandFromInput(' ! git status ', 'prompt'), 'git status');
  assert.equal(shellCommandFromInput('explain pwd', 'prompt'), null);
  assert.equal(shellCommandFromInput('!', 'prompt'), null);
});

test('shell output is formatted for the next model turn', () => {
  assert.match(formatShellResultForModel('pwd', '/workspace', false), /pwd/);
  assert.match(formatShellResultForModel('pwd', '/workspace', false), /completed/);
  assert.match(formatShellResultForModel('false', 'exit status: 1', true), /failed/);
});
