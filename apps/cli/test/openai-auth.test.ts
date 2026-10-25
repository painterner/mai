import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CodexAuthManager } from '../src/llm/auth.js';

test('Codex auth manager supports browser, device, API-key, access-token, reuse, and logout flows', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mai-auth-'));
  const codexHome = join(root, 'codex-home');
  mkdirSync(codexHome);
  const fake = makeFakeCodex(root);
  const env = {
    ...process.env,
    OPENAI_API_KEY: 'test-api-key',
    CODEX_ACCESS_TOKEN: jwt(Date.now() + 60 * 60_000, 'access-login'),
  };
  const manager = new CodexAuthManager({ codexHome, codexPath: fake, env, requestTimeoutMs: 2_000 });

  assert.equal((await manager.login('browser')).configured, true);
  assert.equal((await manager.login('device')).configured, true);
  assert.deepEqual(await manager.getAuthorization(), {
    mode: 'chatgpt',
    headers: {
      authorization: `Bearer ${JSON.parse(readFileSync(join(codexHome, 'auth.json'), 'utf8')).tokens.access_token}`,
      'chatgpt-account-id': 'account-1',
    },
  });
  assert.equal((await manager.login('api-key')).mode, 'apikey');
  assert.equal(await manager.getToken(), 'test-api-key');
  assert.equal((await manager.login('access-token')).configured, true);
  assert.equal((await manager.login('reuse')).configured, true);

  const invocations = readFileSync(join(root, 'invocations.log'), 'utf8');
  assert.match(invocations, /login .*--device-auth/);
  assert.match(invocations, /login .*--with-api-key/);
  assert.match(invocations, /login .*--with-access-token/);
  assert.doesNotMatch(invocations, /test-api-key|access-login/);

  await manager.logout();
  assert.deepEqual(await manager.status(), { configured: true, mode: 'api-key-env' });
  delete env.OPENAI_API_KEY;
  assert.equal((await manager.status()).configured, false);
});

test('Codex auth manager asks app-server to refresh an expiring ChatGPT token', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mai-auth-refresh-'));
  const codexHome = join(root, 'codex-home');
  mkdirSync(codexHome);
  const initial = authFixture(Date.now() + 30_000, 'old');
  const refreshed = authFixture(Date.now() + 60 * 60_000, 'new');
  writeFileSync(join(codexHome, 'auth.json'), JSON.stringify(initial));
  writeFileSync(join(codexHome, 'refreshed.json'), JSON.stringify(refreshed));
  const manager = new CodexAuthManager({
    codexHome,
    codexPath: makeFakeCodex(root),
    requestTimeoutMs: 2_000,
  });
  assert.equal(await manager.getToken(), refreshed.tokens.access_token);
});

function makeFakeCodex(root: string): string {
  const script = join(root, 'fake-codex.mjs');
  writeFileSync(script, `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
const args = process.argv.slice(2);
fs.appendFileSync(path.join(${JSON.stringify(root)}, 'invocations.log'), args.join(' ') + '\\n');
const home = process.env.CODEX_HOME;
const authPath = path.join(home, 'auth.json');
const makeJwt = (suffix) => {
  const payload = Buffer.from(JSON.stringify({ iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+3600 })).toString('base64url');
  return 'header.' + payload + '.signature-' + suffix;
};
if (args[0] === 'app-server') {
  const lines = readline.createInterface({ input: process.stdin });
  let count = 0;
  lines.on('line', () => {
    count += 1;
    if (count === 1) process.stdout.write('{"id":1,"result":{}}\\n');
    if (count === 3) {
      const refreshed = path.join(home, 'refreshed.json');
      if (fs.existsSync(refreshed)) fs.copyFileSync(refreshed, authPath);
      process.stdout.write('{"id":2,"result":{"account":{"type":"chatgpt"}}}\\n');
    }
  });
} else if (args[0] === 'logout') {
  fs.rmSync(authPath, { force: true });
} else if (args[0] === 'login') {
  let secret = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (value) => { secret += value; });
  process.stdin.on('end', () => {
    if (args.includes('--with-api-key')) {
      fs.writeFileSync(authPath, JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: secret.trim() }));
    } else {
      fs.writeFileSync(authPath, JSON.stringify({ auth_mode: 'chatgpt', tokens: {
        access_token: args.includes('--with-access-token') ? secret.trim() : makeJwt(args.includes('--device-auth') ? 'device' : 'browser'),
        refresh_token: 'refresh', account_id: 'account-1'
      }}));
    }
  });
}
`, { mode: 0o755 });
  chmodSync(script, 0o755);
  return script;
}

function jwt(expiresAt: number, suffix: string): string {
  const payload = Buffer.from(JSON.stringify({
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(expiresAt / 1000),
  })).toString('base64url');
  return `header.${payload}.signature-${suffix}`;
}

function authFixture(expiresAt: number, suffix: string) {
  return {
    auth_mode: 'chatgpt',
    tokens: {
      access_token: jwt(expiresAt, suffix),
      refresh_token: `refresh-${suffix}`,
      account_id: 'account-1',
    },
  };
}
