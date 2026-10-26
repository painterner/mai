#!/usr/bin/env node
import readline from 'node:readline';
import { loadConfig, loadState, configForProvider, saveState, type Config } from './config.js';
import { createLlmClient, type Content, type LlmClient } from './llm/index.js';
import { CodexAuthManager, credentialHint, isCredentialConfigured } from './llm/auth.js';
import { ToolRegistry } from './agent/tools.js';
import { runAgentTurn, buildSystemInstruction, type ApprovalRequest } from './agent/loop.js';
import type { ApprovalMode } from './agent/approval.js';
import { readAndClearHandoff, writeHandoff } from './handoff.js';
import type { Message } from './types.js';
import { SerialQueue } from './serial-queue.js';
import { applyAgentEvent, closeStreaming, createTurnState, type TurnState } from './agent/reducer.js';
import { genId } from './utils.js';
import type { ApiStore, SessionRecord } from './api/store.js';
import {
  checkpointInteractiveSession,
  createInteractiveSession,
  openSessionStore,
  resolveSession,
  restoredMessages,
} from './session.js';
import type { DaemonCommand as InCommand, DaemonEvent as OutEvent } from '@mai/protocol';

/**
 * Headless agent daemon: same agent/tools/approval/LLM code the Ink CLI
 * uses, driven over newline-delimited JSON on stdin/stdout instead of a
 * terminal UI. This is what the Tauri GUI spawns as a subprocess — the GUI
 * shell (Rust + React) never re-implements any agent logic, it only
 * relays these messages to and from the frontend.
 *
 * In  (stdin,  one JSON object per line): InCommand
 * Out (stdout, one JSON object per line): OutEvent
 * Anything unparsable on stdin is ignored; malformed output never happens
 * by construction (we only ever JSON.stringify our own typed objects).
 */

function emit(event: OutEvent) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

let client: LlmClient;
let config: Config;
let tools: ToolRegistry;
let systemInstruction = '';
let approvalMode: ApprovalMode = 'auto';
let conversation: Content[] = [];
let pendingApprovalResolve: ((approved: boolean) => void) | null = null;
let currentAbort: AbortController | null = null;
let busy = false;
let authBusy = false;
let store: ApiStore;
let sessionId = '';
let uiMessages: Message[] = [];
let turnState: TurnState = createTurnState();
const sendQueue = new SerialQueue<string>(
  async (text) => {
    uiMessages.push({ id: genId(), role: 'user', content: text, timestamp: Date.now() });
    emit({ type: 'turnStarted', text });
    checkpointSession();
    await runTurn(text);
  },
  ({ waiting }) => emit({ type: 'queueChanged', waiting }),
  (error) => emit({ type: 'error', message: (error as Error).message }),
);
// Bumped whenever the frontend clears the conversation. A turn that was
// already in flight captures the epoch it started under and only writes
// its result back if it still matches — otherwise finishing a turn that
// was cleared mid-flight would resurrect the whole history it was built
// from.
let conversationEpoch = 0;

function settlePendingApproval(approved: boolean) {
  const resolve = pendingApprovalResolve;
  pendingApprovalResolve = null;
  resolve?.(approved);
}

function checkpointSession() {
  if (!store || !sessionId || !config) return;
  checkpointInteractiveSession(store, sessionId, {
    history: conversation,
    uiMessages: [...uiMessages, ...turnState.messages],
    inputHistory: [],
    approvalMode,
    provider: config.provider,
    model: config.model,
    client: 'gui',
  });
  saveState(config.workspace, config.provider, config.model, sessionId);
}

function requestApproval(request: ApprovalRequest): Promise<boolean> {
  // `request` isn't needed here — the reducer on the frontend side already
  // turned the equivalent `toolApprovalNeeded` event (emitted just before
  // this is called) into whatever UI it wants; this just waits for the
  // matching `approve` command back on stdin.
  void request;
  return new Promise((resolve) => {
    pendingApprovalResolve = resolve;
  });
}

