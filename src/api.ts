#!/usr/bin/env node
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';

import { buildSystemInstruction, runAgentTurn, type AgentEvent } from './agent/loop.js';
import { ToolRegistry } from './agent/tools.js';
import { configForProvider, loadConfig, type Config } from './config.js';
import { createLlmClient, type Content, type LlmClient, type Part } from './llm/index.js';
import { FileInputError, FileNotFoundError, FileTooLargeError, WorkspaceFiles } from './api/files.js';
import { RunConflictError, RunInputError, RunManager, RunNotFoundError } from './api/runs.js';
import { ApiStore, type StoredEvent } from './api/store.js';
import {
  TerminalConflictError,
  TerminalInputError,
  TerminalManager,
  TerminalNotFoundError,
  TerminalUnavailableError,
} from './api/terminals.js';
import type { EventBus } from './api/events.js';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3141;
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const MAX_MESSAGE_CHARS = 100_000;
const MAX_HISTORY_ITEMS = 200;

export interface ApiOptions {
  host: string;
  port: number;
  apiKey: string;
  allowWrite: boolean;
  allowShell: boolean;
  approveRisky: boolean;
  stateFile: string;
}

export interface ApiDependencies {
  config?: Config;
  createClient?: (config: Config) => LlmClient;
  stateFile?: string;
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
  options: ApiOptions;
  store: ApiStore;
  runs: RunManager;
  terminals: TerminalManager;
  files: WorkspaceFiles;
  createClient: (config: Config) => LlmClient;
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
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export async function createApiServer(
  dependencies: ApiDependencies = {},
): Promise<{ server: Server; options: ApiOptions }> {
  const config = dependencies.config ?? loadConfig();
  const options = loadApiOptions(config.workspace, dependencies.stateFile);
  if (!isLoopbackHost(options.host) && !options.apiKey) {
    throw new Error('MAI_API_KEY is required when MAI_API_HOST is not a loopback address.');
  }
  const tools = await ToolRegistry.create(
    config.workspace,
    { write: options.allowWrite, shell: options.allowShell && config.allowShell },
    config.sandboxBinary,
  );
  const files = await WorkspaceFiles.create(config.workspace);
  const store = new ApiStore(options.stateFile);
  const clientFactory = dependencies.createClient ?? createLlmClient;
  const runs = new RunManager({
    store,
    workspace: tools.workspacePath,
    allowWrite: options.allowWrite,
    allowShell: options.allowShell && config.allowShell,
    approveRisky: options.approveRisky,
    sandboxBinary: config.sandboxBinary,
    selectConfig: (provider, model) => selectConfig(config, provider, model),
    createClient: clientFactory,
  });
  const terminals = new TerminalManager(store, tools.workspacePath, config.sandboxBinary);
  const context: ApiContext = { config, tools, options, store, runs, terminals, files, createClient: clientFactory };

  const server = createServer((req, res) => {
    void handleRequest(context, req, res).catch((error: unknown) => handleError(error, res));
  });
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });
  server.on('close', () => {
    runs.stopAll();
    terminals.closeAll();
    store.close();
  });
  return { server, options };
}

