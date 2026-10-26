import type { SlashCommand } from './types.js';

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: '/help', description: 'Show available commands' },
  { name: '/clear', description: 'Clear the active conversation while keeping its session' },
  { name: '/new', description: 'Create and switch to a new persistent session' },
  { name: '/sessions', description: 'List recent persistent sessions for this workspace' },
  { name: '/resume', description: 'Pick a recent session, or use /resume <session-id>' },
  {
    name: '/model',
    description: 'Pick interactively, or use /model <model> [provider] for direct switching',
  },
  {
    name: '/login',
    description: 'Manage OpenAI login: browser, device, API key, access token, reuse, or status',
  },
  { name: '/logout', description: 'Remove the file-backed Codex/OpenAI login' },
  { name: '/approval', description: 'Set tool mode: auto, safe, or manual' },
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
  const approvalArgument = input.match(/^\/approval\s+([^\s]*)$/i);
  if (approvalArgument) {
    const query = approvalArgument[1].toLowerCase();
    return [
      { name: '/approval auto', description: 'Run all tool calls without approval prompts' },
      { name: '/approval safe', description: 'Use risk rules and ask for review-classified calls' },
      { name: '/approval manual', description: 'Ask before every non-forbidden tool call' },
    ].filter((command) => command.name.slice('/approval '.length).startsWith(query));
  }

  const loginArgument = input.match(/^\/login\s+([^\s]*)$/i);
  if (loginArgument) {
    const query = loginArgument[1].toLowerCase();
    return [
      { name: '/login status', description: 'Show the current Codex/OpenAI login' },
      { name: '/login browser', description: 'Sign in with ChatGPT in a browser' },
      { name: '/login device', description: 'Sign in with a device code (headless friendly)' },
      { name: '/login api-key', description: 'Read OPENAI_API_KEY securely from the environment' },
      { name: '/login access-token', description: 'Read CODEX_ACCESS_TOKEN securely from the environment' },
      { name: '/login reuse', description: 'Reuse and refresh the existing Codex login' },
    ].filter((command) => command.name.slice('/login '.length).startsWith(query));
  }

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

export type ResumeCommandRequest =
  | { kind: 'picker' }
  | { kind: 'resume'; sessionId: string }
  | { kind: 'error'; message: string };

export function parseResumeCommandArgs(args: string[]): ResumeCommandRequest {
  if (args.length === 0) return { kind: 'picker' };
  if (args.length === 1) return { kind: 'resume', sessionId: args[0] };
  return { kind: 'error', message: 'Usage: /resume [session-id]' };
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

export type ApprovalCommandRequest =
  | { kind: 'show' }
  | { kind: 'set'; mode: 'auto' | 'safe' | 'manual' }
  | { kind: 'error'; message: string };

export function parseApprovalCommandArgs(args: string[]): ApprovalCommandRequest {
  if (args.length === 0) return { kind: 'show' };
  const mode = args[0]?.toLowerCase();
  if (args.length === 1 && (mode === 'auto' || mode === 'safe' || mode === 'manual')) {
    return { kind: 'set', mode };
  }
  return { kind: 'error', message: 'Usage: /approval [auto|safe|manual]' };
}

export type LoginCommandRequest =
  | { kind: 'show' }
  | { kind: 'status' }
  | { kind: 'login'; method: 'browser' | 'device' | 'api-key' | 'access-token' | 'reuse' }
  | { kind: 'error'; message: string };

export function parseLoginCommandArgs(args: string[]): LoginCommandRequest {
  if (args.length === 0) return { kind: 'show' };
  const method = args[0]?.toLowerCase();
  if (args.length !== 1) {
    return { kind: 'error', message: 'Usage: /login [status|browser|device|api-key|access-token|reuse]' };
  }
  if (method === 'status') return { kind: 'status' };
  if (method === 'browser' || method === 'device' || method === 'api-key' || method === 'access-token' || method === 'reuse') {
    return { kind: 'login', method };
  }
  return { kind: 'error', message: 'Usage: /login [status|browser|device|api-key|access-token|reuse]' };
}
