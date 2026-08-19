import type { Config } from '../config.js';
import { GeminiClient } from './gemini.js';
import { OpenAiClient } from './openai.js';
import type { LlmClient } from './types.js';

export * from './types.js';

export function createLlmClient(config: Config): LlmClient {
  const opts = {
    apiKey: config.apiKey,
    model: config.model,
    baseUrl: config.baseUrl,
    maxOutputTokens: config.maxOutputTokens,
    temperature: config.temperature,
  };
  // `kind` is the wire protocol (there can be many `provider` *names* of
  // each kind — Groq, DeepSeek, a local vLLM server, ... all speak the
  // OpenAI-compatible shape); `provider` is just the providers.json label.
  return config.kind === 'openai' ? new OpenAiClient(opts) : new GeminiClient(opts);
}
