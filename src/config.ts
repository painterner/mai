import path from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

// Load .env — workspace-level first (the directory `mai` was launched
// from), same convention as the sibling Rust CLI (`mail-cli-rust`) — then
// this project's own .env as a fallback for anything the workspace didn't
// set (dotenv.config() never overrides an already-set var, so the
// workspace's values always win). Mirrors providers.json's "follows the
// workspace, falls back to the install dir" lookup — lets `mai` run from
// any directory using one central .env instead of requiring a copy in
// every workspace.
dotenv.config();
dotenv.config({ path: path.join(projectRoot(), '.env') });

/** Wire protocol a provider entry speaks — decides which `LlmClient` class handles it. */
export type ProviderKind = 'gemini' | 'openai';

/**
 * One entry from `providers.json`. `name` is just a label (shown in
 * `/model`'s picker and matched against `API_PROVIDER`); `apiKeyEnv` decouples
 * it from a fixed `{NAME}_API_KEY` convention so e.g. two `kind: "openai"`
 * entries (Groq, DeepSeek, a local vLLM server, ...) can each read their key
 * from a differently-named .env var without colliding.
 */
export interface ProviderDef {
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  apiKeyEnv: string;
  model: string;
}

const DEFAULT_MAX_OUTPUT_TOKENS = 8192;
const DEFAULT_TEMPERATURE = 0.7;

export interface Config {
  /** Active provider's `name` from providers.json. */
  provider: string;
  kind: ProviderKind;
  apiKey: string;
  model: string;
  baseUrl: string;
  maxOutputTokens: number;
  temperature: number;
  workspace: string;
  /** Whether the run_command tool is offered at all (mirrors --no-shell). */
  allowShell: boolean;
  /** Resolved path to the Rust sandbox sidecar binary, if one was found. */
  sandboxBinary: string | null;
  /** Every entry providers.json declared — powers /model's provider picker. */
  providers: ProviderDef[];
}

function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return !['0', 'false', 'no', 'off'].includes(raw.toLowerCase());
}

/** This project's own root — sibling repos are expected next to it. */
function projectRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..'); // src/.. -> project root
}

function firstExisting(candidates: string[]): string | null {
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/**
 * Reads providers from the first existing file in this order:
 * workspace `providers.local.json`, workspace `providers.json`, installation
 * `providers.local.json`, installation `providers.json`. The local filename
 * is gitignored so private endpoints can coexist with a publishable default.
 */
export function loadProviders(): ProviderDef[] {
  const jsonPath = firstExisting([
    path.join(process.cwd(), 'providers.local.json'),
    path.join(process.cwd(), 'providers.json'),
    path.join(projectRoot(), 'providers.local.json'),
    path.join(projectRoot(), 'providers.json'),
  ]);
  if (!jsonPath) {
    throw new Error(
      'No providers.local.json or providers.json found (checked the current directory and the project root). ' +
        'See providers.json in the repo for the expected shape.',
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(jsonPath, 'utf8'));
  } catch (err) {
    throw new Error(`Could not parse ${jsonPath}: ${(err as Error).message}`);
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`${jsonPath} must be a non-empty JSON array of provider entries.`);
  }

  return raw.map((entry, i) => {
    const e = entry as Partial<ProviderDef>;
    for (const field of ['name', 'kind', 'baseUrl', 'apiKeyEnv', 'model'] as const) {
      if (typeof e[field] !== 'string' || !e[field]) {
        throw new Error(`${jsonPath}: entry ${i} is missing a valid "${field}" field.`);
      }
    }
    if (e.kind !== 'gemini' && e.kind !== 'openai') {
      throw new Error(`${jsonPath}: entry ${i} ("${e.name}") has kind "${e.kind}" — must be "gemini" or "openai".`);
    }
    return { name: e.name!, kind: e.kind, baseUrl: e.baseUrl!, apiKeyEnv: e.apiKeyEnv!, model: e.model! };
  });
}

/**
 * Picks the active entry: `preferredName` (the last provider `/model` saved
 * to state.json, if any) wins, then `API_PROVIDER` matched against
 * providers.json's `name` fields (case-insensitively), then the first
 * entry — so an unset `API_PROVIDER` and a fresh workspace with no saved
 * state still work, same as before providers.json existed.
 */
export function resolveProviderDef(providers: ProviderDef[], preferredName?: string): ProviderDef {
  const raw = (preferredName ?? process.env.API_PROVIDER)?.trim().toLowerCase();
  const match = raw ? providers.find((p) => p.name.toLowerCase() === raw) : undefined;
  return match ?? providers[0];
}

/** What `/model` last switched to — persisted so it survives a restart. */
export interface SavedState {
  provider: string;
  model: string;
}

const STATE_DIR = '.mai';
const STATE_FILE = 'state.json';

