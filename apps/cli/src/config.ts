import path from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

// Load .env — workspace-level first (the directory `mai` was launched
// from), same convention as the sibling Rust CLI (`crates/mai-rust`) — then
// this project's own .env as a fallback for anything the workspace didn't
// set (dotenv.config() never overrides an already-set var, so the
// workspace's values always win). Provider JSON uses a related layered
// lookup (installation -> ~/.mai -> workspace), while environment values
// remain centralized so `mai` can run from any directory without requiring
// a copied .env in every workspace.
dotenv.config();
dotenv.config({ path: path.join(projectRoot(), '.env') });

/** Client family. Kept for backwards-compatible providers.json entries. */
export type ProviderKind = 'gemini' | 'openai';

/** Provider identity, separate from the HTTP wire protocol it exposes. */
export type ProviderType = 'gemini' | 'openai' | 'openai-compatible';
export type ProviderWireApi = 'gemini' | 'chat-completions' | 'responses';
export type ProviderAuthType = 'env' | 'codex-login' | 'none';

export interface ProviderAuthDef {
  type: ProviderAuthType;
  /** Environment variable used by `env` authentication. */
  env?: string;
  /** Codex's ChatGPT-plan Responses base URL for a reused Codex login. */
  chatgptBaseUrl?: string;
}

export interface ProviderCapabilities {
  webSearch?: boolean;
  imageGeneration?: boolean;
  reasoning?: boolean;
}

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
  type: ProviderType;
  wireApi: ProviderWireApi;
  baseUrl: string;
  /** Legacy alias retained so existing private provider files keep working. */
  apiKeyEnv?: string;
  auth: ProviderAuthDef;
  capabilities: ProviderCapabilities;
  model: string;
}

const DEFAULT_MAX_OUTPUT_TOKENS = 8192;
const DEFAULT_TEMPERATURE = 0.7;

export interface Config {
  /** Active provider's `name` from providers.json. */
  provider: string;
  kind: ProviderKind;
  type: ProviderType;
  wireApi: ProviderWireApi;
  auth: ProviderAuthDef;
  capabilities: ProviderCapabilities;
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

/** The CLI package root inside the monorepo. */
function projectRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..'); // src/.. -> project root
}

