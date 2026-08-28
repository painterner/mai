import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';

import { EventBus } from './events.js';
import { ApiStore, type StoredEvent, type TerminalRecord } from './store.js';

interface ActiveTerminal {
  child: ChildProcessWithoutNullStreams;
  sawExit: boolean;
}

export class TerminalManager {
  readonly events = new EventBus();
  private readonly active = new Map<string, ActiveTerminal>();
  private shuttingDown = false;

  constructor(
    private readonly store: ApiStore,
    private readonly workspace: string,
    private readonly sandboxBinary: string | null,
  ) {}

  start(command = 'exec sh -i', cols = 80, rows = 24): TerminalRecord {
    if (!this.sandboxBinary) throw new TerminalUnavailableError('No mai-sandbox binary is configured.');
    const terminal = this.store.createTerminal(command, clampSize(cols), clampSize(rows));
    const child = spawn(this.sandboxBinary, ['--terminal'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const active: ActiveTerminal = { child, sawExit: false };
    this.active.set(terminal.id, active);

    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', (line) => this.handleSidecarEvent(terminal.id, line));
    child.stderr.on('data', (chunk: Buffer) => {
      if (this.shuttingDown || !this.active.has(terminal.id)) return;
      this.emit(terminal.id, 'terminal.error', { message: chunk.toString('utf8') });
    });
    child.on('error', (error) => this.fail(terminal.id, error.message));
    child.on('close', (code) => {
      if (this.shuttingDown) return;
      const current = this.active.get(terminal.id);
      this.active.delete(terminal.id);
      if (current && !current.sawExit) {
        this.store.updateTerminal(terminal.id, { status: code === 0 ? 'exited' : 'failed', exitCode: code });
        this.emit(terminal.id, 'terminal.exit', { code });
      }
    });

    this.write(terminal.id, {
      type: 'start',
      workspace: this.workspace,
      command,
      cols: terminal.cols,
      rows: terminal.rows,
    });
    return terminal;
  }

  input(id: string, data: string, encoding: 'utf8' | 'base64' = 'utf8'): TerminalRecord {
    this.requireActive(id);
    const encoded = encoding === 'base64' ? data : Buffer.from(data, 'utf8').toString('base64');
    this.write(id, { type: 'input', data: encoded });
    return this.requireTerminal(id);
  }

  resize(id: string, cols: number, rows: number): TerminalRecord {
    this.requireActive(id);
    const safeCols = clampSize(cols);
    const safeRows = clampSize(rows);
    this.write(id, { type: 'resize', cols: safeCols, rows: safeRows });
    return this.store.updateTerminal(id, { cols: safeCols, rows: safeRows })!;
  }

  signal(id: string, signal: 'INT' | 'TERM' | 'KILL'): TerminalRecord {
    this.requireActive(id);
    this.write(id, { type: 'signal', signal });
    return this.requireTerminal(id);
  }

  close(id: string): TerminalRecord {
    const active = this.active.get(id);
    if (active) {
      this.write(id, { type: 'close' });
      active.child.kill('SIGTERM');
      this.active.delete(id);
    }
    return this.store.updateTerminal(id, { status: 'closed' }) ?? this.requireTerminal(id);
  }

  closeAll(): void {
    this.shuttingDown = true;
    for (const id of [...this.active.keys()]) this.close(id);
  }

  private handleSidecarEvent(id: string, line: string): void {
    if (this.shuttingDown || !this.active.has(id)) return;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.fail(id, `Invalid terminal sidecar event: ${line}`);
      return;
    }
    switch (event.type) {
      case 'ready':
        this.store.updateTerminal(id, { status: 'running' });
        this.emit(id, 'terminal.ready', {});
        break;
      case 'output':
        this.emit(id, 'terminal.output', { data: event.data, encoding: 'base64' });
        break;
      case 'exit': {
        const active = this.active.get(id);
        if (active) active.sawExit = true;
        const code = typeof event.code === 'number' ? event.code : null;
        this.store.updateTerminal(id, { status: 'exited', exitCode: code });
        this.emit(id, 'terminal.exit', { code });
        break;
      }
      case 'error':
        this.fail(id, typeof event.message === 'string' ? event.message : 'Unknown terminal error');
        break;
      default:
        this.fail(id, `Unknown terminal sidecar event: ${String(event.type)}`);
    }
  }

  private fail(id: string, message: string): void {
    if (this.shuttingDown) return;
    this.store.updateTerminal(id, { status: 'failed', error: message });
    this.emit(id, 'terminal.error', { message });
  }

  private emit(id: string, type: string, data: Record<string, unknown>): StoredEvent {
    const event = this.store.appendTerminalEvent(id, type, data);
    this.events.publish(id, event);
    return event;
  }

  private write(id: string, payload: Record<string, unknown>): void {
    const active = this.requireActive(id);
    active.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private requireActive(id: string): ActiveTerminal {
    const active = this.active.get(id);
    if (!active) throw new TerminalConflictError(`Terminal ${id} is not active.`);
    return active;
  }

  private requireTerminal(id: string): TerminalRecord {
    const terminal = this.store.getTerminal(id);
    if (!terminal) throw new TerminalNotFoundError(`Terminal ${id} was not found.`);
    return terminal;
  }
}

function clampSize(value: number): number {
  if (!Number.isInteger(value)) throw new TerminalInputError('Terminal size must be an integer.');
  return Math.min(500, Math.max(1, value));
}

export class TerminalNotFoundError extends Error {}
export class TerminalConflictError extends Error {}
export class TerminalUnavailableError extends Error {}
export class TerminalInputError extends Error {}
