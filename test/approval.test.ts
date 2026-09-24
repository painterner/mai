import assert from 'node:assert/strict';
import test from 'node:test';

import { approvalAction, classifyTool } from '../src/agent/approval.js';
import { resolveApiApprovalMode } from '../src/api.js';

test('approval modes map rules to the documented behavior', () => {
  const allowed = { decision: 'allow', risk: 'low', reason: 'fixture' } as const;
  const review = { decision: 'review', risk: 'high', reason: 'fixture' } as const;
  const forbidden = { decision: 'forbidden', risk: 'critical', reason: 'fixture' } as const;

  assert.equal(approvalAction('auto', allowed), 'execute');
  assert.equal(approvalAction('auto', review), 'execute');
  assert.equal(approvalAction('auto', forbidden), 'execute');
  assert.equal(approvalAction('safe', allowed), 'execute');
  assert.equal(approvalAction('safe', review), 'prompt');
  assert.equal(approvalAction('safe', forbidden), 'decline');
  assert.equal(approvalAction('manual', allowed), 'prompt');
  assert.equal(approvalAction('manual', review), 'prompt');
  assert.equal(approvalAction('manual', forbidden), 'decline');
});

test('API approval mode defaults to auto and maps the legacy setting', () => {
  assert.equal(resolveApiApprovalMode({}), 'auto');
  assert.equal(resolveApiApprovalMode({ MAI_API_APPROVAL_MODE: 'manual' }), 'manual');
  assert.equal(resolveApiApprovalMode({ MAI_API_APPROVE_RISKY: 'true' }), 'auto');
  assert.equal(resolveApiApprovalMode({ MAI_API_APPROVE_RISKY: 'false' }), 'safe');
  assert.throws(
    () => resolveApiApprovalMode({ MAI_API_APPROVAL_MODE: 'invalid' }),
    /must be auto, safe, or manual/,
  );
});

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
