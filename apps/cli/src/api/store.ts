import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { Content } from '../llm/types.js';
import type { ApprovalMode, Message } from '@mai/protocol';

export type RunStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface SessionRecord {
  id: string;
  title: string | null;
  provider: string;
  model: string;
  history: Content[];
  uiMessages: Message[];
  inputHistory: string[];
  approvalMode: ApprovalMode;
  client: 'api' | 'cli' | 'gui';
  createdAt: string;
  updatedAt: string;
}

export interface RunRecord {
  id: string;
  sessionId: string;
  status: RunStatus;
  input: string;
  provider: string;
  model: string;
  message: string;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StoredEvent {
  seq: number;
  type: string;
  data: Record<string, unknown>;
  createdAt: string;
}

export interface TerminalRecord {
  id: string;
  status: 'starting' | 'running' | 'exited' | 'failed' | 'closed';
  command: string;
  cols: number;
  rows: number;
  exitCode: number | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

interface SessionRow {
  id: string;
  title: string | null;
  provider: string;
  model: string;
  history_json: string;
  ui_messages_json: string;
  input_history_json: string;
  approval_mode: ApprovalMode;
  client: 'api' | 'cli' | 'gui';
  created_at: string;
  updated_at: string;
}

interface RunRow {
  id: string;
  session_id: string;
  status: RunStatus;
  input: string;
  provider: string;
  model: string;
  message: string;
  error: string | null;
  created_at: string;
  updated_at: string;
}

interface EventRow {
  seq: number;
  type: string;
  data_json: string;
  created_at: string;
}

interface TerminalRow {
  id: string;
  status: TerminalRecord['status'];
  command: string;
  cols: number;
  rows: number;
  exit_code: number | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export class ApiStore {
  private readonly db: DatabaseSync;

  constructor(filename: string, options: { recoverInterrupted?: boolean } = {}) {
    if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(
      'PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;',
    );
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        history_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        input TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        message TEXT NOT NULL DEFAULT '',
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS runs_session_created ON runs(session_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS run_events (
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        data_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (run_id, seq)
      );
      CREATE TABLE IF NOT EXISTS terminals (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        command TEXT NOT NULL,
        cols INTEGER NOT NULL,
        rows INTEGER NOT NULL,
        exit_code INTEGER,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS terminal_events (
        terminal_id TEXT NOT NULL REFERENCES terminals(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        data_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (terminal_id, seq)
      );
    `);
    this.ensureSessionColumn('ui_messages_json', "TEXT NOT NULL DEFAULT '[]'");
    this.ensureSessionColumn('input_history_json', "TEXT NOT NULL DEFAULT '[]'");
    this.ensureSessionColumn('approval_mode', "TEXT NOT NULL DEFAULT 'auto'");
    this.ensureSessionColumn('client', "TEXT NOT NULL DEFAULT 'api'");

    if (options.recoverInterrupted !== false) {
      const now = timestamp();
      this.db
        .prepare("UPDATE runs SET status = 'failed', error = ?, updated_at = ? WHERE status IN ('queued','running','waiting_approval')")
        .run('API process restarted before this run completed', now);
      this.db
        .prepare("UPDATE terminals SET status = 'failed', error = ?, updated_at = ? WHERE status IN ('starting','running')")
        .run('API process restarted before this terminal exited', now);
    }
  }

  private ensureSessionColumn(name: string, definition: string): void {
    const columns = this.db.prepare('PRAGMA table_info(sessions)').all() as unknown as Array<{ name: string }>;
    if (!columns.some((column) => column.name === name)) {
      try {
        this.db.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${definition}`);
      } catch (error) {
        // A GUI daemon and API sidecar can open a new workspace database at
        // the same time. If the other process won the migration race, the
        // desired schema is already present and this connection can proceed.
        if (!/duplicate column name/i.test((error as Error).message)) throw error;
      }
    }
  }

  close(): void {
    this.db.close();
  }

  createSession(
    provider: string,
    model: string,
    title?: string,
    presentation: Partial<Pick<SessionRecord, 'uiMessages' | 'inputHistory' | 'approvalMode' | 'client'>> = {},
  ): SessionRecord {
    const id = `sess_${randomUUID()}`;
    const now = timestamp();
    this.db
      .prepare(
        'INSERT INTO sessions (id,title,provider,model,history_json,ui_messages_json,input_history_json,approval_mode,client,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        id,
        title?.trim() || null,
        provider,
        model,
        '[]',
        JSON.stringify(presentation.uiMessages ?? []),
        JSON.stringify(presentation.inputHistory ?? []),
        presentation.approvalMode ?? 'auto',
        presentation.client ?? 'api',
        now,
        now,
      );
    return this.getSession(id)!;
  }

  listSessions(limit = 50, offset = 0): SessionRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM sessions ORDER BY updated_at DESC, rowid DESC LIMIT ? OFFSET ?')
      .all(limit, offset) as unknown as SessionRow[];
    return rows.map(sessionFromRow);
  }

