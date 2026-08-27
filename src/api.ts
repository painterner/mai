#!/usr/bin/env node
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { runAgentTurn, buildSystemInstruction, type AgentEvent } from './agent/loop.js';
import { ToolRegistry } from './agent/tools.js';
import { configForProvider, loadConfig, type Config } from './config.js';
import { createLlmClient, type Content, type Part } from './llm/index.js';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3141;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_MESSAGE_CHARS = 100_000;
const MAX_HISTORY_ITEMS = 200;

export interface ApiOptions {
  host: string;
  port: number;
  apiKey: string;
  allowWrite: boolean;
  allowShell: boolean;
  approveRisky: boolean;
}

interface ChatRequest {
  message: string;
  history: Content[];
  provider?: string;
  model?: string;
  stream: boolean;
}

interface ApiContext {
  config: Config;
  tools: ToolRegistry;
  systemInstruction: string;
  options: ApiOptions;
}

interface ChatResult {
  id: string;
  provider: string;
  model: string;
  message: string;
  events: AgentEvent[];
  history: Content[];
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Creates the HTTP API without listening. Exported so callers and tests can
 * embed the server while the executable entry point below remains tiny.
 */
export async function createApiServer(): Promise<{ server: Server; options: ApiOptions }> {
  const options = loadApiOptions();
  if (!isLoopbackHost(options.host) && !options.apiKey) {
    throw new Error('MAI_API_KEY is required when MAI_API_HOST is not a loopback address.');
  }

  const config = loadConfig();
  const tools = await ToolRegistry.create(
    config.workspace,
    { write: options.allowWrite, shell: options.allowShell && config.allowShell },
    config.sandboxBinary,
  );
  const context: ApiContext = {
    config,
    tools,
    systemInstruction: buildSystemInstruction(tools.workspacePath, tools.skillCatalog),
    options,
  };

  const server = createServer((req, res) => {
    void handleRequest(context, req, res).catch((err: unknown) => {
      if (res.writableEnded || res.destroyed) return;
      const status = err instanceof HttpError ? err.status : 500;
      if (res.headersSent) {
        res.end(
          `${JSON.stringify({
            type: 'error',
            message: err instanceof Error ? err.message : String(err),
          })}\n`,
        );
        return;
      }
      writeJson(res, status, {
        error: {
          code: errorCode(status),
          message: err instanceof Error ? err.message : String(err),
        },
      });
    });
  });

  server.on('clientError', (_err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });

  return { server, options };
}

/** Starts listening and returns the bound address. */
export async function startApiServer(): Promise<{ server: Server; host: string; port: number }> {
  const { server, options } = await createApiServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;
  return { server, host: options.host, port };
}

async function handleRequest(context: ApiContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (method === 'GET' && url.pathname === '/health') {
    writeJson(res, 200, {
      status: 'ok',
      service: 'mai-api',
      workspace: context.tools.workspacePath,
      provider: context.config.provider,
      model: context.config.model,
      permissions: {
        write: context.options.allowWrite,
        shell: context.options.allowShell && context.config.allowShell,
        approveRisky: context.options.approveRisky,
      },
    });
    return;
  }

  if (!url.pathname.startsWith('/v1/')) {
    throw new HttpError(404, 'Route not found');
  }
  requireAuthorization(req, context.options.apiKey);

  if (method === 'GET' && url.pathname === '/v1/providers') {
    writeJson(res, 200, {
      current: context.config.provider,
      providers: context.config.providers.map((provider) => {
        const candidate = configForProvider(context.config, provider);
        return {
          name: provider.name,
          kind: provider.kind,
          baseUrl: candidate.baseUrl,
          defaultModel: candidate.model,
          configured: Boolean(candidate.apiKey),
        };
      }),
    });
    return;
  }

  if (method === 'GET' && url.pathname === '/v1/models') {
    const candidate = selectConfig(context.config, url.searchParams.get('provider') ?? undefined, undefined);
    if (!candidate.apiKey) {
      throw new HttpError(400, `No API key configured for provider "${candidate.provider}".`);
    }
    const models = await createLlmClient(candidate).listModels();
    writeJson(res, 200, { provider: candidate.provider, current: candidate.model, models });
    return;
  }

  if (method === 'POST' && url.pathname === '/v1/chat') {
    const input = parseChatRequest(await readJson(req));
    await handleChat(context, input, req, res);
    return;
  }

  throw new HttpError(404, 'Route not found');
}

async function handleChat(
  context: ApiContext,
  input: ChatRequest,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const requestConfig = selectConfig(context.config, input.provider, input.model);
  if (!requestConfig.apiKey) {
    throw new HttpError(400, `No API key configured for provider "${requestConfig.provider}".`);
  }

  const id = `chat_${randomUUID()}`;
  const controller = new AbortController();
  req.once('aborted', () => controller.abort());
  res.once('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  const generator = runAgentTurn(
    {
      client: createLlmClient(requestConfig),
      tools: context.tools,
      systemInstruction: context.systemInstruction,
      requestApproval: async () => context.options.approveRisky,
      signal: controller.signal,
    },
    input.history,
    input.message,
  );

  const events: AgentEvent[] = [];
  let assistantMessage = '';

  if (input.stream) {
    res.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-content-type-options': 'nosniff',
    });
  }

  let step = await generator.next();
  while (!step.done) {
    const event = step.value;
    events.push(event);
    if (event.type === 'text') assistantMessage += event.text;
    if (input.stream && !res.destroyed) res.write(`${JSON.stringify(event)}\n`);
    step = await generator.next();
  }

  const result: ChatResult = {
    id,
    provider: requestConfig.provider,
    model: requestConfig.model,
    message: assistantMessage,
    events,
    history: step.value ?? input.history,
  };

  if (input.stream) {
    if (!res.destroyed) res.end(`${JSON.stringify({ type: 'result', ...result, events: undefined })}\n`);
    return;
  }

  const failed = events.some((event) => event.type === 'error');
  writeJson(res, failed ? 502 : 200, result);
}

