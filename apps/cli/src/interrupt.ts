import type { Message } from './types.js';

export function finalizeInterruptedMessages(messages: Message[]): Message[] {
  return messages.map((message) => {
    if (message.streaming) {
      return {
        ...message,
        streaming: false,
        content: `${message.content}${message.content ? ' ' : ''}[interrupted]`,
      };
    }
    if (message.tool && (message.tool.status === 'running' || message.tool.status === 'pending_approval')) {
      return {
        ...message,
        tool: {
          ...message.tool,
          status: 'failed' as const,
          output: message.tool.output ?? 'Interrupted',
        },
      };
    }
    return message;
  });
}

export interface InterruptedTranscriptTarget {
  showFinalized: (messages: Message[]) => void;
  appendHistory: (messages: Message[]) => void;
  clearPending: () => void;
}

/** Yield one event-loop turn so Ink can commit and paint the current frame. */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Move interrupted output from Ink's mutable region into `<Static>` without
 * ever producing a frame in which neither region contains it.
 *
 * In particular, appending to history and clearing pending in one React
 * batch is unsafe: Ink may erase the live region before `<Static>` has
 * emitted the replacement into terminal scrollback. The three distinct
 * frames below deliberately overlap the content for one frame instead.
 */
export async function preserveInterruptedTranscript(
  messages: Message[],
  target: InterruptedTranscriptTarget,
  yieldFrame: () => Promise<void> = nextFrame,
): Promise<void> {
  const finalized = finalizeInterruptedMessages(messages);
  target.showFinalized(finalized);
  await yieldFrame();
  target.appendHistory(finalized);
  await yieldFrame();
  target.clearPending();
}
