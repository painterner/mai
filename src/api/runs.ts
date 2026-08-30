import { buildSystemInstruction, runAgentTurn, type AgentEvent, type ApprovalRequest } from '../agent/loop.js';
import { ToolRegistry } from '../agent/tools.js';
import type { Config } from '../config.js';
import type { LlmClient } from '../llm/types.js';
import { EventBus } from './events.js';
import { ApiStore, type RunRecord, type SessionRecord, type StoredEvent } from './store.js';

interface ActiveRun {
  controller: AbortController;
  approval: ((approved: boolean) => void) | null;
  steering: string[];
}

interface QueuedRun {
  run: RunRecord;
  config: Config;
}

export interface RunManagerOptions {
  store: ApiStore;
  workspace: string;
  allowWrite: boolean;
  allowShell: boolean;
  approveRisky: boolean;
  sandboxBinary: string | null;
  selectConfig: (provider?: string, model?: string) => Config;
  createClient: (config: Config) => LlmClient;
}

export class RunManager {
  readonly events = new EventBus();
  private readonly active = new Map<string, ActiveRun>();
  private readonly activeSession = new Map<string, string>();
  private readonly queuedBySession = new Map<string, QueuedRun[]>();
  private shuttingDown = false;

  constructor(private readonly options: RunManagerOptions) {}

  start(
    session: SessionRecord,
    input: string,
    provider?: string,
    model?: string,
  ): RunRecord {
    const config = this.options.selectConfig(provider ?? session.provider, model ?? session.model);
    if (!config.apiKey) throw new RunInputError(`No API key configured for provider "${config.provider}".`);
    const run = this.options.store.createRun(session.id, input, config.provider, config.model);
    this.emit(run.id, 'run.queued', { sessionId: session.id });

    if (this.activeSession.has(session.id)) {
      const queue = this.queuedBySession.get(session.id) ?? [];
      queue.push({ run, config });
      this.queuedBySession.set(session.id, queue);
      return run;
    }

    this.launch(run, session, config);
    return run;
  }

  private launch(run: RunRecord, session: SessionRecord, config: Config): void {
    const active: ActiveRun = { controller: new AbortController(), approval: null, steering: [] };
    this.active.set(run.id, active);
    this.activeSession.set(session.id, run.id);
    void this.execute(run, session, config, active);
  }

  approve(runId: string, approved: boolean): RunRecord {
    const run = this.requireRun(runId);
    const active = this.active.get(runId);
    if (!active?.approval || run.status !== 'waiting_approval') {
      throw new RunConflictError('Run is not waiting for approval.');
    }
    const resolve = active.approval;
    active.approval = null;
    this.update(runId, 'running', approved ? 'run.approval_granted' : 'run.approval_denied', { approved });
    resolve(approved);
    return this.requireRun(runId);
  }

  steer(runId: string, message: string): RunRecord {
    const run = this.requireRun(runId);
    const active = this.active.get(runId);
    if (!active || !['running', 'waiting_approval'].includes(run.status)) {
      throw new RunConflictError('Run is not active.');
    }
    active.steering.push(message);
    this.emit(runId, 'run.steered', { message });
    return run;
  }

  stop(runId: string): RunRecord {
    const run = this.requireRun(runId);
    const active = this.active.get(runId);
    if (!active) {
      if (run.status === 'queued' && this.removeQueued(run)) {
        this.update(runId, 'cancelled', 'run.cancelled', {});
        return this.requireRun(runId);
      }
      return run;
    }
    active.controller.abort();
    const resolve = active.approval;
    active.approval = null;
    resolve?.(false);
    this.update(runId, 'cancelled', 'run.cancelled', {});
    return this.requireRun(runId);
  }

  stopAll(): void {
    this.shuttingDown = true;
    for (const runId of [...this.active.keys()]) this.stop(runId);
    for (const queue of this.queuedBySession.values()) {
      for (const { run } of queue) this.update(run.id, 'cancelled', 'run.cancelled', {});
    }
    this.queuedBySession.clear();
  }