function firstExisting(candidates: string[]): string | null {
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

export interface ProviderLoadOptions {
  workspace?: string;
  installationRoot?: string;
  userConfigDir?: string;
}

/**
 * Provider files are returned from lowest to highest priority. Paths are
 * de-duplicated because running Mai from its own package directory makes the
 * workspace and installation candidates identical.
 */
export function providerConfigPaths(options: ProviderLoadOptions = {}): string[] {
  const workspace = path.resolve(options.workspace ?? process.cwd());
  const installationRoot = path.resolve(options.installationRoot ?? projectRoot());
  const userConfigDir = path.resolve(
    options.userConfigDir
      ?? process.env.MAI_HOME?.trim()
      ?? path.join(os.homedir(), '.mai'),
  );
  return [...new Set([
    path.join(installationRoot, 'providers.json'),
    path.join(installationRoot, 'providers.local.json'),
    path.join(userConfigDir, 'providers.json'),
    path.join(workspace, 'providers.json'),
    path.join(workspace, 'providers.local.json'),
  ])];
}

export interface UserProviderConfigInitResult {
  path: string;
  created: boolean;
}

/**
 * Seed the stable user configuration with the complete bundled example.
 * Existing user configuration is never overwritten. Failure to create the
 * convenience copy is non-fatal because Mai can still use bundled defaults.
 */
export function ensureUserProviderConfig(
  options: ProviderLoadOptions = {},
): UserProviderConfigInitResult {
  const installationRoot = path.resolve(options.installationRoot ?? projectRoot());
  const userConfigDir = path.resolve(
    options.userConfigDir
      ?? process.env.MAI_HOME?.trim()
      ?? path.join(os.homedir(), '.mai'),
  );
  const source = path.join(installationRoot, 'providers.json');
  const destination = path.join(userConfigDir, 'providers.json');
  if (existsSync(destination) || !existsSync(source)) return { path: destination, created: false };

  try {
    mkdirSync(userConfigDir, { recursive: true, mode: 0o700 });
    writeFileSync(destination, readFileSync(source), { flag: 'wx', mode: 0o600 });
    return { path: destination, created: true };
  } catch (error) {
    if (isNodeError(error) && error.code === 'EEXIST') return { path: destination, created: false };
    return { path: destination, created: false };
  }
}

/**
 * Merges every existing provider file by case-insensitive provider name.
 * Later files override earlier files, and object-valued auth/capabilities
 * fields are merged so a user can override only a URL, model, or capability.
 * This keeps package defaults upgradeable while making ~/.mai/providers.json
 * the stable user-owned configuration location.
 */
export function loadProviders(options: ProviderLoadOptions = {}): ProviderDef[] {
  ensureUserProviderConfig(options);
  const jsonPaths = providerConfigPaths(options).filter((candidate) => existsSync(candidate));
  if (jsonPaths.length === 0) {
    throw new Error(
      'No provider configuration found (checked the installation, ~/.mai, and current workspace). ' +
        'See the bundled providers.json for the expected shape.',
    );
  }

  const merged = new Map<string, { entry: Record<string, unknown>; location: string }>();
  for (const jsonPath of jsonPaths) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(jsonPath, 'utf8'));
    } catch (err) {
      throw new Error(`Could not parse ${jsonPath}: ${(err as Error).message}`);
    }
    if (!Array.isArray(raw)) {
      throw new Error(`${jsonPath} must be a JSON array of provider entries.`);
    }
    raw.forEach((value, index) => {
      const location = `${jsonPath}: entry ${index}`;
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${location} must be an object.`);
      }
      const entry = value as Record<string, unknown>;
      if (typeof entry.name !== 'string' || !entry.name.trim()) {
        throw new Error(`${location} is missing a valid "name" field.`);
      }
      const key = entry.name.trim().toLowerCase();
      const previous = merged.get(key)?.entry;
      merged.set(key, {
        entry: previous ? mergeProviderEntries(previous, entry) : entry,
        location,
      });
    });
  }
  if (merged.size === 0) throw new Error('Provider configuration did not define any providers.');

  return [...merged.values()].map(({ entry, location }) => normalizeProviderDef(entry, location));
}

function mergeProviderEntries(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...base, ...override };
  for (const field of ['auth', 'capabilities'] as const) {
    const before = plainRecord(base[field]);
    const after = plainRecord(override[field]);
    if (before && after) result[field] = { ...before, ...after };
  }
  return result;
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

/**
 * Normalizes both the original `{ kind, apiKeyEnv }` provider shape and the
 * richer provider/auth/protocol shape. Keeping this conversion at the config
 * boundary means the rest of Mai never needs compatibility branches.
 */
export function normalizeProviderDef(entry: unknown, location = 'provider'): ProviderDef {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`${location} must be an object.`);
  }
  const e = entry as Record<string, unknown>;
  for (const field of ['name', 'baseUrl', 'model'] as const) {
    if (typeof e[field] !== 'string' || !e[field]) {
      throw new Error(`${location} is missing a valid "${field}" field.`);
    }
  }

  const legacyKind = e.kind;
  if (legacyKind !== undefined && legacyKind !== 'gemini' && legacyKind !== 'openai') {
    throw new Error(`${location} has kind "${String(legacyKind)}" — must be "gemini" or "openai".`);
  }
  const declaredType = e.type;
  if (declaredType !== undefined && !['gemini', 'openai', 'openai-compatible'].includes(String(declaredType))) {
    throw new Error(`${location} has unsupported type "${String(declaredType)}".`);
  }
  const inferredKind: ProviderKind = legacyKind === 'gemini' || declaredType === 'gemini' ? 'gemini' : 'openai';
  const inferredType: ProviderType = declaredType as ProviderType | undefined
    ?? (inferredKind === 'gemini'
      ? 'gemini'
      : String(e.baseUrl).startsWith('https://api.openai.com/')
        ? 'openai'
        : 'openai-compatible');

  const wireApi = (e.wireApi ?? (inferredKind === 'gemini' ? 'gemini' : 'chat-completions')) as ProviderWireApi;
  if (!['gemini', 'chat-completions', 'responses'].includes(wireApi)) {
    throw new Error(`${location} has unsupported wireApi "${String(wireApi)}".`);
  }
  if ((inferredKind === 'gemini') !== (wireApi === 'gemini')) {
    throw new Error(`${location} has incompatible kind/type and wireApi "${wireApi}".`);
  }

  const legacyEnv = typeof e.apiKeyEnv === 'string' && e.apiKeyEnv ? e.apiKeyEnv : undefined;
  let auth: ProviderAuthDef;
  if (e.auth === undefined) {
    if (!legacyEnv) throw new Error(`${location} must define auth or apiKeyEnv.`);
    auth = { type: 'env', env: legacyEnv };
  } else if (typeof e.auth === 'string') {
    if (!['env', 'codex-login', 'none'].includes(e.auth)) {
      throw new Error(`${location}.auth has unsupported type "${e.auth}".`);
    }
    auth = { type: e.auth as ProviderAuthType, ...(legacyEnv ? { env: legacyEnv } : {}) };
  } else if (e.auth && typeof e.auth === 'object' && !Array.isArray(e.auth)) {
    const value = e.auth as Record<string, unknown>;
    if (!['env', 'codex-login', 'none'].includes(String(value.type))) {
      throw new Error(`${location}.auth.type must be "env", "codex-login", or "none".`);
    }
    auth = {
      type: value.type as ProviderAuthType,
      ...(typeof value.env === 'string' && value.env ? { env: value.env } : legacyEnv ? { env: legacyEnv } : {}),
      ...(typeof value.chatgptBaseUrl === 'string' && value.chatgptBaseUrl
        ? { chatgptBaseUrl: value.chatgptBaseUrl.replace(/\/$/, '') }
        : {}),
    };
  } else {
    throw new Error(`${location}.auth must be a string or object.`);
  }
  if (auth.type === 'env' && !auth.env) {
    throw new Error(`${location}.auth.env (or apiKeyEnv) is required for env authentication.`);
  }
  if (auth.type === 'codex-login' && inferredType !== 'openai') {
    throw new Error(`${location} can use codex-login only when type is "openai".`);
  }

  let capabilities: ProviderCapabilities = {};
  if (e.capabilities !== undefined) {
    if (!e.capabilities || typeof e.capabilities !== 'object' || Array.isArray(e.capabilities)) {
      throw new Error(`${location}.capabilities must be an object.`);
    }
    const value = e.capabilities as Record<string, unknown>;
    for (const field of ['webSearch', 'imageGeneration', 'reasoning'] as const) {
      if (value[field] !== undefined && typeof value[field] !== 'boolean') {
        throw new Error(`${location}.capabilities.${field} must be a boolean.`);
      }
    }
    capabilities = {
      ...(typeof value.webSearch === 'boolean' ? { webSearch: value.webSearch } : {}),
      ...(typeof value.imageGeneration === 'boolean' ? { imageGeneration: value.imageGeneration } : {}),
      ...(typeof value.reasoning === 'boolean' ? { reasoning: value.reasoning } : {}),
    };
  }

  return {
    name: e.name as string,
    kind: inferredKind,
    type: inferredType,
    wireApi,
    baseUrl: e.baseUrl as string,
    ...(legacyEnv ? { apiKeyEnv: legacyEnv } : auth.env ? { apiKeyEnv: auth.env } : {}),
    auth,
    capabilities,
    model: e.model as string,
  };
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
    type: def.type,
    wireApi: def.wireApi,
    auth: def.auth,
    capabilities: def.capabilities,
    apiKey: def.auth.type === 'env' && def.auth.env ? process.env[def.auth.env]?.trim() ?? '' : '',
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
    type: def.type,
    wireApi: def.wireApi,
    auth: def.auth,
    capabilities: def.capabilities,
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
 * Looks for the `mai-sandbox` binary built from `crates/mai-rust`. Checked,
 * in order: an explicit override, a release/debug monorepo build,
 * then finally whatever `mai-sandbox` resolves to on PATH.
 */
function resolveSandboxBinary(): string | null {
  const override = process.env.MAI_SANDBOX_BIN?.trim();
  if (override && existsSync(override)) return override;

  const monorepoRoot = path.resolve(projectRoot(), '..', '..');
  const rustRoot = path.join(monorepoRoot, 'crates', 'mai-rust');
  const found = firstExisting([
    path.join(monorepoRoot, 'target', 'release', 'mai-sandbox'),
    path.join(monorepoRoot, 'target', 'debug', 'mai-sandbox'),
    path.join(rustRoot, 'target', 'release', 'mai-sandbox'),
    path.join(rustRoot, 'target', 'debug', 'mai-sandbox'),
  ]);
  return found ?? 'mai-sandbox'; // fall back to PATH lookup; sandbox.ts reports a clear error if that fails too
}

/**
 * Looks for the Tauri GUI app built from `apps/desktop`. Checked, in
 * order: an explicit override, then a release/debug Tauri monorepo build.
 * Unlike the sandbox binary, this has no PATH fallback — `/gui`
 * would rather say plainly "not found" than launch some unrelated program
 * that happens to be named `mai-gui` on someone's PATH.
 */
export function resolveGuiBinary(): string | null {
  const override = process.env.MAI_GUI_BIN?.trim();
  if (override && existsSync(override)) return override;

  const monorepoRoot = path.resolve(projectRoot(), '..', '..');
  const desktopRoot = path.join(monorepoRoot, 'apps', 'desktop');
  return firstExisting([
    path.join(monorepoRoot, 'target', 'release', 'mai-gui'),
    path.join(monorepoRoot, 'target', 'debug', 'mai-gui'),
    path.join(desktopRoot, 'src-tauri', 'target', 'release', 'mai-gui'),
    path.join(desktopRoot, 'src-tauri', 'target', 'debug', 'mai-gui'),
  ]);
}
