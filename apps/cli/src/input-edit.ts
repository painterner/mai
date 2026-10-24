export interface InputEdit {
  value: string;
  cursor: number;
}

export function insertAtCursor(value: string, cursor: number, text: string): InputEdit {
  const position = Math.max(0, Math.min(cursor, value.length));
  return {
    value: value.slice(0, position) + text + value.slice(position),
    cursor: position + text.length,
  };
}

export function normalizeLineBreaks(value: string): string {
  return value.replace(/\r\n|\r/g, '\n');
}

/** Handles both Ink's shifted return flag and common enhanced-keyboard terminal sequences. */
export function isShiftEnterInput(input: string, shiftedReturn: boolean): boolean {
  if (shiftedReturn) return true;
  const sequence = input.startsWith('\u001b') ? input.slice(1) : input;
  return sequence === '\n' || sequence === '[13;2u' || sequence === '[27;2;13~';
}

export function moveCursorVertically(value: string, cursor: number, direction: -1 | 1): number {
  const position = Math.max(0, Math.min(cursor, value.length));
  const lineStart = lastLineBreakBefore(value, position) + 1;
  const column = position - lineStart;

  if (direction === -1) {
    if (lineStart === 0) return position;
    const previousEnd = lineStart - 1;
    const previousStart = lastLineBreakBefore(value, previousEnd) + 1;
    return previousStart + Math.min(column, previousEnd - previousStart);
  }

  const lineEnd = value.indexOf('\n', position);
  if (lineEnd === -1) return position;
  const nextStart = lineEnd + 1;
  const nextBreak = value.indexOf('\n', nextStart);
  const nextEnd = nextBreak === -1 ? value.length : nextBreak;
  return nextStart + Math.min(column, nextEnd - nextStart);
}

function lastLineBreakBefore(value: string, position: number): number {
  return position <= 0 ? -1 : value.lastIndexOf('\n', position - 1);
}
