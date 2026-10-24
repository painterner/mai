import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { classifyLsEntry, resolveLsBaseDirectory } from '../src/ls-entry-style.js';

test('ls entries receive conventional semantic color categories', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-ls-color-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  fs.mkdirSync(path.join(directory, 'folder'));
  fs.writeFileSync(path.join(directory, 'run.sh'), '#!/bin/sh\n');
  fs.chmodSync(path.join(directory, 'run.sh'), 0o755);
  fs.writeFileSync(path.join(directory, 'photo.png'), 'fixture');
  fs.writeFileSync(path.join(directory, 'bundle.zip'), 'fixture');
  fs.symlinkSync('folder', path.join(directory, 'folder-link'));

  assert.equal(classifyLsEntry(directory, 'folder'), 'directory');
  assert.equal(classifyLsEntry(directory, 'run.sh'), 'executable');
  assert.equal(classifyLsEntry(directory, 'folder-link'), 'symlink');
  assert.equal(classifyLsEntry(directory, 'photo.png'), 'image');
  assert.equal(classifyLsEntry(directory, 'bundle.zip'), 'archive');
  assert.equal(classifyLsEntry(directory, 'notes.txt'), 'file');
});

test('plain ls arguments resolve the directory used for type inspection', () => {
  assert.equal(
    resolveLsBaseDirectory(JSON.stringify({ command: 'ls' }), '/workspace'),
    '/workspace',
  );
  assert.equal(
    resolveLsBaseDirectory(JSON.stringify({ command: 'ls src' }), '/workspace'),
    '/workspace/src',
  );
  assert.equal(resolveLsBaseDirectory(JSON.stringify({ command: 'ls a b' }), '/workspace'), null);
  assert.equal(resolveLsBaseDirectory(JSON.stringify({ command: 'ls | head' }), '/workspace'), null);
});
