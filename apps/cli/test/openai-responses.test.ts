import assert from 'node:assert/strict';
import test from 'node:test';

import { OpenAiClient, parseResponsesSseStream, toResponsesInput } from '../src/llm/openai.js';

function stream(...events: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')));
      controller.close();
    },
  });
}

test('maps Responses text, hosted search, citations, reasoning state, and function calls', async () => {
  const events = parseResponsesSseStream(stream(
    { type: 'response.web_search_call.in_progress', item_id: 'ws_1' },
    { type: 'response.web_search_call.searching', item_id: 'ws_1' },
    { type: 'response.output_text.delta', delta: 'Today' },
    {
      type: 'response.output_text.annotation.added',
      annotation: { type: 'url_citation', url: 'https://example.com/news', title: 'News', start_index: 0, end_index: 5 },
    },
    { type: 'response.web_search_call.completed', item_id: 'ws_1' },
    {
      type: 'response.output_item.done',
      item: { type: 'reasoning', id: 'rs_1', encrypted_content: 'encrypted' },
    },
    {
      type: 'response.output_item.done',
      item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read_file', arguments: '{"path":"README.md"}' },
    },
  ));
  const received = [];
  for await (const event of events) received.push(event);
  assert.deepEqual(received, [
    { type: 'hostedTool', id: 'ws_1', name: 'web_search', stage: 'started' },
    { type: 'hostedTool', id: 'ws_1', name: 'web_search', stage: 'running' },
    { type: 'text', text: 'Today', thought: false },
    {
      type: 'citation',
      citation: { url: 'https://example.com/news', title: 'News', startIndex: 0, endIndex: 5 },
    },
    { type: 'hostedTool', id: 'ws_1', name: 'web_search', stage: 'completed' },
    {
      type: 'providerState',
      state: { provider: 'openai', item: { type: 'reasoning', id: 'rs_1', encrypted_content: 'encrypted' } },
    },
    { type: 'functionCall', call: { id: 'call_1', name: 'read_file', args: { path: 'README.md' } } },
  ]);
});

test('replays Responses call ids and encrypted provider state', () => {
  assert.deepEqual(toResponsesInput([
    { role: 'user', parts: [{ text: 'Inspect it' }] },
    {
      role: 'model',
      parts: [
        { providerState: { provider: 'openai', item: { type: 'reasoning', id: 'rs_1', encrypted_content: 'x' } } },
        { functionCall: { id: 'call_1', name: 'read_file', args: { path: 'README.md' } } },
      ],
    },
    {
      role: 'user',
      parts: [{ functionResponse: { callId: 'call_1', name: 'read_file', response: { result: 'ok' } } }],
    },
  ]), [
    { role: 'user', content: 'Inspect it' },
    { type: 'reasoning', id: 'rs_1', encrypted_content: 'x' },
    { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"README.md"}' },
    { type: 'function_call_output', call_id: 'call_1', output: '{"result":"ok"}' },
  ]);
});

test('the shared OpenAI-compatible client switches to Responses and enables hosted search by capability', async (t) => {
  const requests: Array<{ url: string; body: Record<string, unknown>; authorization: string | null }> = [];
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    requests.push({
      url: String(input),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      authorization: new Headers(init?.headers).get('authorization'),
    });
    return new Response('data: {"type":"response.output_text.delta","delta":"ok"}\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  });
  const client = new OpenAiClient({
    credential: {
      description: 'test',
      isConfigured: () => true,
      getAuthorization: async () => ({
        mode: 'api-key' as const,
        headers: { authorization: 'Bearer token-from-manager' },
      }),
      getToken: async () => 'token-from-manager',
    },
    providerType: 'openai',
    wireApi: 'responses',
    capabilities: { webSearch: true },
    model: 'gpt-test',
    baseUrl: 'https://api.openai.com/v1',
    maxOutputTokens: 1024,
    temperature: 0,
  });
  const received = [];
  for await (const event of client.streamTurn('system', [{ role: 'user', parts: [{ text: 'news' }] }], [])) {
    received.push(event);
  }
  assert.deepEqual(received, [{ type: 'text', text: 'ok', thought: false }]);
  assert.equal(requests[0].url, 'https://api.openai.com/v1/responses');
  assert.equal(requests[0].authorization, 'Bearer token-from-manager');
  assert.deepEqual(requests[0].body.tools, [{ type: 'web_search', external_web_access: true }]);
});

test('a reused Codex login routes through the configured ChatGPT plan endpoint with account scope', async (t) => {
  const requests: Array<{ url: string; account: string | null }> = [];
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    requests.push({ url: String(input), account: new Headers(init?.headers).get('chatgpt-account-id') });
    return new Response(JSON.stringify({
      models: [
        { slug: 'hidden', visibility: 'hide' },
        { slug: 'gpt-visible', visibility: 'list' },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const client = new OpenAiClient({
    credential: {
      description: 'codex',
      isConfigured: () => true,
      getToken: async () => 'codex-token',
      getAuthorization: async () => ({
        mode: 'chatgpt' as const,
        headers: {
          authorization: 'Bearer codex-token',
          'chatgpt-account-id': 'account-1',
        },
      }),
      getClientVersion: async () => '0.164.0',
    },
    providerType: 'openai',
    wireApi: 'responses',
    capabilities: { webSearch: true },
    model: 'gpt-visible',
    baseUrl: 'https://api.openai.com/v1',
    chatgptBaseUrl: 'https://chatgpt.com/backend-api/codex',
    maxOutputTokens: 1024,
    temperature: 0,
  });
  assert.deepEqual(await client.listModels(), ['gpt-visible']);
  assert.equal(
    requests[0].url,
    'https://chatgpt.com/backend-api/codex/models?client_version=0.164.0',
  );
  assert.equal(requests[0].account, 'account-1');
});
