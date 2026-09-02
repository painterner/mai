import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { discoverSkills } from '../src/agent/skills.js';

test('discovers a skill directory linked into the workspace skills folder', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mai-skills-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const workspace = path.join(root, 'workspace');
  const sharedSkill = path.join(root, 'shared', 'astro-setup');
  const skillsDir = path.join(workspace, '.agents', 'skills');
  await fs.mkdir(sharedSkill, { recursive: true });
  await fs.mkdir(skillsDir, { recursive: true });
  await fs.writeFile(
    path.join(sharedSkill, 'SKILL.md'),
    '---\nname: linked-astro\ndescription: Linked fixture\n---\nUse the linked skill.\n',
  );
  await fs.mkdir(path.join(sharedSkill, 'agents'), { recursive: true });
  await fs.writeFile(
    path.join(sharedSkill, 'agents', 'openai.yaml'),
    'interface:\n  display_name: Linked\n\ndependencies:\n  tools:\n    - type: "mcp"\n      value: "linked_server"\n      transport: "stdio"\n',
  );
  await fs.symlink(sharedSkill, path.join(skillsDir, 'astro-setup'));

  const skills = await discoverSkills(workspace);
  const linked = skills.find((skill) => skill.name === 'linked-astro');
  assert.ok(linked);
  assert.equal(linked.source, 'workspace');
  assert.equal(linked.body, 'Use the linked skill.');
  assert.equal(linked.dir, path.join(skillsDir, 'astro-setup'));
  assert.deepEqual(linked.mcpDependencies, ['linked_server']);
});

test('ignores broken skill links and links to ordinary files', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mai-skills-links-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const workspace = path.join(root, 'workspace');
  const skillsDir = path.join(workspace, '.agents', 'skills');
  const regularFile = path.join(root, 'not-a-skill');
  await fs.mkdir(skillsDir, { recursive: true });
  await fs.writeFile(regularFile, 'not a directory');
  await fs.symlink(path.join(root, 'missing'), path.join(skillsDir, 'broken'));
  await fs.symlink(regularFile, path.join(skillsDir, 'file-link'));

  const skills = await discoverSkills(workspace);
  assert.equal(skills.some((skill) => skill.dir.startsWith(skillsDir)), false);
});
