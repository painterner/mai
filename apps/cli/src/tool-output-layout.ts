interface ToolOutputLayoutInput {
  toolName: string;
  args?: string;
  output: string;
  width: number;
}

export interface ToolOutputCell {
  value: string;
  /** Terminal-column width reserved for this cell, including the inter-column gap. */
  width: number;
  padding: number;
}

export interface ToolOutputRow {
  text: string;
  cells?: ToolOutputCell[];
  tone?: 'normal' | 'error';
}

/** UI-only formatting. The original tool output remains unchanged for the model. */
export function layoutToolOutput({
  toolName,
  args,
  output,
  width,
}: ToolOutputLayoutInput): string[] {
  return layoutToolOutputRows({ toolName, args, output, width }).map((row) => row.text);
}

export function layoutToolOutputRows({
  toolName,
  args,
  output,
  width,
}: ToolOutputLayoutInput): ToolOutputRow[] {
  const lines = output.split('\n');
  if (toolName !== 'run_command') return plainRows(lines);
  const envelope = parseCommandEnvelope(lines);
  if (!envelope) return plainRows(lines);

  const statusRows: ToolOutputRow[] = envelope.exitCode === 0
    ? []
    : [{ text: `exit ${envelope.exitCode}`, tone: 'error' }];
  const stderrRows = plainRows(envelope.stderr).map((row) => ({ ...row, tone: 'error' as const }));
  if (!isColumnizableLs(args)) {
    return [...statusRows, ...plainRows(envelope.stdout), ...stderrRows];
  }

  // Multiple-directory `ls` output contains blank separators and "path:"
  // headings. Keep that structure verbatim instead of flattening it.
  if (
    envelope.stdout.length < 2
    || envelope.stdout.some((line) => !line || line.endsWith(':') || line.includes('\t'))
  ) {
    return [...statusRows, ...plainRows(envelope.stdout), ...stderrRows];
  }

  return [
    ...statusRows,
    ...columnizeRows(envelope.stdout, Math.max(10, width)),
    ...stderrRows,
  ];
}

interface CommandEnvelope {
  exitCode: number;
  stdout: string[];
  stderr: string[];
}

function parseCommandEnvelope(lines: string[]): CommandEnvelope | null {
  const status = /^exit status:\s*(-?\d+)\s*$/.exec(lines[0] ?? '');
  const stdoutIndex = lines.indexOf('stdout:');
  const stderrIndex = lines.indexOf('stderr:', stdoutIndex + 1);
  if (!status || stdoutIndex < 0 || stderrIndex < 0) return null;
  return {
    exitCode: Number(status[1]),
    stdout: trimTrailingEmpty(lines.slice(stdoutIndex + 1, stderrIndex)),
    stderr: trimTrailingEmpty(lines.slice(stderrIndex + 1)),
  };
}

function trimTrailingEmpty(lines: string[]): string[] {
  const result = [...lines];
  while (result.at(-1) === '') result.pop();
  return result;
}

export function commandExitCode(output: string): number | null {
  const match = /^exit status:\s*(-?\d+)\s*$/m.exec(output);
  return match ? Number(match[1]) : null;
}

function plainRows(lines: string[]): ToolOutputRow[] {
  return lines.map((text) => ({ text }));
}

function isColumnizableLs(args: string | undefined): boolean {
  if (!args) return false;
  let command: unknown;
  try {
    command = (JSON.parse(args) as { command?: unknown }).command;
  } catch {
    return false;
  }
  if (typeof command !== 'string') return false;
  const trimmed = command.trim();
  if (/[|;&><\n\r]/.test(trimmed)) return false;

  const match = /^(?:command\s+)?(?:\S*\/)?ls(?:\s+(.*))?$/.exec(trimmed);
  if (!match) return false;
  const argumentsText = match[1] ?? '';
  const tokens = argumentsText.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  return !tokens.some((token) => {
    if (/^--format=/.test(token)) return true;
    if (token === '--long' || token === '--single-column') return true;
    return /^-[^-]*[l1mCx]/.test(token);
  });
}

/** Packs items row-first, choosing the greatest column count that fits. */
export function columnize(items: string[], width: number, gap = 2): string[] {
  return columnizeRows(items, width, gap).map((row) => row.text);
}

function columnizeRows(items: string[], width: number, gap = 2): ToolOutputRow[] {
  if (items.length < 2 || width < 1) return cellRows(items);
  const maxColumns = Math.min(items.length, Math.max(1, Math.floor((width + gap) / (1 + gap))));

  for (let columns = maxColumns; columns > 1; columns -= 1) {
    const rows = Math.ceil(items.length / columns);
    const columnWidths = Array.from({ length: columns }, () => 0);
    for (let index = 0; index < items.length; index += 1) {
      const column = index % columns;
      columnWidths[column] = Math.max(columnWidths[column], displayWidth(items[index]));
    }
    const needed = columnWidths.reduce((sum, itemWidth) => sum + itemWidth, 0)
      + gap * (columns - 1);
    if (needed > width) continue;

    return Array.from({ length: rows }, (_, row): ToolOutputRow => {
      const cells: ToolOutputCell[] = [];
      for (let column = 0; column < columns; column += 1) {
        const item = items[row * columns + column];
        if (item === undefined) break;
        const hasFollowingItem = row * columns + column + 1 < items.length && column + 1 < columns;
        const padding = hasFollowingItem
          ? Math.max(0, columnWidths[column] + gap - displayWidth(item))
          : 0;
        cells.push({ value: item, width: displayWidth(item) + padding, padding });
      }
      return {
        text: cells.map((cell) => cell.value + ' '.repeat(cell.padding)).join(''),
        cells,
      };
    });
  }
  return cellRows(items);
}

function cellRows(items: string[]): ToolOutputRow[] {
  return items.map((value) => ({
    text: value,
    cells: [{ value, width: displayWidth(value), padding: 0 }],
  }));
}

function displayWidth(value: string): number {
  let width = 0;
  for (const character of value.replace(/\u001b\[[0-9;]*m/g, '')) {
    if (/\p{Mark}/u.test(character)) continue;
    const codepoint = character.codePointAt(0) ?? 0;
    width += isWide(codepoint) ? 2 : 1;
  }
  return width;
}

function isWide(codepoint: number): boolean {
  return codepoint >= 0x1100 && (
    codepoint <= 0x115f
    || codepoint === 0x2329
    || codepoint === 0x232a
    || (codepoint >= 0x2e80 && codepoint <= 0xa4cf && codepoint !== 0x303f)
    || (codepoint >= 0xac00 && codepoint <= 0xd7a3)
    || (codepoint >= 0xf900 && codepoint <= 0xfaff)
    || (codepoint >= 0xfe10 && codepoint <= 0xfe19)
    || (codepoint >= 0xfe30 && codepoint <= 0xfe6f)
    || (codepoint >= 0xff00 && codepoint <= 0xff60)
    || (codepoint >= 0xffe0 && codepoint <= 0xffe6)
    || (codepoint >= 0x1f300 && codepoint <= 0x1faff)
    || (codepoint >= 0x20000 && codepoint <= 0x3fffd)
  );
}
