import React, { useCallback, useEffect, useRef, useState } from 'react';
import { spawn } from 'node:child_process';
import { Box, useApp, useInput, useStdout } from 'ink';
import { ConversationView } from './components/ConversationView.js';
import { InputPrompt } from './components/InputPrompt.js';
import { StatusBar } from './components/StatusBar.js';
import { ApprovalPrompt } from './components/ApprovalPrompt.js';
import { ModelPicker } from './components/ModelPicker.js';
import { SLASH_COMMANDS, matchIdentifier, parseModelCommandArgs } from './commands.js';
import { loadConfig, resolveGuiBinary, configForProvider, saveState, type Config, type ProviderDef } from './config.js';
import { createLlmClient, type Content, type LlmClient } from './llm/index.js';
import { ToolRegistry } from './agent/tools.js';
import { runAgentTurn, buildSystemInstruction, type AgentEvent, type ApprovalRequest } from './agent/loop.js';
import { applyAgentEvent, closeStreaming, createTurnState } from './agent/reducer.js';
import { readAndClearHandoff, writeHandoff } from './handoff.js';
import { useTerminalSize } from './hooks/useTerminalSize.js';
import type { Message } from './types.js';
import { genId } from './utils.js';
import { SerialQueue } from './serial-queue.js';

// Erase screen + scrollback, then home the cursor. Same sequence
// `ansi-escapes`' clearTerminal emits on POSIX; inlined so this doesn't
// depend on a transitive dependency of Ink's.
const CLEAR_TERMINAL = '\u001B[2J\u001B[3J\u001B[H';

interface QueuedTurn {
  /** Text shown in the transcript when this turn starts. */
  displayText: string;
  /** Text actually sent to the model (different for manually invoked skills). */
  userText: string;
}

