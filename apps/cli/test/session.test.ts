import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { ApiStore } from '../src/api/store.js';
import { parseCliOptions } from '../src/cli-options.js';
import {
  checkpointInteractiveSession,
  createInteractiveSession,
  resolveSession,
  restoredMessages,
} from '../src/session.js';
import type { Message } from '../src/types.js';

test('interactive sessions preserve model history, UI history, input history, and settings', () => {
  const store = new ApiStore(':memory:', { recoverInterrupted: false });
  const session = createInteractiveSession(store, {
    provider: 'provider-a',
    model: 'model-a',
    approvalMode: 'manual',
    client: 'cli',
  });
  const uiMessages: Message[] = [
    { id: 'user-1', role: 'user', content: 'remember this session', timestamp: 1 },
    {
      id: 'tool-1',
      role: 'tool',
      content: '',
      tool: { name: 'run_command', status: 'running', args: '{"command":"sleep 10"}' },
      timestamp: 2,
    },
  ];

  checkpointInteractiveSession(store, session.id, {
    history: [{ role: 'user', parts: [{ text: 'remember this session' }] }],
    uiMessages,
    inputHistory: ['first', 'second'],
    approvalMode: 'manual',
    provider: 'provider-a',
    model: 'model-a',
    client: 'cli',
  });

  const saved = store.getSession(session.id)!;
  assert.equal(saved.title, 'remember this session');
  assert.equal(saved.client, 'cli');
  assert.equal(saved.approvalMode, 'manual');
  assert.deepEqual(saved.inputHistory, ['first', 'second']);
  assert.deepEqual(saved.history, [{ role: 'user', parts: [{ text: 'remember this session' }] }]);

  const restored = restoredMessages(saved);
  assert.equal(restored[1].tool?.status, 'failed');
  assert.match(restored[1].tool?.output ?? '', /not replayed/i);
  store.close();
});

test('session resolution accepts exact ids, unique prefixes, and last', () => {
  const store = new ApiStore(':memory:', { recoverInterrupted: false });
  const first = createInteractiveSession(store, {
    provider: 'p',
    model: 'm',
    approvalMode: 'auto',
    client: 'cli',
  });
  const second = createInteractiveSession(store, {
    provider: 'p',
    model: 'm',
    approvalMode: 'safe',
    client: 'gui',
  });
  const sessions = store.listSessions();

  assert.equal(resolveSession(sessions, first.id)?.id, first.id);
  assert.equal(resolveSession(sessions, first.id.slice(0, 20))?.id, first.id);
  assert.equal(resolveSession(sessions, 'last')?.id, second.id);
  assert.equal(resolveSession(sessions, 'missing'), null);
  store.close();
});

test('the session store migrates API databases created before interactive resume metadata', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mai-session-migration-'));
  const filename = path.join(directory, 'api.sqlite');
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const legacy = new DatabaseSync(filename);
  legacy.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      title TEXT,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      history_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  legacy.prepare(
    'INSERT INTO sessions (id,title,provider,model,history_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
  ).run('sess_legacy', null, 'legacy-provider', 'legacy-model', '[]', '2026-01-01', '2026-01-01');
  legacy.close();

  const store = new ApiStore(filename, { recoverInterrupted: false });
  const migrated = store.getSession('sess_legacy')!;
  assert.deepEqual(migrated.uiMessages, []);
  assert.deepEqual(migrated.inputHistory, []);
  assert.equal(migrated.approvalMode, 'auto');
  assert.equal(migrated.client, 'api');
  store.close();
});

test('CLI resume aliases use the latest session unless an id is supplied', () => {
  assert.deepEqual(parseCliOptions([]), { keyTest: false });
  assert.deepEqual(parseCliOptions(['--resume']), { keyTest: false, resume: 'last' });
  assert.deepEqual(parseCliOptions(['--continue', 'sess_123']), { keyTest: false, resume: 'sess_123' });
  assert.deepEqual(parseCliOptions(['-r', 'abc', '--key-test']), { keyTest: true, resume: 'abc' });
});
