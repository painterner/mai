import type { Content, LlmClient, StreamEvent, ToolDeclaration, FunctionCall } from './types.js';

/**
 * Thin client for the Gemini `streamGenerateContent` REST endpoint, using
 * native function calling (the `tools`/`functionCall`/`functionResponse`
 * fields) rather than the prompt-hacked "respond with one JSON action"
 * protocol mail-cli-rust uses — this gets us real token-level streaming
 * of the final answer instead of only revealing it once a whole JSON blob
 * parses. Endpoint shape (`/models/{model}:streamGenerateContent?alt=sse`,
 * `systemInstruction`, `generationConfig.maxOutputTokens/temperature`) is
 * confirmed against the sibling Rust client rather than guessed.
 */

export interface GeminiClientOptions {
  apiKey: string;
  model: string;
  baseUrl: string;
  maxOutputTokens: number;
  temperature: number;
}

export class GeminiClient implements LlmClient {
  constructor(private readonly opts: GeminiClientOptions) {}

  async *streamTurn(
    systemInstruction: string,
    contents: Content[],
    tools: ToolDeclaration[],
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent, void, unknown> {
    if (!this.opts.apiKey) {
      throw new Error(
        'No API key configured for this provider — set the env var named by its providers.json apiKeyEnv field, in a .env file (see .env.example) or exported in your shell.',
      );
    }

    const url =
      `${this.opts.baseUrl}/models/${encodeURIComponent(this.opts.model)}:streamGenerateContent` +
      `?alt=sse&key=${encodeURIComponent(this.opts.apiKey)}`;

    const body = {
      systemInstruction: { parts: [{ text: systemInstruction }] },
      contents,
      ...(tools.length ? { tools: [{ functionDeclarations: tools }] } : {}),
      generationConfig: {
        maxOutputTokens: this.opts.maxOutputTokens,
        temperature: this.opts.temperature,
      },
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => '');
      throw new Error(
        `Gemini API error (HTTP ${response.status} ${response.statusText}): ${truncate(text, 500)}`,
      );
    }

    yield* parseSseStream(response.body);
  }

  /**
   * `GET {baseUrl}/models` (paginated via `pageToken`/`nextPageToken`).
   * Keeps only models whose `supportedGenerationMethods` includes
   * `generateContent` — the ones `streamTurn` above can actually drive —
   * and strips the API's `models/` name prefix down to the bare id this
   * client's `model` option expects.
   */
  async listModels(): Promise<string[]> {
    if (!this.opts.apiKey) {
      throw new Error(
        'No API key configured for this provider — set the env var named by its providers.json apiKeyEnv field, in a .env file (see .env.example) or exported in your shell.',
      );
    }

    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      const url =
        `${this.opts.baseUrl}/models?pageSize=1000&key=${encodeURIComponent(this.opts.apiKey)}` +
        (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');
      const response = await fetch(url);
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(
          `Gemini API error (HTTP ${response.status} ${response.statusText}): ${truncate(text, 500)}`,
        );
      }
      const page = (await response.json()) as GeminiModelsPage;
      for (const model of page.models ?? []) {
        if (!model.supportedGenerationMethods?.includes('generateContent')) continue;
        ids.push(model.name.replace(/^models\//, ''));
      }
      pageToken = page.nextPageToken;
    } while (pageToken);

    return ids.sort((a, b) => a.localeCompare(b));
  }
}

interface GeminiModelsPage {
  models?: Array<{ name: string; supportedGenerationMethods?: string[] }>;
  nextPageToken?: string;
}

async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<StreamEvent, void, unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        yield* eventsFromSseBlock(rawEvent);
      }
    }
    if (buffer.trim()) {
      yield* eventsFromSseBlock(buffer);
    }
  } finally {
    reader.releaseLock();
  }
}

function* eventsFromSseBlock(block: string): Generator<StreamEvent, void, unknown> {
  const dataLines = block
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim());
  if (dataLines.length === 0) return;

  const payload = dataLines.join('\n');
  let chunk: GeminiStreamChunk;
  try {
    chunk = JSON.parse(payload);
  } catch (err) {
    throw new Error(`Invalid Gemini stream response: ${(err as Error).message}`);
  }

  if (chunk.error) {
    throw new Error(`Gemini API error: ${chunk.error.message}`);
  }

  const parts = chunk.candidates?.[0]?.content?.parts ?? [];
  for (const part of parts) {
    if (part.functionCall) {
      yield { type: 'functionCall', call: part.functionCall };
    } else if (part.text) {
      yield { type: 'text', text: part.text, thought: Boolean(part.thought) };
    }
  }
}

interface GeminiStreamChunk {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        thought?: boolean;
        functionCall?: FunctionCall;
      }>;
    };
  }>;
  error?: { message: string };
}

function truncate(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars)}…` : value;
}
