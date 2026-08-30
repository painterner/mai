export interface QueueSnapshot {
  /** Items waiting behind the one currently being processed. */
  waiting: number;
  running: boolean;
}

/**
 * A small, failure-tolerant FIFO executor.
 *
 * `enqueue()` never waits for the current item. The worker still receives
 * exactly one item at a time, and a failed item cannot strand later items.
 */
export class SerialQueue<T> {
  private readonly items: T[] = [];
  private active = false;
  private readonly idleWaiters: Array<() => void> = [];

  constructor(
    private readonly worker: (item: T) => Promise<void>,
    private readonly onChange: (snapshot: QueueSnapshot) => void = () => {},
    private readonly onError: (error: unknown, item: T) => void = () => {},
  ) {}

  get running(): boolean {
    return this.active;
  }

  get waiting(): number {
    return this.items.length;
  }

  enqueue(item: T): void {
    this.items.push(item);
    this.notify();
    void this.drain();
  }

  /** Remove items that have not started. The active worker is unaffected. */
  clearWaiting(): T[] {
    const removed = this.items.splice(0);
    this.notify();
    return removed;
  }

  waitForIdle(): Promise<void> {
    if (!this.active && this.items.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private async drain(): Promise<void> {
    if (this.active) return;
    this.active = true;
    this.notify();

    try {
      while (this.items.length > 0) {
        const item = this.items.shift()!;
        this.notify();
        try {
          await this.worker(item);
        } catch (error) {
          this.onError(error, item);
        }
      }
    } finally {
      this.active = false;
      this.notify();
      if (this.items.length > 0) {
        void this.drain();
      } else {
        this.idleWaiters.splice(0).forEach((resolve) => resolve());
      }
    }
  }

  private notify(): void {
    this.onChange({ waiting: this.items.length, running: this.active });
  }
}
