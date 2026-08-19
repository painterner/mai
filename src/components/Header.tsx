import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';

export function Header({ cwd }: { cwd: string }) {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.accentDim}
      paddingX={1}
      marginBottom={1}
    >
      <Box>
        <Text color={theme.accent} bold>
          ✳ Mai
        </Text>
        <Text color={theme.dim}> — coding agent</Text>
      </Box>
      <Box marginTop={0}>
        <Text color={theme.dim}>cwd: </Text>
        <Text color={theme.text}>{cwd}</Text>
      </Box>
      <Box>
        <Text color={theme.dim}>
          Type a message and press Enter · <Text color={theme.accent}>/</Text> for commands ·{' '}
          <Text color={theme.accent}>Ctrl+C</Text> twice to exit
        </Text>
      </Box>
    </Box>
  );
}
