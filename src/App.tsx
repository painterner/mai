import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  applyAgentEvent,
  closeStreaming,
  createTurnState,
  genId,
  type DaemonEvent,
  type Message,
  type RiskLevel,
  type TurnState,
} from './shared';
import './App.css';

interface ReadyInfo {
  workspace: string;
  provider: string;
  model: string;
  baseUrl: string;
  hasApiKey: boolean;
  sandbox: string | null;
}

interface ApprovalRequest {
  name: string;
  args: Record<string, unknown>;
  risk: RiskLevel;
  reason: string;
}

interface ApiStatus {
  state: 'starting' | 'running' | 'restarting';
  url?: string;
  message?: string;
}

const ROLE_LABEL: Record<Message['role'], string> = {
  user: 'you',
  assistant: 'mai',
  thought: 'thinking',
  tool: 'tool',
  system: 'system',
  error: 'error',
};

export default function App() {
  const [ready, setReady] = useState<ReadyInfo | null>(null);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [history, setHistory] = useState<Message[]>([]);
  const [turn, setTurnState] = useState<TurnState>(createTurnState());
  const [busy, setBusy] = useState(false);
  const [approvalRequest, setApprovalRequest] = useState<ApprovalRequest | null>(null);
  const [inputValue, setInputValue] = useState('');
  const [switching, setSwitching] = useState(false);
  const [pickerStage, setPickerStage] = useState<'provider' | 'model' | null>(null);
  const [pickerOptions, setPickerOptions] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [autostart, setAutostartState] = useState(false);
  const [autostartBusy, setAutostartBusy] = useState(false);
  const [apiStatus, setApiStatus] = useState<ApiStatus>({ state: 'starting' });

  const turnRef = useRef(turn);
  const listRef = useRef<HTMLDivElement | null>(null);
  const pendingProviderRef = useRef<string | null>(null);
  const pendingDefaultModelRef = useRef('');

  function setTurn(next: TurnState) {
    turnRef.current = next;
    setTurnState(next);
  }

  useEffect(() => {
    const unlistenPromises = [
      listen<DaemonEvent>('daemon-event', (event) => handleEvent(event.payload)),
      listen<string>('daemon-fatal', (event) => setFatalError(event.payload)),
      listen<ApiStatus>('api-status', (event) => setApiStatus(event.payload)),
    ];
    // The daemon can finish starting (and emit `ready`) before the listener
    // above is actually registered — Tauri doesn't buffer events for late
    // subscribers — so also pull the cached payload directly as a fallback.
    invoke<DaemonEvent | null>('get_ready_info').then((info) => {
      if (info) handleEvent(info);
    });
    invoke<ApiStatus>('get_api_status').then(setApiStatus);
    invoke<boolean>('autostart_status').then(setAutostartState);
    return () => {
      unlistenPromises.forEach((p) => p.then((unlisten) => unlisten()));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Follow the tail only while the user is already there. Pinning the
  // scroll unconditionally yanked them back down every time a streaming
  // token arrived, which made it impossible to read back over a long reply
  // while the model was still writing.
  const stickToBottomRef = useRef(true);

  function handleScroll() {
    const el = listRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distanceFromBottom < 40;
  }

  useEffect(() => {
    if (!stickToBottomRef.current) return;
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [history, turn]);

  function handleEvent(event: DaemonEvent) {
    switch (event.type) {
      case 'ready':
        setReady(event);
        setHistory(
          event.resumedMessages.length
            ? event.resumedMessages
            : [
                {
                  id: 'welcome',
                  role: 'system',
                  content:
                    'Welcome to Mai. It can read/search/write files in this workspace and run ' +
                    'shell commands through a Rust-sandboxed sidecar. Risky actions pause for your ' +
                    'approval first.',
                  timestamp: Date.now(),
                },
              ],
        );
        return;
      case 'fatal':
        setFatalError(event.message);
        return;
      case 'handoffWritten':
      case 'handoffFailed':
        // Resolved via the switch_to_cli() invoke() call itself, not here.
        return;
      case 'providersListed':
        if (event.providers.length === 1) {
          void selectProvider(event.providers[0]);
        } else {
          setModelsLoading(false);
          setPickerOptions(event.providers);
          setPickerStage('provider');
        }
        return;
      case 'modelsListed':
        setModelsLoading(false);
        pendingDefaultModelRef.current = event.current;
        setPickerOptions(event.models);
        setPickerStage('model');
        return;
      case 'modelsError':
        setModelsLoading(false);
        setHistory((h) => [...h, { id: genId(), role: 'error', content: event.message, timestamp: Date.now() }]);
        return;
      case 'modelChanged':
        setReady((r) => (r ? { ...r, provider: event.provider, model: event.model, baseUrl: event.baseUrl } : r));
        setHistory((h) => [
          ...h,
          {
            id: genId(),
            role: 'system',
            content: `Switched model: provider=${event.provider} model=${event.model}`,
            timestamp: Date.now(),
          },
        ]);
        return;
      default: {
        const next = applyAgentEvent(turnRef.current, event);
        setTurn(next);
        if (event.type === 'toolApprovalNeeded') {
          setApprovalRequest({ name: event.name, args: event.args, risk: event.risk, reason: event.reason });
        }
        if (event.type === 'done' || event.type === 'error') {
          setHistory((h) => [...h, ...closeStreaming(next.messages)]);
          setTurn(createTurnState());
          setBusy(false);
          // A turn can end while an approval is still on screen — the
          // daemon declines anything outstanding when a turn is
          // interrupted. Leaving the bar up would hide the composer with
          // no way to dismiss it.
          setApprovalRequest(null);
        }
      }
    }
  }

  async function sendMessage(text: string) {
    const value = text.trim();
    if (!value || busy || !ready) return;
    stickToBottomRef.current = true;
    setHistory((h) => [...h, { id: genId(), role: 'user', content: value, timestamp: Date.now() }]);
    setInputValue('');
    setBusy(true);
    try {
      await invoke('send_message', { text: value });
    } catch (err) {
      setHistory((h) => [...h, { id: genId(), role: 'error', content: String(err), timestamp: Date.now() }]);
      setBusy(false);
    }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    void sendMessage(inputValue);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void sendMessage(inputValue);
    }
  }

  async function answerApproval(approved: boolean) {
    setApprovalRequest(null);
    await invoke('approve', { approved });
  }

  async function interruptTurn() {
    await invoke('interrupt_turn');
  }

  async function clearConversation() {
    // Clearing mid-turn would otherwise leave the turn streaming into a
    // transcript whose model-side context the daemon has already dropped —
    // stop it first so what's on screen and what the model remembers stay
    // in step.
    if (busy) await invoke('interrupt_turn');
    setHistory([]);
    setTurn(createTurnState());
    setApprovalRequest(null);
    await invoke('clear_conversation');
  }

  // /model-equivalent "Model" button is a two-stage picker: pick a provider
  // (skipped automatically if providers.json only declares one), then pick
  // a model from that provider's freshly-fetched list. Both stages are
  // request/response round trips through the daemon over stdio, not local
  // state, so the daemon is the source of truth for what's available.
  async function openModelPicker() {
    setModelsLoading(true);
    try {
      await invoke('list_providers');
    } catch (err) {
      setModelsLoading(false);
      setHistory((h) => [...h, { id: genId(), role: 'error', content: String(err), timestamp: Date.now() }]);
    }
  }

  async function selectProvider(provider: string) {
    pendingProviderRef.current = provider;
    setPickerStage(null);
    setModelsLoading(true);
    try {
      await invoke('list_models', { provider });
    } catch (err) {
      setModelsLoading(false);
      setHistory((h) => [...h, { id: genId(), role: 'error', content: String(err), timestamp: Date.now() }]);
    }
  }

  async function selectModel(model: string) {
    setPickerStage(null);
    const provider = pendingProviderRef.current;
    pendingProviderRef.current = null;
    if (!provider) return;
    try {
      await invoke('set_model', { provider, model });
    } catch (err) {
      setHistory((h) => [...h, { id: genId(), role: 'error', content: String(err), timestamp: Date.now() }]);
    }
  }

  function cancelPicker() {
    setPickerStage(null);
    pendingProviderRef.current = null;
    pendingDefaultModelRef.current = '';
  }

  async function switchToCli() {
    setSwitching(true);
    try {
      await invoke('switch_to_cli', { uiMessages: history });
      await getCurrentWindow().close();
    } catch (err) {
      setSwitching(false);
      setHistory((h) => [
        ...h,
        { id: genId(), role: 'error', content: `Could not switch to the CLI: ${String(err)}`, timestamp: Date.now() },
      ]);
    }
  }

  async function toggleAutostart() {
    if (autostartBusy) return;
    setAutostartBusy(true);
    try {
      setAutostartState(await invoke<boolean>('set_autostart', { enabled: !autostart }));
    } catch (err) {
      setHistory((h) => [
        ...h,
        { id: genId(), role: 'error', content: `Could not update startup setting: ${String(err)}`, timestamp: Date.now() },
      ]);
    } finally {
      setAutostartBusy(false);
    }
  }

  if (fatalError) {
    return (
      <div className="app app--fatal">
        <h1>Mai couldn't start</h1>
        <pre>{fatalError}</pre>
        <p className="dim">
          Make sure mai-cli-node is built (<code>npm run build</code>) and reachable next to this
          project, or set <code>MAI_DAEMON_JS</code>.
        </p>
      </div>
    );
  }

  const allMessages = [...history, ...turn.messages];

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand__dot" />
          Mai
        </div>
        <div className="topbar__info dim">
          {ready ? `${ready.provider} · ${ready.model} · ${ready.workspace}` : 'starting…'}
        </div>
        <div className="topbar__actions">
          <span
            className={`service-status service-status--${apiStatus.state}`}
            title={apiStatus.message ?? apiStatus.url ?? 'Mai HTTP API'}
          >
            API {apiStatus.state}
          </span>
          <button className="btn btn--ghost" onClick={() => void toggleAutostart()} disabled={autostartBusy}>
            {autostartBusy ? 'Updating…' : `Start at login: ${autostart ? 'On' : 'Off'}`}
          </button>
          <button className="btn btn--ghost" onClick={() => void clearConversation()} disabled={!ready}>
            Clear
          </button>
          <button
            className="btn btn--ghost"
            onClick={() => void openModelPicker()}
            disabled={!ready || busy || modelsLoading}
          >
            {modelsLoading ? 'Loading…' : 'Model'}
          </button>
          <button className="btn btn--ghost" onClick={() => void switchToCli()} disabled={!ready || switching}>
            {switching ? 'Switching…' : 'Open in CLI'}
          </button>
        </div>
      </header>

      <div className="messages" ref={listRef} onScroll={handleScroll}>
        {allMessages.map((m) => (
          <MessageView key={m.id} message={m} />
        ))}
        {!ready && <div className="dim status-line">Starting the agent…</div>}
      </div>

      {approvalRequest ? (
        <ApprovalBar request={approvalRequest} onAnswer={(a) => void answerApproval(a)} />
      ) : pickerStage === 'provider' ? (
        <ModelBar
          label="Select a provider"
          models={pickerOptions}
          current={ready?.provider ?? ''}
          onSelect={(p) => void selectProvider(p)}
          onCancel={cancelPicker}
        />
      ) : pickerStage === 'model' ? (
        <ModelBar
          models={pickerOptions}
          current={pendingDefaultModelRef.current}
          onSelect={(m) => void selectModel(m)}
          onCancel={cancelPicker}
        />
      ) : (
        <form className="composer" onSubmit={handleSubmit}>
          <textarea
            className="composer__input"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={ready ? 'Ask Mai anything… (Enter to send, Shift+Enter for a new line)' : 'Starting up…'}
            disabled={!ready || busy}
            rows={2}
          />
          <div className="composer__actions">
            {busy ? (
              <button type="button" className="btn" onClick={() => void interruptTurn()}>
                Stop
              </button>
            ) : (
              <button type="submit" className="btn btn--primary" disabled={!ready || !inputValue.trim()}>
                Send
              </button>
            )}
          </div>
        </form>
      )}
    </div>
  );
}

function MessageView({ message }: { message: Message }) {
  const label = ROLE_LABEL[message.role];
  return (
    <div className={`message message--${message.role}`}>
      <div className="message__meta">
        <span className="message__role">{label}</span>
        <span className="message__time">{formatTime(message.timestamp)}</span>
      </div>
      {message.tool ? <ToolCard tool={message.tool} /> : null}
      {message.content || message.streaming ? (
        <div className="message__content">
          {message.content}
          {message.streaming ? <span className="cursor" /> : null}
        </div>
      ) : null}
    </div>
  );
}

function ToolCard({ tool }: { tool: NonNullable<Message['tool']> }) {
  return (
    <div className={`tool-card tool-card--${tool.status}`}>
      <div className="tool-card__title">
        <span>{tool.name}</span>
        {tool.args ? <span className="dim tool-card__args">{tool.args}</span> : null}
        <span className={`tool-card__status tool-card__status--${tool.status}`}>{statusLabel(tool.status)}</span>
      </div>
      {tool.output ? <pre className="tool-card__output">{tool.output}</pre> : null}
    </div>
  );
}

function ApprovalBar({
  request,
  onAnswer,
}: {
  request: ApprovalRequest;
  onAnswer: (approved: boolean) => void;
}) {
  return (
    <div className="approval-bar">
      <div>
        <div className="approval-bar__title">
          Approval needed — <strong>{request.name}</strong>{' '}
          <span className={`risk risk--${request.risk}`}>{request.risk}</span>
        </div>
        <div className="dim">{request.reason}</div>
        {Object.keys(request.args).length ? <code className="dim">{JSON.stringify(request.args)}</code> : null}
      </div>
      <div className="approval-bar__actions">
        <button className="btn" onClick={() => onAnswer(false)}>
          Decline
        </button>
        <button className="btn btn--primary" onClick={() => onAnswer(true)}>
          Approve
        </button>
      </div>
    </div>
  );
}

function ModelBar({
  models,
  current,
  onSelect,
  onCancel,
  label = 'Select a model',
}: {
  models: string[];
  current: string;
  onSelect: (model: string) => void;
  onCancel: () => void;
  label?: string;
}) {
  return (
    <div className="model-bar">
      <div className="model-bar__header">
        <span>{label}</span>
        <button className="btn btn--ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <div className="model-bar__list">
        {models.map((m) => (
          <button
            key={m}
            className={`model-bar__option${m === current ? ' model-bar__option--current' : ''}`}
            onClick={() => onSelect(m)}
          >
            {m}
            {m === current ? <span className="dim"> (current)</span> : null}
          </button>
        ))}
      </div>
    </div>
  );
}

function statusLabel(status: string): string {
  switch (status) {
    case 'pending_approval':
      return 'needs approval';
    case 'running':
      return 'running';
    case 'done':
      return 'done';
    case 'failed':
      return 'failed';
    case 'declined':
      return 'declined';
    default:
      return status;
  }
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
