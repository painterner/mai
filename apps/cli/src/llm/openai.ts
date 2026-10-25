import type {
  Citation,
  Content,
  FunctionCall,
  FunctionResponsePart,
  LlmClient,
  Part,
  ProviderStatePart,
  StreamEvent,
  ToolDeclaration,
} from './types.js';
import type { ProviderCapabilities, ProviderType, ProviderWireApi } from '../config.js';
import type { AccessTokenProvider } from './auth.js';

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
  credential: AccessTokenProvider;
  providerType: ProviderType;
  wireApi: ProviderWireApi;
  capabilities: ProviderCapabilities;
  chatgptBaseUrl?: string;
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
    const useResponses = this.opts.wireApi === 'responses';
    const endpoint = useResponses ? 'responses' : 'chat/completions';
    const body = useResponses
      ? responsesRequest(this.opts, systemInstruction, contents, tools)
      : chatCompletionsRequest(this.opts, systemInstruction, contents, tools);
    const { response } = await this.authorizedFetch(endpoint, {
      method: 'POST',
      headers: {
        accept: 'text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    });
    await requireStreamingResponse(response);
    yield* useResponses
      ? parseResponsesSseStream(response.body!)
      : parseChatCompletionsSseStream(response.body!);
  }

  /**
   * `GET {baseUrl}/models` — the Chat Completions-side counterpart of
   * Gemini's model-discovery route, same shape across real OpenAI and the
   * self-hosted servers that mimic it (vLLM, Ollama, LM Studio, ...).
   * There's no reliable "supports chat" flag in the response the way
   * Gemini has `supportedGenerationMethods`, so every id returned is kept.
   */
  async listModels(): Promise<string[]> {
    const version = await this.opts.credential.getClientVersion?.();
    const query = version ? `?client_version=${encodeURIComponent(version)}` : '';
    const { response, authorization } = await this.authorizedFetch(`models${query}`);
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(
        `OpenAI-compatible API error (HTTP ${response.status} ${response.statusText}): ${truncate(text, 500)}`,
      );
    }
    const body = (await response.json()) as {
      data?: Array<{ id: string }>;
      models?: Array<{ slug?: string; id?: string; visibility?: string }>;
    };
    if (authorization.mode === 'chatgpt' && body.models) {
      return body.models
        .filter((model) => model.visibility === undefined || model.visibility === 'list')
        .map((model) => model.slug ?? model.id ?? '')
        .filter(Boolean);
    }
    return (body.data ?? body.models ?? [])
      .map((model) => 'id' in model ? model.id ?? '' : '')
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
  }

  private async authorizedFetch(
    endpoint: string,
    init: RequestInit = {},
  ): Promise<{ response: Response; authorization: Awaited<ReturnType<AccessTokenProvider['getAuthorization']>> }> {
    let authorization = await this.opts.credential.getAuthorization();
    let response = await fetch(this.endpointUrl(endpoint, authorization.mode), withAuthorization(init, authorization.headers));
    if (response.status !== 401) return { response, authorization };
    await response.body?.cancel().catch(() => undefined);
    authorization = await this.opts.credential.getAuthorization(true);
    response = await fetch(this.endpointUrl(endpoint, authorization.mode), withAuthorization(init, authorization.headers));
    return { response, authorization };
  }

  private endpointUrl(endpoint: string, authMode: 'chatgpt' | 'api-key' | 'none'): string {
    const base = authMode === 'chatgpt' && this.opts.chatgptBaseUrl
      ? this.opts.chatgptBaseUrl
      : this.opts.baseUrl;
    return `${base.replace(/\/$/, '')}/${endpoint}`;
  }
}

function chatCompletionsRequest(
  opts: OpenAiClientOptions,
  systemInstruction: string,
  contents: Content[],
  tools: ToolDeclaration[],
): Record<string, unknown> {
  return {
    model: opts.model,
    messages: toOpenAiMessages(systemInstruction, contents),
    ...(tools.length ? { tools: tools.map((t) => ({ type: 'function' as const, function: t })) } : {}),
    stream: true,
    max_tokens: opts.maxOutputTokens,
    temperature: opts.temperature,
  };
}

function responsesRequest(
  opts: OpenAiClientOptions,
  systemInstruction: string,
  contents: Content[],
  tools: ToolDeclaration[],
): Record<string, unknown> {
  const responseTools: Array<Record<string, unknown>> = tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    strict: false,
  }));
  if (opts.providerType === 'openai' && opts.capabilities.webSearch) {
    responseTools.unshift({ type: 'web_search', external_web_access: true });
  }
  return {
    model: opts.model,
    instructions: systemInstruction,
    input: toResponsesInput(contents),
    ...(responseTools.length ? { tools: responseTools } : {}),
    ...(opts.providerType === 'openai' && opts.capabilities.reasoning
      ? { include: ['reasoning.encrypted_content'] }
      : {}),
    stream: true,
    store: false,
    max_output_tokens: opts.maxOutputTokens,
  };
}

