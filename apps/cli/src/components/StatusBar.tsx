import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import { Spinner } from './Spinner.js';
import type { ApprovalMode } from '../agent/approval.js';

interface Props {
  busy: boolean;
  queuedCount?: number;
  shellCommandCount?: number;
  turnCount: number;
  model: string;
  approvalMode: ApprovalMode;
  exitArmed: boolean;
}

/**
 * One row, always exactly one row. Both halves used to be free to wrap, so
 * a narrow terminal (or a long provider·model name) spilled the bar onto a
 * second line and split words across it — "ready" rendered as "read" / "y".
 * The left half is pinned; the right half truncates instead of wrapping,
 * from the start so the turn counter at the end survives.
 */
export function StatusBar({
  busy,
  queuedCount = 0,
  shellCommandCount = 0,
  turnCount,
  model,
  approvalMode,
  exitArmed,
}: Props) {
  const right = exitArmed
    ? 'press Ctrl+C again to exit'
    : `${model} · approval:${approvalMode} · ${turnCount} turn${turnCount === 1 ? '' : 's'}`;

  return (
    <Box justifyContent="space-between" paddingX={1}>
      <Box flexShrink={0}>
        {busy ? (
          <Spinner
            label={[
              'thinking…',
              queuedCount ? `${queuedCount} queued` : '',
              shellCommandCount ? `${shellCommandCount} shell` : '',
            ].filter(Boolean).join(' · ')}
          />
        ) : (
          <Text color={theme.dim}>{shellCommandCount ? `${shellCommandCount} shell running` : 'ready'}</Text>
        )}
      </Box>
      <Text color={exitArmed ? theme.error : theme.dim} wrap="truncate-start">
        {right}
      </Text>
    </Box>
  );
}
