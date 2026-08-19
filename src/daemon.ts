#!/usr/bin/env node
import readline from 'node:readline';
import { loadConfig } from './config.js';
import { createLlmClient, type Content, type LlmClient } from './llm/index.js';
import { ToolRegistry } from './agent/tools.js';
import { runAgentTurn, buildSystemInstruction, type AgentEvent, type ApprovalRequest } from './agent/loop.js';
import { readAndClearHandoff, writeHandoff } from './handoff.js';
import type { Message } from './types.js';

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

type InCommand =
  | { type: 'send'; text: string }
  | { type: 'approve'; approved: boolean }
  | { type: 'clear' }
  | { type: 'interrupt' }
  | { type: 'handoff'; uiMessages: Message[] };

type OutEvent =
  | {
      type: 'ready';
      workspace: string;
      provider: string;
      model: string;
      baseUrl: string;
      hasApiKey: boolean;
      sandbox: string | null;
      resumedMessages: Message[];
    }
  | { type: 'fatal'; message: string }
  | { type: 'handoffWritten' }
  | { type: 'handoffFailed'; message: string }
  | AgentEvent;

function emit(event: OutEvent) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

let client: LlmClient;
let tools: ToolRegistry;
let systemInstruction = '';
let conversation: Content[] = [];
let pendingApprovalResolve: ((approved: boolean) => void) | null = null;
let currentAbort: AbortController | null = null;
let busy = false;

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
  const controller = new AbortController();
  currentAbort = controller;

  try {
    const generator = runAgentTurn(
      { client, tools, systemInstruction, requestApproval, signal: controller.signal },
      conversation,
      userText,
    );
    let step = await generator.next();
    while (!step.done) {
      emit(step.value);
      step = await generator.next();
    }
    conversation = step.value ?? conversation;
  } catch (err) {
    emit({ type: 'error', message: (err as Error).message });
  }

  busy = false;
  currentAbort = null;
}

async function init() {
  const config = loadConfig();
  client = createLlmClient(config);
  tools = await ToolRegistry.create(
    config.workspace,
    { write: true, shell: config.allowShell },
    config.sandboxBinary,
  );
  systemInstruction = buildSystemInstruction(tools.workspacePath);

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
    resumedMessages,
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
        if (!busy) void runTurn(cmd.text);
        break;
      case 'approve':
        pendingApprovalResolve?.(cmd.approved);
        pendingApprovalResolve = null;
        break;
      case 'clear':
        conversation = [];
        break;
      case 'interrupt':
        currentAbort?.abort();
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
    }
  });
  rl.on('close', () => process.exit(0));
}

init().catch((err) => {
  emit({ type: 'fatal', message: (err as Error).message });
  process.exit(1);
});
