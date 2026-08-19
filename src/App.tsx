import React, { useEffect, useRef, useState } from 'react';
import { spawn } from 'node:child_process';
import { Box, useApp } from 'ink';
import { Header } from './components/Header.js';
import { ConversationView } from './components/ConversationView.js';
import { InputPrompt } from './components/InputPrompt.js';
import { StatusBar } from './components/StatusBar.js';
import { ApprovalPrompt } from './components/ApprovalPrompt.js';
import { SLASH_COMMANDS } from './commands.js';
import { loadConfig, resolveGuiBinary, type Config } from './config.js';
import { createLlmClient, type Content, type LlmClient } from './llm/index.js';
import { ToolRegistry } from './agent/tools.js';
import { runAgentTurn, buildSystemInstruction, type AgentEvent, type ApprovalRequest } from './agent/loop.js';
import { applyAgentEvent, closeStreaming, createTurnState } from './agent/reducer.js';
import { readAndClearHandoff, writeHandoff } from './handoff.js';
import type { Message } from './types.js';
import { genId } from './utils.js';

export default function App() {
  const { exit } = useApp();

  const [history, setHistory] = useState<Message[]>(() => [
    {
      id: 'welcome',
      role: 'system',
      content:
        'Welcome to Mai — a coding agent that can read/search/write files in this workspace ' +
        'and run shell commands through a Rust-sandboxed sidecar. Risky actions pause for your ' +
        'approval first. Try /help to see commands.',
      timestamp: Date.now(),
    },
  ]);
  const [pending, setPending] = useState<Message[]>([]);
  const [inputHistory, setInputHistory] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [exitArmed, setExitArmed] = useState(false);
  const [approvalRequest, setApprovalRequest] = useState<ApprovalRequest | null>(null);

  const pendingRef = useRef<Message[]>([]);
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const approvalResolveRef = useRef<((approved: boolean) => void) | null>(null);
  const cancelledRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  const configRef = useRef<Config | null>(null);
  const clientRef = useRef<LlmClient | null>(null);
  const toolsRef = useRef<ToolRegistry | null>(null);
  const systemInstructionRef = useRef('');
  const conversationRef = useRef<Content[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const config = loadConfig();
        configRef.current = config;
        clientRef.current = createLlmClient(config);
        const registry = await ToolRegistry.create(
          config.workspace,
          { write: true, shell: config.allowShell },
          config.sandboxBinary,
        );
        if (cancelled) return;
        toolsRef.current = registry;
        systemInstructionRef.current = buildSystemInstruction(registry.workspacePath);

        const handoff = await readAndClearHandoff(registry.workspacePath).catch(() => null);
        if (handoff) {
          conversationRef.current = handoff.modelContents;
          setHistory(handoff.uiMessages);
          setInputHistory(handoff.inputHistory);
          pushSystem('Resumed the conversation handed off from the GUI.');
        }

        setReady(true);
        if (!config.apiKey) {
          const envVar = config.provider === 'openai' ? 'OPENAI_API_KEY' : 'GEMINI_API_KEY';
          pushSystem(
            `No ${envVar} found. Add it to a .env file (see .env.example) or export it in your ` +
              'shell — local commands like /help still work without it.',
          );
        }
      } catch (err) {
        if (!cancelled) pushError(`Failed to start: ${(err as Error).message}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(
    () => () => {
      if (exitTimerRef.current) clearTimeout(exitTimerRef.current);
      abortControllerRef.current?.abort();
    },
    [],
  );

  function updatePending(next: Message[]) {
    pendingRef.current = next;
    setPending(next);
  }

  function pushHistory(...messages: Message[]) {
    setHistory((h) => [...h, ...messages]);
  }

  function pushSystem(content: string) {
    pushHistory({ id: genId(), role: 'system', content, timestamp: Date.now() });
  }

  function pushError(content: string) {
    pushHistory({ id: genId(), role: 'error', content, timestamp: Date.now() });
  }

  function requestApproval(request: ApprovalRequest): Promise<boolean> {
    return new Promise((resolve) => {
      approvalResolveRef.current = resolve;
      setApprovalRequest(request);
    });
  }

  function answerApproval(approved: boolean) {
    setApprovalRequest(null);
    const resolve = approvalResolveRef.current;
    approvalResolveRef.current = null;
    resolve?.(approved);
  }

  function handleCtrlC() {
    if (exitArmed) {
      exit();
      return;
    }
    setExitArmed(true);
    if (exitTimerRef.current) clearTimeout(exitTimerRef.current);
    exitTimerRef.current = setTimeout(() => setExitArmed(false), 2000);
  }

  function handleSubmit(raw: string) {
    const value = raw.trim();
    if (!value) return;
    setInputHistory((h) => [...h, value]);

    if (value.startsWith('/')) {
      runCommand(value);
      return;
    }

    pushHistory({ id: genId(), role: 'user', content: value, timestamp: Date.now() });
    void runTurn(value);
  }

  function runCommand(raw: string) {
    const cmd = raw.trim().split(/\s+/)[0].toLowerCase();
    switch (cmd) {
      case '/help':
        pushSystem(SLASH_COMMANDS.map((c) => `${c.name.padEnd(10)}${c.description}`).join('\n'));
        break;
      case '/clear':
        setHistory([]);
        conversationRef.current = [];
        break;
      case '/model': {
        const config = configRef.current;
        pushSystem(
          config
            ? `provider: ${config.provider}\nmodel: ${config.model}\nbase url: ${config.baseUrl}\n` +
                `api key: ${config.apiKey ? 'configured' : `MISSING — set ${config.provider === 'openai' ? 'OPENAI_API_KEY' : 'GEMINI_API_KEY'}`}\n` +
                `sandbox: ${config.sandboxBinary ?? '(not found)'}`
            : 'Still starting up — try again in a moment.',
        );
        break;
      }
      case '/theme':
        pushSystem("Theme switching isn't implemented yet — this build ships one dark theme.");
        break;
      case '/about':
        pushSystem(
          `Mai — an Ink/React terminal UI backed by Gemini or an OpenAI-compatible API ` +
            `(currently: ${configRef.current?.provider ?? 'unknown'}), with a Rust sidecar ` +
            '(mai-sandbox, from mail-cli-rust) for sandboxed shell execution.',
        );
        break;
      case '/gui':
        void switchToGui();
        break;
      case '/exit':
      case '/quit':
        exit();
        break;
      default:
        pushError(`Unknown command: ${cmd} — try /help.`);
    }
  }

  async function switchToGui() {
    const tools = toolsRef.current;
    if (!tools) {
      pushError('Still starting up — try again in a moment.');
      return;
    }
    if (busy) {
      pushError('Finish or interrupt the current turn first (Esc), then try /gui again.');
      return;
    }

    const guiBinary = resolveGuiBinary();
    if (!guiBinary) {
      pushError(
        'Could not find the GUI app. Build it in mai-cli-gui (`npm run tauri build`, or ' +
          '`npm run tauri dev` for a debug build), or set MAI_GUI_BIN to an existing binary.',
      );
      return;
    }

    try {
      await writeHandoff({
        workspace: tools.workspacePath,
        uiMessages: history,
        modelContents: conversationRef.current,
        inputHistory,
      });
    } catch (err) {
      pushError(`Failed to hand off the conversation: ${(err as Error).message}`);
      return;
    }

    const child = spawn(guiBinary, [], {
      detached: true,
      stdio: 'ignore',
      cwd: tools.workspacePath,
    });
    child.unref();
    exit();
  }

  async function runTurn(userText: string) {
    const tools = toolsRef.current;
    const client = clientRef.current;
    if (!tools || !client) {
      pushError('Agent is still starting up — try again in a moment.');
      return;
    }

    setBusy(true);
    cancelledRef.current = false;
    const controller = new AbortController();
    abortControllerRef.current = controller;

    let turn = createTurnState();
    const applyAndRender = (event: AgentEvent) => {
      turn = applyAgentEvent(turn, event);
      updatePending(turn.messages);
    };

    const generator = runAgentTurn(
      {
        client,
        tools,
        systemInstruction: systemInstructionRef.current,
        requestApproval,
        signal: controller.signal,
      },
      conversationRef.current,
      userText,
    );

    try {
      let step = await generator.next();
      while (!step.done) {
        if (cancelledRef.current) {
          void generator.return(conversationRef.current);
          break;
        }
        applyAndRender(step.value);
        step = await generator.next();
      }
      if (!cancelledRef.current && step.done) {
        conversationRef.current = step.value ?? conversationRef.current;
      }
    } catch (err) {
      if (!cancelledRef.current) {
        applyAndRender({ type: 'error', message: (err as Error).message });
      }
    }

    if (!cancelledRef.current) {
      pushHistory(...closeStreaming(turn.messages));
      updatePending([]);
      setBusy(false);
    }
    abortControllerRef.current = null;
  }

  function handleInterrupt() {
    if (!busy) return;
    cancelledRef.current = true;
    abortControllerRef.current?.abort();

    const finalized = pendingRef.current.map((m) => {
      if (m.streaming) {
        return { ...m, streaming: false, content: `${m.content}${m.content ? ' ' : ''}[interrupted]` };
      }
      if (m.tool && (m.tool.status === 'running' || m.tool.status === 'pending_approval')) {
        return { ...m, tool: { ...m.tool, status: 'failed' as const, output: m.tool.output ?? 'Interrupted' } };
      }
      return m;
    });
    pushHistory(...finalized);
    updatePending([]);
    setBusy(false);

    if (approvalResolveRef.current) {
      const resolve = approvalResolveRef.current;
      approvalResolveRef.current = null;
      setApprovalRequest(null);
      resolve(false);
    }
  }

  const turnCount = history.filter((m) => m.role === 'user').length;
  const disabled = busy || !ready;
  const disabledLabel = !ready
    ? 'Starting up…'
    : 'Mai is responding… (Esc to interrupt)';

  return (
    <Box flexDirection="column">
      <Header cwd={process.cwd()} />
      <ConversationView history={history} pending={pending} />
      <Box marginTop={1} flexDirection="column">
        {approvalRequest ? (
          <ApprovalPrompt request={approvalRequest} onAnswer={answerApproval} />
        ) : (
          <InputPrompt
            history={inputHistory}
            disabled={disabled}
            disabledLabel={disabledLabel}
            onSubmit={handleSubmit}
            onCtrlC={handleCtrlC}
            onInterrupt={handleInterrupt}
          />
        )}
        <StatusBar
          busy={busy}
          turnCount={turnCount}
          model={configRef.current ? `${configRef.current.provider} · ${configRef.current.model}` : '…'}
          exitArmed={exitArmed}
        />
      </Box>
    </Box>
  );
}
