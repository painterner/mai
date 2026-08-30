import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { theme } from '../theme.js';
import { matchCommands } from '../commands.js';
import {
  insertAtCursor,
  isShiftEnterInput,
  moveCursorVertically,
  normalizeLineBreaks,
} from '../input-edit.js';

interface Props {
  history: string[];
  disabled?: boolean;
  /** Placeholder shown while disabled; defaults to a "responding" message. */
  disabledLabel?: string;
  onSubmit: (value: string) => void;
  onInterrupt?: () => void;
}

/**
 * A hand-rolled, fully-controlled text field (no ink-text-input) so we get
 * full control over cursor movement, kill/word shortcuts, history browsing,
 * and the slash-command dropdown all sharing the same key stream.
 */
export function InputPrompt({ history, disabled, disabledLabel, onSubmit, onInterrupt }: Props) {
  const [value, setValue] = useState('');
  const [cursor, setCursor] = useState(0);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [menuIndex, setMenuIndex] = useState(0);

  const suggestions = value.startsWith('/') && value.length > 0 ? matchCommands(value) : [];
  const menuVisible = suggestions.length > 0;
  const clampedMenuIndex = Math.min(menuIndex, Math.max(suggestions.length - 1, 0));

  useInput((input, key) => {
    // Ctrl+C is App's — it has to keep working while this row is swapped
    // out for the approval prompt or the model picker.
    if (key.ctrl && input === 'c') return;

    if (disabled) {
      if (key.escape) onInterrupt?.();
      return;
    }

    if (key.upArrow) {
      if (menuVisible) {
        setMenuIndex((i) => Math.max(0, i - 1));
      } else if (value.includes('\n')) {
        setCursor((current) => moveCursorVertically(value, current, -1));
      } else if (history.length > 0) {
        const nextIndex = historyIndex === null ? history.length - 1 : Math.max(0, historyIndex - 1);
        if (historyIndex === null) setDraft(value);
        setHistoryIndex(nextIndex);
        setValueAndCursor(history[nextIndex]);
      }
      return;
    }

    if (key.downArrow) {
      if (menuVisible) {
        setMenuIndex((i) => Math.min(suggestions.length - 1, i + 1));
      } else if (value.includes('\n')) {
        setCursor((current) => moveCursorVertically(value, current, 1));
      } else if (historyIndex !== null) {
        const nextIndex = historyIndex + 1;
        if (nextIndex >= history.length) {
          setHistoryIndex(null);
          setValueAndCursor(draft);
        } else {
          setHistoryIndex(nextIndex);
          setValueAndCursor(history[nextIndex]);
        }
      }
      return;
    }

    if (key.tab) {
      if (menuVisible) setValueAndCursor(suggestions[clampedMenuIndex].name + ' ');
      return;
    }

    if (isShiftEnterInput(input, key.return && key.shift)) {
      applyInsertion('\n');
      return;
    }

    if (key.return) {
      submit(value);
      return;
    }

    if (key.escape) {
      setValueAndCursor('');
      setHistoryIndex(null);
      return;
    }

    if (key.leftArrow) {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (key.rightArrow) {
      setCursor((c) => Math.min(value.length, c + 1));
      return;
    }

    if (key.ctrl && input === 'a') {
      setCursor(0);
      return;
    }
    if (key.ctrl && input === 'e') {
      setCursor(value.length);
      return;
    }
    if (key.ctrl && input === 'u') {
      setValueAndCursor('');
      return;
    }
    if (key.ctrl && input === 'w') {
      deleteWordBackward();
      return;
    }

    if (key.backspace || key.delete) {
      if (cursor === 0) return;
      const next = value.slice(0, cursor - 1) + value.slice(cursor);
      setValue(next);
      setCursor((c) => c - 1);
      return;
    }

    if (!input) return;

    // A terminal paste can arrive as one multi-character chunk containing
    // CRLF/CR line endings. Preserve it as multiline input and only submit
    // from the explicit, non-shifted key.return branch above.
    if (/[\r\n]/.test(input)) {
      applyInsertion(normalizeLineBreaks(input));
      return;
    }

    // Regular keystroke or a pasted chunk — insert at the cursor.
    applyInsertion(input);
  });

  function applyInsertion(text: string) {
    const next = insertAtCursor(value, cursor, text);
    setValue(next.value);
    setCursor(next.cursor);
  }

  function submit(text: string) {
    if (!text.trim()) return;
    onSubmit(text);
    setValue('');
    setCursor(0);
    setHistoryIndex(null);
    setDraft('');
    setMenuIndex(0);
  }

  function setValueAndCursor(v: string) {
    setValue(v);
    setCursor(v.length);
  }

  function deleteWordBackward() {
    if (cursor === 0) return;
    const left = value.slice(0, cursor);
    const trimmed = left.replace(/\s+$/, '');
    const idx = trimmed.lastIndexOf(' ');
    const newLeft = idx === -1 ? '' : trimmed.slice(0, idx + 1);
    setValue(newLeft + value.slice(cursor));
    setCursor(newLeft.length);
  }

  const before = value.slice(0, cursor);
  const cursorCharacter = value[cursor];
  const atCursor = cursorCharacter === '\n' || cursorCharacter === undefined ? ' ' : cursorCharacter;
  const after = cursorCharacter === '\n' ? `\n${value.slice(cursor + 1)}` : value.slice(cursor + 1);

  return (
    <Box flexDirection="column">
      <Box
        borderStyle="round"
        borderColor={disabled ? theme.border : theme.borderFocus}
        paddingX={1}
      >
        <Text color={theme.user} bold>
          {'❯ '}
        </Text>
        {value.length === 0 ? (
          <>
            <Text inverse> </Text>
            <Text color={theme.dim}>
              {disabled
                ? (disabledLabel ?? 'Mai is responding… (Esc to interrupt)')
                : 'Ask Mai anything, or try /help…'}
            </Text>
          </>
        ) : (
          <>
            <Text>{before}</Text>
            <Text inverse>{atCursor}</Text>
            <Text>{after}</Text>
          </>
        )}
      </Box>
      {menuVisible ? (
        <Box flexDirection="column" paddingLeft={2}>
          {suggestions.map((s, i) => (
            <Text key={s.name} color={i === clampedMenuIndex ? theme.accent : theme.dim}>
              {i === clampedMenuIndex ? '❯ ' : '  '}
              {s.name}
              <Text color={theme.dim}>  {s.description}</Text>
            </Text>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}
