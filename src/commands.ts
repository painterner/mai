import type { SlashCommand } from './types.js';

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: '/help', description: 'Show available commands' },
  { name: '/clear', description: 'Clear the conversation and start a fresh model context' },
  {
    name: '/model',
    description: 'Pick interactively, or use /model <model> [provider] for direct switching',
  },
  { name: '/tools', description: 'List the tools currently available to the model' },
  {
    name: '/skills',
    description: 'List skills, or /skills <name> [args] to force-run one (works for manual-only skills too)',
  },
  { name: '/system', description: 'Show the current system prompt sent to the model' },
  { name: '/theme', description: 'Toggle a cosmetic theme note (placeholder)' },
  { name: '/about', description: 'About this CLI' },
  { name: '/gui', description: 'Switch to the GUI app, handing off this conversation' },
  { name: '/exit', description: 'Exit the CLI' },
  { name: '/quit', description: 'Exit the CLI' },
];

export function matchCommands(input: string): SlashCommand[] {
  const q = input.toLowerCase();
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(q));
}

export type ModelCommandRequest =
  | { kind: 'picker' }
  | { kind: 'select'; model: string; provider?: string }
  | { kind: 'error'; message: string };

/** Parses the arguments after `/model`; model comes first, then provider. */
export function parseModelCommandArgs(args: string[]): ModelCommandRequest {
  if (args.length === 0) return { kind: 'picker' };
  if (args.length > 2) {
    return { kind: 'error', message: 'Usage: /model <model> [provider]' };
  }
  return { kind: 'select', model: args[0], provider: args[1] };
}

/** Prefer an exact identifier, then accept a case-insensitive exact match. */
export function matchIdentifier(available: string[], requested: string): string | undefined {
  return available.find((value) => value === requested)
    ?? available.find((value) => value.toLowerCase() === requested.toLowerCase());
}
