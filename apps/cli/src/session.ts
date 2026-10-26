import path from 'node:path';

import type { ApprovalMode, Message } from '@mai/protocol';
import type { Content, Part } from './llm/types.js';
import { ApiStore, type SessionRecord } from './api/store.js';
import { genId } from './utils.js';

export interface InteractiveSessionState {
  history: Content[];
  uiMessages: Message[];
  inputHistory: string[];
  approvalMode: ApprovalMode;
  provider: string;
  model: string;
  client: 'cli' | 'gui';
}

export function sessionStateFile(workspace: string): string {
  return process.env.MAI_API_STATE?.trim() || path.join(workspace, '.mai', 'api.sqlite');
}

export function openSessionStore(workspace: string): ApiStore {
  return new ApiStore(sessionStateFile(workspace), { recoverInterrupted: false });
}

export function createInteractiveSession(
  store: ApiStore,
  state: Pick<InteractiveSessionState, 'provider' | 'model' | 'approvalMode' | 'client'>,
): SessionRecord {
  return store.createSession(state.provider, state.model, undefined, {
    approvalMode: state.approvalMode,
    client: state.client,
  });
}

export function checkpointInteractiveSession(
  store: ApiStore,
  id: string,
  state: InteractiveSessionState,
): SessionRecord | null {
  const uiMessages = stableMessages(state.uiMessages);
  const title = store.getSession(id)?.title ?? deriveTitle(uiMessages);
  return store.updateSession(id, {
    history: state.history,
    uiMessages,
    inputHistory: state.inputHistory.slice(-200),
    approvalMode: state.approvalMode,
    provider: state.provider,
    model: state.model,
    client: state.client,
    ...(title ? { title } : {}),
  });
}

export function restoredMessages(session: SessionRecord): Message[] {
  return session.uiMessages.length
    ? stableMessages(session.uiMessages)
    : messagesFromContents(session.history);
}

export function resolveSession(
  sessions: SessionRecord[],
  requested?: string,
): SessionRecord | null {
  if (!sessions.length) return null;
  if (!requested || requested === 'last') return sessions[0];
  const exact = sessions.find((session) => session.id === requested);
  if (exact) return exact;
  const matches = sessions.filter((session) => session.id.startsWith(requested));
  return matches.length === 1 ? matches[0] : null;
}

export function sessionLabel(session: SessionRecord): string {
  const id = session.id.replace(/^sess_/, '').slice(0, 8);
  const title = session.title || '(untitled)';
  const stamp = session.updatedAt.replace('T', ' ').slice(0, 16);
  return `${id} · ${stamp} · ${title} · ${session.provider}/${session.model}`;
}

export function stableMessages(messages: Message[]): Message[] {
  return messages.map((message) => ({
    ...message,
    streaming: false,
    ...(message.tool?.status === 'running' || message.tool?.status === 'pending_approval'
      ? {
          tool: {
            ...message.tool,
            status: 'failed' as const,
            output: message.tool.output || 'Interrupted before completion; not replayed on resume.',
          },
        }
      : {}),
  }));
}

export function messagesFromContents(contents: Content[]): Message[] {
  const messages: Message[] = [];
  for (const content of contents) {
    for (const part of content.parts) {
      const message = messageFromPart(content.role, part);
      if (message) messages.push(message);
    }
  }
  return messages;
}

function messageFromPart(role: Content['role'], part: Part): Message | null {
  if ('text' in part) {
    return {
      id: genId(),
      role: role === 'user' ? 'user' : part.thought ? 'thought' : 'assistant',
      content: part.text,
      timestamp: Date.now(),
    };
  }
  if ('functionCall' in part) {
    return {
      id: genId(),
      role: 'tool',
      content: '',
      tool: {
        name: part.functionCall.name,
        args: JSON.stringify(part.functionCall.args ?? {}),
        output: 'Tool call restored from model history.',
        status: 'done',
      },
      timestamp: Date.now(),
    };
  }
  if ('functionResponse' in part) {
    return {
      id: genId(),
      role: 'tool',
      content: '',
      tool: {
        name: part.functionResponse.name,
        output: JSON.stringify(part.functionResponse.response),
        status: 'done',
      },
      timestamp: Date.now(),
    };
  }
  return null;
}

function deriveTitle(messages: Message[]): string | null {
  const first = messages.find((message) => message.role === 'user' && message.content.trim());
  if (!first) return null;
  return first.content.replace(/\s+/g, ' ').trim().slice(0, 80);
}
