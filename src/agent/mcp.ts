import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';

import type { ApprovalRequirement } from './approval.js';
import type { Skill } from './skills.js';
import type { ToolDeclaration } from '../llm/types.js';

const MAX_MCP_OUTPUT_CHARS = 100_000;
const MCP_START_TIMEOUT_MS = 15_000;
const MCP_CALL_TIMEOUT_MS = 120_000;
const TOOL_NAME_LIMIT = 64;

const RESERVED_TOOL_NAMES = new Set([
  'list_files',
  'read_file',
  'search_files',
  'write_file',
  'replace_in_file',
  'run_command',
  'load_skill',
]);

interface McpServerConfig {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  enabled?: boolean;
}

interface ResolvedMcpServerConfig extends McpServerConfig {
  name: string;
}

interface McpTool {
  exposedName: string;
  originalName: string;
  serverName: string;
  description?: string;
  inputSchema: object;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    openWorldHint?: boolean;
  };
  client: Client;
}

interface McpConnection {
  name: string;
  client: Client;
  transport: StdioClientTransport;
}

export interface McpServerIssue {
  server: string;
  message: string;
}

/** A process-local collection of stdio MCP servers and their exposed tools. */
export class McpRegistry {
  private readonly connections: McpConnection[] = [];
  private readonly tools = new Map<string, McpTool>();
  readonly issues: McpServerIssue[] = [];

  private constructor() {}

  static async create(workspace: string, skills: Skill[]): Promise<McpRegistry> {
    const registry = new McpRegistry();
    const configs = await discoverMcpServers(workspace, skills);
    await Promise.all(configs.map((config) => registry.connect(config)));
    return registry;
  }

  definitions(): ToolDeclaration[] {
    return [...this.tools.values()].map((tool) => ({
      name: tool.exposedName,
      description: `[MCP: ${tool.serverName}] ${tool.description ?? tool.originalName}`,
      parameters: exposedInputSchema(tool),
    }));
  }

  has(toolName: string): boolean {
    return this.tools.has(toolName);
  }

  approvalRequirement(toolName: string): ApprovalRequirement {
    const tool = this.tools.get(toolName);
    if (!tool) {
      return { decision: 'forbidden', risk: 'critical', reason: `Unknown MCP tool: ${toolName}` };
    }
    if (tool.annotations?.readOnlyHint && !tool.annotations.destructiveHint) {
      return { decision: 'allow', risk: 'low', reason: `Read-only MCP tool from ${tool.serverName}` };
    }
    return {
      decision: 'review',
      risk: tool.annotations?.destructiveHint ? 'high' : 'medium',
      reason: `MCP tool from ${tool.serverName} may perform external actions`,
    };
  }

  async execute(toolName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const tool = this.tools.get(toolName);
    if (!tool) throw new Error(`Unknown MCP tool: ${toolName}`);
    const normalizedArgs = normalizeMcpArguments(tool, args);
    const result = await tool.client.callTool(
      { name: tool.originalName, arguments: normalizedArgs },
      undefined,
      { signal, timeout: MCP_CALL_TIMEOUT_MS, maxTotalTimeout: MCP_CALL_TIMEOUT_MS },
    );
    const output = formatMcpResult(result as Record<string, unknown>);
    if (result.isError) throw new Error(output || `${tool.serverName}.${tool.originalName} failed`);
    return truncate(output || '(MCP tool returned no content)', MAX_MCP_OUTPUT_CHARS);
  }

  async close(): Promise<void> {
    const connections = this.connections.splice(0);
    this.tools.clear();
    await Promise.allSettled(connections.map(({ client }) => client.close()));
  }

