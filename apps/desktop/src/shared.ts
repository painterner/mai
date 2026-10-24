import type {
  AgentEvent,
  Message,
} from '@mai/protocol';

export type {
  AgentEvent,
  ApprovalMode,
  DaemonEvent,
  Message,
  RiskLevel,
  Role,
  ToolCallInfo,
  ToolStatus,
} from '@mai/protocol';

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
