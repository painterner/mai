export type InputMode = 'prompt' | 'shell';

export function toggleInputMode(mode: InputMode): InputMode {
  return mode === 'prompt' ? 'shell' : 'prompt';
}

/**
 * Shell mode treats the entire submission as a command. Prompt mode also
 * supports the familiar one-shot `!command` spelling used by agent CLIs.
 */
export function shellCommandFromInput(value: string, mode: InputMode): string | null {
  const trimmed = value.trim();
  if (mode === 'shell') return trimmed || null;
  if (!trimmed.startsWith('!')) return null;
  const command = trimmed.slice(1).trim();
  return command || null;
}

export function formatShellResultForModel(command: string, output: string, failed: boolean): string {
  return [
    `The user ran this local sandboxed shell command between agent turns: ${command}`,
    `${failed ? 'The command failed with this output:' : 'The command completed with this output:'}`,
    output || '(no output)',
  ].join('\n');
}
