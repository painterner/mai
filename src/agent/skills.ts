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
   * gated it behind an explicit trigger (a slash command, typically) this
   * CLI doesn't implement per-skill, so it's discovered and listable but
   * never offered to the model or served by `load_skill`.
   */
  modelInvocable: boolean;
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
    if (!entry.isDirectory()) continue;
    const skillDir = path.join(dir, entry.name);
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
    skills.push({ ...parsed, dir: skillDir, source });
  }
  return skills;
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