function statePath(workspace: string): string {
  return path.join(workspace, STATE_DIR, STATE_FILE);
}

/**
 * Reads `.mai/state.json` from the workspace — deliberately workspace-only
 * (no project-root fallback like `.env`/`providers.json`): "what I last
 * picked" is inherently per-project, not something to share across
 * unrelated workspaces. Best-effort: a missing or corrupt file just means
 * "nothing saved yet", not a startup error.
 */
export function loadState(workspace: string): SavedState | null {
  const p = statePath(workspace);
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    if (raw && typeof raw.provider === 'string' && typeof raw.model === 'string') {
      return { provider: raw.provider, model: raw.model };
    }
  } catch {
    // Corrupt state.json — fall through to "nothing saved" rather than crash.
  }
  return null;
}

/** Called after a successful `/model` switch; failures are non-fatal. */
export function saveState(workspace: string, provider: string, model: string): void {
  try {
    mkdirSync(path.join(workspace, STATE_DIR), { recursive: true });
    writeFileSync(statePath(workspace), `${JSON.stringify({ provider, model }, null, 2)}\n`);
  } catch {
    // A session that can't persist its pick still works — just won't stick after restart.
  }
}

/**
 * Builds a `Config` for a specific provider entry — same env-var overrides
 * (`{NAME}_MODEL`, `{NAME}_BASE_URL`) `loadConfig` uses, factored out so
 * `/model`'s provider switch can reuse it without re-reading providers.json
 * or duplicating the override logic.
 */
export function configForProvider(base: Config, def: ProviderDef): Config {
  const envPrefix = def.name.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  return {
    ...base,
    provider: def.name,
    kind: def.kind,
    apiKey: process.env[def.apiKeyEnv]?.trim() ?? '',
    model: process.env[`${envPrefix}_MODEL`]?.trim() || def.model,
    baseUrl: (process.env[`${envPrefix}_BASE_URL`]?.trim() || def.baseUrl).replace(/\/$/, ''),
  };
}

export function loadConfig(): Config {
  const providers = loadProviders();
  const workspace = process.cwd();
  const saved = loadState(workspace);
  const def = resolveProviderDef(providers, saved?.provider);

  const base: Config = {
    provider: def.name,
    kind: def.kind,
    apiKey: '',
    model: def.model,
    baseUrl: def.baseUrl,
    maxOutputTokens: Number(process.env.MAI_MAX_TOKENS) || DEFAULT_MAX_OUTPUT_TOKENS,
    temperature: process.env.MAI_TEMPERATURE ? Number(process.env.MAI_TEMPERATURE) : DEFAULT_TEMPERATURE,
    workspace,
    allowShell: envFlag('MAI_ALLOW_SHELL', true),
    sandboxBinary: resolveSandboxBinary(),
    providers,
  };

  const config = configForProvider(base, def);
  // The saved model is more specific than providers.json's default or a
  // {NAME}_MODEL env override — it's literally what /model was last set to
  // for this provider — so it wins, but only once we've confirmed `def` is
  // that same saved provider (resolveProviderDef already did that match).
  if (saved && saved.provider === def.name) config.model = saved.model;
  return config;
}

/**
 * Looks for the `mai-sandbox` binary built from `mail-cli-rust`. Checked,
 * in order: an explicit override, a release/debug build in the sibling repo
 * (this project and mail-cli-rust are expected to sit next to each other),
 * then finally whatever `mai-sandbox` resolves to on PATH.
 */
function resolveSandboxBinary(): string | null {
  const override = process.env.MAI_SANDBOX_BIN?.trim();
  if (override && existsSync(override)) return override;

  const siblingRust = path.resolve(projectRoot(), '..', 'mail-cli-rust');
  const found = firstExisting([
    path.join(siblingRust, 'target', 'release', 'mai-sandbox'),
    path.join(siblingRust, 'target', 'debug', 'mai-sandbox'),
  ]);
  return found ?? 'mai-sandbox'; // fall back to PATH lookup; sandbox.ts reports a clear error if that fails too
}

/**
 * Looks for the Tauri GUI app built from `mai-cli-gui`. Checked, in
 * order: an explicit override, a release/debug Tauri build in the sibling
 * repo. Unlike the sandbox binary, this has no PATH fallback — `/gui`
 * would rather say plainly "not found" than launch some unrelated program
 * that happens to be named `mai-gui` on someone's PATH.
 */
export function resolveGuiBinary(): string | null {
  const override = process.env.MAI_GUI_BIN?.trim();
  if (override && existsSync(override)) return override;

  const siblingGui = path.resolve(projectRoot(), '..', 'mai-cli-gui');
  return firstExisting([
    path.join(siblingGui, 'src-tauri', 'target', 'release', 'mai-gui'),
    path.join(siblingGui, 'src-tauri', 'target', 'debug', 'mai-gui'),
  ]);
}