  private async connect(config: ResolvedMcpServerConfig): Promise<void> {
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      cwd: config.cwd,
      env: config.env
        ? { ...getDefaultEnvironment(), ...resolveEnvironment(config.env) }
        : undefined,
      stderr: 'pipe',
    });
    transport.stderr?.on('data', (chunk) => {
      const message = String(chunk).trim();
      if (message) process.stderr.write(`[mcp:${config.name}] ${message}\n`);
    });
    const client = new Client({ name: 'mai-cli', version: '0.1.0' });
    try {
      await client.connect(transport, { timeout: MCP_START_TIMEOUT_MS });
      const listed = await client.listTools(undefined, { timeout: MCP_START_TIMEOUT_MS });
      this.connections.push({ name: config.name, client, transport });
      for (const tool of listed.tools) this.registerTool(config.name, client, tool);
    } catch (error) {
      await client.close().catch(() => {});
      const message = error instanceof Error ? error.message : String(error);
      this.issues.push({ server: config.name, message });
      process.stderr.write(`[mcp:${config.name}] unavailable: ${message}\n`);
    }
  }

  private registerTool(
    serverName: string,
    client: Client,
    tool: {
      name: string;
      description?: string;
      inputSchema: object;
      annotations?: McpTool['annotations'];
    },
  ): void {
    const exposedName = uniqueToolName(tool.name, serverName, this.tools);
    this.tools.set(exposedName, {
      exposedName,
      originalName: tool.name,
      serverName,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
      client,
    });
  }
}

/**
 * Some MCP servers validate values more narrowly than their generated JSON
 * schema can express. Brave's Zod refinement, for example, is exposed to the
 * model as a plain string, so models commonly send ISO durations such as P6M
 * even though the API expects a shortcut or explicit date range.
 */
function exposedInputSchema(tool: McpTool): object {
  if (!isBraveWebSearch(tool)) return tool.inputSchema;
  const schema = tool.inputSchema as Record<string, unknown>;
  const properties = schema.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
    return tool.inputSchema;
  }
  const freshness = (properties as Record<string, unknown>).freshness;
  if (!freshness || typeof freshness !== 'object' || Array.isArray(freshness)) {
    return tool.inputSchema;
  }
  return {
    ...schema,
    properties: {
      ...(properties as Record<string, unknown>),
      freshness: {
        ...(freshness as Record<string, unknown>),
        description:
          'Optional result age: pd (day), pw (week), pm (month), py (year), ' +
          'YYYY-MM-DDtoYYYY-MM-DD, or an ISO date duration such as P6M.',
      },
    },
  };
}

function normalizeMcpArguments(
  tool: McpTool,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (!isBraveWebSearch(tool) || typeof args.freshness !== 'string') return args;
  const freshness = isoDurationToBraveFreshness(args.freshness);
  return freshness === args.freshness ? args : { ...args, freshness };
}

function isBraveWebSearch(tool: McpTool): boolean {
  return tool.originalName === 'web_search' &&
    (tool.serverName === 'brave_search' || /brave/i.test(tool.description ?? ''));
}

function isoDurationToBraveFreshness(value: string, now = new Date()): string {
  const match = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?$/i.exec(value);
  if (!match || !match.slice(1).some(Boolean)) return value;
  const years = Number(match[1] ?? 0);
  const months = Number(match[2] ?? 0);
  const weeks = Number(match[3] ?? 0);
  const days = Number(match[4] ?? 0);

  if (years === 0 && months === 0 && weeks === 0 && days === 1) return 'pd';
  if (years === 0 && months === 0 && ((weeks === 1 && days === 0) || (weeks === 0 && days === 7))) return 'pw';
  if (years === 0 && months === 1 && weeks === 0 && days === 0) return 'pm';
  if (years === 1 && months === 0 && weeks === 0 && days === 0) return 'py';

  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const targetYear = end.getUTCFullYear() - years;
  const targetMonth = end.getUTCMonth() - months;
  const start = new Date(Date.UTC(targetYear, targetMonth, 1));
  const lastDay = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate();
  start.setUTCDate(Math.min(end.getUTCDate(), lastDay));
  start.setUTCDate(start.getUTCDate() - weeks * 7 - days);
  return `${formatUtcDate(start)}to${formatUtcDate(end)}`;
}

function formatUtcDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

