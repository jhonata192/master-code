import type { ContextEntry, MemoryFact } from './types.js';

export interface CacheEntry {
  key: string;
  content: string;
  tokens: number;
  ts: number;
}

export interface CacheableSource {
  entries: ContextEntry[];
  facts: MemoryFact[];
}

export class ContextCache {
  private items = new Map<string, CacheEntry>();
  readonly maxItems: number;
  readonly maxTokensPerItem: number;
  readonly totalTokenLimit: number;
  private _totalTokens = 0;

  constructor(opts: { maxItems?: number; maxTokensPerItem?: number; totalTokenLimit?: number } = {}) {
    this.maxItems = opts.maxItems ?? 50;
    this.maxTokensPerItem = opts.maxTokensPerItem ?? 1500;
    this.totalTokenLimit = opts.totalTokenLimit ?? 10000;
  }

  get totalTokens(): number {
    return this._totalTokens;
  }

  get count(): number {
    return this.items.size;
  }

  get(key: string): CacheEntry | undefined {
    const e = this.items.get(key);
    if (e) e.ts = Date.now();
    return e;
  }

  set(key: string, content: string, tokens: number): void {
    const prev = this.items.get(key);
    if (prev) this._totalTokens -= prev.tokens;
    this.items.set(key, { key, content, tokens, ts: Date.now() });
    this._totalTokens += tokens;
    this.evictIfNeeded();
  }

  has(key: string): boolean {
    return this.items.has(key);
  }

  private evictIfNeeded(): void {
    while (this._totalTokens > this.totalTokenLimit || this.items.size > this.maxItems) {
      const lru = [...this.items.values()].sort((a, b) => a.ts - b.ts);
      if (lru.length === 0) break;
      const victim = lru[0];
      this._totalTokens -= victim.tokens;
      this.items.delete(victim.key);
    }
  }

  reset(): void {
    this.items.clear();
    this._totalTokens = 0;
  }
}
