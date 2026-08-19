import React from 'react';
import { Box, Static } from 'ink';
import type { Message } from '../types.js';
import { MessageItem } from './MessageItem.js';

interface Props {
  /** Finished turns — never mutated after being appended, safe for <Static>. */
  history: Message[];
  /** The in-flight turn (tool call + streaming reply). Re-renders freely. */
  pending: Message[];
}

/**
 * `history` is handed to Ink's <Static>, which paints each item once and
 * never repaints it — the same trick real CLI agents use to keep a long
 * transcript scrolling smoothly instead of redrawing the whole thing every
 * frame. Only `pending` (the turn currently streaming in) re-renders live.
 */
export function ConversationView({ history, pending }: Props) {
  return (
    <Box flexDirection="column">
      <Static items={history}>{(m) => <MessageItem key={m.id} message={m} />}</Static>
      {pending.map((m) => (
        <MessageItem key={m.id} message={m} />
      ))}
    </Box>
  );
}