async function discoverMcpServers(
  workspace: string,
  skills: Skill[],
): Promise<ResolvedMcpServerConfig[]> {
  const configured = new Map<string, ResolvedMcpServerConfig>();
  for (const configPath of [
    path.join(os.homedir(), '.agents', 'mcp.json'),
    path.join(workspace, '.agents', 'mcp.json'),
  ]) {
    for (const server of await readMcpConfig(configPath)) configured.set(server.name, server);
  }

  // A self-contained Skill can declare an MCP dependency in
  // agents/openai.yaml and provide scripts/serve.sh. Explicit mcp.json
  // configuration wins when present.
  for (const skill of skills) {
    for (const serverName of skill.mcpDependencies) {
      if (configured.has(serverName)) continue;
      const launcher = path.join(skill.dir, 'scripts', 'serve.sh');
      const stat = await fs.stat(launcher).catch(() => null);
      if (!stat?.isFile()) continue;
      configured.set(serverName, {
        name: serverName,
        // Do not require the shared Skill's launcher to carry an executable
        // bit (it may live on a filesystem/archive that drops modes).
        command: process.platform === 'win32' ? 'bash.exe' : 'bash',
        args: [launcher],
        cwd: skill.dir,
      });
    }
  }

  return [...configured.values()]
    .filter((server) => server.enabled !== false)
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function readMcpConfig(configPath: string): Promise<ResolvedMcpServerConfig[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(configPath, 'utf8'));
  } catch {
    return [];
  }
  const servers = (parsed as { mcpServers?: unknown })?.mcpServers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return [];
  const base = path.dirname(configPath);
  const output: ResolvedMcpServerConfig[] = [];
  for (const [name, raw] of Object.entries(servers as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const value = raw as Record<string, unknown>;
    if (typeof value.command !== 'string' || !value.command.trim()) continue;
    output.push({
      name,
      command: expandCommand(value.command, base),
      args: Array.isArray(value.args)
        ? value.args.filter((arg): arg is string => typeof arg === 'string').map((arg) => expandValue(arg))
        : [],
      cwd: typeof value.cwd === 'string' ? expandPath(value.cwd, base) : base,
      env: stringRecord(value.env),
      enabled: value.enabled !== false,
    });
  }
  return output;
}

function uniqueToolName(original: string, server: string, existing: Map<string, McpTool>): string {
  const direct = sanitizeToolName(original);
  if (direct && !RESERVED_TOOL_NAMES.has(direct) && !existing.has(direct)) return direct;
  const prefix = sanitizeToolName(server) || 'mcp';
  const suffix = direct || 'tool';
  const base = `${prefix}__${suffix}`.slice(0, TOOL_NAME_LIMIT);
  let candidate = base;
  let counter = 2;
  while (RESERVED_TOOL_NAMES.has(candidate) || existing.has(candidate)) {
    const tag = `_${counter++}`;
    candidate = `${base.slice(0, TOOL_NAME_LIMIT - tag.length)}${tag}`;
  }
  return candidate;
}

function sanitizeToolName(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_-]/g, '_').replace(/^[^A-Za-z_]+/, '');
  return normalized.slice(0, TOOL_NAME_LIMIT);
}

function resolveEnvironment(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).map(([key, value]) => [key, expandValue(value)]));
}

function expandPath(value: string, base: string): string {
  const expanded = expandValue(value);
  if (expanded === '~') return os.homedir();
  if (expanded.startsWith('~/')) return path.join(os.homedir(), expanded.slice(2));
  return path.isAbsolute(expanded) ? expanded : path.resolve(base, expanded);
}

function expandCommand(value: string, base: string): string {
  const expanded = expandValue(value);
  return expanded.includes('/') || expanded.includes('\\') || expanded.startsWith('.') || expanded.startsWith('~')
    ? expandPath(expanded, base)
    : expanded;
}

function expandValue(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => process.env[name] ?? '');
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function formatMcpResult(result: Record<string, unknown>): string {
  const parts: string[] = [];
  if (Array.isArray(result.content)) {
    for (const block of result.content) {
      if (!block || typeof block !== 'object') continue;
      const value = block as Record<string, unknown>;
      if (value.type === 'text' && typeof value.text === 'string') {
        parts.push(value.text);
      } else if (value.type === 'resource' || value.type === 'resource_link') {
        parts.push(JSON.stringify(value));
      } else if ((value.type === 'image' || value.type === 'audio') && typeof value.mimeType === 'string') {
        parts.push(`[${value.type}: ${value.mimeType}]`);
      }
    }
  }
  if (!parts.length && result.structuredContent !== undefined) {
    parts.push(JSON.stringify(result.structuredContent));
  }
  return parts.join('\n');
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}\n… (truncated)`;
}
