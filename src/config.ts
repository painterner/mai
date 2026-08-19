import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

// Load .env from the current working directory (where the user launched
// `mai` from) before reading anything below — same convention as the
// sibling Rust CLI (`mail-cli-rust`), so a copied-over .env just works.
dotenv.config();

export type ApiProvider = 'gemini' | 'openai';

const PROVIDER_DEFAULTS: Record<ApiProvider, { model: string; baseUrl: string }> = {
  gemini: { model: 'gemini-2.5-flash', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' },
  openai: { model: 'gpt-4o-mini', baseUrl: 'https://api.openai.com/v1' },
};

const DEFAULT_MAX_OUTPUT_TOKENS = 8192;
const DEFAULT_TEMPERATURE = 0.7;

export interface Config {
  provider: ApiProvider;
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
}

function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return !['0', 'false', 'no', 'off'].includes(raw.toLowerCase());
}

/**
 * Which provider is active, and its `{PREFIX}_API_KEY`/`{PREFIX}_MODEL`/
 * `{PREFIX}_BASE_URL` env-var prefix — mirrors mail-cli-rust's
 * `ApiProvider`/`apply_provider_env` so a `.env` written for one CLI mostly
 * works for the other. Defaults to Gemini for backward compatibility with
 * configs from before `API_PROVIDER` existed.
 */
function resolveProvider(): ApiProvider {
  const raw = process.env.API_PROVIDER?.trim().toLowerCase();
  return raw === 'openai' ? 'openai' : 'gemini';
}

export function loadConfig(): Config {
  const provider = resolveProvider();
  const prefix = provider === 'openai' ? 'OPENAI' : 'GEMINI';
  const defaults = PROVIDER_DEFAULTS[provider];

  return {
    provider,
    apiKey: process.env[`${prefix}_API_KEY`]?.trim() ?? '',
    model: process.env[`${prefix}_MODEL`]?.trim() || defaults.model,
    baseUrl: (process.env[`${prefix}_BASE_URL`]?.trim() || defaults.baseUrl).replace(/\/$/, ''),
    maxOutputTokens: Number(process.env.MAI_MAX_TOKENS) || DEFAULT_MAX_OUTPUT_TOKENS,
    temperature: process.env.MAI_TEMPERATURE ? Number(process.env.MAI_TEMPERATURE) : DEFAULT_TEMPERATURE,
    workspace: process.cwd(),
    allowShell: envFlag('MAI_ALLOW_SHELL', true),
    sandboxBinary: resolveSandboxBinary(),
  };
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
