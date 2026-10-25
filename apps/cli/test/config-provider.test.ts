import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  ensureUserCredentialsFile,
  ensureUserProviderConfig,
  loadProviders,
  normalizeProviderDef,
  providerConfigPaths,
} from '../src/config.js';

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

test('merges installation, user, and workspace provider layers by name', () => {
  const root = mkdtempSync(join(tmpdir(), 'mai-providers-'));
  const installationRoot = join(root, 'installation');
  const userConfigDir = join(root, 'home', '.mai');
  const workspace = join(root, 'workspace');
  for (const directory of [installationRoot, userConfigDir, workspace]) mkdirSync(directory, { recursive: true });

  writeJson(join(installationRoot, 'providers.json'), [{
    name: 'openai',
    kind: 'openai',
    type: 'openai',
    wireApi: 'responses',
    baseUrl: 'https://api.openai.com/v1',
    auth: { type: 'env', env: 'OPENAI_API_KEY' },
    capabilities: { webSearch: true, reasoning: true },
    model: 'bundled-model',
  }]);
  writeJson(join(userConfigDir, 'providers.json'), [
    { name: 'OPENAI', model: 'user-model', capabilities: { webSearch: false } },
    {
      name: 'local',
      kind: 'openai',
      baseUrl: 'http://127.0.0.1:11434/v1',
      auth: { type: 'none' },
      model: 'local-model',
    },
  ]);
  writeJson(join(workspace, 'providers.json'), [{
    name: 'openai',
    baseUrl: 'https://workspace.example/v1',
  }]);
  const providers = loadProviders({ installationRoot, userConfigDir, workspace });
  assert.deepEqual(providers.map((provider) => provider.name), ['openai', 'local']);
  assert.deepEqual(providers[0], {
    name: 'openai',
    kind: 'openai',
    type: 'openai',
    wireApi: 'responses',
    baseUrl: 'https://workspace.example/v1',
    auth: { type: 'env', env: 'OPENAI_API_KEY' },
    apiKeyEnv: 'OPENAI_API_KEY',
    capabilities: { webSearch: false, reasoning: true },
    model: 'user-model',
  });
  assert.equal(providers[1].model, 'local-model');
  assert.deepEqual(providerConfigPaths({ installationRoot, userConfigDir, workspace }), [
    join(installationRoot, 'providers.json'),
    join(userConfigDir, 'providers.json'),
    join(workspace, 'providers.json'),
  ]);
});

test('copies bundled providers to the user config once without overwriting edits', () => {
  const root = mkdtempSync(join(tmpdir(), 'mai-provider-init-'));
  const installationRoot = join(root, 'installation');
  const userConfigDir = join(root, 'home', '.mai');
  mkdirSync(installationRoot, { recursive: true });
  const bundled = [{
    name: 'gemini',
    kind: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    apiKeyEnv: 'GEMINI_API_KEY',
    model: 'gemini-test',
  }];
  writeJson(join(installationRoot, 'providers.json'), bundled);

  const first = ensureUserProviderConfig({ installationRoot, userConfigDir });
  assert.equal(first.created, true);
  assert.deepEqual(JSON.parse(readFileSync(first.path, 'utf8')), bundled);

  writeJson(first.path, [{ ...bundled[0], model: 'user-edited-model' }]);
  const second = ensureUserProviderConfig({ installationRoot, userConfigDir });
  assert.equal(second.created, false);
  assert.equal(JSON.parse(readFileSync(second.path, 'utf8'))[0].model, 'user-edited-model');
});

test('creates a private user credentials template once without overwriting edits', () => {
  const root = mkdtempSync(join(tmpdir(), 'mai-credentials-init-'));
  const userConfigDir = join(root, '.mai');
  const first = ensureUserCredentialsFile({ userConfigDir });
  assert.equal(first.created, true);
  assert.match(readFileSync(first.path, 'utf8'), /GEMINI_API_KEY/);
  assert.equal(statSync(first.path).mode & 0o777, 0o600);

  writeFileSync(first.path, 'CUSTOM_API_KEY=user-edited\n', { mode: 0o600 });
  const second = ensureUserCredentialsFile({ userConfigDir });
  assert.equal(second.created, false);
  assert.equal(readFileSync(second.path, 'utf8'), 'CUSTOM_API_KEY=user-edited\n');
});

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