export async function startApiServer(
  dependencies: ApiDependencies = {},
): Promise<{ server: Server; host: string; port: number }> {
  const { server, options } = await createApiServer(dependencies);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, resolve);
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
      status: 'ok', service: 'mai-api', workspace: context.tools.workspacePath,
      provider: context.config.provider, model: context.config.model,
      permissions: {
        write: context.options.allowWrite,
        shell: context.options.allowShell && context.config.allowShell,
        approveRisky: context.options.approveRisky,
      },
    });
    return;
  }
  if (!url.pathname.startsWith('/v1/')) throw new HttpError(404, 'Route not found.');
  requireAuthorization(req, context.options.apiKey);

  if (method === 'GET' && url.pathname === '/v1/capabilities') {
    writeJson(res, 200, {
      service: 'mai-api', version: 1, stateful: true,
      features: {
        sessions: true, runs: true, resumableSse: true, approvals: true, steer: true, stop: true,
        skills: true, tools: true, files: true,
        interactiveTerminals: Boolean(context.config.sandboxBinary), legacyChat: true,
      },
    });
    return;
  }
  if (method === 'GET' && url.pathname === '/v1/providers') {
    writeJson(res, 200, {
      current: context.config.provider,
      providers: context.config.providers.map((provider) => {
        const candidate = configForProvider(context.config, provider);
        return { name: provider.name, kind: provider.kind, baseUrl: candidate.baseUrl,
          defaultModel: candidate.model, configured: Boolean(candidate.apiKey) };
      }),
    });
    return;
  }
  if (method === 'GET' && url.pathname === '/v1/models') {
    const candidate = selectConfig(context.config, url.searchParams.get('provider') ?? undefined, undefined);
    if (!candidate.apiKey) throw new HttpError(400, `No API key configured for provider "${candidate.provider}".`);
    writeJson(res, 200, { provider: candidate.provider, current: candidate.model,
      models: await context.createClient(candidate).listModels() });
    return;
  }

  if (method === 'GET' && url.pathname === '/v1/tools') {
    writeJson(res, 200, { tools: (await freshTools(context)).definitions() });
    return;
  }
  if (method === 'GET' && url.pathname === '/v1/skills') {
    const tools = await freshTools(context);
    writeJson(res, 200, { skills: tools.skillList.map(({ name, description, source, modelInvocable }) =>
      ({ name, description, source, modelInvocable })) });
    return;
  }
  const skillMatch = matchPath(url.pathname, /^\/v1\/skills\/([^/]+)$/);
  if (method === 'GET' && skillMatch) {
    const skill = (await freshTools(context)).skillList.find((entry) => entry.name === skillMatch[1]);
    if (!skill) throw new HttpError(404, `Skill ${skillMatch[1]} was not found.`);
    writeJson(res, 200, { name: skill.name, description: skill.description, source: skill.source,
      modelInvocable: skill.modelInvocable, instructions: skill.body });
    return;
  }

  if (url.pathname === '/v1/files') {
    if (method === 'GET') {
      writeJson(res, 200, { files: await context.files.list(url.searchParams.get('path') ?? '.') });
      return;
    }
    if (method === 'PUT') {
      if (!context.options.allowWrite) throw new HttpError(403, 'Workspace writes are disabled.');
      const body = requireRecord(await readJson(req));
      const encoding = body.encoding === 'base64' ? 'base64' : 'utf8';
      writeJson(res, 200, await context.files.write(
        requireString(body.path, 'path'), requireString(body.content, 'content', true), encoding));
      return;
    }
  }
  if (method === 'GET' && url.pathname === '/v1/files/content') {
    const filePath = url.searchParams.get('path');
    if (!filePath) throw new HttpError(400, 'The path query parameter is required.');
    writeJson(res, 200, await context.files.read(filePath));
    return;
  }

  if (url.pathname === '/v1/sessions') {
    if (method === 'GET') {
      writeJson(res, 200, { sessions: context.store.listSessions(
        integerQuery(url, 'limit', 50, 1, 200), integerQuery(url, 'offset', 0, 0, 1_000_000)) });
      return;
    }
    if (method === 'POST') {
      const body = await optionalJson(req);
      const config = selectConfig(context.config,
        optionalString(body.provider, 'provider'), optionalString(body.model, 'model'));
      writeJson(res, 201, context.store.createSession(
        config.provider, config.model, optionalString(body.title, 'title')));
      return;
    }
  }
  const sessionMatch = matchPath(url.pathname, /^\/v1\/sessions\/([^/]+)$/);
  if (sessionMatch) {
    const sessionId = sessionMatch[1];
    if (method === 'GET') { writeJson(res, 200, requireSession(context, sessionId)); return; }
    if (method === 'PATCH') {
      requireSession(context, sessionId);
      const body = requireRecord(await readJson(req));
      const provider = optionalString(body.provider, 'provider');
      const model = optionalString(body.model, 'model');
      const selected = provider || model ? selectConfig(context.config, provider, model) : null;
      const title = body.title === null ? null : optionalString(body.title, 'title');
      writeJson(res, 200, context.store.updateSession(sessionId,
        { title, provider: selected?.provider, model: selected?.model }));
      return;
    }
    if (method === 'DELETE') {
      requireSession(context, sessionId); context.store.deleteSession(sessionId); res.writeHead(204).end(); return;
    }
  }
  const messagesMatch = matchPath(url.pathname, /^\/v1\/sessions\/([^/]+)\/messages$/);
  if (method === 'GET' && messagesMatch) {
    const session = requireSession(context, messagesMatch[1]);
    writeJson(res, 200, { sessionId: session.id, messages: session.history }); return;
  }
  const sessionRunsMatch = matchPath(url.pathname, /^\/v1\/sessions\/([^/]+)\/runs$/);
  if (sessionRunsMatch) {
    const session = requireSession(context, sessionRunsMatch[1]);
    if (method === 'GET') { writeJson(res, 200, { runs: context.store.listRuns(session.id) }); return; }
    if (method === 'POST') {
      const body = requireRecord(await readJson(req));
      const input = requireString(body.input, 'input');
      if (input.length > MAX_MESSAGE_CHARS) throw new HttpError(400, 'input is too long.');
      const run = context.runs.start(session, input,
        optionalString(body.provider, 'provider'), optionalString(body.model, 'model'));
      writeJson(res, 202, context.store.getRun(run.id)); return;
    }
  }

  const runMatch = matchPath(url.pathname, /^\/v1\/runs\/([^/]+)$/);
  if (method === 'GET' && runMatch) { writeJson(res, 200, requireRun(context, runMatch[1])); return; }
  const runEventsMatch = matchPath(url.pathname, /^\/v1\/runs\/([^/]+)\/events$/);
  if (method === 'GET' && runEventsMatch) {
    const runId = runEventsMatch[1]; requireRun(context, runId);
    streamEvents(req, res, runId, context.store.listRunEvents.bind(context.store), context.runs.events,
      () => isFinalRun(context.store.getRun(runId)?.status));
    return;
  }
  const runActionMatch = matchPath(url.pathname, /^\/v1\/runs\/([^/]+)\/(approval|steer|stop)$/);
  if (method === 'POST' && runActionMatch) {
    const [runId, action] = runActionMatch.slice(1); requireRun(context, runId);
    const body = action === 'stop' ? {} : requireRecord(await readJson(req));
    const run = action === 'approval'
      ? context.runs.approve(runId, requireBoolean(body.approved, 'approved'))
      : action === 'steer'
        ? context.runs.steer(runId, requireString(body.message, 'message'))
        : context.runs.stop(runId);
    writeJson(res, 200, run); return;
  }

  if (url.pathname === '/v1/terminals' && method === 'POST') {
    if (!context.options.allowShell || !context.config.allowShell) throw new HttpError(403, 'Shell is disabled.');
    const body = await optionalJson(req);
    writeJson(res, 201, context.terminals.start(
      optionalString(body.command, 'command') ?? 'exec sh -i',
      optionalInteger(body.cols, 'cols') ?? 80, optionalInteger(body.rows, 'rows') ?? 24));
    return;
  }
  const terminalMatch = matchPath(url.pathname, /^\/v1\/terminals\/([^/]+)$/);
  if (terminalMatch) {
    const terminalId = terminalMatch[1];
    if (method === 'GET') { writeJson(res, 200, requireTerminal(context, terminalId)); return; }
    if (method === 'DELETE') {
      requireTerminal(context, terminalId); writeJson(res, 200, context.terminals.close(terminalId)); return;
    }
  }
  const terminalEventsMatch = matchPath(url.pathname, /^\/v1\/terminals\/([^/]+)\/events$/);
  if (method === 'GET' && terminalEventsMatch) {
    const terminalId = terminalEventsMatch[1]; requireTerminal(context, terminalId);
    streamEvents(req, res, terminalId, context.store.listTerminalEvents.bind(context.store), context.terminals.events,
      () => isFinalTerminal(context.store.getTerminal(terminalId)?.status));
    return;
  }
  const terminalActionMatch = matchPath(url.pathname, /^\/v1\/terminals\/([^/]+)\/(input|resize|signal)$/);
  if (method === 'POST' && terminalActionMatch) {
    const [terminalId, action] = terminalActionMatch.slice(1); requireTerminal(context, terminalId);
    const body = requireRecord(await readJson(req));
    const terminal = action === 'input'
      ? context.terminals.input(terminalId, requireString(body.data, 'data', true),
          body.encoding === 'base64' ? 'base64' : 'utf8')
      : action === 'resize'
        ? context.terminals.resize(terminalId, requireInteger(body.cols, 'cols'), requireInteger(body.rows, 'rows'))
        : context.terminals.signal(terminalId, parseSignal(body.signal));
    writeJson(res, 200, terminal); return;
  }

  // Compatibility endpoint. New clients should use sessions/runs so state,
  // approvals and progress survive disconnects.
  if (method === 'POST' && url.pathname === '/v1/chat') {
    await handleLegacyChat(context, parseChatRequest(await readJson(req)), req, res); return;
  }
  throw new HttpError(404, 'Route not found.');
}

