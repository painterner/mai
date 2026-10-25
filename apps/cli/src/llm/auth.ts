import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

import type { Config, ProviderAuthDef } from '../config.js';

const DEFAULT_REFRESH_WINDOW_MS = 5 * 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export interface AccessTokenProvider {
  getAuthorization(forceRefresh?: boolean): Promise<AuthorizationContext>;
  getToken(forceRefresh?: boolean): Promise<string>;
  isConfigured(): boolean;
  description: string;
  getClientVersion?(): Promise<string | undefined>;
}

export interface AuthorizationContext {
  mode: 'chatgpt' | 'api-key' | 'none';
  headers: Record<string, string>;
}

export type CodexLoginMethod = 'browser' | 'device' | 'api-key' | 'access-token' | 'reuse';

export interface CodexAuthStatus {
  configured: boolean;
  mode: string | null;
  expiresAt?: string;
  accountId?: string;
}

export interface LoginOptions {
  apiKey?: string;
  accessToken?: string;
  onOutput?: (text: string) => void;
}

interface CodexAuthManagerOptions {
  codexHome?: string;
  codexPath?: string;
  requestTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

/**
 * Owns access to Codex's credential cache without ever returning refresh
 * tokens or raw auth documents to callers. Codex itself performs login and
 * refresh operations; Mai only reads the resulting current bearer token.
 */
export class CodexAuthManager implements AccessTokenProvider {
  readonly description = 'Codex/ChatGPT login';
  readonly codexHome: string;
  readonly codexPath: string;
  private readonly requestTimeoutMs: number;
  private readonly env: NodeJS.ProcessEnv;
  private refreshInFlight: Promise<void> | null = null;

