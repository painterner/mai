import type { SlashCommand } from './types.js';

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: '/help', description: 'Show available commands' },
  { name: '/clear', description: 'Clear the conversation and start a fresh model context' },
  { name: '/model', description: 'Discover and switch provider/model (↑/↓ to pick, Enter to confirm)' },
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