async function handleLegacyChat(context: ApiContext, input: ChatRequest,
  req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestConfig = selectConfig(context.config, input.provider, input.model);
  if (!requestConfig.apiKey) throw new HttpError(400, `No API key configured for provider "${requestConfig.provider}".`);
  const id = `chat_${randomUUID()}`;
  const controller = new AbortController();
  req.once('aborted', () => controller.abort());
  res.once('close', () => { if (!res.writableEnded) controller.abort(); });
  const tools = await freshTools(context);
  const generator = runAgentTurn({
    client: context.createClient(requestConfig), tools,
    systemInstruction: buildSystemInstruction(tools.workspacePath, tools.skillCatalog),
    requestApproval: async () => context.options.approveRisky, signal: controller.signal,
  }, input.history, input.message);
  const events: AgentEvent[] = [];
  let assistantMessage = '';
  if (input.stream) startNdjson(res);
  let step = await generator.next();
  while (!step.done) {
    const event = step.value; events.push(event);
    if (event.type === 'text') assistantMessage += event.text;
    if (input.stream && !res.destroyed) res.write(`${JSON.stringify(event)}\n`);
    step = await generator.next();
  }
  const result: ChatResult = { id, provider: requestConfig.provider, model: requestConfig.model,
    message: assistantMessage, events, history: step.value ?? input.history };
  if (input.stream) {
    if (!res.destroyed) res.end(`${JSON.stringify({ type: 'result', ...result, events: undefined })}\n`);
  } else writeJson(res, events.some((event) => event.type === 'error') ? 502 : 200, result);
}

