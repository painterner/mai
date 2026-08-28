import assert from 'node:assert/strict';
import test from 'node:test';

import { matchIdentifier, parseModelCommandArgs } from '../src/commands.js';

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
