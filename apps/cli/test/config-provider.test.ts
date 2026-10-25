import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeProviderDef } from '../src/config.js';

test('normalizes legacy OpenAI-compatible providers without changing their protocol', () => {
  assert.deepEqual(normalizeProviderDef({
    name: 'legacy',
    kind: 'openai',
    baseUrl: 'https://gateway.example/v1',
    apiKeyEnv: 'LEGACY_API_KEY',
    model: 'legacy-model',
  }), {
    name: 'legacy',
    kind: 'openai',
    type: 'openai-compatible',
    wireApi: 'chat-completions',
    baseUrl: 'https://gateway.example/v1',
    apiKeyEnv: 'LEGACY_API_KEY',
    auth: { type: 'env', env: 'LEGACY_API_KEY' },
    capabilities: {},
    model: 'legacy-model',
  });
});

test('normalizes an OpenAI Responses provider using Codex login', () => {
  const provider = normalizeProviderDef({
    name: 'openai',
    kind: 'openai',
    type: 'openai',
    wireApi: 'responses',
    baseUrl: 'https://api.openai.com/v1',
    auth: { type: 'codex-login' },
    capabilities: { webSearch: true, reasoning: true },
    model: 'gpt-test',
  });
  assert.equal(provider.auth.type, 'codex-login');
  assert.equal(provider.wireApi, 'responses');
  assert.equal(provider.capabilities.webSearch, true);
});

test('rejects codex-login on non-OpenAI providers', () => {
  assert.throws(() => normalizeProviderDef({
    name: 'proxy',
    kind: 'openai',
    type: 'openai-compatible',
    wireApi: 'responses',
    baseUrl: 'https://gateway.example/v1',
    auth: { type: 'codex-login' },
    model: 'proxy-model',
  }), /codex-login only when type is "openai"/);
});
