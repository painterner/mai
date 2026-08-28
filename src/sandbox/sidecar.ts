import { spawn } from 'node:child_process';

/**
 * Talks to the `mai-sandbox` binary built from `mail-cli-rust`
 * (`src/bin/mai-sandbox.rs`): one JSON request on stdin, one JSON response
 * on stdout. That binary owns all the bubblewrap/seccomp details — this
 * file only knows the wire format, not the sandboxing itself. See the
 * project conversation for why this lives in Rust rather than being ported
 * to JS: it needs to build a raw seccomp-BPF filter and call `memfd_create`,
 * neither of which Node exposes without native code.
 */
export interface SandboxSuccess {
  ok: true;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface SandboxFailure {
  ok: false;
  error: string;
}

export type SandboxResponse = SandboxSuccess | SandboxFailure;

export function runSandboxed(
  binary: string,
  workspace: string,
  command: string,
  timeoutSeconds = 120,
  signal?: AbortSignal,
): Promise<SandboxResponse> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ ok: false, error: 'Sandbox command was interrupted' });
      return;
    }
    let child;
    try {
      child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ ok: false, error: launchErrorMessage(binary, err) });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (response: SandboxResponse) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      resolve(response);
    };
    const abort = () => {
      child.kill('SIGTERM');
      finish({ ok: false, error: 'Sandbox command was interrupted' });
    };
    signal?.addEventListener('abort', abort, { once: true });

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      finish({ ok: false, error: launchErrorMessage(binary, err) });
    });

    child.on('close', () => {
      const trimmed = stdout.trim();
      if (!trimmed) {
        finish({
          ok: false,
          error: stderr.trim() || 'Sandbox binary exited without producing a response',
        });
        return;
      }
      try {
        const parsed = JSON.parse(trimmed) as {
          ok: boolean;
          exit_code?: number | null;
          stdout?: string;
          stderr?: string;
          error?: string;
        };
        if (parsed.ok) {
          finish({
            ok: true,
            exitCode: parsed.exit_code ?? null,
            stdout: parsed.stdout ?? '',
            stderr: parsed.stderr ?? '',
          });
        } else {
          finish({ ok: false, error: parsed.error ?? 'Unknown sandbox error' });
        }
      } catch (err) {
        finish({ ok: false, error: `Failed to parse sandbox response: ${(err as Error).message}` });
      }
    });

    child.stdin?.write(
      JSON.stringify({ workspace, command, timeout_seconds: timeoutSeconds }),
    );
    child.stdin?.end();
  });
}

function launchErrorMessage(binary: string, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return (
    `Failed to launch sandbox binary "${binary}": ${message}. ` +
    'Build it with `cargo build --release --bin mai-sandbox` in mail-cli-rust, ' +
    'or point MAI_SANDBOX_BIN at an existing build.'
  );
}
