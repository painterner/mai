import assert from 'node:assert/strict';
import test from 'node:test';

import { describeKeypress } from '../src/key-test.js';

test('keyboard diagnostic describes legacy and enhanced Enter events', () => {
  assert.deepEqual(describeKeypress(Buffer.from('\r')), {
    hex: '0d',
    escaped: '"\\r"',
    return: true,
    shift: false,
  });
  assert.deepEqual(describeKeypress(Buffer.from('\u001b[13;2u')), {
    hex: '1b 5b 31 33 3b 32 75',
    escaped: '"\\u001b[13;2u"',
    return: true,
    shift: true,
  });
});

test('keyboard diagnostic recognizes VS Code xterm.js associated text', () => {
  assert.deepEqual(describeKeypress(Buffer.from('\u001b[47;;47u')), {
    hex: '1b 5b 34 37 3b 3b 34 37 75',
    escaped: '"\\u001b[47;;47u"',
    return: false,
    shift: false,
  });
});
