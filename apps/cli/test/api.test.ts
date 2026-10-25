import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { startApiServer } from '../src/api.js';
import type { Config } from '../src/config.js';
import type { Content, LlmClient, StreamEvent, ToolDeclaration } from '../src/llm/types.js';

let releaseFirstQueuedRun: (() => void) | null = null;

process.env.MAI_API_HOST = '127.0.0.1';
process.env.MAI_API_PORT = '0';
process.env.MAI_API_KEY = '';
process.env.MAI_API_ALLOW_WRITE = 'true';
process.env.MAI_API_ALLOW_SHELL = 'true';
process.env.MAI_API_APPROVE_RISKY = 'false';

class FakeClient implements LlmClient {
  async *streamTurn(
    _systemInstruction: string,
    contents: Content[],
    _tools: ToolDeclaration[],
    _signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent, void, unknown> {
    const hasToolResponse = contents.some((content) =>
      content.parts.some((part) => 'functionResponse' in part));
    const prompt = contents
      .flatMap((content) => content.parts)
      .filter((part): part is { text: string } => 'text' in part)
      .map((part) => part.text)
      .join('\n');
    const latestUserText = contents.at(-1)?.parts
      .filter((part): part is { text: string } => 'text' in part)
      .map((part) => part.text)
      .join('\n');
    if (latestUserText === 'queue first') {
      await new Promise<void>((resolve) => {
        releaseFirstQueuedRun = resolve;
      });
      yield { type: 'text', text: 'first queued response', thought: false };
      return;
    }
    if (latestUserText === 'queue second') {
      yield { type: 'text', text: 'second queued response', thought: false };
      return;
    }
    if (prompt.includes('write fixture') && !hasToolResponse) {
      yield { type: 'functionCall', call: { name: 'write_file', args: { path: 'changed.txt', content: 'changed by run' } } };
      return;
    }
    if (prompt.includes('approval fixture') && !hasToolResponse) {
      yield { type: 'functionCall', call: { name: 'run_command', args: { command: 'bash -lc true' } } };
      return;
    }
    if (prompt.includes('steer fixture') && !hasToolResponse) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      yield { type: 'functionCall', call: { name: 'list_files', args: { path: '.' } } };
      return;
    }
    if (prompt.includes('stop fixture') && !hasToolResponse) {
      await new Promise<void>((resolve) => {
        if (_signal?.aborted) resolve();
        else _signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      throw new Error('fixture aborted');
    }
    if (prompt.includes('Additional user guidance')) {
      yield { type: 'text', text: 'steered response', thought: false };
      return;
    }
    yield { type: 'text', text: hasToolResponse ? 'tool cycle complete' : 'plain response', thought: false };
  }

  async listModels(): Promise<string[]> {
    return ['test-model'];
  }
}

test('stateful gateway persists sessions, files, skills, events, and approvals', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'mai-api-test-'));
  await fs.mkdir(path.join(workspace, '.agents', 'skills', 'sample'), { recursive: true });
  await fs.writeFile(
    path.join(workspace, '.agents', 'skills', 'sample', 'SKILL.md'),
    '---\nname: sample\ndescription: Test skill\n---\nFollow the fixture.\n',
  );
  const config = fixtureConfig(workspace);
  const { server, port } = await startApiServer({
    config,
    createClient: () => new FakeClient(),
    stateFile: path.join(workspace, '.mai', 'test.sqlite'),
  });
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(workspace, { recursive: true, force: true });
  });

  const capabilities = await json(base, '/v1/capabilities');
  assert.equal(capabilities.stateful, true);
  assert.equal((capabilities.features as Record<string, unknown>).interactiveTerminals, true);

  const skills = await json(base, '/v1/skills');
  assert.ok((skills.skills as Array<{ name: string }>).some((entry) => entry.name === 'sample'));
  const skill = await json(base, '/v1/skills/sample');
  assert.equal(skill.instructions, 'Follow the fixture.');

  const tools = await json(base, '/v1/tools');
  assert.ok((tools.tools as Array<{ name: string }>).some((tool) => tool.name === 'run_command'));

  const session = await json(base, '/v1/sessions', { method: 'POST', body: '{}' });
  const run = await json(base, `/v1/sessions/${session.id}/runs`, {
    method: 'POST',
    body: JSON.stringify({ input: 'write fixture' }),
  });
  const completed = await waitForRun(base, String(run.id), 'completed');
  assert.equal(completed.message, 'tool cycle complete');

  const file = await json(base, '/v1/files/content?path=changed.txt');
  assert.equal(file.content, 'changed by run');
  const messages = await json(base, `/v1/sessions/${session.id}/messages`);
  assert.ok((messages.messages as unknown[]).length >= 4);

  const eventResponse = await fetch(`${base}/v1/runs/${run.id}/events?after=0`);
  const eventText = await eventResponse.text();
  assert.match(eventText, /event: agent\.toolStart/);
  assert.match(eventText, /event: run\.completed/);

  const approvalSession = await json(base, '/v1/sessions', { method: 'POST', body: '{}' });
  const approvalRun = await json(base, `/v1/sessions/${approvalSession.id}/runs`, {
    method: 'POST',
    body: JSON.stringify({ input: 'approval fixture' }),
  });
  await waitForRun(base, String(approvalRun.id), 'waiting_approval');
  await json(base, `/v1/runs/${approvalRun.id}/approval`, {
    method: 'POST',
    body: JSON.stringify({ approved: false }),
  });
  const approvalCompleted = await waitForRun(base, String(approvalRun.id), 'completed');
  assert.equal(approvalCompleted.message, 'tool cycle complete');

  const steerSession = await json(base, '/v1/sessions', { method: 'POST', body: '{}' });
  const steerRun = await json(base, `/v1/sessions/${steerSession.id}/runs`, {
    method: 'POST', body: JSON.stringify({ input: 'steer fixture' }),
  });
  await json(base, `/v1/runs/${steerRun.id}/steer`, {
    method: 'POST', body: JSON.stringify({ message: 'use the steered result' }),
  });
  const steerCompleted = await waitForRun(base, String(steerRun.id), 'completed');
  assert.equal(steerCompleted.message, 'steered response');

  const stopSession = await json(base, '/v1/sessions', { method: 'POST', body: '{}' });
  const stopRun = await json(base, `/v1/sessions/${stopSession.id}/runs`, {
    method: 'POST', body: JSON.stringify({ input: 'stop fixture' }),
  });
  await json(base, `/v1/runs/${stopRun.id}/stop`, { method: 'POST' });
  await waitForRun(base, String(stopRun.id), 'cancelled');
});

