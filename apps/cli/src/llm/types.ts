/**
 * Provider-agnostic conversation model shared by every LLM client
 * (`gemini.ts`, `openai.ts`, ...). Shaped like Gemini's `Content`/`Part`
 * because that's the first client this project had — it's just the
 * canonical in-memory history now, and other clients translate to/from
 * their own wire format around it rather than the rest of the app (the
 * agent loop, the daemon, the handoff file) needing to know or care which
 * provider produced it.
 */

export type ContentRole = 'user' | 'model';

export interface FunctionCall {
  /** Provider call identifier; Responses requires it when returning output. */
  id?: string;
  name: string;
  args: Record<string, unknown>;
}

export interface FunctionResponsePart {
  callId?: string;
  name: string;
  response: Record<string, unknown>;
}

export interface ProviderStatePart {
  provider: string;
  /** Opaque provider item needed to continue a stateless reasoning turn. */
  item: Record<string, unknown>;
}

export interface Citation {
  url: string;
  title?: string;
  startIndex?: number;
  endIndex?: number;
}

export type Part =
  | { text: string; thought?: boolean }
  | { functionCall: FunctionCall }
  | { functionResponse: FunctionResponsePart }
  | { providerState: ProviderStatePart };

export interface Content {
  role: ContentRole;
  parts: Part[];
}

export type StreamEvent =
  | { type: 'text'; text: string; thought: boolean }
  | { type: 'functionCall'; call: FunctionCall }
  | { type: 'providerState'; state: ProviderStatePart }
  | { type: 'hostedTool'; id: string; name: string; stage: 'started' | 'running' | 'completed' }
  | { type: 'citation'; citation: Citation };

/** Shape handed to the model as a tool/function declaration. */
export interface ToolDeclaration {
  name: string;
  description: string;
  parameters: object;
}

/** Implemented by every provider client (`GeminiClient`, `OpenAiClient`). */
export interface LlmClient {
  streamTurn(
    systemInstruction: string,
    contents: Content[],
    tools: ToolDeclaration[],
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent, void, unknown>;

  /**
   * Hits the provider's model-discovery route and returns the model ids
   * actually available to this API key, sorted alphabetically — used by
   * `/model` to build the interactive picker rather than trusting a
   * hardcoded list that drifts out of date.
   */
  listModels(): Promise<string[]>;
}