function withAuthorization(init: RequestInit, authorization: Record<string, string>): RequestInit {
  const headers = new Headers(init.headers);
  for (const [name, value] of Object.entries(authorization)) headers.set(name, value);
  return {
    ...init,
    headers,
  };
}

async function requireStreamingResponse(response: Response): Promise<void> {
  if (response.ok && response.body) return;
  const text = await response.text().catch(() => '');
  throw new Error(
    `OpenAI-compatible API error (HTTP ${response.status} ${response.statusText}): ${truncate(text, 500)}`,
  );
}

// --- request-side translation: canonical Content[] -> OpenAI messages ---

interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  /**
   * Some "thinking mode" reasoning models (DeepSeek-R1-style, several
   * proxies) require the reasoning they streamed on a previous turn to be
   * echoed back verbatim on this field when that assistant message is
   * replayed in a later request — omit it and they 400 with "reasoning_content
   * ... must be passed back to the API" the moment a tool call triggers a
   * follow-up completion.
   */
  reasoning_content?: string;
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
  // Some "thinking mode" providers (see the reasoning_content doc comment
  // above) treat reasoning as a *session-level* switch, not a per-turn one:
  // once any turn has streamed reasoning, they require every later
  // assistant message to carry the field — even ones that themselves had
  // no reasoning text — and 400 on a message that omits it outright rather
  // than tolerating a missing field the way most JSON APIs would.
  let thinkingModeActive = false;

  for (const entry of contents) {
    const allTextParts = entry.parts.filter(isTextPart);
    const textParts = allTextParts.filter((p) => !p.thought);
    const thoughtParts = allTextParts.filter((p) => p.thought);
    const functionCalls = entry.parts.filter(isFunctionCallPart);
    const functionResponses = entry.parts.filter(isFunctionResponsePart);

    if (entry.role === 'model') {
      const text = textParts.map((p) => p.text).join('');
      const reasoning = thoughtParts.map((p) => p.text).join('');
      if (reasoning) thinkingModeActive = true;
      const reasoningField = thinkingModeActive ? { reasoning_content: reasoning } : {};
      if (functionCalls.length) {
        const ids = functionCalls.map((p, i) => p.functionCall.id ?? `call_${messages.length}_${i}`);
        messages.push({
          role: 'assistant',
          content: text || null,
          ...reasoningField,
          tool_calls: functionCalls.map((p, i) => ({
            id: ids[i],
            type: 'function',
            function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args ?? {}) },
          })),
        });
        lastToolCallIds = ids;
      } else {
        messages.push({ role: 'assistant', content: text, ...reasoningField });
        lastToolCallIds = [];
      }
    } else if (functionResponses.length) {
      functionResponses.forEach((p, i) => {
        messages.push({
          role: 'tool',
          tool_call_id: p.functionResponse.callId ?? lastToolCallIds[i] ?? `call_unmatched_${i}`,
          content: JSON.stringify(p.functionResponse.response),
        });
      });
    } else if (textParts.length) {
      messages.push({ role: 'user', content: textParts.map((p) => p.text).join('') });
    }
  }

  return messages;
}

type ResponsesInputItem = Record<string, unknown>;

