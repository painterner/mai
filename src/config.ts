import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

// Load .env from the current working directory (where the user launched
// `mai` from) before reading anything below — same convention as the
// sibling Rust CLI (`mail-cli-rust`), so a copied-over .env just works.
dotenv.config();

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
 * Reads `providers.json` — checked in the current workspace first (so a
 * project can pin its own provider list, same "follows the workspace"
 * convention as `.env`), falling back to the copy shipped with this project
 * so a fresh checkout works with zero setup.
 */
export function loadProviders(): ProviderDef[] {
  const jsonPath = firstExisting([
    path.join(process.cwd(), 'providers.json'),
    path.join(projectRoot(), 'providers.json'),
  ]);
  if (!jsonPath) {
    throw new Error(
      'No providers.json found (checked the current directory and the project root). ' +
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
 * Picks the active entry: `API_PROVIDER` matched against providers.json's
 * `name` fields (case-insensitively), falling back to the first entry so an
 * unset `API_PROVIDER` still works, same as before providers.json existed.
 */
export function resolveProviderDef(providers: ProviderDef[]): ProviderDef {
  const raw = process.env.API_PROVIDER?.trim().toLowerCase();
  const match = raw ? providers.find((p) => p.name.toLowerCase() === raw) : undefined;
  return match ?? providers[0];
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
  const def = resolveProviderDef(providers);

  const base: Config = {
    provider: def.name,
    kind: def.kind,
    apiKey: '',
    model: def.model,
    baseUrl: def.baseUrl,
    maxOutputTokens: Number(process.env.MAI_MAX_TOKENS) || DEFAULT_MAX_OUTPUT_TOKENS,
    temperature: process.env.MAI_TEMPERATURE ? Number(process.env.MAI_TEMPERATURE) : DEFAULT_TEMPERATURE,
    workspace: process.cwd(),
    allowShell: envFlag('MAI_ALLOW_SHELL', true),
    sandboxBinary: resolveSandboxBinary(),
    providers,
  };

  return configForProvider(base, def);
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