function selectConfig(base: Config, providerName?: string, model?: string): Config {
  let selected = base;
  if (providerName) {
    const provider = base.providers.find((entry) => entry.name.toLowerCase() === providerName.toLowerCase());
    if (!provider) throw new HttpError(400, `Unknown provider "${providerName}".`);
    selected = configForProvider(base, provider);
  }
  if (model !== undefined) selected = { ...selected, model };
  return selected;
}

function parseChatRequest(raw: unknown): ChatRequest {
  if (!isRecord(raw)) throw new HttpError(400, 'Request body must be a JSON object.');
  if (typeof raw.message !== 'string' || !raw.message.trim()) {
    throw new HttpError(400, '"message" must be a non-empty string.');
  }
  if (raw.message.length > MAX_MESSAGE_CHARS) {
    throw new HttpError(400, `"message" exceeds the ${MAX_MESSAGE_CHARS}-character limit.`);
  }
  if (raw.provider !== undefined && (typeof raw.provider !== 'string' || !raw.provider.trim())) {
    throw new HttpError(400, '"provider" must be a non-empty string when provided.');
  }
  if (raw.model !== undefined && (typeof raw.model !== 'string' || !raw.model.trim())) {
    throw new HttpError(400, '"model" must be a non-empty string when provided.');
  }
  if (raw.stream !== undefined && typeof raw.stream !== 'boolean') {
    throw new HttpError(400, '"stream" must be a boolean when provided.');
  }

  const history = raw.history ?? [];
  if (!Array.isArray(history) || history.length > MAX_HISTORY_ITEMS || !history.every(isContent)) {
    throw new HttpError(
      400,
      `"history" must be an array of at most ${MAX_HISTORY_ITEMS} valid Content objects.`,
    );
  }

  return {
    message: raw.message,
    history,
    provider: raw.provider as string | undefined,
    model: raw.model as string | undefined,
    stream: raw.stream === true,
  };
}

function isContent(value: unknown): value is Content {
  if (!isRecord(value) || (value.role !== 'user' && value.role !== 'model') || !Array.isArray(value.parts)) {
    return false;
  }
  if (!value.parts.every(isPart)) return false;
  if (value.role === 'user') {
    return value.parts.every((part) => !('functionCall' in part) && !('thought' in part && part.thought));
  }
  return value.parts.every((part) => !('functionResponse' in part));
}

function isPart(value: unknown): value is Part {
  if (!isRecord(value)) return false;
  const variants = ['text', 'functionCall', 'functionResponse'].filter((key) => key in value);
  if (variants.length !== 1) return false;
  if ('text' in value && typeof value.text === 'string') {
    return value.thought === undefined || typeof value.thought === 'boolean';
  }
  if (isRecord(value.functionCall)) {
    return typeof value.functionCall.name === 'string' && isRecord(value.functionCall.args);
  }
  if (isRecord(value.functionResponse)) {
    return typeof value.functionResponse.name === 'string' && isRecord(value.functionResponse.response);
  }
  return false;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_BODY_BYTES) throw new HttpError(413, `Request body exceeds ${MAX_BODY_BYTES} bytes.`);
    chunks.push(buffer);
  }
  if (chunks.length === 0) throw new HttpError(400, 'Request body is required.');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Request body is not valid JSON.');
  }
}

function requireAuthorization(req: IncomingMessage, apiKey: string): void {
  if (!apiKey) return;
  const header = req.headers.authorization ?? '';
  const prefix = 'Bearer ';
  if (!header.startsWith(prefix) || !safeEqual(header.slice(prefix.length), apiKey)) {
    throw new HttpError(401, 'Missing or invalid bearer token.');
  }
}

function safeEqual(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const json = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(json);
}

function errorCode(status: number): string {
  switch (status) {
    case 400:
      return 'invalid_request';
    case 401:
      return 'unauthorized';
    case 404:
      return 'not_found';
    case 413:
      return 'payload_too_large';
    default:
      return 'internal_error';
  }
}

function loadApiOptions(): ApiOptions {
  const host = process.env.MAI_API_HOST?.trim() || DEFAULT_HOST;
  const rawPort = process.env.MAI_API_PORT?.trim();
  const port = rawPort === undefined || rawPort === '' ? DEFAULT_PORT : Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('MAI_API_PORT must be an integer between 0 and 65535.');
  }
  return {
    host,
    port,
    apiKey: process.env.MAI_API_KEY ?? '',
    allowWrite: envFlag('MAI_API_ALLOW_WRITE', false),
    allowShell: envFlag('MAI_API_ALLOW_SHELL', false),
    approveRisky: envFlag('MAI_API_APPROVE_RISKY', false),
  };
}

function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return !['0', 'false', 'no', 'off'].includes(raw.toLowerCase());
}

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host.toLowerCase() === 'localhost';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
