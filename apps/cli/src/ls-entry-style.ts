import fs from 'node:fs';
import path from 'node:path';

export type LsEntryKind = 'directory' | 'executable' | 'symlink' | 'archive' | 'image' | 'media' | 'file';

const ARCHIVE_EXTENSIONS = new Set([
  '.7z', '.bz2', '.gz', '.rar', '.tar', '.tbz', '.tgz', '.txz', '.xz', '.zip', '.zst',
]);
const IMAGE_EXTENSIONS = new Set([
  '.avif', '.bmp', '.gif', '.ico', '.jpeg', '.jpg', '.png', '.svg', '.tif', '.tiff', '.webp',
]);
const MEDIA_EXTENSIONS = new Set([
  '.aac', '.avi', '.flac', '.m4a', '.mkv', '.mov', '.mp3', '.mp4', '.ogg', '.wav', '.webm',
]);

/** Resolves the directory represented by plain `ls` or `ls <one-directory>`. */
export function resolveLsBaseDirectory(args: string | undefined, cwd: string): string | null {
  if (!args) return null;
  let command: unknown;
  try {
    command = (JSON.parse(args) as { command?: unknown }).command;
  } catch {
    return null;
  }
  if (typeof command !== 'string' || /[|;&><\n\r]/.test(command)) return null;
  const match = /^(?:command\s+)?(?:\S*\/)?ls(?:\s+(.*))?$/.exec(command.trim());
  if (!match) return null;
  const tokens = match[1]?.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const operands = tokens.filter((token) => !token.startsWith('-'));
  if (operands.length > 1) return null;
  const operand = operands[0] ? unquote(operands[0]) : '.';
  return path.resolve(cwd, operand);
}

export function classifyLsEntry(baseDirectory: string | null, entry: string): LsEntryKind {
  const plain = stripAnsi(entry);
  if (baseDirectory) {
    try {
      const stats = fs.lstatSync(path.join(baseDirectory, plain));
      if (stats.isSymbolicLink()) return 'symlink';
      if (stats.isDirectory()) return 'directory';
      if (stats.isFile() && (stats.mode & 0o111) !== 0) return 'executable';
    } catch {
      // The listing may refer to a sandbox-only path. Extension coloring
      // below still gives a useful result without making rendering fail.
    }
  }

  const extension = path.extname(plain).toLowerCase();
  if (ARCHIVE_EXTENSIONS.has(extension)) return 'archive';
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (MEDIA_EXTENSIONS.has(extension)) return 'media';
  return 'file';
}

function unquote(value: string): string {
  return ((value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'")))
    ? value.slice(1, -1)
    : value;
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}