test('legacy chat endpoint remains compatible', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'mai-chat-test-'));
  const { server, port } = await startApiServer({
    config: fixtureConfig(workspace),
    createClient: () => new FakeClient(),
    stateFile: ':memory:',
  });
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(workspace, { recursive: true, force: true });
  });
  const response = await json(base, '/v1/chat', {
    method: 'POST',
    body: JSON.stringify({ message: 'hello' }),
  });
  assert.equal(response.message, 'plain response');
  assert.ok(Array.isArray(response.history));
});

test('runs submitted during an active session run execute later in FIFO order', async (t) => {
  releaseFirstQueuedRun = null;
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'mai-run-queue-test-'));
  const { server, port } = await startApiServer({
    config: fixtureConfig(workspace),
    createClient: () => new FakeClient(),
    stateFile: ':memory:',
  });
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => {
    releaseFirstQueuedRun?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(workspace, { recursive: true, force: true });
  });

  const session = await json(base, '/v1/sessions', { method: 'POST', body: '{}' });
  const first = await json(base, `/v1/sessions/${session.id}/runs`, {
    method: 'POST', body: JSON.stringify({ input: 'queue first' }),
  });
  await waitForRun(base, String(first.id), 'running');
  const second = await json(base, `/v1/sessions/${session.id}/runs`, {
    method: 'POST', body: JSON.stringify({ input: 'queue second' }),
  });
  const queued = await json(base, `/v1/runs/${second.id}`);
  assert.equal(queued.status, 'queued');

  for (let attempt = 0; attempt < 100 && !releaseFirstQueuedRun; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(releaseFirstQueuedRun, 'first run should be waiting on the fixture gate');
  releaseFirstQueuedRun();
  await waitForRun(base, String(first.id), 'completed');
  const completedSecond = await waitForRun(base, String(second.id), 'completed');
  assert.equal(completedSecond.message, 'second queued response');

  const messages = await json(base, `/v1/sessions/${session.id}/messages`);
  const text = JSON.stringify(messages.messages);
  assert.ok(text.indexOf('queue first') < text.indexOf('queue second'));
});

