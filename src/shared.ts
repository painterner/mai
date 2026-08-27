/**
 * Duplicated (not imported) from mai-cli-node's `src/types.ts` +
 * `src/agent/loop.ts` + `src/agent/reducer.ts`. This is a separate npm/Vite
 * project so it can't `import` that TS source directly; the surface here
 * is small and stable (it's just the wire format for the daemon's JSON
 * events), so keeping a synced copy is simpler than wiring up a shared
 * package. If you change the shape of `AgentEvent` or `Message` on the
 * Node side, mirror the change here too.
 */

export type Role = 'user' | 'assistant' | 'thought' | 'tool' | 'system' | 'error';
export type ToolStatus = 'pending_approval' | 'running' | 'done' | 'failed' | 'declined';
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface ToolCallInfo {
  name: string;
  args?: string;
  output?: string;
  status: ToolStatus;
}

export interface Message {
  id: string;
  role: Role;
  content: string;
  streaming?: boolean;
  tool?: ToolCallInfo;
  timestamp: number;
}

export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'thought'; text: string }
  | { type: 'toolStart'; id: string; name: string; args: Record<string, unknown> }
  | {
      type: 'toolApprovalNeeded';
      id: string;
      name: string;
      args: Record<string, unknown>;
      risk: RiskLevel;
      reason: string;
    }
  | { type: 'toolFinished'; id: string; name: string; output: string; status: 'done' | 'failed' | 'declined' }
  | { type: 'done' }
  | { type: 'error'; message: string };

export type DaemonEvent =
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
  | { type: 'providersListed'; providers: string[]; current: string }
  | { type: 'modelsListed'; models: string[]; current: string }
  | { type: 'modelsError'; message: string }
  | { type: 'modelChanged'; provider: string; model: string; baseUrl: string }
  | AgentEvent;

let counter = 0;
export function genId(): string {
  counter += 1;
  return `m${counter}-${Date.now().toString(36)}`;
}

export interface TurnState {
  messages: Message[];
  assistantId: string | null;
  thoughtId: string | null;
  toolMessageIds: Map<string, string>;
}

export function createTurnState(): TurnState {
  return { messages: [], assistantId: null, thoughtId: null, toolMessageIds: new Map() };
}

export function closeStreaming(msgs: Message[]): Message[] {
  return msgs.map((m) => (m.streaming ? { ...m, streaming: false } : m));
}

/** Returns a new `TurnState` — never mutates the one passed in. */
export function applyAgentEvent(state: TurnState, event: AgentEvent): TurnState {
  switch (event.type) {
    case 'thought': {
      if (!state.thoughtId) {
        const id = genId();
        return {
          ...state,
          // A model that interleaves reasoning with prose (thought, text,
          // thought, text) starts a *new* bubble each time it switches.
          // Leaving assistantId set here would make the next 'text' event
          // append to the assistant bubble sitting above this thought
          // instead, so the reply would render out of order.
          assistantId: null,
          thoughtId: id,
          messages: closeStreaming(state.messages).concat([
            { id, role: 'thought', content: event.text, streaming: true, timestamp: Date.now() },
          ]),
        };
      }
      const id = state.thoughtId;
      return {
        ...state,
        messages: state.messages.map((m) => (m.id === id ? { ...m, content: m.content + event.text } : m)),
      };
    }

    case 'text': {
      if (!state.assistantId) {
        const id = genId();
        return {
          ...state,
          assistantId: id,
          // Mirror of the 'thought' case above — see the note there.
          thoughtId: null,
          messages: closeStreaming(state.messages).concat([
            { id, role: 'assistant', content: event.text, streaming: true, timestamp: Date.now() },
          ]),
        };
      }
      const id = state.assistantId;
      return {
        ...state,
        messages: state.messages.map((m) => (m.id === id ? { ...m, content: m.content + event.text } : m)),
      };
    }

    case 'toolStart': {
      const id = genId();
      const toolMessageIds = new Map(state.toolMessageIds);
      toolMessageIds.set(event.id, id);
      return {
        ...state,
        assistantId: null,
        thoughtId: null,
        toolMessageIds,
        messages: closeStreaming(state.messages).concat([
          {
            id,
            role: 'tool',
            content: '',
            tool: { name: event.name, args: formatArgs(event.args), status: 'running' },
            timestamp: Date.now(),
          },
        ]),
      };
    }

    case 'toolApprovalNeeded': {
      const id = genId();
      const toolMessageIds = new Map(state.toolMessageIds);
      toolMessageIds.set(event.id, id);
      return {
        ...state,
        assistantId: null,
        thoughtId: null,
        toolMessageIds,
        messages: closeStreaming(state.messages).concat([
          {
            id,
            role: 'tool',
            content: '',
            tool: { name: event.name, args: formatArgs(event.args), status: 'pending_approval' },
            timestamp: Date.now(),
          },
        ]),
      };
    }

    case 'toolFinished': {
      const msgId = state.toolMessageIds.get(event.id);
      if (!msgId) return state;
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.id === msgId ? { ...m, tool: { ...m.tool!, status: event.status, output: event.output } } : m,
        ),
      };
    }

    case 'error': {
      return {
        ...state,
        assistantId: null,
        thoughtId: null,
        messages: closeStreaming(state.messages).concat([
          { id: genId(), role: 'error', content: event.message, timestamp: Date.now() },
        ]),
      };
    }

    case 'done':
      return state;

    default:
      return state;
  }
}

function formatArgs(args: Record<string, unknown>): string | undefined {
  return Object.keys(args).length ? JSON.stringify(args) : undefined;
}