function streamEvents(req: IncomingMessage, res: ServerResponse, ownerId: string,
  list: (ownerId: string, after?: number) => StoredEvent[], bus: EventBus, isFinal: () => boolean): void {
  const rawHeader = req.headers['last-event-id'];
  const headerCursor = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const after = parseCursor(url.searchParams.get('after') ?? headerCursor);
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  for (const event of list(ownerId, after)) writeSse(res, event);
  if (isFinal()) { res.end(); return; }
  let heartbeat: NodeJS.Timeout;
  const unsubscribe = bus.subscribe(ownerId, (event) => {
    if (!res.destroyed) writeSse(res, event);
    if (isFinal()) { unsubscribe(); clearInterval(heartbeat); res.end(); }
  });
  heartbeat = setInterval(() => { if (!res.destroyed) res.write(': keep-alive\n\n'); }, 15_000);
  heartbeat.unref();
  req.once('close', () => { unsubscribe(); clearInterval(heartbeat); });
}

function writeSse(res: ServerResponse, event: StoredEvent): void {
  res.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(
    { ...event.data, seq: event.seq, createdAt: event.createdAt })}\n\n`);
}

async function freshTools(context: ApiContext): Promise<ToolRegistry> {
  return ToolRegistry.create(context.tools.workspacePath,
    { write: context.options.allowWrite, shell: context.options.allowShell && context.config.allowShell },
    context.config.sandboxBinary);
}

function selectConfig(base: Config, providerName?: string, model?: string): Config {
  let selected = base;
  if (providerName && providerName.toLowerCase() !== base.provider.toLowerCase()) {
    const provider = base.providers.find((entry) => entry.name.toLowerCase() === providerName.toLowerCase());
    if (!provider) throw new HttpError(400, `Unknown provider "${providerName}".`);
    selected = configForProvider(base, provider);
  }
  if (model !== undefined) selected = { ...selected, model };
  return selected;
}

function parseChatRequest(raw: unknown): ChatRequest {
  const body = requireRecord(raw);
  const message = requireString(body.message, 'message');
  if (message.length > MAX_MESSAGE_CHARS) throw new HttpError(400, `message exceeds ${MAX_MESSAGE_CHARS} characters.`);
  if (body.stream !== undefined && typeof body.stream !== 'boolean') throw new HttpError(400, 'stream must be boolean.');
  const history = body.history ?? [];
  if (!Array.isArray(history) || history.length > MAX_HISTORY_ITEMS || !history.every(isContent)) {
    throw new HttpError(400, `history must contain at most ${MAX_HISTORY_ITEMS} valid Content objects.`);
  }
  return { message, history, provider: optionalString(body.provider, 'provider'),
    model: optionalString(body.model, 'model'), stream: body.stream === true };
}

function requireSession(context: ApiContext, id: string) {
  const value = context.store.getSession(id);
  if (!value) throw new HttpError(404, `Session ${id} was not found.`);
  return value;
}
function requireRun(context: ApiContext, id: string) {
  const value = context.store.getRun(id);
  if (!value) throw new HttpError(404, `Run ${id} was not found.`);
  return value;
}
function requireTerminal(context: ApiContext, id: string) {
  const value = context.store.getTerminal(id);
  if (!value) throw new HttpError(404, `Terminal ${id} was not found.`);
  return value;
}
function isFinalRun(status?: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}
function isFinalTerminal(status?: string): boolean {
  return status === 'exited' || status === 'failed' || status === 'closed';
}
function matchPath(pathname: string, pattern: RegExp): string[] | null {
  const match = pathname.match(pattern);
  return match ? match.map((part, index) => index === 0 ? part : decodeURIComponent(part)) : null;
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
  if (!chunks.length) throw new HttpError(400, 'Request body is required.');
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'Request body is not valid JSON.'); }
}
async function optionalJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_BODY_BYTES) throw new HttpError(413, `Request body exceeds ${MAX_BODY_BYTES} bytes.`);
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  try {
    return requireRecord(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'Request body is not valid JSON.');
  }
}
function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new HttpError(400, 'Request body must be a JSON object.');
  return value;
}
function requireString(value: unknown, field: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) {
    throw new HttpError(400, `${field} must be ${allowEmpty ? 'a string' : 'a non-empty string'}.`);
  }
  return value;
}
function optionalString(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : requireString(value, field);
}
function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new HttpError(400, `${field} must be boolean.`);
  return value;
}
function requireInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value)) throw new HttpError(400, `${field} must be an integer.`);
  return value as number;
}
function optionalInteger(value: unknown, field: string): number | undefined {
  return value === undefined ? undefined : requireInteger(value, field);
}
function parseSignal(value: unknown): 'INT' | 'TERM' | 'KILL' {
  const signal = requireString(value, 'signal').toUpperCase();
  if (signal !== 'INT' && signal !== 'TERM' && signal !== 'KILL') {
    throw new HttpError(400, 'signal must be INT, TERM, or KILL.');
  }
  return signal;
}
function integerQuery(url: URL, name: string, fallback: number, min: number, max: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new HttpError(400, `${name} must be an integer from ${min} to ${max}.`);
  }
  return value;
}
function parseCursor(value?: string | null): number {
  if (!value) return 0;
  const cursor = Number(value);
  if (!Number.isInteger(cursor) || cursor < 0) throw new HttpError(400, 'Invalid event cursor.');
  return cursor;
}

function isContent(value: unknown): value is Content {
  if (!isRecord(value) || (value.role !== 'user' && value.role !== 'model') || !Array.isArray(value.parts)) return false;
  if (!value.parts.every(isPart)) return false;
  if (value.role === 'user') return value.parts.every((part) => !('functionCall' in part) && !('thought' in part && part.thought));
  return value.parts.every((part) => !('functionResponse' in part));
}
function isPart(value: unknown): value is Part {
  if (!isRecord(value)) return false;
  const variants = ['text', 'functionCall', 'functionResponse'].filter((key) => key in value);
  if (variants.length !== 1) return false;
  if ('text' in value && typeof value.text === 'string') return value.thought === undefined || typeof value.thought === 'boolean';
  if (isRecord(value.functionCall)) return typeof value.functionCall.name === 'string' && isRecord(value.functionCall.args);
  if (isRecord(value.functionResponse)) return typeof value.functionResponse.name === 'string' && isRecord(value.functionResponse.response);
  return false;
}

function requireAuthorization(req: IncomingMessage, apiKey: string): void {
  if (!apiKey) return;
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ') || !safeEqual(header.slice(7), apiKey)) {
    throw new HttpError(401, 'Missing or invalid bearer token.');
  }
}
function safeEqual(actual: string, expected: string): boolean {
  const a = Buffer.from(actual); const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const json = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(json);
}
function startNdjson(res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-content-type-options': 'nosniff' });
}
function handleError(error: unknown, res: ServerResponse): void {
  if (res.writableEnded || res.destroyed) return;
  let status = error instanceof HttpError ? error.status : 500;
  if (error instanceof RunNotFoundError || error instanceof TerminalNotFoundError || error instanceof FileNotFoundError) status = 404;
  if (error instanceof RunConflictError || error instanceof TerminalConflictError) status = 409;
  if (error instanceof RunInputError || error instanceof TerminalInputError || error instanceof FileInputError) status = 400;
  if (error instanceof TerminalUnavailableError) status = 501;
  if (error instanceof FileTooLargeError) status = 413;
  const message = error instanceof Error ? error.message : String(error);
  if (res.headersSent) res.end(`event: error\ndata: ${JSON.stringify({ message })}\n\n`);
  else writeJson(res, status, { error: { code: errorCode(status), message } });
}
function errorCode(status: number): string {
  if (status === 400) return 'invalid_request';
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 413) return 'payload_too_large';
  if (status === 501) return 'not_implemented';
  return 'internal_error';
}
function loadApiOptions(workspace: string, stateFile?: string): ApiOptions {
  const host = process.env.MAI_API_HOST?.trim() || DEFAULT_HOST;
  const rawPort = process.env.MAI_API_PORT?.trim();
  const port = rawPort === undefined || rawPort === '' ? DEFAULT_PORT : Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('MAI_API_PORT must be an integer between 0 and 65535.');
  const configuredState = process.env.MAI_API_STATE?.trim();
  return { host, port, apiKey: process.env.MAI_API_KEY ?? '',
    allowWrite: envFlag('MAI_API_ALLOW_WRITE', false), allowShell: envFlag('MAI_API_ALLOW_SHELL', false),
    approveRisky: envFlag('MAI_API_APPROVE_RISKY', false),
    stateFile: stateFile ?? configuredState ?? path.join(workspace, '.mai', 'api.sqlite') };
}
function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  return raw === undefined ? fallback : !['0', 'false', 'no', 'off'].includes(raw.toLowerCase());
}
function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host.toLowerCase() === 'localhost';
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