async function runTurn(userText: string) {
  busy = true;
  const epoch = conversationEpoch;
  const controller = new AbortController();
  currentAbort = controller;

  try {
    const generator = runAgentTurn(
      { client, tools, systemInstruction, approvalMode, requestApproval, signal: controller.signal },
      conversation,
      userText,
    );
    let step = await generator.next();
    while (!step.done) {
      turnState = applyAgentEvent(turnState, step.value);
      emit(step.value);
      step = await generator.next();
    }
    if (epoch === conversationEpoch) conversation = step.value ?? conversation;
  } catch (err) {
    const event = { type: 'error' as const, message: (err as Error).message };
    turnState = applyAgentEvent(turnState, event);
    emit(event);
  }

  if (epoch === conversationEpoch) {
    uiMessages.push(...closeStreaming(turnState.messages));
  }
  turnState = createTurnState();
  if (epoch === conversationEpoch) checkpointSession();
  busy = false;
  currentAbort = null;
  settlePendingApproval(false);
}

async function init() {
  config = loadConfig();
  tools = await ToolRegistry.create(
    config.workspace,
    { write: true, shell: config.allowShell },
    config.sandboxBinary,
  );
  store = openSessionStore(tools.workspacePath);

  const handoff = await readAndClearHandoff(tools.workspacePath).catch(() => null);
  const savedSessionId = loadState(tools.workspacePath)?.sessionId;
  let session: SessionRecord | null = handoff?.sessionId ? store.getSession(handoff.sessionId) : null;
  if (!session) session = resolveSession(store.listSessions(100), savedSessionId ?? 'last');
  if (!session) {
    session = createInteractiveSession(store, {
      provider: config.provider,
      model: config.model,
      approvalMode,
      client: 'gui',
    });
  }
  sessionId = session.id;

  const provider = config.providers.find((entry) =>
    entry.name.toLowerCase() === session!.provider.toLowerCase());
  if (provider) config = { ...configForProvider(config, provider), model: session.model };
  approvalMode = session.approvalMode;
  if (handoff) {
    conversation = handoff.modelContents;
    uiMessages = handoff.uiMessages;
  } else {
    conversation = session.history;
    uiMessages = restoredMessages(session);
  }
  client = createLlmClient(config);
  systemInstruction = buildSystemInstruction(
    tools.workspacePath,
    tools.skillCatalog,
    approvalMode,
    { hostedWebSearch: config.type === 'openai' && config.capabilities.webSearch },
  );
  checkpointSession();

  emit({
    type: 'ready',
    workspace: tools.workspacePath,
    provider: config.provider,
    model: config.model,
    baseUrl: config.baseUrl,
    hasApiKey: isCredentialConfigured(config),
    sandbox: config.sandboxBinary,
    approvalMode,
    sessionId,
    resumedMessages: uiMessages,
    mcpIssues: tools.mcpIssues,
  });

  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let cmd: InCommand;
    try {
      cmd = JSON.parse(line);
    } catch {
      return;
    }
    switch (cmd.type) {
      case 'send':
        if (cmd.text.trim()) sendQueue.enqueue(cmd.text.trim());
        break;
      case 'approve':
        settlePendingApproval(cmd.approved);
        break;
      case 'clear':
        sendQueue.clearWaiting();
        currentAbort?.abort();
        settlePendingApproval(false);
        conversation = [];
        uiMessages = [];
        turnState = createTurnState();
        conversationEpoch += 1;
        checkpointSession();
        break;
      case 'interrupt':
        currentAbort?.abort();
        // A turn parked on an approval prompt isn't waiting on the network,
        // so aborting the request alone does nothing for it: the turn (and
        // `busy` with it) would stay stuck forever and every later `send`
        // would be silently dropped. Decline the pending call instead.
        settlePendingApproval(false);
        break;
      case 'handoff':
        uiMessages = cmd.uiMessages;
        checkpointSession();
        writeHandoff({
          workspace: tools.workspacePath,
          sessionId,
          uiMessages,
          modelContents: conversation,
          inputHistory: [],
        })
          .then(() => emit({ type: 'handoffWritten' }))
          .catch((err) => emit({ type: 'handoffFailed', message: (err as Error).message }));
        break;
      case 'listSessions': {
        const sessions = store.listSessions(50).map((session) => ({
          id: session.id,
          title: session.title,
          provider: session.provider,
          model: session.model,
          updatedAt: session.updatedAt,
        }));
        emit({ type: 'sessionsListed', sessions, current: sessionId });
        break;
      }
      case 'resumeSession':
        resumeDaemonSession(cmd.sessionId);
        break;
      case 'newSession':
        newDaemonSession();
        break;
      case 'listProviders':
        emit({ type: 'providersListed', providers: config.providers.map((p) => p.name), current: config.provider });
        break;
      case 'listModels': {
        if (busy) {
          emit({ type: 'modelsError', message: 'Finish or interrupt the current turn first, then try again.' });
          break;
        }
        const def = config.providers.find((p) => p.name === cmd.provider);
        if (!def) {
          emit({ type: 'modelsError', message: `Unknown provider "${cmd.provider}".` });
          break;
        }
        const candidate = configForProvider(config, def);
        if (!isCredentialConfigured(candidate)) {
          emit({
            type: 'modelsError',
            message: `Provider "${def.name}" is not authenticated — ${credentialHint(candidate.auth)}.`,
          });
          break;
        }
        // Re-picking the already-active provider should highlight the
        // model actually in use (which may differ from providers.json's
        // default if it was switched at runtime); picking a *different*
        // provider has no "last used model" to fall back on, so highlight
        // its declared default instead.
        const current = config.provider === def.name ? config.model : candidate.model;
        createLlmClient(candidate)
          .listModels()
          .then((models) => emit({ type: 'modelsListed', models, current }))
          .catch((err) => emit({ type: 'modelsError', message: (err as Error).message }));
        break;
      }
      case 'setModel': {
        if (busy) {
          emit({ type: 'modelsError', message: 'Finish or interrupt the current turn first, then try again.' });
          break;
        }
        const def = config.providers.find((p) => p.name === cmd.provider);
        if (!def) {
          emit({ type: 'modelsError', message: `Unknown provider "${cmd.provider}".` });
          break;
        }
        config = { ...configForProvider(config, def), model: cmd.model };
        client = createLlmClient(config);
        systemInstruction = buildSystemInstruction(
          tools.workspacePath,
          tools.skillCatalog,
          approvalMode,
          { hostedWebSearch: config.type === 'openai' && config.capabilities.webSearch },
        );
        saveState(config.workspace, config.provider, config.model, sessionId);
        checkpointSession();
        emit({ type: 'modelChanged', provider: config.provider, model: config.model, baseUrl: config.baseUrl });
        break;
      }
      case 'getAuthStatus':
        void emitAuthStatus();
        break;
      case 'loginOpenAi':
        void loginOpenAi(cmd.method);
        break;
      case 'logoutOpenAi':
        void logoutOpenAi();
        break;
      case 'setApprovalMode':
        if (busy) {
          emit({ type: 'error', message: 'Finish or interrupt the current turn before changing approval mode.' });
          break;
        }
        if (!['auto', 'safe', 'manual'].includes(cmd.mode)) {
          emit({ type: 'error', message: `Unknown approval mode "${String(cmd.mode)}".` });
          break;
        }
        approvalMode = cmd.mode;
        systemInstruction = buildSystemInstruction(
          tools.workspacePath,
          tools.skillCatalog,
          approvalMode,
          { hostedWebSearch: config.type === 'openai' && config.capabilities.webSearch },
        );
        checkpointSession();
        emit({ type: 'approvalModeChanged', mode: approvalMode });
        break;
    }
  });
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    currentAbort?.abort();
    settlePendingApproval(false);
    checkpointSession();
    store.close();
    void tools.close().finally(() => process.exit(0));
  };
  rl.on('close', shutdown);
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