  constructor(options: CodexAuthManagerOptions = {}) {
    this.env = options.env ?? process.env;
    this.codexHome = options.codexHome
      ?? this.env.CODEX_HOME?.trim()
      ?? path.join(os.homedir(), '.codex');
    this.codexPath = options.codexPath ?? this.env.MAI_CODEX_BIN?.trim() ?? 'codex';
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  get authPath(): string {
    return path.join(this.codexHome, 'auth.json');
  }

  isConfigured(): boolean {
    return Boolean(this.env.OPENAI_API_KEY?.trim()) || existsSync(this.authPath);
  }

  async status(): Promise<CodexAuthStatus> {
    if (!existsSync(this.authPath)) {
      return this.env.OPENAI_API_KEY?.trim()
        ? { configured: true, mode: 'api-key-env' }
        : { configured: false, mode: null };
    }
    const auth = await this.readAuth();
    const timing = accessTokenTiming(auth);
    const accountId = record(auth.tokens)?.account_id;
    return {
      configured: hasUsableCredential(auth),
      mode: typeof auth.auth_mode === 'string' ? auth.auth_mode : null,
      ...(timing ? { expiresAt: new Date(timing.expiresAt).toISOString() } : {}),
      ...(typeof accountId === 'string' && accountId ? { accountId } : {}),
    };
  }

  async getToken(forceRefresh = false): Promise<string> {
    const authorization = await this.getAuthorization(forceRefresh);
    return authorization.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
  }

  async getAuthorization(forceRefresh = false): Promise<AuthorizationContext> {
    if (!existsSync(this.authPath)) {
      const environmentKey = this.env.OPENAI_API_KEY?.trim();
      if (environmentKey) {
        return { mode: 'api-key', headers: { authorization: `Bearer ${environmentKey}` } };
      }
    }
    let auth = await this.readAuthWithGuidance();
    const apiKey = auth.OPENAI_API_KEY;
    if (typeof apiKey === 'string' && apiKey) {
      return { mode: 'api-key', headers: { authorization: `Bearer ${apiKey}` } };
    }

    const timing = accessTokenTiming(auth);
    if (forceRefresh || (timing && timing.expiresAt - Date.now() <= refreshWindow(timing))) {
      await this.refresh();
      auth = await this.readAuthWithGuidance();
    }
    const token = record(auth.tokens)?.access_token;
    if (typeof token !== 'string' || !token) {
      throw new Error('Codex login has no usable access token. Run /login browser, /login device, or /login api-key.');
    }
    const accountId = record(auth.tokens)?.account_id;
    return {
      mode: 'chatgpt',
      headers: {
        authorization: `Bearer ${token}`,
        ...(typeof accountId === 'string' && accountId ? { 'chatgpt-account-id': accountId } : {}),
      },
    };
  }

  async getClientVersion(): Promise<string | undefined> {
    return new Promise((resolve) => {
      const child = spawn(this.codexPath, ['--version'], {
        env: { ...this.env, CODEX_HOME: this.codexHome },
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      let output = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => { output += chunk; });
      child.once('error', () => resolve(undefined));
      child.once('exit', (code) => {
        if (code !== 0) return resolve(undefined);
        resolve(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(output)?.[1]);
      });
    });
  }

  async login(method: CodexLoginMethod, options: LoginOptions = {}): Promise<CodexAuthStatus> {
    if (method === 'reuse') {
      await this.getToken(true);
      return this.status();
    }

    const args = ['login', '-c', 'cli_auth_credentials_store="file"'];
    let secret: string | undefined;
    if (method === 'device') args.push('--device-auth');
    if (method === 'api-key') {
      args.push('--with-api-key');
      secret = options.apiKey ?? this.env.OPENAI_API_KEY?.trim();
      if (!secret) throw new Error('OPENAI_API_KEY is not set. Set it in the environment, then run /login api-key.');
    }
    if (method === 'access-token') {
      args.push('--with-access-token');
      secret = options.accessToken ?? this.env.CODEX_ACCESS_TOKEN?.trim();
      if (!secret) {
        throw new Error('CODEX_ACCESS_TOKEN is not set. Set it in the environment, then run /login access-token.');
      }
    }
    await this.runCodex(args, secret, options.onOutput);
    return this.status();
  }

  async logout(onOutput?: (text: string) => void): Promise<void> {
    await this.runCodex(['logout', '-c', 'cli_auth_credentials_store="file"'], undefined, onOutput);
  }

  private async refresh(): Promise<void> {
    if (!this.refreshInFlight) {
      this.refreshInFlight = requestCodexRefresh(
        this.codexPath,
        this.codexHome,
        this.requestTimeoutMs,
        this.env,
      ).finally(() => {
        this.refreshInFlight = null;
      });
    }
    await this.refreshInFlight;
  }

  private async readAuthWithGuidance(): Promise<Record<string, unknown>> {
    try {
      return await this.readAuth();
    } catch (error) {
      if (isMissing(error)) {
        throw new Error(
          `No file-backed Codex login was found at ${this.authPath}. ` +
          'Run /login browser, /login device, /login api-key, or /login access-token; ' +
          'for containers, OPENAI_API_KEY is also accepted as a fallback.',
        );
      }
      throw error;
    }
  }

  private async readAuth(): Promise<Record<string, unknown>> {
    const parsed = JSON.parse(await readFile(this.authPath, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`Codex credential file is not a JSON object: ${this.authPath}`);
    }
    return parsed as Record<string, unknown>;
  }

  private runCodex(args: string[], secret?: string, onOutput?: (text: string) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.codexPath, args, {
        env: { ...this.env, CODEX_HOME: this.codexHome },
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let tail = '';
      const capture = (chunk: Buffer | string) => {
        const text = String(chunk);
        tail = `${tail}${text}`.slice(-4096);
        onOutput?.(text);
      };
      child.stdout.on('data', capture);
      child.stderr.on('data', capture);
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        if (code === 0) resolve();
        else reject(new Error(
          `Codex login command failed (${signal ? `signal ${signal}` : `exit ${String(code)}`})` +
          `${tail.trim() ? `: ${tail.trim()}` : ''}`,
        ));
      });
      if (secret !== undefined) child.stdin.end(`${secret}\n`);
      else child.stdin.end();
    });
  }
}

class StaticAccessTokenProvider implements AccessTokenProvider {
  constructor(readonly token: string, readonly description: string, private readonly allowEmpty = false) {}
  isConfigured(): boolean { return this.allowEmpty || Boolean(this.token); }
  async getAuthorization(): Promise<AuthorizationContext> {
    return {
      mode: this.allowEmpty ? 'none' : 'api-key',
      headers: this.token ? { authorization: `Bearer ${this.token}` } : {},
    };
  }
  async getToken(): Promise<string> {
    if (!this.token && !this.allowEmpty) throw new Error(`No credential configured for ${this.description}.`);
    return this.token;
  }
}

