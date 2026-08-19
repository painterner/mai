import type {
  Content,
  FunctionCall,
  FunctionResponsePart,
  LlmClient,
  Part,
  StreamEvent,
  ToolDeclaration,
} from './types.js';

/**
 * Client for the OpenAI-compatible Chat Completions streaming endpoint
 * (`POST {baseUrl}/chat/completions`, `stream: true`) — works against the
 * real OpenAI API and against the many local/self-hosted servers that
 * mimic its wire format (vLLM, Ollama's OpenAI-compat mode, LM Studio,
 * etc).
 *
 * The one genuinely tricky part versus the Gemini client: a streamed tool
 * call's `arguments` arrive as raw string *fragments* spread across many
 * chunks (`delta.tool_calls[i].function.arguments`), keyed by a numeric
 * `index`, not as one complete JSON object like Gemini's `functionCall`
 * part. Each index's fragments have to be concatenated and only
 * `JSON.parse`d once the stream signals that tool call is done — there is
 * no way to safely act on a partial fragment.
 */

export interface OpenAiClientOptions {
  apiKey: string;
  model: string;
  baseUrl: string;
  maxOutputTokens: number;
  temperature: number;
}

export class OpenAiClient implements LlmClient {
  constructor(private readonly opts: OpenAiClientOptions) {}

  async *streamTurn(
    systemInstruction: string,
    contents: Content[],
    tools: ToolDeclaration[],
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent, void, unknown> {
    if (!this.opts.apiKey) {
      throw new Error(
        'No OPENAI_API_KEY configured. Put it in a .env file (see .env.example) or export it in your shell.',
      );
    }

    const url = `${this.opts.baseUrl}/chat/completions`;
    const body = {
      model: this.opts.model,
      messages: toOpenAiMessages(systemInstruction, contents),
      ...(tools.length
        ? { tools: tools.map((t) => ({ type: 'function' as const, function: t })) }
        : {}),
      stream: true,
      max_tokens: this.opts.maxOutputTokens,
      temperature: this.opts.temperature,
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.opts.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => '');
      throw new Error(
        `OpenAI-compatible API error (HTTP ${response.status} ${response.statusText}): ${truncate(text, 500)}`,
      );
    }

    yield* parseSseStream(response.body);
  }
}

// --- request-side translation: canonical Content[] -> OpenAI messages ---

interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

function toOpenAiMessages(systemInstruction: string, contents: Content[]): OpenAiMessage[] {
  const messages: OpenAiMessage[] = [{ role: 'system', content: systemInstruction }];
  // Ids only need to be self-consistent *within this one outgoing request*
  // (OpenAI just checks a `tool` message's tool_call_id matches an id on
  // the preceding assistant message in the same request) — so they're
  // synthesized fresh from position every call rather than persisted
  // anywhere, which sidesteps needing to carry a provider-specific id
  // through the canonical Content/FunctionCall shape at all.
  let lastToolCallIds: string[] = [];

  for (const entry of contents) {
    const textParts = entry.parts.filter(isTextPart);
    const functionCalls = entry.parts.filter(isFunctionCallPart);
    const functionResponses = entry.parts.filter(isFunctionResponsePart);

    if (entry.role === 'model') {
      const text = textParts.map((p) => p.text).join('');
      if (functionCalls.length) {
        const ids = functionCalls.map((_, i) => `call_${messages.length}_${i}`);
        messages.push({
          role: 'assistant',
          content: text || null,
          tool_calls: functionCalls.map((p, i) => ({
            id: ids[i],
            type: 'function',
            function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args ?? {}) },
          })),
        });
        lastToolCallIds = ids;
      } else {
        messages.push({ role: 'assistant', content: text });
        lastToolCallIds = [];
      }
    } else if (functionResponses.length) {
      functionResponses.forEach((p, i) => {
        messages.push({
          role: 'tool',
          tool_call_id: lastToolCallIds[i] ?? `call_unmatched_${i}`,
          content: JSON.stringify(p.functionResponse.response),
        });
      });
    } else if (textParts.length) {
      messages.push({ role: 'user', content: textParts.map((p) => p.text).join('') });
    }
  }

  return messages;
}

function isTextPart(part: Part): part is { text: string; thought?: boolean } {
  return 'text' in part;
}
function isFunctionCallPart(part: Part): part is { functionCall: FunctionCall } {
  return 'functionCall' in part;
}
function isFunctionResponsePart(part: Part): part is { functionResponse: FunctionResponsePart } {
  return 'functionResponse' in part;
}

// --- response-side streaming parse ---

interface PendingToolCall {
  name: string;
  argsText: string;
}

async function* parseSseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent, void, unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  const pendingCalls = new Map<number, PendingToolCall>();

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        yield* handleSseBlock(rawEvent, pendingCalls);
      }
    }
    if (buffer.trim()) {
      yield* handleSseBlock(buffer, pendingCalls);
    }
  } finally {
    reader.releaseLock();
  }

  // The stream ended (either "data: [DONE]" or the connection just closed)
  // without an explicit finish_reason flush — emit whatever tool calls
  // accumulated rather than silently dropping them.
  yield* flushToolCalls(pendingCalls);
}

function* handleSseBlock(
  block: string,
  pendingCalls: Map<number, PendingToolCall>,
): Generator<StreamEvent, void, unknown> {
  const dataLines = block
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim());
  if (dataLines.length === 0) return;

  const payload = dataLines.join('\n');
  if (payload === '[DONE]') {
    yield* flushToolCalls(pendingCalls);
    return;
  }

  let chunk: OpenAiStreamChunk;
  try {
    chunk = JSON.parse(payload);
  } catch (err) {
    throw new Error(`Invalid OpenAI-compatible stream response: ${(err as Error).message}`);
  }

  if (chunk.error) {
    throw new Error(`OpenAI-compatible API error: ${chunk.error.message}`);
  }

  const choice = chunk.choices?.[0];
  const delta = choice?.delta;
  if (!delta) return;

  const thoughtText = delta.reasoning_content ?? delta.reasoning;
  if (thoughtText) {
    yield { type: 'text', text: thoughtText, thought: true };
  }
  if (delta.content) {
    yield { type: 'text', text: delta.content, thought: false };
  }

  for (const toolCallDelta of delta.tool_calls ?? []) {
    const existing = pendingCalls.get(toolCallDelta.index) ?? { name: '', argsText: '' };
    if (toolCallDelta.function?.name) existing.name += toolCallDelta.function.name;
    if (toolCallDelta.function?.arguments) existing.argsText += toolCallDelta.function.arguments;
    pendingCalls.set(toolCallDelta.index, existing);
  }

  if (choice?.finish_reason) {
    yield* flushToolCalls(pendingCalls);
  }
}

function* flushToolCalls(pendingCalls: Map<number, PendingToolCall>): Generator<StreamEvent, void, unknown> {
  if (pendingCalls.size === 0) return;
  const indexes = [...pendingCalls.keys()].sort((a, b) => a - b);
  for (const index of indexes) {
    const call = pendingCalls.get(index)!;
    let args: Record<string, unknown> = {};
    if (call.argsText.trim()) {
      try {
        args = JSON.parse(call.argsText);
      } catch (err) {
        throw new Error(
          `Failed to parse streamed tool call arguments for "${call.name}": ${(err as Error).message}`,
        );
      }
    }
    yield { type: 'functionCall', call: { name: call.name, args } };
  }
  pendingCalls.clear();
}

interface OpenAiStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string;
      reasoning_content?: string;
      reasoning?: string;
      tool_calls?: Array<{
        index: number;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  error?: { message: string };
}

function truncate(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars)}…` : value;
}
