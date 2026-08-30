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
    description: 'List skills; invoke with /<name> [args] or /skills <name> [args]',
  },
  { name: '/system', description: 'Show the current system prompt sent to the model' },
  { name: '/theme', description: 'Toggle a cosmetic theme note (placeholder)' },
  { name: '/about', description: 'About this CLI' },
  { name: '/gui', description: 'Switch to the GUI app, handing off this conversation' },
  { name: '/exit', description: 'Exit the CLI' },
  { name: '/quit', description: 'Exit the CLI' },
];

export interface SkillCommandDescriptor {
  name: string;
  description: string;
}

/**
 * Completes both direct skill aliases (`/astro-setup`) and the explicit
 * form (`/skills astro-setup`). Built-in commands own their names when a
 * skill collides; the colliding skill remains available through `/skills`.
 */
export function matchCommands(
  input: string,
  skills: SkillCommandDescriptor[] = [],
): SlashCommand[] {
  const skillArgument = input.match(/^\/skills\s+([^\s]*)$/i);
  if (skillArgument) {
    const q = skillArgument[1].toLowerCase();
    return skills
      .filter((skill) => isSlashSafeSkillName(skill.name) && skill.name.toLowerCase().startsWith(q))
      .map((skill) => ({
        name: `/skills ${skill.name}`,
        description: `Skill — ${skill.description}`,
      }));
  }

  // Once an argument has started, regular commands and direct skill aliases
  // are already complete; don't keep an unrelated menu open over free text.
  if (/\s/.test(input)) return [];

  const q = input.toLowerCase();
  const builtIns = SLASH_COMMANDS.filter((command) => command.name.startsWith(q));
  const reserved = new Set(SLASH_COMMANDS.map((command) => command.name.toLowerCase()));
  const skillAliases = skills
    .filter((skill) => {
      const alias = `/${skill.name}`.toLowerCase();
      return isSlashSafeSkillName(skill.name) && !reserved.has(alias) && alias.startsWith(q);
    })
    .map((skill) => ({ name: `/${skill.name}`, description: `Skill — ${skill.description}` }));
  return [...builtIns, ...skillAliases];
}

function isSlashSafeSkillName(name: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(name);
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
