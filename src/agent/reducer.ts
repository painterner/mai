import type { AgentEvent } from './loop.js';
import type { Message } from '../types.js';
import { genId } from '../utils.js';

/**
 * Turns a stream of `AgentEvent`s into the `Message[]` transcript a UI
 * renders. Pulled out of `App.tsx` (the Ink frontend) so the Tauri/React
 * GUI can drive the exact same turn — text/thought bubbles, tool-call
 * cards, approval state — from the exact same event stream instead of
 * re-implementing this bookkeeping a second time.
 */
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
