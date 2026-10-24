import assert from 'node:assert/strict';
import test from 'node:test';

import { matchCommands, matchIdentifier, parseApprovalCommandArgs, parseModelCommandArgs } from '../src/commands.js';

test('approval command supports all three modes and reports invalid input', () => {
  assert.deepEqual(parseApprovalCommandArgs([]), { kind: 'show' });
  assert.deepEqual(parseApprovalCommandArgs(['AUTO']), { kind: 'set', mode: 'auto' });
  assert.deepEqual(parseApprovalCommandArgs(['safe']), { kind: 'set', mode: 'safe' });
  assert.deepEqual(parseApprovalCommandArgs(['manual']), { kind: 'set', mode: 'manual' });
  assert.deepEqual(parseApprovalCommandArgs(['unsafe']), {
    kind: 'error',
    message: 'Usage: /approval [auto|safe|manual]',
  });
});

test('approval modes are available through slash completion', () => {
  assert.deepEqual(matchCommands('/approval s'), [
    { name: '/approval safe', description: 'Use risk rules and ask for review-classified calls' },
  ]);
});

test('model command keeps the no-argument interactive picker', () => {
  assert.deepEqual(parseModelCommandArgs([]), { kind: 'picker' });
});

test('model command parses model first and optional provider second', () => {
  assert.deepEqual(parseModelCommandArgs(['modelA']), {
    kind: 'select',
    model: 'modelA',
    provider: undefined,
  });
  assert.deepEqual(parseModelCommandArgs(['modelA', 'providerA']), {
    kind: 'select',
    model: 'modelA',
    provider: 'providerA',
  });
  assert.deepEqual(parseModelCommandArgs(['modelA', 'providerA', 'extra']), {
    kind: 'error',
    message: 'Usage: /model <model> [provider]',
  });
});

test('provider and model identifiers prefer exact matches and tolerate case differences', () => {
  assert.equal(matchIdentifier(['ProviderA', 'providerB'], 'ProviderA'), 'ProviderA');
  assert.equal(matchIdentifier(['ProviderA', 'providerB'], 'providera'), 'ProviderA');
  assert.equal(matchIdentifier(['modelA', 'modelB'], 'MODELB'), 'modelB');
  assert.equal(matchIdentifier(['modelA'], 'missing'), undefined);
});

const skills = [
  { name: 'astro-setup', description: 'Create an Astro project' },
  { name: 'agents-sdk', description: 'Build an agent' },
  { name: 'help', description: 'Collides with a built-in command' },
  { name: 'not safe', description: 'Cannot be represented as one slash token' },
];

test('slash completion includes direct skill aliases', () => {
  assert.deepEqual(matchCommands('/ast', skills), [
    { name: '/astro-setup', description: 'Skill — Create an Astro project' },
  ]);
});

test('/skills argument completion expands skill names', () => {
  assert.deepEqual(matchCommands('/skills ag', skills), [
    { name: '/skills agents-sdk', description: 'Skill — Build an agent' },
  ]);
});

test('built-in slash commands win direct alias collisions', () => {
  assert.deepEqual(matchCommands('/help', skills), [
    { name: '/help', description: 'Show available commands' },
  ]);
  assert.deepEqual(matchCommands('/skills help', skills), [
    { name: '/skills help', description: 'Skill — Collides with a built-in command' },
  ]);
});

test('completion closes once free-form arguments begin', () => {
  assert.deepEqual(matchCommands('/astro-setup new-project', skills), []);
  assert.deepEqual(matchCommands('/skills astro-setup new-project', skills), []);
});
