import type { StoredEvent } from './store.js';

type Listener = (event: StoredEvent) => void;

export class EventBus {
  private readonly listeners = new Map<string, Set<Listener>>();

  publish(ownerId: string, event: StoredEvent): void {
    for (const listener of this.listeners.get(ownerId) ?? []) listener(event);
  }

  subscribe(ownerId: string, listener: Listener): () => void {
    let listeners = this.listeners.get(ownerId);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(ownerId, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners?.delete(listener);
      if (listeners?.size === 0) this.listeners.delete(ownerId);
    };
  }
}