export function createAccessTokenProvider(config: Config): AccessTokenProvider {
  if (config.auth.type === 'codex-login') return new CodexAuthManager();
  if (config.auth.type === 'none') return new StaticAccessTokenProvider('', 'unauthenticated provider', true);
  return new StaticAccessTokenProvider(config.apiKey, config.auth.env ?? 'provider API key');
}

export function isCredentialConfigured(config: Pick<Config, 'auth' | 'apiKey'>): boolean {
  if (config.auth.type === 'none') return true;
  if (config.auth.type === 'codex-login') return new CodexAuthManager().isConfigured();
  return Boolean(config.apiKey);
}

export function credentialHint(auth: ProviderAuthDef): string {
  if (auth.type === 'codex-login') return 'run /login to use Codex/ChatGPT, or set OPENAI_API_KEY';
  if (auth.type === 'env') return `set ${auth.env ?? 'the provider API key environment variable'}`;
  return 'no credential is required';
}

function hasUsableCredential(auth: Record<string, unknown>): boolean {
  return (typeof auth.OPENAI_API_KEY === 'string' && Boolean(auth.OPENAI_API_KEY))
    || (typeof record(auth.tokens)?.access_token === 'string' && Boolean(record(auth.tokens)?.access_token));
}

function accessTokenTiming(auth: Record<string, unknown>): { issuedAt?: number; expiresAt: number } | undefined {
  const token = record(auth.tokens)?.access_token;
  if (typeof token !== 'string') return undefined;
  const payload = token.split('.')[1];
  if (!payload) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) return undefined;
    const issuedAt = typeof claims.iat === 'number' && Number.isFinite(claims.iat) ? claims.iat * 1000 : undefined;
    return { expiresAt: claims.exp * 1000, ...(issuedAt !== undefined ? { issuedAt } : {}) };
  } catch {
    return undefined;
  }
}

function refreshWindow(timing: { issuedAt?: number; expiresAt: number }): number {
  return timing.issuedAt === undefined
    ? DEFAULT_REFRESH_WINDOW_MS
    : Math.max(DEFAULT_REFRESH_WINDOW_MS, Math.floor((timing.expiresAt - timing.issuedAt) / 4));
}

async function requestCodexRefresh(
  codexPath: string,
  codexHome: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const child = spawn(codexPath, ['app-server', '--listen', 'stdio://'], {
    env: { ...env, CODEX_HOME: codexHome },
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map<number, { resolve(): void; reject(error: Error): void }>();
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-4096); });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on('line', (line) => settleAppServerLine(line, pending));
  const exited = processExit(child, () => stderr);
  const request = (id: number, method: string, params: Record<string, unknown>): Promise<void> => {
    const result = new Promise<void>((resolve, reject) => pending.set(id, { resolve, reject }));
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    return Promise.race([result, exited]);
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Codex auth refresh timed out after ${timeoutMs} ms.`)), timeoutMs);
    timer.unref();
  });
  try {
    await Promise.race([
      (async () => {
        await request(1, 'initialize', {
          clientInfo: { name: 'mai', title: 'Mai', version: '0.1.0' },
          capabilities: { experimentalApi: true },
        });
        child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
        await request(2, 'account/read', { refreshToken: true });
      })(),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    lines.close();
    child.kill('SIGTERM');
  }
}

function settleAppServerLine(
  line: string,
  pending: Map<number, { resolve(): void; reject(error: Error): void }>,
): void {
  let message: { id?: unknown; error?: { message?: unknown } };
  try { message = JSON.parse(line) as typeof message; } catch { return; }
  if (typeof message.id !== 'number') return;
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  if (message.error) {
    request.reject(new Error(
      typeof message.error.message === 'string' ? message.error.message : 'Codex auth request failed.',
    ));
  } else request.resolve();
}

function processExit(child: ChildProcessWithoutNullStreams, stderr: () => string): Promise<never> {
  return new Promise((_resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      const detail = signal ? `signal ${signal}` : `exit code ${String(code)}`;
      const suffix = stderr().trim();
      reject(new Error(`Codex auth process exited with ${detail}${suffix ? `: ${suffix}` : ''}`));
    });
  });
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function isMissing(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}
