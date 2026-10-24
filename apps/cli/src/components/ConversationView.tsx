import React from 'react';
import { Box, Static } from 'ink';
import type { Message } from '../types.js';
import { MessageItem } from './MessageItem.js';
import { Header } from './Header.js';

interface Props {
  cwd: string;
  /** Finished turns — never mutated after being appended, safe for <Static>. */
  history: Message[];
  /** The in-flight turn (tool call + streaming reply). Re-renders freely. */
  pending: Message[];
  /**
   * Bumping this remounts the `<Static>`, which resets its internal "already
   * painted up to index N" counter and makes it repaint the entire
   * transcript. The caller pairs that with clearing the screen — see
   * `redraw()` in App.tsx.
   */
  redrawKey: number;
  /** Terminal width, in columns — see the `<Static>` note below. */
  width: number;
  /** Bounds Ink's mutable region so it never wipes native terminal scrollback. */
  pendingHeight: number;
}

type StaticEntry = { kind: 'header'; cwd: string } | { kind: 'message'; message: Message };

/**
 * Ink only supports one `<Static>` per app — its reconciler keeps a single
 * `rootNode.staticNode` pointer, so a second `<Static>` mounting anywhere
 * else in the tree just overwrites that pointer and the first one silently
 * never paints again. So the startup banner and the history transcript
 * share this one `<Static>` (banner first, then each finished turn) rather
 * than each owning their own — both still paint exactly once and never
 * repaint, which is the whole point: keeps a long transcript scrolling
 * smoothly instead of redrawing everything every frame. Only `pending`
 * (the turn currently streaming in) re-renders live.
 *
 * The explicit `width` matters more than it looks. Ink styles the `<Static>`
 * node `position: absolute`, and an absolutely-positioned box with `width:
 * auto` shrink-wraps its content *without* being clamped to the terminal —
 * so a single item wider than the screen (a long cwd in the banner, a tool
 * call with a long argument) made the whole static box render wider than
 * the terminal. Every line then got hard-wrapped by the emulator instead of
 * by Ink, which shreds the box borders and leaves the transcript looking
 * scrambled — worst when the terminal is narrow, i.e. exactly when you zoom
 * in. Pinning the width to the real column count makes Ink do the wrapping.
 */
export function ConversationView({ cwd, history, pending, redrawKey, width, pendingHeight }: Props) {
  const staticEntries: StaticEntry[] = [
    { kind: 'header', cwd },
    ...history.map((message): StaticEntry => ({ kind: 'message', message })),
  ];

  return (
    <Box flexDirection="column">
      <Static key={redrawKey} items={staticEntries} style={{ width }}>
        {(entry) =>
          entry.kind === 'header' ? (
            <Header key="header" cwd={entry.cwd} />
          ) : (
            <MessageItem key={entry.message.id} message={entry.message} />
          )
        }
      </Static>
      {pending.length ? (
        <Box
          flexDirection="column"
          height={pendingHeight}
          overflowY="hidden"
          justifyContent="flex-end"
        >
          {pending.map((m) => (
            <Box key={m.id} flexShrink={0}>
              <MessageItem message={m} />
            </Box>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}
