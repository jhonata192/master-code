import type { AgentEvent } from './types.js';

export type AgentEventType = AgentEvent['type'];
export type AgentEventListener = (e: AgentEvent) => void;

export class EventBus {
  private typeListeners = new Map<AgentEventType, Set<AgentEventListener>>();
  private anyListeners = new Set<AgentEventListener>();

  on<T extends AgentEventType>(type: T, fn: (e: Extract<AgentEvent, { type: T }>) => void): () => void {
    const wrap: AgentEventListener = (e) => fn(e as Extract<AgentEvent, { type: T }>);
    let set = this.typeListeners.get(type);
    if (!set) {
      set = new Set();
      this.typeListeners.set(type, set);
    }
    set.add(wrap);
    return () => {
      set!.delete(wrap);
    };
  }

  onAny(fn: AgentEventListener): () => void {
    this.anyListeners.add(fn);
    return () => this.offAny(fn);
  }

  off(type: AgentEventType, fn: AgentEventListener): void {
    this.typeListeners.get(type)?.delete(fn);
  }

  offAny(fn: AgentEventListener): void {
    this.anyListeners.delete(fn);
  }

  emit(e: AgentEvent): void {
    const set = this.typeListeners.get(e.type);
    if (set) for (const fn of [...set]) fn(e);
    for (const fn of [...this.anyListeners]) fn(e);
  }

  clear(): void {
    this.typeListeners.clear();
    this.anyListeners.clear();
  }

  listenerCount(type: AgentEventType): number {
    return this.typeListeners.get(type)?.size ?? 0;
  }
}
