import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_DIRECT_FILE_BYTES = 10 * 1024 * 1024;

export class WorkspaceFiles {
  private constructor(readonly root: string) {}

  static async create(workspace: string): Promise<WorkspaceFiles> {
    const root = await fs.realpath(workspace);
    const stat = await fs.stat(root);
    if (!stat.isDirectory()) throw new Error(`Workspace is not a directory: ${workspace}`);
    return new WorkspaceFiles(root);
  }

  async list(input = '.'): Promise<Record<string, unknown>[]> {
    const directory = await this.resolveExisting(input);
    const stat = await fs.stat(directory);
    if (!stat.isDirectory()) throw new FileInputError(`Not a directory: ${input}`);
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const rows = await Promise.all(
      entries.map(async (entry) => {
        const relative = path.posix.join(normalizeRelative(input), entry.name).replace(/^\.\//, '');
        const info = await fs.stat(path.join(directory, entry.name));
        return {
          name: entry.name,
          path: relative || '.',
          type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
          size: info.size,
          modifiedAt: info.mtime.toISOString(),
        };
      }),
    );
    return rows.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }

  async read(input: string): Promise<Record<string, unknown>> {
    const target = await this.resolveExisting(input);
    const stat = await fs.stat(target);
    if (!stat.isFile()) throw new FileInputError(`Not a file: ${input}`);
    if (stat.size > MAX_DIRECT_FILE_BYTES) {
      throw new FileTooLargeError(`File exceeds the ${MAX_DIRECT_FILE_BYTES}-byte direct-read limit.`);
    }
    const content = await fs.readFile(target);
    const utf8 = isUtf8(content);
    return {
      path: normalizeRelative(input),
      size: content.length,
      modifiedAt: stat.mtime.toISOString(),
      encoding: utf8 ? 'utf8' : 'base64',
      content: utf8 ? content.toString('utf8') : content.toString('base64'),
    };
  }

  async write(input: string, content: string, encoding: 'utf8' | 'base64'): Promise<Record<string, unknown>> {
    const buffer = Buffer.from(content, encoding);
    if (buffer.length > MAX_DIRECT_FILE_BYTES) {
      throw new FileTooLargeError(`File exceeds the ${MAX_DIRECT_FILE_BYTES}-byte direct-write limit.`);
    }
    const target = await this.resolveForWrite(input);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, buffer);
    const stat = await fs.stat(target);
    return {
      path: normalizeRelative(input),
      size: stat.size,
      modifiedAt: stat.mtime.toISOString(),
    };
  }

  private async resolveExisting(input: string): Promise<string> {
    const relative = normalizeRelative(input);
    assertDirectAccessAllowed(relative);
    const candidate = path.join(this.root, relative);
    let real: string;
    try {
      real = await fs.realpath(candidate);
    } catch {
      throw new FileNotFoundError(`Workspace path does not exist: ${input}`);
    }
    return this.ensureInside(real);
  }

  private async resolveForWrite(input: string): Promise<string> {
    const relative = normalizeRelative(input);
    assertDirectAccessAllowed(relative);
    if (relative === '.') throw new FileInputError('A file path is required.');
    const candidate = path.join(this.root, relative);
    if (existsSync(candidate)) return this.ensureInside(await fs.realpath(candidate));
    let ancestor = path.dirname(candidate);
    while (!existsSync(ancestor)) ancestor = path.dirname(ancestor);
    this.ensureInside(await fs.realpath(ancestor));
    return candidate;
  }

  private ensureInside(real: string): string {
    if (real === this.root || real.startsWith(`${this.root}${path.sep}`)) return real;
    throw new FileInputError(`Path escapes workspace: ${real}`);
  }
}

function assertDirectAccessAllowed(relative: string): void {
  const parts = relative.toLowerCase().split('/');
  if (parts.some((part) => ['.env', '.ssh', '.aws', '.gnupg', '.codex'].includes(part))) {
    throw new FileInputError('Direct API access to credential or protected agent paths is forbidden.');
  }
  if (relative.toLowerCase().startsWith('.mai/api.sqlite')) {
    throw new FileInputError('The Agent Gateway state database cannot be accessed through the file API.');
  }
}

function normalizeRelative(input: string): string {
  const raw = input.trim() || '.';
  if (path.isAbsolute(raw)) throw new FileInputError('Absolute paths are not allowed.');
  const parts: string[] = [];
  for (const part of raw.replaceAll('\\', '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') throw new FileInputError('Parent paths are not allowed.');
    parts.push(part);
  }
  return parts.join('/') || '.';
}

function isUtf8(buffer: Buffer): boolean {
  return Buffer.from(buffer.toString('utf8'), 'utf8').equals(buffer) && !buffer.includes(0);
}

export class FileNotFoundError extends Error {}
export class FileInputError extends Error {}
export class FileTooLargeError extends Error {}
