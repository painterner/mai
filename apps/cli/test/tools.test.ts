import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ToolRegistry } from '../src/agent/tools.js';

test('read-only tools accept absolute paths outside the workspace', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'mai-tools-workspace-'));
  const diagnosticRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mai-tools-diagnostic-'));
  const diagnosticFile = path.join(diagnosticRoot, 'apt-proxy.conf');
  await fs.writeFile(diagnosticFile, 'Acquire::http::Proxy "http://127.0.0.1:7890";\n');
  const tools = await ToolRegistry.create(workspace, { write: true, shell: false }, null, { mcp: false });
  t.after(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(diagnosticRoot, { recursive: true, force: true });
  });

  const listing = await tools.execute('list_files', { path: diagnosticRoot });
  assert.match(listing, /apt-proxy\.conf/);

  const content = await tools.execute('read_file', { path: diagnosticFile });
  assert.match(content, /127\.0\.0\.1:7890/);

  const matches = await tools.execute('search_files', {
    path: diagnosticRoot,
    query: 'Acquire::http::Proxy',
  });
  assert.match(matches, new RegExp(escapeRegExp(diagnosticFile)));
});

test('writes accept absolute workspace paths but remain workspace-confined', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'mai-tools-write-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'mai-tools-outside-'));
  const tools = await ToolRegistry.create(workspace, { write: true, shell: false }, null, { mcp: false });
  t.after(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  const insideFile = path.join(workspace, 'absolute.txt');
  await tools.execute('write_file', { path: insideFile, content: 'inside' });
  assert.equal(await fs.readFile(insideFile, 'utf8'), 'inside');

  await assert.rejects(
    tools.execute('write_file', { path: path.join(outside, 'blocked.txt'), content: 'outside' }),
    /Writes outside the workspace are not allowed/,
  );
  assert.equal(await fileExists(path.join(outside, 'blocked.txt')), false);

  const outsideFile = path.join(outside, 'existing.txt');
  await fs.writeFile(outsideFile, 'unchanged');
  await assert.rejects(
    tools.execute('replace_in_file', { path: outsideFile, old: 'unchanged', new: 'changed' }),
    /Writes outside the workspace are not allowed/,
  );
  assert.equal(await fs.readFile(outsideFile, 'utf8'), 'unchanged');
});

test('known credential paths remain unreadable through absolute paths', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'mai-tools-secrets-workspace-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'mai-tools-secrets-outside-'));
  const secret = path.join(outside, '.env');
  await fs.writeFile(secret, 'TOKEN=secret\n');
  const tools = await ToolRegistry.create(workspace, { write: false, shell: false }, null, { mcp: false });
  t.after(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  await assert.rejects(
    tools.execute('read_file', { path: secret }),
    /Reading credential, secret, or process-environment paths is not allowed/,
  );
});

async function fileExists(target: string): Promise<boolean> {
  return fs.access(target).then(() => true, () => false);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
