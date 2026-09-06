import React, { useState } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import type { ApprovalRequest } from '../agent/loop.js';
import { useMaiInput } from '../hooks/useMaiInput.js';

const RISK_COLOR: Record<ApprovalRequest['risk'], string> = {
  low: theme.success,
  medium: theme.tool,
  high: theme.error,
  critical: theme.error,
};

interface Props {
  request: ApprovalRequest;
  onAnswer: (approved: boolean) => void;
}

/**
 * Replaces the input box while a review-gated tool call is waiting on the
 * user. Defaults the cursor on "No" — approval has to be actively opted
 * into, never just Enter-mashed through.
 */
export function ApprovalPrompt({ request, onAnswer }: Props) {
  const [selected, setSelected] = useState<'approve' | 'deny'>('deny');

  useMaiInput((input, key) => {
    if (key.leftArrow || key.rightArrow || key.tab) {
      setSelected((s) => (s === 'approve' ? 'deny' : 'approve'));
      return;
    }
    if (input.toLowerCase() === 'y') {
      onAnswer(true);
      return;
    }
    if (input.toLowerCase() === 'n' || key.escape) {
      onAnswer(false);
      return;
    }
    if (key.return) {
      onAnswer(selected === 'approve');
    }
  });

  const argsText = Object.keys(request.args).length ? JSON.stringify(request.args) : null;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.tool} paddingX={1}>
      <Text color={theme.tool} bold>
        ⚠ Approval needed — {request.tool}
      </Text>
      <Text>
        <Text color={theme.dim}>{request.reason}  </Text>
        <Text color={RISK_COLOR[request.risk]}>risk: {request.risk}</Text>
      </Text>
      {argsText ? <Text color={theme.dim}>{argsText}</Text> : null}
      <Box marginTop={1}>
        <Text color={selected === 'approve' ? theme.success : theme.dim} bold={selected === 'approve'}>
          {selected === 'approve' ? '❯ ' : '  '}Yes, run it
        </Text>
      </Box>
      <Box>
        <Text color={selected === 'deny' ? theme.error : theme.dim} bold={selected === 'deny'}>
          {selected === 'deny' ? '❯ ' : '  '}No, skip it
        </Text>
      </Box>
      <Text color={theme.dim}>y / n, ←/→ then Enter, or Esc to decline</Text>
    </Box>
  );
}
