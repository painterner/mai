import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import { Spinner } from './Spinner.js';

interface Props {
  busy: boolean;
  turnCount: number;
  model: string;
  exitArmed: boolean;
}

/**
 * One row, always exactly one row. Both halves used to be free to wrap, so
 * a narrow terminal (or a long provider·model name) spilled the bar onto a
 * second line and split words across it — "ready" rendered as "read" / "y".
 * The left half is pinned; the right half truncates instead of wrapping,
 * from the start so the turn counter at the end survives.
 */
export function StatusBar({ busy, turnCount, model, exitArmed }: Props) {
  const right = exitArmed
    ? 'press Ctrl+C again to exit'
    : `${model} · ${turnCount} turn${turnCount === 1 ? '' : 's'}`;

  return (
    <Box justifyContent="space-between" paddingX={1}>
      <Box flexShrink={0}>
        {busy ? <Spinner label="thinking…" /> : <Text color={theme.dim}>ready</Text>}
      </Box>
      <Text color={exitArmed ? theme.error : theme.dim} wrap="truncate-start">
        {right}
      </Text>
    </Box>
  );
}