/** Convert Mai's provider-neutral history to Responses Items. */
export function toResponsesInput(contents: Content[]): ResponsesInputItem[] {
  const input: ResponsesInputItem[] = [];
  for (const entry of contents) {
    const text = entry.parts
      .filter(isTextPart)
      .filter((part) => !part.thought)
      .map((part) => part.text)
      .join('');
    if (text) input.push({ role: entry.role === 'model' ? 'assistant' : 'user', content: text });

    for (const part of entry.parts) {
      if (isProviderStatePart(part) && part.providerState.provider === 'openai') {
        input.push(part.providerState.item);
      } else if (isFunctionCallPart(part)) {
        input.push({
          type: 'function_call',
          call_id: part.functionCall.id ?? `call_replayed_${input.length}`,
          name: part.functionCall.name,
          arguments: JSON.stringify(part.functionCall.args ?? {}),
        });
      } else if (isFunctionResponsePart(part)) {
        input.push({
          type: 'function_call_output',
          call_id: part.functionResponse.callId ?? `call_unmatched_${input.length}`,
          output: JSON.stringify(part.functionResponse.response),
        });
      }
    }
  }
  return input;
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
function isProviderStatePart(part: Part): part is { providerState: ProviderStatePart } {
  return 'providerState' in part;
}

// --- response-side streaming parse ---

interface PendingToolCall {
  id?: string;
  name: string;
  argsText: string;
}

export async function* parseChatCompletionsSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<StreamEvent, void, unknown> {
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
    if (toolCallDelta.id) existing.id = toolCallDelta.id;
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
    yield { type: 'functionCall', call: { id: call.id, name: call.name, args } };
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
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  error?: { message: string };
}

interface ResponsesStreamEvent {
  type?: string;
  delta?: string;
  item_id?: string;
  item?: Record<string, unknown>;
  annotation?: Record<string, unknown>;
  error?: { message?: string };
  message?: string;
  response?: {
    error?: { message?: string } | null;
    incomplete_details?: { reason?: string } | null;
  };
}

export async function* parseResponsesSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<StreamEvent, void, unknown> {
  for await (const payload of ssePayloads(body)) {
    if (payload === '[DONE]') continue;
    let event: ResponsesStreamEvent;
    try {
      event = JSON.parse(payload) as ResponsesStreamEvent;
    } catch (error) {
      throw new Error(`Invalid OpenAI Responses stream event: ${(error as Error).message}`);
    }
    yield* mapResponsesEvent(event);
  }
}

async function* ssePayloads(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const payload = sseData(block);
        if (payload !== null) yield payload;
      }
    }
    buffer += decoder.decode().replace(/\r\n/g, '\n');
    if (buffer.trim()) {
      const payload = sseData(buffer);
      if (payload !== null) yield payload;
    }
  } finally {
    reader.releaseLock();
  }
}

function sseData(block: string): string | null {
  const lines = block
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart());
  return lines.length ? lines.join('\n') : null;
}

function* mapResponsesEvent(event: ResponsesStreamEvent): Generator<StreamEvent> {
  switch (event.type) {
    case 'response.output_text.delta':
      if (event.delta) yield { type: 'text', text: event.delta, thought: false };
      return;
    case 'response.reasoning_summary_text.delta':
    case 'response.reasoning_text.delta':
      if (event.delta) yield { type: 'text', text: event.delta, thought: true };
      return;
    case 'response.web_search_call.in_progress':
      yield { type: 'hostedTool', id: event.item_id ?? 'web-search', name: 'web_search', stage: 'started' };
      return;
    case 'response.web_search_call.searching':
      yield { type: 'hostedTool', id: event.item_id ?? 'web-search', name: 'web_search', stage: 'running' };
      return;
    case 'response.web_search_call.completed':
      yield { type: 'hostedTool', id: event.item_id ?? 'web-search', name: 'web_search', stage: 'completed' };
      return;
    case 'response.output_text.annotation.added': {
      const citation = parseCitation(event.annotation);
      if (citation) yield { type: 'citation', citation };
      return;
    }
    case 'response.output_item.done': {
      const item = event.item;
      if (!item || typeof item.type !== 'string') return;
      if (item.type === 'function_call') {
        const name = typeof item.name === 'string' ? item.name : '';
        const callId = typeof item.call_id === 'string'
          ? item.call_id
          : typeof item.id === 'string' ? item.id : undefined;
        const argumentsText = typeof item.arguments === 'string' ? item.arguments : '{}';
        let args: Record<string, unknown>;
        try {
          const parsed = JSON.parse(argumentsText) as unknown;
          args = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : {};
        } catch (error) {
          throw new Error(`Failed to parse Responses function call arguments for "${name}": ${(error as Error).message}`);
        }
        yield { type: 'functionCall', call: { id: callId, name, args } };
        return;
      }
      // Message text and local function calls are represented by canonical
      // Mai parts. Preserve every other output item verbatim so encrypted
      // reasoning and hosted-tool state can be replayed with store:false.
      if (item.type !== 'message') {
        yield { type: 'providerState', state: { provider: 'openai', item } };
      }
      return;
    }
    case 'response.failed':
      throw new Error(event.response?.error?.message ?? 'OpenAI Responses request failed.');
    case 'response.incomplete':
      throw new Error(`OpenAI Responses request was incomplete: ${event.response?.incomplete_details?.reason ?? 'unknown reason'}.`);
    case 'error':
      throw new Error(event.error?.message ?? event.message ?? 'OpenAI Responses stream error.');
    default:
      return;
  }
}

function parseCitation(annotation: Record<string, unknown> | undefined): Citation | null {
  if (!annotation || annotation.type !== 'url_citation') return null;
  const nested = record(annotation.url_citation) ?? annotation;
  const url = nested.url;
  if (typeof url !== 'string' || !url) return null;
  return {
    url,
    ...(typeof nested.title === 'string' ? { title: nested.title } : {}),
    ...(typeof nested.start_index === 'number' ? { startIndex: nested.start_index } : {}),
    ...(typeof nested.end_index === 'number' ? { endIndex: nested.end_index } : {}),
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function truncate(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars)}…` : value;
}
