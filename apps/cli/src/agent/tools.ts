import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { classifyTool, type ApprovalRequirement } from './approval.js';
import { discoverSkills, formatSkillCatalog, type Skill } from './skills.js';
import { McpRegistry } from './mcp.js';
import { runSandboxed } from '../sandbox/sidecar.js';
import type { ToolDeclaration } from '../llm/types.js';

export type { Skill } from './skills.js';

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_OUTPUT_CHARS = 100_000;
const MAX_SEARCH_RESULTS = 100;
const SKIPPED_DIRS = new Set(['.git', 'target', 'node_modules', 'dist', '.mai', '.agents']);
const SENSITIVE_DIRS = new Set([
  '.ssh', '.gnupg', '.aws', '.kube', '.docker', '.azure', '.terraform.d', 'gcloud', 'auth.conf.d',
]);
const SENSITIVE_FILES = new Set([
  '.env', '.npmrc', '.netrc', 'credentials', 'credentials.json', 'auth.conf',
  'shadow', 'gshadow', 'environ', 'cmdline',
]);

export type { ToolDeclaration };

export interface ToolPermissions {
  write: boolean;
  shell: boolean;
}

export class ToolRegistry {
  private constructor(
    private readonly workspace: string,
    private readonly permissions: ToolPermissions,
    private readonly sandboxBinary: string | null,
    private readonly skills: Skill[],
    private readonly mcp: McpRegistry | null,
    private readonly ownsMcp: boolean,
  ) {}

  static async create(
    workspace: string,
    permissions: ToolPermissions,
    sandboxBinary: string | null,
    options: { mcp?: boolean } = {},
  ): Promise<ToolRegistry> {
    const real = await fs.realpath(workspace).catch(() => {
      throw new Error(`Failed to resolve workspace: ${workspace}`);
    });
    const stat = await fs.stat(real);
    if (!stat.isDirectory()) {
      throw new Error(`Workspace is not a directory: ${workspace}`);
    }
    const skills = await discoverSkills(real);
    const mcp = options.mcp === false ? null : await McpRegistry.create(real, skills);
    return new ToolRegistry(real, permissions, sandboxBinary, skills, mcp, true);
  }

  async refresh(permissions: ToolPermissions = this.permissions): Promise<ToolRegistry> {
    const skills = await discoverSkills(this.workspace);
    return new ToolRegistry(this.workspace, permissions, this.sandboxBinary, skills, this.mcp, false);
  }

  async close(): Promise<void> {
    if (this.ownsMcp) await this.mcp?.close();
  }

  get workspacePath(): string {
    return this.workspace;
  }

  /** Every skill found under `~/.agents/skills` and `<workspace>/.agents/skills`, for `/skills`. */
  get skillList(): Skill[] {
    return this.skills;
  }

  /** Formatted "- name: description" catalog of model-invocable skills, for the system prompt. */
  get skillCatalog(): string {
    return formatSkillCatalog(this.skills);
  }

  get mcpIssues() {
    return this.mcp?.issues ?? [];
  }

  definitions(): ToolDeclaration[] {
    const definitions: ToolDeclaration[] = [
      {
        name: 'list_files',
        description: 'List the direct children of a readable directory. Accepts absolute paths.',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string', default: '.' } },
        },
      },
      {
        name: 'read_file',
        description: 'Read a UTF-8 file with line numbers. Accepts absolute paths; credential paths are blocked.',
        parameters: {
          type: 'object',
          required: ['path'],
          properties: {
            path: { type: 'string' },
            start_line: { type: 'integer', minimum: 1 },
            end_line: { type: 'integer', minimum: 1 },
          },
        },
      },
      {
        name: 'search_files',
        description: 'Search UTF-8 files below a readable path for literal text. Accepts absolute paths.',
        parameters: {
          type: 'object',
          required: ['query'],
          properties: {
            query: { type: 'string' },
            path: { type: 'string', default: '.' },
            case_sensitive: { type: 'boolean', default: false },
          },
        },
      },
    ];

    if (this.permissions.write) {
      definitions.push(
        {
          name: 'write_file',
          description: 'Create or replace a UTF-8 file inside the workspace; absolute workspace paths are accepted.',
          parameters: {
            type: 'object',
            required: ['path', 'content'],
            properties: { path: { type: 'string' }, content: { type: 'string' } },
          },
        },
        {
          name: 'replace_in_file',
          description: 'Replace one exact, uniquely occurring string in a workspace file; absolute workspace paths are accepted.',
          parameters: {
            type: 'object',
            required: ['path', 'old', 'new'],
            properties: {
              path: { type: 'string' },
              old: { type: 'string' },
              new: { type: 'string' },
            },
          },
        },
      );
    }

