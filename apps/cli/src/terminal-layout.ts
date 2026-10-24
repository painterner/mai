import type { Message } from './types.js';
import { genId } from './utils.js';

// Ink 5 clears the terminal *and its scrollback* whenever the live React
// region reaches the viewport height. Keep enough rows for the composer,
// status bar, their margin, and the completion menu so the live region is
// always strictly shorter than the terminal.
const FIXED_COMPOSER_ROWS = 6;
const MAX_BUSY_SUGGESTIONS = 8;

export interface LiveRegionLayout {
  suggestionLimit: number;
  pendingRows: number;
}

export function liveRegionLayout(terminalRows: number, estimatedPendingRows: number): LiveRegionLayout {
  const rows = Math.max(1, Math.floor(terminalRows));
  const suggestionLimit = Math.max(0, Math.min(MAX_BUSY_SUGGESTIONS, rows - 7));
  const maxPendingRows = Math.max(1, rows - suggestionLimit - FIXED_COMPOSER_ROWS);
  return {
    suggestionLimit,
    pendingRows: Math.max(1, Math.min(maxPendingRows, Math.ceil(estimatedPendingRows))),
  };
}

/** A conservative display-height estimate; overflow clipping is the final guard. */
export function estimatePendingRows(messages: Message[], terminalColumns: number): number {
  const width = Math.max(1, Math.floor(terminalColumns) - 4);
  let rows = 0;
  for (const message of messages) {
    rows += 2; // role heading plus the message's bottom margin

    if (message.tool) {
      rows += 1;
      if (message.tool.output) {
        const outputLines = message.tool.output.split('\n').length;
        rows += 2 + Math.min(20, outputLines) + (outputLines > 20 ? 1 : 0);
      }
    }

    if (message.content || message.streaming) {
      for (const line of `${message.content}${message.streaming ? '▍' : ''}`.split('\n')) {
        rows += Math.max(1, Math.ceil(Array.from(line).length / width));
      }
      // Markdown code boxes add a top and bottom border.
      rows += (message.content.match(/^\s*```/gm)?.length ?? 0);
    }
  }
  return Math.max(1, rows);
}

export interface StreamFlushResult {
  pending: Message[];
  settled: Message[];
}

/**
 * Moves append-only prefixes of a long streaming bubble into `<Static>`.
 * Those rows become native terminal scrollback immediately, while only the
 * small tail remains mutable. Concatenating the fragments always reconstructs
 * the original content exactly.
 */
export function flushStreamingForScrollback(
  messages: Message[],
  maxTailChars: number,
): StreamFlushResult {
  const index = messages.findIndex((message) =>
    message.streaming && (message.role === 'assistant' || message.role === 'thought'));
  if (index === -1) return { pending: messages, settled: [] };

  const original = messages[index];
  const tailLimit = Math.max(64, Math.floor(maxTailChars));
  const chunkTarget = Math.max(64, Math.floor(tailLimit / 2));
  if (original.content.length <= tailLimit + chunkTarget) {
    return { pending: messages, settled: [] };
  }

  const settled: Message[] = [];
  let remaining = original.content;
  let continuation = original.continuation ?? false;
  let startsInCode = original.startsInCode ?? false;

  while (remaining.length > tailLimit + chunkTarget) {
    const split = preferredSplit(remaining, chunkTarget);
    const content = remaining.slice(0, split);
    const nextStartsInCode = codeStateAfter(content, startsInCode);
    settled.push({
      ...original,
      id: genId(),
      content,
      streaming: false,
      continuation,
      continues: true,
      startsInCode,
    });
    remaining = remaining.slice(split);
    continuation = true;
    startsInCode = nextStartsInCode;
  }

  const tail: Message = {
    ...original,
    content: remaining,
    continuation,
    continues: false,
    startsInCode,
  };
  return {
    pending: [...messages.slice(0, index), tail, ...messages.slice(index + 1)],
    settled,
  };
}

/** Restores one logical bubble before handing CLI history to the GUI. */
export function coalesceStreamFragments(messages: Message[]): Message[] {
  const output: Message[] = [];
  for (const message of messages) {
    const previous = output.at(-1);
    if (message.continuation && previous?.continues && previous.role === message.role) {
      output[output.length - 1] = {
        ...previous,
        content: previous.content + message.content,
        streaming: message.streaming,
        continuation: previous.continuation,
        continues: message.continues,
        startsInCode: previous.startsInCode,
      };
    } else {
      output.push({ ...message });
    }
  }
  return output.map(({ continuation: _continuation, continues: _continues, startsInCode: _starts, ...message }) => message);
}

function preferredSplit(content: string, target: number): number {
  const minimum = Math.max(1, Math.floor(target / 2));
  for (const separator of ['\n\n', '\n', ' ']) {
    const before = content.lastIndexOf(separator, target);
    if (before >= minimum) return before + separator.length;
    const after = content.indexOf(separator, target);
    if (after !== -1 && after < target * 2) return after + separator.length;
  }
  return Math.min(target, content.length - 1);
}

function codeStateAfter(content: string, startsInCode: boolean): boolean {
  const fences = content.match(/^\s*```/gm)?.length ?? 0;
  return fences % 2 === 0 ? startsInCode : !startsInCode;
}
