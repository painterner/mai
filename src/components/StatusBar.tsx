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

export function StatusBar({ busy, turnCount, model, exitArmed }: Props) {
  return (
    <Box justifyContent="space-between" paddingX={1}>
      <Box>
        {busy ? (
          <Spinner label="thinking…" />
        ) : (
          <Text color={theme.dim}>ready</Text>
        )}
      </Box>
      <Box>
        {exitArmed ? (
          <Text color={theme.error}>press Ctrl+C again to exit  </Text>
        ) : null}
        <Text color={theme.dim}>
          {model} · {turnCount} turn{turnCount === 1 ? '' : 's'}
        </Text>
      </Box>
    </Box>
  );
}
