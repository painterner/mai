import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * One discovered skill — a directory containing a SKILL.md: YAML-ish
 * frontmatter (`name`, `description`, optionally `disable-model-invocation`)
 * followed by a Markdown instructions body. Same file shape Claude
 * Code/Codex use for `~/.agents/skills`, so a skill authored for those
 * tools works here unmodified.
 */
export interface Skill {
  name: string;
  description: string;
  body: string;
  /** Absolute path to the skill's own directory (SKILL.md may reference sibling files by relative path). */
  dir: string;
  source: 'global' | 'workspace';
  /**
   * `disable-model-invocation: true` in frontmatter — the skill's author
   * gated it behind an explicit trigger. It remains listable and manually
   * invocable through `/<name>` or `/skills <name>`, but is never offered
   * to the model or served by `load_skill`.
   */
  modelInvocable: boolean;
  /** MCP server names declared under dependencies.tools in agents/openai.yaml. */
  mcpDependencies: string[];
}

const GLOBAL_SKILLS_DIR = path.join(os.homedir(), '.agents', 'skills');

function workspaceSkillsDir(workspace: string): string {
  return path.join(workspace, '.agents', 'skills');
}

/**
 * Discovers skills from `~/.agents/skills` (personal, cross-project) and
 * `<workspace>/.agents/skills` (project-local), merged by `name` with the
 * workspace copy winning on a collision — same "workspace wins, global is
 * the fallback layer" convention `providers.json`/`.env` use elsewhere in
 * this project. A missing directory is not an error, just nothing to load;
 * one malformed skill folder is skipped (with a stderr note) rather than
 * failing startup.
 */
export async function discoverSkills(workspace: string): Promise<Skill[]> {
  const byName = new Map<string, Skill>();
  for (const skill of await scanSkillsDir(GLOBAL_SKILLS_DIR, 'global')) {
    byName.set(skill.name, skill);
  }
  for (const skill of await scanSkillsDir(workspaceSkillsDir(workspace), 'workspace')) {
    byName.set(skill.name, skill);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function scanSkillsDir(dir: string, source: Skill['source']): Promise<Skill[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const skills: Skill[] = [];
  for (const entry of entries) {
    const skillDir = path.join(dir, entry.name);
    if (!entry.isDirectory()) {
      if (!entry.isSymbolicLink()) continue;
      // `Dirent.isDirectory()` is false for a symlink even when its target
      // is a directory. Follow it deliberately so a shared skill library
      // can be linked into ~/.agents/skills, but quietly ignore broken
      // links and links to ordinary files.
      const target = await fs.stat(skillDir).catch(() => null);
      if (!target?.isDirectory()) continue;
    }
    const skillFile = path.join(skillDir, 'SKILL.md');
    let raw: string;
    try {
      raw = await fs.readFile(skillFile, 'utf8');
    } catch {
      continue; // not a skill folder — no SKILL.md, skip quietly
    }
    const parsed = parseSkillFile(raw);
    if (!parsed) {
      process.stderr.write(`Skipping malformed skill (needs name + description frontmatter): ${skillFile}\n`);
      continue;
    }
    const mcpDependencies = await readMcpDependencies(skillDir);
    skills.push({ ...parsed, dir: skillDir, source, mcpDependencies });
  }
  return skills;
}

async function readMcpDependencies(skillDir: string): Promise<string[]> {
  const metadata = await fs.readFile(path.join(skillDir, 'agents', 'openai.yaml'), 'utf8').catch(() => '');
  if (!metadata) return [];

  // Parse only the small dependency surface we own here, without claiming
  // to be a general YAML parser. Each list item is collected as flat
  // key/value fields, then MCP entries contribute their `value` (server id).
  const dependencies: string[] = [];
  let inDependencies = false;
  let inTools = false;
  let item: Record<string, string> | null = null;
  const flush = () => {
    if (item?.type === 'mcp' && item.value) dependencies.push(item.value);
    item = null;
  };

  for (const line of metadata.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();
    if (indent === 0) {
      flush();
      inDependencies = trimmed === 'dependencies:';
      inTools = false;
      continue;
    }
    if (!inDependencies) continue;
    if (indent === 2) {
      flush();
      inTools = trimmed === 'tools:';
      continue;
    }
    if (!inTools || indent < 4) continue;
    if (trimmed.startsWith('-')) {
      flush();
      item = {};
      parseMetadataField(trimmed.slice(1).trim(), item);
    } else if (item) {
      parseMetadataField(trimmed, item);
    }
  }
  flush();
  return [...new Set(dependencies)];
}

function parseMetadataField(text: string, target: Record<string, string>): void {
  const match = text.match(/^([A-Za-z0-9_-]+):\s*(.*?)\s*$/);
  if (!match) return;
  target[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
}

function parseSkillFile(
  raw: string,
): { name: string; description: string; body: string; modelInvocable: boolean } | null {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return null;
  const [, frontmatter, body] = match;

  const fields = parseFrontmatter(frontmatter);
  const name = fields.name;
  const description = fields.description;
  if (typeof name !== 'string' || !name || typeof description !== 'string' || !description) return null;

  return {
    name,
    description,
    body: body.trim(),
    modelInvocable: fields['disable-model-invocation'] !== true,
  };
}

/**
 * Deliberately minimal YAML-subset parser — no dependency, just enough for
 * the shapes real SKILL.md frontmatter actually uses: flat `key: value`
 * scalars, quoted strings, `true`/`false`, and folded (`>`) or literal (`|`)
 * block scalars for a multi-line `description`. Nested maps/lists (e.g. a
 * `metadata:`/`references:` block) are encountered but not parsed into
 * anything — harmless, since only `name`/`description`/
 * `disable-model-invocation` are read here.
 */
function parseFrontmatter(text: string): Record<string, string | boolean> {
  const lines = text.split(/\r?\n/);
  const fields: Record<string, string | boolean> = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) {
      i++;
      continue;
    }
    const key = m[1];
    const rawValue = m[2].trim();
    i++;

    if (rawValue === '>' || rawValue === '>-' || rawValue === '>+' || rawValue === '|' || rawValue === '|-' || rawValue === '|+') {
      const folded = rawValue[0] === '>';
      const blockLines: string[] = [];
      let indent: number | null = null;
      while (i < lines.length) {
        const l = lines[i];
        if (l.trim() === '') {
          blockLines.push('');
          i++;
          continue;
        }
        const lineIndent = l.match(/^ */)?.[0].length ?? 0;
        if (indent === null) indent = lineIndent;
        if (lineIndent < indent) break;
        blockLines.push(l.slice(indent));
        i++;
      }
      while (blockLines.length && blockLines[blockLines.length - 1] === '') blockLines.pop();
      fields[key] = folded ? blockLines.join(' ').replace(/\s+/g, ' ').trim() : blockLines.join('\n');
      continue;
    }

    const unquoted = rawValue.replace(/^["']|["']$/g, '');
    fields[key] = unquoted === 'true' ? true : unquoted === 'false' ? false : unquoted;
  }
  return fields;
}

/** One line per model-invocable skill, shown in the system prompt. */
export function formatSkillCatalog(skills: Skill[]): string {
  const invocable = skills.filter((s) => s.modelInvocable);
  if (!invocable.length) return '';
  return invocable.map((s) => `- ${s.name}: ${s.description}`).join('\n');
}
