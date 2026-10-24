import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { ToolRegistry } from '../src/agent/tools.js';

test('loads stdio MCP tools, calls them, and namespaces built-in collisions', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mai-mcp-test-'));
  const workspace = path.join(root, 'workspace');
  const agentsDir = path.join(workspace, '.agents');
  await fs.mkdir(agentsDir, { recursive: true });

  // Override the machine's global brave-search skill so this isolated test
  // starts only its explicit fixture server.
  const shadowSkill = path.join(agentsDir, 'skills', 'brave-search');
  await fs.mkdir(shadowSkill, { recursive: true });
  await fs.writeFile(
    path.join(shadowSkill, 'SKILL.md'),
    '---\nname: brave-search\ndescription: Test shadow\n---\nNo MCP dependency.\n',
  );

  const serverFile = fileURLToPath(new URL('./fixtures/mcp-server.mjs', import.meta.url));
  await fs.writeFile(
    path.join(agentsDir, 'mcp.json'),
    JSON.stringify({
      mcpServers: {
        brave_search: {
          command: process.execPath,
          args: [serverFile],
          cwd: workspace,
          env: { MCP_FIXTURE_PREFIX: 'from-config' },
        },
      },
    }),
  );

  const tools = await ToolRegistry.create(workspace, { write: true, shell: false }, null);
  t.after(async () => {
    await tools.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  const definitions = tools.definitions();
  assert.ok(definitions.some((tool) => tool.name === 'fixture_echo'));
  assert.ok(definitions.some((tool) => tool.name === 'brave_search__read_file'));
  const webSearch = definitions.find((tool) => tool.name === 'web_search');
  assert.match(
    String((webSearch?.parameters as { properties?: { freshness?: { description?: string } } })
      .properties?.freshness?.description),
    /P6M/,
  );
  assert.equal(tools.approvalRequirement('fixture_echo', {}).decision, 'allow');
  assert.equal(
    await tools.execute('fixture_echo', { value: 'hello' }),
    'from-config:hello',
  );
  assert.match(
    await tools.execute('web_search', { query: 'recent', freshness: 'P6M' }),
    /^recent:\d{4}-\d{2}-\d{2}to\d{4}-\d{2}-\d{2}$/,
  );
  assert.equal(await tools.execute('web_search', { query: 'today', freshness: 'P1D' }), 'today:pd');
});