  private async execute(
    run: RunRecord,
    session: SessionRecord,
    config: Config,
    active: ActiveRun,
  ): Promise<void> {
    this.update(run.id, 'running', 'run.started', {
      sessionId: session.id,
      provider: config.provider,
      model: config.model,
    });
    let message = '';
    try {
      // Recreate the registry per run so newly installed workspace skills are
      // visible without restarting the API process.
      const tools = await ToolRegistry.create(
        this.options.workspace,
        { write: this.options.allowWrite, shell: this.options.allowShell },
        this.options.sandboxBinary,
      );
      if (this.shuttingDown) return;
      const generator = runAgentTurn(
        {
          client: this.options.createClient(config),
          tools,
          systemInstruction: buildSystemInstruction(tools.workspacePath, tools.skillCatalog),
          signal: active.controller.signal,
          requestApproval: (request) => this.requestApproval(run.id, active, request),
          takeSteering: () => active.steering.splice(0),
        },
        session.history,
        run.input,
      );

      let step = await generator.next();
      while (!step.done) {
        if (this.shuttingDown) return;
        if (active.controller.signal.aborted) break;
        const event = step.value;
        if (event.type === 'text') message += event.text;
        this.emitAgentEvent(run.id, event);
        step = await generator.next();
      }

      if (this.shuttingDown) return;
      if (active.controller.signal.aborted) {
        this.update(run.id, 'cancelled', 'run.cancelled', {});
        return;
      }
      const history = step.done ? step.value : session.history;
      const failed = this.options.store
        .listRunEvents(run.id)
        .some((event) => event.type === 'agent.error');
      if (failed) {
        this.options.store.updateRun(run.id, { status: 'failed', message, error: 'Agent run failed' });
        this.emit(run.id, 'run.failed', { message, error: 'Agent run failed' });
        return;
      }
      this.options.store.updateSession(session.id, {
        history,
        provider: config.provider,
        model: config.model,
      });
      this.options.store.updateRun(run.id, { status: 'completed', message, error: null });
      this.emit(run.id, 'run.completed', { message });
    } catch (error) {
      if (this.shuttingDown) return;
      if (active.controller.signal.aborted) {
        this.update(run.id, 'cancelled', 'run.cancelled', {});
      } else {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.options.store.updateRun(run.id, { status: 'failed', message, error: errorMessage });
        this.emit(run.id, 'run.failed', { message, error: errorMessage });
      }
    } finally {
      this.active.delete(run.id);
      this.activeSession.delete(session.id);
      this.launchNext(session.id);
    }
  }

  private launchNext(sessionId: string): void {
    if (this.shuttingDown) return;
    const queue = this.queuedBySession.get(sessionId);
    if (!queue?.length) {
      this.queuedBySession.delete(sessionId);
      return;
    }

    const next = queue.shift()!;
    if (queue.length === 0) this.queuedBySession.delete(sessionId);
    const session = this.options.store.getSession(sessionId);
    if (!session) {
      if (this.options.store.getRun(next.run.id)) {
        this.options.store.updateRun(next.run.id, {
          status: 'failed',
          error: `Session ${sessionId} was deleted before the queued run started.`,
        });
        this.emit(next.run.id, 'run.failed', { error: `Session ${sessionId} no longer exists.` });
      }
      this.launchNext(sessionId);
      return;
    }
    this.launch(next.run, session, next.config);
  }

  private removeQueued(run: RunRecord): boolean {
    const queue = this.queuedBySession.get(run.sessionId);
    if (!queue) return false;
    const index = queue.findIndex((entry) => entry.run.id === run.id);
    if (index < 0) return false;
    queue.splice(index, 1);
    if (queue.length === 0) this.queuedBySession.delete(run.sessionId);
    return true;
  }

  private requestApproval(
    runId: string,
    active: ActiveRun,
    request: ApprovalRequest,
  ): Promise<boolean> {
    if (this.options.approveRisky) {
      this.emit(runId, 'run.approval_auto_granted', { ...request });
      return Promise.resolve(true);
    }
    this.options.store.updateRun(runId, { status: 'waiting_approval' });
    this.emit(runId, 'run.waiting_approval', { ...request });
    return new Promise<boolean>((resolve) => {
      active.approval = resolve;
    });
  }

  private emitAgentEvent(runId: string, event: AgentEvent): StoredEvent {
    return this.emit(runId, `agent.${event.type}`, event as unknown as Record<string, unknown>);
  }

  private update(
    runId: string,
    status: RunRecord['status'],
    eventType: string,
    data: Record<string, unknown>,
  ): void {
    this.options.store.updateRun(runId, { status });
    this.emit(runId, eventType, data);
  }

  private emit(runId: string, type: string, data: Record<string, unknown>): StoredEvent {
    const event = this.options.store.appendRunEvent(runId, type, data);
    this.events.publish(runId, event);
    return event;
  }

  private requireRun(runId: string): RunRecord {
    const run = this.options.store.getRun(runId);
    if (!run) throw new RunNotFoundError(`Run ${runId} was not found.`);
    return run;
  }
}

export class RunNotFoundError extends Error {}
export class RunConflictError extends Error {}
export class RunInputError extends Error {}
