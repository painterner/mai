import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { classifyTool, type ApprovalRequirement } from './approval.js';
import { runSandboxed } from '../sandbox/sidecar.js';
import type { ToolDeclaration } from '../llm/types.js';

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_OUTPUT_CHARS = 100_000;
const MAX_SEARCH_RESULTS = 100;
const SKIPPED_DIRS = new Set(['.git', 'target', 'node_modules', 'dist', '.mai']);

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
  ) {}

  static async create(
    workspace: string,
    permissions: ToolPermissions,
    sandboxBinary: string | null,
  ): Promise<ToolRegistry> {
    const real = await fs.realpath(workspace).catch(() => {
      throw new Error(`Failed to resolve workspace: ${workspace}`);
    });
    const stat = await fs.stat(real);
    if (!stat.isDirectory()) {
      throw new Error(`Workspace is not a directory: ${workspace}`);
    }
    return new ToolRegistry(real, permissions, sandboxBinary);
  }

  get workspacePath(): string {
    return this.workspace;
  }

  definitions(): ToolDeclaration[] {
    const definitions: ToolDeclaration[] = [
      {
        name: 'list_files',
        description: 'List the direct children of a workspace directory.',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string', default: '.' } },
        },
      },
      {
        name: 'read_file',
        description: 'Read a UTF-8 workspace file with line numbers.',
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
        description: 'Search UTF-8 files below a workspace path for literal text.',
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
          description: 'Create or replace a UTF-8 file inside the workspace.',
          parameters: {
            type: 'object',
            required: ['path', 'content'],
            properties: { path: { type: 'string' }, content: { type: 'string' } },
          },
        },
        {
          name: 'replace_in_file',
          description: 'Replace one exact, uniquely occurring string in a workspace file.',
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
          'Run a shell command in a network-disabled Linux sandbox with workspace-only writes and return its exit status and output.',
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

    return definitions;
  }

  approvalRequirement(tool: string, args: unknown): ApprovalRequirement {
    return classifyTool(tool, args);
  }

  async execute(tool: string, args: unknown): Promise<string> {
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
        return this.runCommand(str(record.command), num(record.timeout_seconds));
      default:
        throw new Error(`Unknown tool: ${tool}`);
    }
  }

  private async listFiles(input: string): Promise<string> {
    const directory = await this.resolveExisting(input);
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
        const relative = path.relative(this.workspace, filePath);
        matches.push(`${relative}:${i + 1}: ${truncate(lines[i].trim(), 300)}`);
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
    const target = await this.resolveExisting(input);
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

  private async runCommand(command: string, timeoutSeconds?: number): Promise<string> {
    if (!this.sandboxBinary) {
      throw new Error(
        'No sandbox binary configured. Build mail-cli-rust with ' +
          '`cargo build --release --bin mai-sandbox`, or set MAI_SANDBOX_BIN.',
      );
    }
    const timeout = Math.min(300, Math.max(1, timeoutSeconds ?? 120));
    const result = await runSandboxed(this.sandboxBinary, this.workspace, command, timeout);
    if (!result.ok) throw new Error(result.error);
    const summary = `exit status: ${result.exitCode ?? 'unknown'}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
    return truncate(summary, MAX_OUTPUT_CHARS);
  }

  // --- path safety -------------------------------------------------------

  private async resolveExisting(input: string): Promise<string> {
    const relative = normalizeRelative(input);
    const candidate = path.join(this.workspace, relative);
    let real: string;
    try {
      real = await fs.realpath(candidate);
    } catch {
      throw new Error(`Workspace path does not exist or cannot be resolved: ${input}`);
    }
    return this.ensureInWorkspace(real);
  }

  private async resolveForWrite(input: string): Promise<string> {
    const relative = normalizeRelative(input);
    const candidate = path.join(this.workspace, relative);

    if (existsSync(candidate)) {
      const real = await fs.realpath(candidate);
      return this.ensureInWorkspace(real);
    }

    let ancestor = candidate;
    while (!existsSync(ancestor)) {
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw new Error('Workspace path has no existing ancestor');
      ancestor = parent;
    }
    const real = await fs.realpath(ancestor);
    this.ensureInWorkspace(real);
    return candidate;
  }

  private ensureInWorkspace(real: string): string {
    if (real === this.workspace || real.startsWith(this.workspace + path.sep)) return real;
    throw new Error(`Path escapes workspace: ${real}`);
  }
}

function normalizeRelative(input: string): string {
  const raw = input.length === 0 ? '.' : input;
  if (path.isAbsolute(raw)) throw new Error(`Absolute paths are not allowed: ${input}`);

  const parts: string[] = [];
  for (const part of raw.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') throw new Error(`Parent or rooted paths are not allowed: ${input}`);
    parts.push(part);
  }
  return parts.join('/');
}

async function readUtf8File(target: string): Promise<string> {
  const buffer = await fs.readFile(target);
  if (buffer.length > MAX_FILE_BYTES) {
    throw new Error(`File is too large (${buffer.length} bytes, limit is ${MAX_FILE_BYTES} bytes)`);
  }
  return buffer.toString('utf8');
}

async function collectFiles(start: string, files: string[]): Promise<void> {
  const stat = await fs.stat(start);
  if (stat.isFile()) {
    files.push(start);
    return;
  }
  const entries = await fs.readdir(start, { withFileTypes: true });
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