export default function App() {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const { columns, rows } = useTerminalSize();

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
  const [queuedCount, setQueuedCount] = useState(0);
  const [ready, setReady] = useState(false);
  const [exitArmed, setExitArmed] = useState(false);
  const [approvalRequest, setApprovalRequest] = useState<ApprovalRequest | null>(null);
  const [pickerStage, setPickerStage] = useState<'provider' | 'model' | null>(null);
  const [pickerOptions, setPickerOptions] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [redrawKey, setRedrawKey] = useState(0);

  const pendingRef = useRef<Message[]>([]);
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const approvalResolveRef = useRef<((approved: boolean) => void) | null>(null);
  const cancelledRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const pendingProviderRef = useRef<ProviderDef | null>(null);
  const pendingDefaultModelRef = useRef('');

  const configRef = useRef<Config | null>(null);
  const clientRef = useRef<LlmClient | null>(null);
  const toolsRef = useRef<ToolRegistry | null>(null);
  const systemInstructionRef = useRef('');
  const conversationRef = useRef<Content[]>([]);
  const queuedInputWorkerRef = useRef<(turn: QueuedTurn) => Promise<void>>(async () => {});
  const inputQueueRef = useRef<SerialQueue<QueuedTurn> | null>(null);
  if (!inputQueueRef.current) {
    inputQueueRef.current = new SerialQueue(
      (turn) => queuedInputWorkerRef.current(turn),
      ({ running, waiting }) => {
        setBusy(running);
        setQueuedCount(waiting);
      },
      (error) => pushError(`Queued message failed: ${(error as Error).message}`),
    );
  }

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
        systemInstructionRef.current = buildSystemInstruction(registry.workspacePath, registry.skillCatalog);

        const handoff = await readAndClearHandoff(registry.workspacePath).catch(() => null);
        if (handoff) {
          conversationRef.current = handoff.modelContents;
          setHistory(handoff.uiMessages);
          setInputHistory(handoff.inputHistory);
          pushSystem('Resumed the conversation handed off from the GUI.');
        }

        setReady(true);
        if (!config.apiKey) {
          const envVar = config.providers.find((p) => p.name === config.provider)?.apiKeyEnv ?? 'its API key';
          pushSystem(
            `No ${envVar} found for provider "${config.provider}". Add it to a .env file (see ` +
              '.env.example) or export it in your shell — local commands like /help still work without it.',
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

  /**
   * Wipe the screen and repaint everything, transcript included.
   *
   * Ink paints `<Static>` content once, straight into the scrollback, and
   * only ever erases the *live* region below it — and it erases it by
   * counting the newlines in the frame it last wrote, not the screen rows
   * that frame actually occupies. Both assumptions break the moment the
   * terminal is resized (zooming in/out is a resize): the transcript was
   * laid out for the old width, and the emulator has since reflowed the
   * live region into a different number of rows than Ink is about to erase,
   * so the next frame lands on top of leftovers from the last one. There's
   * no incremental repair for that — the only reliable fix is to start
   * over, so clear the screen and remount `<Static>` (via `redrawKey`) so
   * it re-emits the whole transcript at the new width.
   */
  const redraw = useCallback(() => {
    stdout?.write(CLEAR_TERMINAL);
    setRedrawKey((k) => k + 1);
  }, [stdout]);

  const laidOutFor = useRef<string | null>(null);
  useEffect(() => {
    const size = `${columns}x${rows}`;
    // Skip the very first run: nothing has been painted yet, and clearing
    // the screen on startup would eat whatever the user had on it.
    if (laidOutFor.current === null) {
      laidOutFor.current = size;
      return;
    }
    if (laidOutFor.current === size) return;
    laidOutFor.current = size;
    redraw();
  }, [columns, rows, redraw]);

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

  // Ctrl+C lives here rather than in InputPrompt because the input row is
  // swapped out entirely while an approval or the model picker is up —
  // handling it there meant those two states had no way to quit at all.
  useInput((input, key) => {
    if (key.ctrl && input === 'c') handleCtrlC();
  });

  function handleSubmit(raw: string) {
    const value = raw.trim();
    if (!value) return;
    setInputHistory((h) => [...h, value]);

    if (value.startsWith('/')) {
      runCommand(value);
      return;
    }

    inputQueueRef.current!.enqueue({ displayText: value, userText: value });
  }

  function runCommand(raw: string) {
    const parts = raw.trim().split(/\s+/);
    const cmd = parts[0].toLowerCase();
    switch (cmd) {
      case '/help':
        pushSystem(SLASH_COMMANDS.map((c) => `${c.name.padEnd(10)}${c.description}`).join('\n'));
        break;
      case '/clear':
        inputQueueRef.current!.clearWaiting();
        if (inputQueueRef.current!.running) handleInterrupt();
        setHistory([]);
        conversationRef.current = [];
        // The transcript already lives in the terminal's scrollback, where
        // React can't reach it — dropping `history` alone leaves every past
        // turn on screen. Wipe it for real.
        redraw();
        break;
      case '/model':
      case '/model/': {
        const request = parseModelCommandArgs(parts.slice(1));
        if (request.kind === 'error') {
          pushError(request.message);
        } else if (request.kind === 'picker') {
          openModelPicker();
        } else {
          void selectNamedModel(request.model, request.provider);
        }
        break;
      }
      case '/tools': {
        const tools = toolsRef.current;
        if (!tools) {
          pushSystem('Still starting up — try again in a moment.');
          break;
        }
        // classifyTool() always allows these outright; run_command's actual
        // risk depends on the command itself and is only known per-call.
        const RISK_NOTE: Record<string, string> = {
          run_command: 'risk depends on the command — some need your approval first',
        };
        pushSystem(
          tools
            .definitions()
            .map((d) => `${d.name} (${RISK_NOTE[d.name] ?? 'auto-approved'}) — ${d.description}`)
            .join('\n'),
        );
        break;
      }
      case '/skills': {
        const skills = toolsRef.current?.skillList;
        if (!skills) {
          pushSystem('Still starting up — try again in a moment.');
          break;
        }

        const name = parts[1];
        if (!name) {
          if (!skills.length) {
            pushSystem('No skills found under ~/.agents/skills or <workspace>/.agents/skills.');
            break;
          }
          pushSystem(
            skills
              .map((s) => {
                const tag = s.modelInvocable ? s.source : `${s.source}, manual-only`;
                return `${s.name} (${tag}) — ${s.description}`;
              })
              .join('\n'),
          );
          break;
        }

        // `/skills <name>` is the manual-trigger path: unlike the model's own
        // load_skill tool call, this works for manual-only skills too (that's
        // the whole point of the flag — gated behind an explicit trigger,
        // which this is) since it never goes through ToolRegistry.execute.
        const skill = skills.find((s) => s.name === name);
        if (!skill) {
          pushError(`No skill named "${name}" — try /skills to see what's available.`);
          break;
        }
        if (busy) {
          pushError('Finish or interrupt the current turn first (Esc), then try /skills again.');
          break;
        }
        const extra = parts.slice(2).join(' ').trim();
        // Some skills gate themselves on "only when the user explicitly
        // invokes /foo" — a slash command from whatever tool the skill was
        // authored for (Claude Code, Codex, ...), which mai doesn't have.
        // Spell out plainly that /skills <name> *is* that explicit
        // invocation, so the model doesn't second-guess the precondition
        // just because it doesn't see that exact command name.
        const invocationNote =
          `The user just explicitly invoked this skill manually via "/skills ${skill.name}" in this ` +
          'CLI — treat that as satisfying any "only when the user explicitly invokes ..." precondition ' +
          "below, even if the exact command name mentioned there differs (mai doesn't have per-skill " +
          'slash commands).';
        const turnText = extra
          ? `${invocationNote}\n\n${skill.body}\n\n---\n\nUser-supplied argument for this skill: ${extra}`
          : `${invocationNote}\n\n${skill.body}`;
        inputQueueRef.current!.enqueue({ displayText: raw.trim(), userText: turnText });
        break;
      }
      case '/system':
        pushSystem(systemInstructionRef.current || 'Still starting up — try again in a moment.');
        break;
      case '/theme':
        pushSystem("Theme switching isn't implemented yet — this build ships one dark theme.");
        break;
      case '/about':
        pushSystem(
          `Mai — an Ink/React terminal UI backed by any provider listed in providers.json ` +
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

  // /model is a two-stage picker: pick a provider from providers.json, then
  // (once that provider's model list has loaded) pick a model within it.
  // A single-provider setup skips straight to the model stage.
  function openModelPicker() {
    const config = configRef.current;
    if (!config) {
      pushSystem('Still starting up — try again in a moment.');
      return;
    }
    if (busy) {
      pushError('Finish or interrupt the current turn first (Esc), then try /model again.');
      return;
    }
    if (config.providers.length === 1) {
      void selectProvider(config.providers[0].name);
      return;
    }
    setPickerOptions(config.providers.map((p) => p.name));
    setPickerStage('provider');
  }

  async function selectProvider(name: string) {
    setPickerStage(null);
    const config = configRef.current;
    const def = config?.providers.find((p) => p.name === name);
    if (!config || !def) return;

    const candidate = configForProvider(config, def);
    if (!candidate.apiKey) {
      pushError(`No API key configured for "${def.name}" — set ${def.apiKeyEnv} first.`);
      return;
    }

    setModelsLoading(true);
    pushSystem(`Fetching available ${def.name} models…`);
    try {
      const models = await createLlmClient(candidate).listModels();
      if (!models.length) {
        pushError(`"${def.name}" returned no usable models.`);
        return;
      }
      pendingProviderRef.current = def;
      // Re-picking the already-active provider should highlight the model
      // actually in use (which may differ from providers.json's default if
      // it was switched at runtime); picking a *different* provider has no
      // "last used model" to fall back on, so highlight its declared
      // default instead.
      pendingDefaultModelRef.current = config.provider === def.name ? config.model : candidate.model;
      setPickerOptions(models);
      setPickerStage('model');
    } catch (err) {
      pushError(`Failed to list models: ${(err as Error).message}`);
    } finally {
      setModelsLoading(false);
    }
  }

  async function selectNamedModel(modelName: string, providerName?: string) {
    const config = configRef.current;
    if (!config) {
      pushSystem('Still starting up — try again in a moment.');
      return;
    }
    if (busy) {
      pushError('Finish or interrupt the current turn first (Esc), then try /model again.');
      return;
    }

    const requestedProvider = providerName ?? config.provider;
    const matchedProvider = matchIdentifier(
      config.providers.map((provider) => provider.name),
      requestedProvider,
    );
    const def = config.providers.find((provider) => provider.name === matchedProvider);
    if (!def) {
      pushError(
        `Unknown provider "${requestedProvider}". Available providers: ` +
          config.providers.map((provider) => provider.name).join(', '),
      );
      return;
    }

    const candidate = configForProvider(config, def);
    if (!candidate.apiKey) {
      pushError(`No API key configured for "${def.name}" — set ${def.apiKeyEnv} first.`);
      return;
    }

    setModelsLoading(true);
    pushSystem(`Fetching available ${def.name} models…`);
    try {
      const models = await createLlmClient(candidate).listModels();
      if (!models.length) {
        pushError(`"${def.name}" returned no usable models.`);
        return;
      }
      const matchedModel = matchIdentifier(models, modelName);
      if (!matchedModel) {
        pushError(
          `Model "${modelName}" was not found for provider "${def.name}". ` +
            'Run /model to browse the available models.',
        );
        return;
      }
      activateModel(config, def, matchedModel);
    } catch (err) {
      pushError(`Failed to list models: ${(err as Error).message}`);
    } finally {
      setModelsLoading(false);
    }
  }

  function selectModel(model: string) {
    setPickerStage(null);
    const config = configRef.current;
    const def = pendingProviderRef.current;
    pendingProviderRef.current = null;
    if (!config || !def) return;

    activateModel(config, def, model);
  }

  function activateModel(config: Config, def: ProviderDef, model: string) {
    const next = configForProvider(config, def);
    next.model = model;
    configRef.current = next;
    clientRef.current = createLlmClient(next);
    saveState(next.workspace, next.provider, next.model);
    pushSystem(`Switched model: provider=${next.provider} model=${model} base url=${next.baseUrl}`);
  }

  function cancelPicker() {
    setPickerStage(null);
    pendingProviderRef.current = null;
    pendingDefaultModelRef.current = '';
  }

  async function runTurn(userText: string) {
    const tools = toolsRef.current;
    const client = clientRef.current;
    if (!tools || !client) {
      pushError('Agent is still starting up — try again in a moment.');
      return;
    }

    cancelledRef.current = false;
    const controller = new AbortController();
    abortControllerRef.current = controller;

    let turn = createTurnState();
    const applyAndRender = (event: AgentEvent) => {
      turn = applyAgentEvent(turn, event);
      // Hand every message at the head of the turn that can no longer
      // change (a bubble that stopped streaming, a tool call that already
      // reported) straight to <Static> rather than waiting for the turn to
      // end. Otherwise the live region Ink redraws on *every* frame grows
      // for the whole turn, and the moment it's taller than the terminal
      // Ink switches to clearing the screen and reprinting the entire
      // transcript each frame — which is what makes a long reply flicker
      // and tear.
      const settled = countSettled(turn.messages);
      if (settled > 0) {
        const done = turn.messages.slice(0, settled);
        turn = { ...turn, messages: turn.messages.slice(settled) };
        pushHistory(...done);
      }
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
    }
    if (abortControllerRef.current === controller) abortControllerRef.current = null;
  }

  queuedInputWorkerRef.current = async (turn) => {
    pushHistory({ id: genId(), role: 'user', content: turn.displayText, timestamp: Date.now() });
    await runTurn(turn.userText);
  };

  function handleInterrupt() {
    if (!inputQueueRef.current?.running) return;
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

    if (approvalResolveRef.current) {
      const resolve = approvalResolveRef.current;
      approvalResolveRef.current = null;
      setApprovalRequest(null);
      resolve(false);
    }
  }

  const turnCount = history.filter((m) => m.role === 'user').length;
  const disabled = !ready || modelsLoading;
  const disabledLabel = !ready
    ? 'Starting up…'
    : modelsLoading
      ? 'Fetching models…'
      : undefined;

  return (
    <Box flexDirection="column">
      <ConversationView
        cwd={process.cwd()}
        history={history}
        pending={pending}
        redrawKey={redrawKey}
        width={columns}
      />
      <Box marginTop={1} flexDirection="column">
        {approvalRequest ? (
          <ApprovalPrompt request={approvalRequest} onAnswer={answerApproval} />
        ) : pickerStage === 'provider' ? (
          <ModelPicker
            label="Select a provider"
            models={pickerOptions}
            current={configRef.current?.provider ?? ''}
            onSelect={(name) => void selectProvider(name)}
            onCancel={cancelPicker}
          />
        ) : pickerStage === 'model' ? (
          <ModelPicker
            models={pickerOptions}
            current={pendingDefaultModelRef.current}
            onSelect={selectModel}
            onCancel={cancelPicker}
          />
        ) : (
          <InputPrompt
            history={inputHistory}
            disabled={disabled}
            busy={busy}
            queuedCount={queuedCount}
            disabledLabel={disabledLabel}
            onSubmit={handleSubmit}
            onInterrupt={handleInterrupt}
          />
        )}
        <StatusBar
          busy={busy}
          queuedCount={queuedCount}
          turnCount={turnCount}
          model={configRef.current ? `${configRef.current.provider} · ${configRef.current.model}` : '…'}
          exitArmed={exitArmed}
        />
      </Box>
    </Box>
  );
}

/**
 * How many messages at the head of an in-flight turn are final: a bubble
 * that has stopped streaming, or a tool call that has already reported its
 * result. Stops at the first message that could still change, so moving
 * that prefix into the finished transcript never reorders anything.
 */
function countSettled(messages: Message[]): number {
  let count = 0;
  for (const message of messages) {
    if (message.streaming) break;
    const status = message.tool?.status;
    if (status === 'running' || status === 'pending_approval') break;
    count += 1;
  }
  return count;
}