function resumeDaemonSession(requested: string) {
  if (busy) {
    emit({ type: 'sessionError', message: 'Finish or interrupt the current turn before resuming another session.' });
    return;
  }
  const session = resolveSession(store.listSessions(100), requested);
  if (!session) {
    emit({ type: 'sessionError', message: `No unique session matched "${requested}".` });
    return;
  }
  const provider = config.providers.find((entry) =>
    entry.name.toLowerCase() === session.provider.toLowerCase());
  if (!provider) {
    emit({ type: 'sessionError', message: `Session provider "${session.provider}" is not configured.` });
    return;
  }
  checkpointSession();
  config = { ...configForProvider(config, provider), model: session.model };
  client = createLlmClient(config);
  conversation = session.history;
  uiMessages = restoredMessages(session);
  turnState = createTurnState();
  approvalMode = session.approvalMode;
  sessionId = session.id;
  conversationEpoch += 1;
  systemInstruction = buildSystemInstruction(
    tools.workspacePath,
    tools.skillCatalog,
    approvalMode,
    { hostedWebSearch: config.type === 'openai' && config.capabilities.webSearch },
  );
  checkpointSession();
  emit({
    type: 'sessionChanged',
    sessionId,
    provider: config.provider,
    model: config.model,
    baseUrl: config.baseUrl,
    approvalMode,
    resumedMessages: uiMessages,
  });
}