test('sessions, runs, and events survive an API restart', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'mai-restart-test-'));
  const stateFile = path.join(workspace, '.mai', 'restart.sqlite');
  const first = await startApiServer({
    config: fixtureConfig(workspace), createClient: () => new FakeClient(), stateFile,
  });
  const firstBase = `http://127.0.0.1:${first.port}`;
  const session = await json(firstBase, '/v1/sessions', { method: 'POST', body: '{}' });
  const run = await json(firstBase, `/v1/sessions/${session.id}/runs`, {
    method: 'POST', body: JSON.stringify({ input: 'hello' }),
  });
  await waitForRun(firstBase, String(run.id), 'completed');
  await new Promise<void>((resolve) => first.server.close(() => resolve()));

  const second = await startApiServer({
    config: fixtureConfig(workspace), createClient: () => new FakeClient(), stateFile,
  });
  try {
    const secondBase = `http://127.0.0.1:${second.port}`;
    const restoredSession = await json(secondBase, `/v1/sessions/${session.id}`);
    assert.equal(restoredSession.id, session.id);
    const restoredRun = await json(secondBase, `/v1/runs/${run.id}`);
    assert.equal(restoredRun.status, 'completed');
    const events = await (await fetch(`${secondBase}/v1/runs/${run.id}/events`)).text();
    assert.match(events, /run\.completed/);
  } finally {
    await new Promise<void>((resolve) => second.server.close(() => resolve()));
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('interactive terminal streams stdin and stdout through mai-sandbox', {
  skip: !process.env.MAI_TEST_SANDBOX_BIN,
}, async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'mai-terminal-test-'));
  const { server, port } = await startApiServer({
    config: fixtureConfig(workspace, process.env.MAI_TEST_SANDBOX_BIN),
    createClient: () => new FakeClient(),
    stateFile: ':memory:',
  });
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(workspace, { recursive: true, force: true });
  });

  const terminal = await json(base, '/v1/terminals', {
    method: 'POST',
    body: JSON.stringify({ command: 'read value; printf "got:%s\\n" "$value"' }),
  });
  await waitForTerminal(base, String(terminal.id), 'running');
  await json(base, `/v1/terminals/${terminal.id}/input`, {
    method: 'POST',
    body: JSON.stringify({ data: 'hello from api\n' }),
  });
  await waitForTerminal(base, String(terminal.id), 'exited');
  const response = await fetch(`${base}/v1/terminals/${terminal.id}/events`);
  const stream = await response.text();
  const output = [...stream.matchAll(/^data: (.+)$/gm)]
    .map((match) => JSON.parse(match[1]) as { data?: string })
    .filter((event) => event.data)
    .map((event) => Buffer.from(event.data!, 'base64').toString('utf8'))
    .join('');
  assert.match(output, /got:hello from api/);
});

function fixtureConfig(workspace: string, sandboxBinary = '/bin/false'): Config {
  return {
    provider: 'test',
    kind: 'openai',
    type: 'openai-compatible',
    wireApi: 'chat-completions',
    auth: { type: 'env', env: 'TEST_API_KEY' },
    capabilities: {},
    apiKey: 'fixture-key',
    model: 'test-model',
    baseUrl: 'http://127.0.0.1:1',
    maxOutputTokens: 1024,
    temperature: 0,
    workspace,
    allowShell: true,
    sandboxBinary,
    providers: [{
      name: 'test', kind: 'openai', type: 'openai-compatible', wireApi: 'chat-completions',
      baseUrl: 'http://127.0.0.1:1', apiKeyEnv: 'TEST_API_KEY',
      auth: { type: 'env', env: 'TEST_API_KEY' }, capabilities: {}, model: 'test-model',
    }],
  };
}

async function waitForTerminal(
  base: string,
  terminalId: string,
  status: string,
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const terminal = await json(base, `/v1/terminals/${terminalId}`);
    if (terminal.status === status) return terminal;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Terminal ${terminalId} did not reach ${status}.`);
}

async function json(base: string, route: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(`${base}${route}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = await response.json() as Record<string, unknown>;
  assert.ok(response.ok, `${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function waitForRun(
  base: string,
  runId: string,
  status: string,
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const run = await json(base, `/v1/runs/${runId}`);
    if (run.status === status) return run;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Run ${runId} did not reach ${status}.`);
}
