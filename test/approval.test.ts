import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyTool } from '../src/agent/approval.js';

test('read-only grep pipelines do not require approval', () => {
  const result = classifyTool('run_command', {
    command: 'cat stories/framework-gemini.md | grep -n "3.3"',
  });

  assert.equal(result.decision, 'allow');
  assert.equal(result.risk, 'low');
});

test('grep does not bypass sensitive-target protection', () => {
  const result = classifyTool('run_command', {
    command: 'grep token /home/user/.ssh/id_ed25519',
  });

  assert.equal(result.decision, 'forbidden');
  assert.equal(result.risk, 'critical');
});