  getSession(id: string): SessionRecord | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as unknown as SessionRow | undefined;
    return row ? sessionFromRow(row) : null;
  }

  updateSession(
    id: string,
    update: {
      history?: Content[];
      uiMessages?: Message[];
      inputHistory?: string[];
      approvalMode?: ApprovalMode;
      client?: SessionRecord['client'];
      title?: string | null;
      provider?: string;
      model?: string;
    },
  ): SessionRecord | null {
    const session = this.getSession(id);
    if (!session) return null;
    const now = timestamp();
    this.db
      .prepare(
        'UPDATE sessions SET title=?,provider=?,model=?,history_json=?,ui_messages_json=?,input_history_json=?,approval_mode=?,client=?,updated_at=? WHERE id=?',
      )
      .run(
        update.title === undefined ? session.title : update.title?.trim() || null,
        update.provider ?? session.provider,
        update.model ?? session.model,
        JSON.stringify(update.history ?? session.history),
        JSON.stringify(update.uiMessages ?? session.uiMessages),
        JSON.stringify(update.inputHistory ?? session.inputHistory),
        update.approvalMode ?? session.approvalMode,
        update.client ?? session.client,
        now,
        id,
      );
    return this.getSession(id);
  }

  deleteSession(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id).changes) > 0;
  }

  createRun(sessionId: string, input: string, provider: string, model: string): RunRecord {
    const id = `run_${randomUUID()}`;
    const now = timestamp();
    this.db
      .prepare('INSERT INTO runs (id,session_id,status,input,provider,model,message,error,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, sessionId, 'queued', input, provider, model, '', null, now, now);
    return this.getRun(id)!;
  }

  getRun(id: string): RunRecord | null {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as unknown as RunRow | undefined;
    return row ? runFromRow(row) : null;
  }

  listRuns(sessionId: string, limit = 50): RunRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM runs WHERE session_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(sessionId, limit) as unknown as RunRow[];
    return rows.map(runFromRow);
  }

  updateRun(
    id: string,
    update: Partial<Pick<RunRecord, 'status' | 'message' | 'error'>>,
  ): RunRecord | null {
    const run = this.getRun(id);
    if (!run) return null;
    this.db
      .prepare('UPDATE runs SET status=?, message=?, error=?, updated_at=? WHERE id=?')
      .run(update.status ?? run.status, update.message ?? run.message, update.error === undefined ? run.error : update.error, timestamp(), id);
    return this.getRun(id);
  }

  appendRunEvent(runId: string, type: string, data: Record<string, unknown>): StoredEvent {
    return this.appendEvent('run_events', 'run_id', runId, type, data);
  }

  listRunEvents(runId: string, after = 0): StoredEvent[] {
    return this.listEvents('run_events', 'run_id', runId, after);
  }

  createTerminal(command: string, cols: number, rows: number): TerminalRecord {
    const id = `term_${randomUUID()}`;
    const now = timestamp();
    this.db
      .prepare('INSERT INTO terminals (id,status,command,cols,rows,exit_code,error,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, 'starting', command, cols, rows, null, null, now, now);
    return this.getTerminal(id)!;
  }

  getTerminal(id: string): TerminalRecord | null {
    const row = this.db.prepare('SELECT * FROM terminals WHERE id = ?').get(id) as unknown as TerminalRow | undefined;
    return row ? terminalFromRow(row) : null;
  }

  updateTerminal(
    id: string,
    update: Partial<Pick<TerminalRecord, 'status' | 'cols' | 'rows' | 'exitCode' | 'error'>>,
  ): TerminalRecord | null {
    const terminal = this.getTerminal(id);
    if (!terminal) return null;
    this.db
      .prepare('UPDATE terminals SET status=?,cols=?,rows=?,exit_code=?,error=?,updated_at=? WHERE id=?')
      .run(
        update.status ?? terminal.status,
        update.cols ?? terminal.cols,
        update.rows ?? terminal.rows,
        update.exitCode === undefined ? terminal.exitCode : update.exitCode,
        update.error === undefined ? terminal.error : update.error,
        timestamp(),
        id,
      );
    return this.getTerminal(id);
  }

  appendTerminalEvent(terminalId: string, type: string, data: Record<string, unknown>): StoredEvent {
    return this.appendEvent('terminal_events', 'terminal_id', terminalId, type, data);
  }

  listTerminalEvents(terminalId: string, after = 0): StoredEvent[] {
    return this.listEvents('terminal_events', 'terminal_id', terminalId, after);
  }

  private appendEvent(
    table: 'run_events' | 'terminal_events',
    ownerColumn: 'run_id' | 'terminal_id',
    ownerId: string,
    type: string,
    data: Record<string, unknown>,
  ): StoredEvent {
    const row = this.db
      .prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM ${table} WHERE ${ownerColumn} = ?`)
      .get(ownerId) as unknown as { seq: number };
    const event = { seq: row.seq, type, data, createdAt: timestamp() };
    this.db
      .prepare(`INSERT INTO ${table} (${ownerColumn},seq,type,data_json,created_at) VALUES (?,?,?,?,?)`)
      .run(ownerId, event.seq, type, JSON.stringify(data), event.createdAt);
    return event;
  }

  private listEvents(
    table: 'run_events' | 'terminal_events',
    ownerColumn: 'run_id' | 'terminal_id',
    ownerId: string,
    after: number,
  ): StoredEvent[] {
    const rows = this.db
      .prepare(`SELECT seq,type,data_json,created_at FROM ${table} WHERE ${ownerColumn}=? AND seq>? ORDER BY seq`)
      .all(ownerId, after) as unknown as EventRow[];
    return rows.map((row) => ({
      seq: row.seq,
      type: row.type,
      data: JSON.parse(row.data_json) as Record<string, unknown>,
      createdAt: row.created_at,
    }));
  }
}

function sessionFromRow(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    title: row.title,
    provider: row.provider,
    model: row.model,
    history: JSON.parse(row.history_json) as Content[],
    uiMessages: JSON.parse(row.ui_messages_json ?? '[]') as Message[],
    inputHistory: JSON.parse(row.input_history_json ?? '[]') as string[],
    approvalMode: row.approval_mode ?? 'auto',
    client: row.client ?? 'api',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function runFromRow(row: RunRow): RunRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    status: row.status,
    input: row.input,
    provider: row.provider,
    model: row.model,
    message: row.message,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function terminalFromRow(row: TerminalRow): TerminalRecord {
  return {
    id: row.id,
    status: row.status,
    command: row.command,
    cols: row.cols,
    rows: row.rows,
    exitCode: row.exit_code,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function timestamp(): string {
  return new Date().toISOString();
}
