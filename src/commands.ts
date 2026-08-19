import type { SlashCommand } from './types.js';

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: '/help', description: 'Show available commands' },
  { name: '/clear', description: 'Clear the conversation and start a fresh model context' },
  { name: '/model', description: 'Show the active model, base URL, and API key status' },
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
