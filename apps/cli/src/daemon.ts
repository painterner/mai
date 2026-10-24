#!/usr/bin/env node
import readline from 'node:readline';
import { loadConfig, configForProvider, saveState, type Config } from './config.js';
import { createLlmClient, type Content, type LlmClient } from './llm/index.js';
import { ToolRegistry } from './agent/tools.js';
import { runAgentTurn, buildSystemInstruction, type ApprovalRequest } from './agent/loop.js';
import type { ApprovalMode } from './agent/approval.js';
import { readAndClearHandoff, writeHandoff } from './handoff.js';
import type { Message } from './types.js';
import { SerialQueue } from './serial-queue.js';
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
const sendQueue = new SerialQueue<string>(
  async (text) => {
    emit({ type: 'turnStarted', text });
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
      emit(step.value);
      step = await generator.next();
    }
    if (epoch === conversationEpoch) conversation = step.value ?? conversation;
  } catch (err) {
    emit({ type: 'error', message: (err as Error).message });
  }

  busy = false;
  currentAbort = null;
  settlePendingApproval(false);
}

async function init() {
  config = loadConfig();
  client = createLlmClient(config);
  tools = await ToolRegistry.create(
    config.workspace,
    { write: true, shell: config.allowShell },
    config.sandboxBinary,
  );
  systemInstruction = buildSystemInstruction(tools.workspacePath, tools.skillCatalog, approvalMode);

  let resumedMessages: Message[] = [];
  const handoff = await readAndClearHandoff(tools.workspacePath).catch(() => null);
  if (handoff) {
    conversation = handoff.modelContents;
    resumedMessages = handoff.uiMessages;
  }

  emit({
    type: 'ready',
    workspace: tools.workspacePath,
    provider: config.provider,
    model: config.model,
    baseUrl: config.baseUrl,
    hasApiKey: Boolean(config.apiKey),
    sandbox: config.sandboxBinary,
    approvalMode,
    resumedMessages,
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
        conversationEpoch += 1;
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
        writeHandoff({
          workspace: tools.workspacePath,
          uiMessages: cmd.uiMessages,
          modelContents: conversation,
          inputHistory: [],
        })
          .then(() => emit({ type: 'handoffWritten' }))
          .catch((err) => emit({ type: 'handoffFailed', message: (err as Error).message }));
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
        if (!candidate.apiKey) {
          emit({ type: 'modelsError', message: `No API key configured for "${def.name}" — set ${def.apiKeyEnv}.` });
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
        saveState(config.workspace, config.provider, config.model);
        emit({ type: 'modelChanged', provider: config.provider, model: config.model, baseUrl: config.baseUrl });
        break;
      }
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
        systemInstruction = buildSystemInstruction(tools.workspacePath, tools.skillCatalog, approvalMode);
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
    void tools.close().finally(() => process.exit(0));
  };
  rl.on('close', shutdown);
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

init().catch((err) => {
  emit({ type: 'fatal', message: (err as Error).message });
  process.exit(1);
});
