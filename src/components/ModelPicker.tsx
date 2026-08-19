import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { theme, symbols } from '../theme.js';

interface Props {
  models: string[];
  current: string;
  onSelect: (model: string) => void;
  onCancel: () => void;
  /** Header text — `/model` reuses this component for both its provider and model stages. */
  label?: string;
}

const MAX_VISIBLE = 10;

/**
 * Replaces the input box while `/model`'s fetched list (providers, then
 * models within the chosen one) is up for selection — same "takes over the
 * input row" pattern as ApprovalPrompt. Windows the list around the
 * selected index so a provider with hundreds of models doesn't blow past
 * the terminal height.
 */
export function ModelPicker({ models, current, onSelect, onCancel, label = 'Select a model' }: Props) {
  const [index, setIndex] = useState(Math.max(0, models.indexOf(current)));

  useInput((_input, key) => {
    if (key.upArrow) {
      setIndex((i) => (i - 1 + models.length) % models.length);
      return;
    }
    if (key.downArrow) {
      setIndex((i) => (i + 1) % models.length);
      return;
    }
    if (key.return) {
      onSelect(models[index]);
      return;
    }
    if (key.escape) {
      onCancel();
    }
  });

  const windowStart = Math.max(
    0,
    Math.min(index - Math.floor(MAX_VISIBLE / 2), Math.max(0, models.length - MAX_VISIBLE)),
  );
  const visible = models.slice(windowStart, windowStart + MAX_VISIBLE);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.assistant} paddingX={1}>
      <Text color={theme.assistant} bold>
        {symbols.assistant} {label} {models.length > MAX_VISIBLE ? `(${index + 1}/${models.length})` : ''}
      </Text>
      {visible.map((model, i) => {
        const isSelected = windowStart + i === index;
        return (
          <Text key={model} color={isSelected ? theme.success : theme.dim} bold={isSelected}>
            {isSelected ? '❯ ' : '  '}
            {model}
            {model === current ? '  (current)' : ''}
          </Text>
        );
      })}
      <Text color={theme.dim}>↑/↓ to move, Enter to select, Esc to cancel</Text>
    </Box>
  );
}