    if (this.permissions.shell) {
      definitions.push({
        name: 'run_command',
        description:
          'Run a shell command with network access in a Linux sandbox with workspace-only writes and return its exit status and output.',
        parameters: {
          type: 'object',
          required: ['command'],
          properties: {
            command: { type: 'string' },
            timeout_seconds: { type: 'integer', minimum: 1, maximum: 300 },
          },
        },
      });
    }

    if (this.skills.some((s) => s.modelInvocable)) {
      definitions.push({
        name: 'load_skill',
        description:
          'Load the full instructions for a skill listed in the system prompt, by its exact name. ' +
          'Call this before following a skill — the system prompt only has its one-line description.',
        parameters: {
          type: 'object',
          required: ['name'],
          properties: { name: { type: 'string' } },
        },
      });
    }

    definitions.push(...(this.mcp?.definitions() ?? []));
    return definitions;
  }

  approvalRequirement(tool: string, args: unknown): ApprovalRequirement {
    if (this.mcp?.has(tool)) return this.mcp.approvalRequirement(tool);
    return classifyTool(tool, args);
  }

  async execute(tool: string, args: unknown, signal?: AbortSignal): Promise<string> {
    const record = (args ?? {}) as Record<string, unknown>;
    switch (tool) {
      case 'list_files':
        return this.listFiles(str(record.path, '.'));
      case 'read_file':
        return this.readFile(str(record.path), num(record.start_line), num(record.end_line));
      case 'search_files':
        return this.searchFiles(
          str(record.query),
          str(record.path, '.'),
          Boolean(record.case_sensitive),
        );
      case 'write_file':
        if (!this.permissions.write) throw new Error('Workspace writes are disabled');
        return this.writeFile(str(record.path), str(record.content));
      case 'replace_in_file':
        if (!this.permissions.write) throw new Error('Workspace writes are disabled');
        return this.replaceInFile(str(record.path), str(record.old), str(record.new));
      case 'run_command':
        if (!this.permissions.shell) throw new Error('Shell execution is disabled');
        return this.runCommand(str(record.command), num(record.timeout_seconds), signal);
      case 'load_skill':
        return this.loadSkill(str(record.name));
      default:
        if (this.mcp?.has(tool)) return this.mcp.execute(tool, record, signal);
        throw new Error(`Unknown tool: ${tool}`);
    }
  }

  private loadSkill(name: string): string {
    const skill = this.skills.find((s) => s.name === name);
    if (!skill || !skill.modelInvocable) {
      const available = this.skills.filter((s) => s.modelInvocable).map((s) => s.name);
      throw new Error(
        `No model-invocable skill named "${name}". Available: ${available.length ? available.join(', ') : '(none)'}`,
      );
    }
    return skill.body;
  }

  private async listFiles(input: string): Promise<string> {
    const directory = await this.resolveExisting(input);
    ensureReadable(directory);
    const stat = await fs.stat(directory);
    if (!stat.isDirectory()) throw new Error(`Not a directory: ${input}`);

    const entries = await fs.readdir(directory, { withFileTypes: true });
    const names = entries
      .map((entry) => entry.name + (entry.isDirectory() ? '/' : ''))
      .sort((a, b) => a.localeCompare(b));
    return names.length ? names.join('\n') : '(empty directory)';
  }

  private async readFile(input: string, startLine?: number, endLine?: number): Promise<string> {
    const target = await this.resolveExisting(input);
    ensureReadable(target);
    const stat = await fs.stat(target);
    if (!stat.isFile()) throw new Error(`Not a file: ${input}`);

    const content = await readUtf8File(target);
    const lines = content.split('\n');
    const start = startLine ?? 1;
    const end = endLine ?? start + 399;
    if (start === 0 || end < start) throw new Error(`Invalid line range: ${start}..${end}`);

    const output = lines
      .slice(start - 1, end)
      .map((line, i) => `${start + i}: ${line}`)
      .join('\n');
    return output.length ? output : '(no lines in requested range)';
  }

  private async searchFiles(query: string, input: string, caseSensitive: boolean): Promise<string> {
    if (!query) throw new Error('Search query cannot be empty');
    const start = await this.resolveExisting(input);
    ensureReadable(start);

    const files: string[] = [];
    await collectFiles(start, files);
    files.sort((a, b) => a.localeCompare(b));

    const needle = caseSensitive ? query : query.toLowerCase();
    const matches: string[] = [];
    for (const filePath of files) {
      const stat = await fs.stat(filePath).catch(() => null);
      if (!stat || stat.size > MAX_FILE_BYTES) continue;
      const content = await fs.readFile(filePath, 'utf8').catch(() => null);
      if (content === null) continue;

      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const haystack = caseSensitive ? lines[i] : lines[i].toLowerCase();
        if (!haystack.includes(needle)) continue;
        const display = this.isInWorkspace(filePath) ? path.relative(this.workspace, filePath) : filePath;
        matches.push(`${display}:${i + 1}: ${truncate(lines[i].trim(), 300)}`);
        if (matches.length === MAX_SEARCH_RESULTS) {
          return `${matches.join('\n')}\n(result limit reached)`;
        }
      }
    }
    return matches.length ? matches.join('\n') : '(no matches)';
  }

  private async writeFile(input: string, content: string): Promise<string> {
    const target = await this.resolveForWrite(input);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, 'utf8');
    return `Wrote ${Buffer.byteLength(content, 'utf8')} bytes to ${input}`;
  }

  private async replaceInFile(input: string, oldText: string, newText: string): Promise<string> {
    if (!oldText) throw new Error('Replacement target cannot be empty');
    const target = this.ensureInWorkspace(await this.resolveExisting(input));
    const content = await readUtf8File(target);
    const occurrences = countOccurrences(content, oldText);
    if (occurrences !== 1) {
      throw new Error(
        `Expected replacement target to occur exactly once, found ${occurrences} occurrences`,
      );
    }
    const updated = content.replace(oldText, newText);
    await fs.writeFile(target, updated, 'utf8');
    return `Updated ${input}`;
  }

  private async runCommand(command: string, timeoutSeconds?: number, signal?: AbortSignal): Promise<string> {
    if (!this.sandboxBinary) {
      throw new Error(
        'No sandbox binary configured. Build mail-cli-rust with ' +
          '`cargo build --release --bin mai-sandbox`, or set MAI_SANDBOX_BIN.',
      );
    }
    const timeout = Math.min(300, Math.max(1, timeoutSeconds ?? 120));
    const result = await runSandboxed(this.sandboxBinary, this.workspace, command, timeout, signal);
    if (!result.ok) throw new Error(result.error);
    const summary = `exit status: ${result.exitCode ?? 'unknown'}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
    return truncate(summary, MAX_OUTPUT_CHARS);
  }

  // --- path safety -------------------------------------------------------

  private async resolveExisting(input: string): Promise<string> {
    const candidate = resolveInputPath(this.workspace, input);
    let real: string;
    try {
      real = await fs.realpath(candidate);
    } catch {
      throw new Error(`Path does not exist or cannot be resolved: ${input}`);
    }
    return real;
  }

  private async resolveForWrite(input: string): Promise<string> {
    const candidate = resolveInputPath(this.workspace, input);

    if (existsSync(candidate)) {
      const real = await fs.realpath(candidate);
      return this.ensureInWorkspace(real);
    }

    let ancestor = candidate;
    while (!existsSync(ancestor)) {
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw new Error('Write path has no existing ancestor');
      ancestor = parent;
    }
    const real = await fs.realpath(ancestor);
    this.ensureInWorkspace(real);
    return candidate;
  }

  private ensureInWorkspace(real: string): string {
    if (this.isInWorkspace(real)) return real;
    throw new Error(`Writes outside the workspace are not allowed: ${real}`);
  }

  private isInWorkspace(real: string): boolean {
    return real === this.workspace || real.startsWith(this.workspace + path.sep);
  }
}

function resolveInputPath(workspace: string, input: string): string {
  const raw = input.length === 0 ? '.' : input;
  return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(workspace, raw);
}

function ensureReadable(target: string): void {
  if (isSensitivePath(target)) {
    throw new Error(`Reading credential, secret, or process-environment paths is not allowed: ${target}`);
  }
}

function isSensitivePath(target: string): boolean {
  const parts = path.resolve(target).split(path.sep).filter(Boolean).map((part) => part.toLowerCase());
  const base = parts.at(-1) ?? '';
  return parts.some((part) => SENSITIVE_DIRS.has(part))
    || SENSITIVE_FILES.has(base)
    || base.startsWith('.env.')
    || base.endsWith('_rsa')
    || base.endsWith('_dsa')
    || base.endsWith('_ecdsa')
    || base.endsWith('_ed25519');
}

async function readUtf8File(target: string): Promise<string> {
  const buffer = await fs.readFile(target);
  if (buffer.length > MAX_FILE_BYTES) {
    throw new Error(`File is too large (${buffer.length} bytes, limit is ${MAX_FILE_BYTES} bytes)`);
  }
  return buffer.toString('utf8');
}

async function collectFiles(start: string, files: string[]): Promise<void> {
  if (isSensitivePath(start)) return;
  const stat = await fs.stat(start).catch(() => null);
  if (!stat) return;
  if (stat.isFile()) {
    files.push(start);
    return;
  }
  const entries = await fs.readdir(start, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) {
        await collectFiles(path.join(start, entry.name), files);
      }
    } else if (entry.isFile()) {
      files.push(path.join(start, entry.name));
    }
  }
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  for (;;) {
    const found = haystack.indexOf(needle, index);
    if (found === -1) break;
    count += 1;
    index = found + needle.length;
  }
  return count;
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n(output truncated)`;
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}