function newDaemonSession() {
  if (busy) {
    emit({ type: 'sessionError', message: 'Finish or interrupt the current turn before creating a session.' });
    return;
  }
  checkpointSession();
  const session = createInteractiveSession(store, {
    provider: config.provider,
    model: config.model,
    approvalMode,
    client: 'gui',
  });
  sessionId = session.id;
  conversation = [];
  uiMessages = [];
  turnState = createTurnState();
  conversationEpoch += 1;
  checkpointSession();
  emit({
    type: 'sessionChanged',
    sessionId,
    provider: config.provider,
    model: config.model,
    baseUrl: config.baseUrl,
    approvalMode,
    resumedMessages: [],
  });
}

async function emitAuthStatus() {
  try {
    emit({ type: 'authStatus', ...await new CodexAuthManager().status() });
  } catch (error) {
    emit({ type: 'authError', message: (error as Error).message });
  }
}

async function loginOpenAi(method: 'browser' | 'device' | 'api-key' | 'access-token' | 'reuse') {
  if (busy || authBusy) {
    emit({ type: 'authError', message: 'Finish the current model or login operation first.' });
    return;
  }
  authBusy = true;
  let buffered = '';
  const flush = (force = false) => {
    const lines = buffered.split(/\r?\n/);
    buffered = force ? '' : lines.pop() ?? '';
    const text = lines.map((line) => line.trim()).filter(Boolean).join('\n');
    if (text) emit({ type: 'authOutput', message: text });
  };
  try {
    const status = await new CodexAuthManager().login(method, {
      onOutput: (text) => { buffered += text; flush(); },
    });
    flush(true);
    if (config.auth.type === 'codex-login') client = createLlmClient(config);
    emit({ type: 'authStatus', ...status });
  } catch (error) {
    flush(true);
    emit({ type: 'authError', message: (error as Error).message });
  } finally {
    authBusy = false;
  }
}

async function logoutOpenAi() {
  if (busy || authBusy) {
    emit({ type: 'authError', message: 'Finish the current model or login operation first.' });
    return;
  }
  authBusy = true;
  try {
    await new CodexAuthManager().logout();
    emit({ type: 'authStatus', configured: false, mode: null });
  } catch (error) {
    emit({ type: 'authError', message: (error as Error).message });
  } finally {
    authBusy = false;
  }
}

init().catch((err) => {
  emit({ type: 'fatal', message: (err as Error).message });
  process.exit(1);
});
