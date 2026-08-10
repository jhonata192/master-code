import { stat, readFile } from 'node:fs/promises';
import { statSync } from 'node:fs';

export interface FileCacheEntry {
  path: string;
  content: string;
  tokens: number;
  mtimeMs: number;
  size: number;
}

export class FileContextCache {
  private entries = new Map<string, FileCacheEntry>();
  private lastUsed = new Map<string, number>();
  readonly maxEntries: number;
  readonly maxTokensPerFile: number;
  readonly totalTokenLimit: number;
  private _totalTokens = 0;

  constructor(opts: { maxEntries?: number; maxTokensPerFile?: number; totalTokenLimit?: number } = {}) {
    this.maxEntries = opts.maxEntries ?? 20;
    this.maxTokensPerFile = opts.maxTokensPerFile ?? 2000;
    this.totalTokenLimit = opts.totalTokenLimit ?? 6000;
  }

  get totalTokens(): number {
    return this._totalTokens;
  }

  get count(): number {
    return this.entries.size;
  }

  private touch(path: string): void {
    this.lastUsed.set(path, Date.now());
  }

  async getOrRead(path: string, tokenCounter: { count(text: string): number }): Promise<FileCacheEntry | null> {
    try {
      const st = await stat(path);
      if (st.isDirectory()) return null;

      const cached = this.entries.get(path);
      if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
        this.touch(path);
        return cached;
      }

      const content = await readFile(path, 'utf8');
      const tokens = tokenCounter.count(content);
      const truncated =
        tokens > this.maxTokensPerFile
          ? `${content.slice(0, Math.floor(this.maxTokensPerFile * 4))}\n...(truncado)`
          : content;
      const finalTokens = tokenCounter.count(truncated);

      const entry: FileCacheEntry = {
        path,
        content: truncated,
        tokens: finalTokens,
        mtimeMs: st.mtimeMs,
        size: st.size,
      };

      const prev = this.entries.get(path);
      if (prev) this._totalTokens -= prev.tokens;
      this.entries.set(path, entry);
      this._totalTokens += finalTokens;
      this.touch(path);

      await this.evictIfNeeded();
      return entry;
    } catch {
      return null;
    }
  }

  async invalidate(path: string): Promise<void> {
    const prev = this.entries.get(path);
    if (prev) {
      this._totalTokens -= prev.tokens;
      this.entries.delete(path);
      this.lastUsed.delete(path);
    }
  }

  /** true se o arquivo mudou no disco em relacao ao que esta em cache (nao async). */
  isModifiedSinceCache(path: string): boolean {
    const cached = this.entries.get(path);
    if (!cached) return false;
    try {
      const st = statSync(path);
      return st.mtimeMs !== cached.mtimeMs || st.size !== cached.size;
    } catch {
      return true;
    }
  }

  async invalidatePrefix(dir: string): Promise<number> {
    const prefix = dir.endsWith('/') ? dir : dir + '/';
    let removed = 0;
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(prefix)) {
        await this.invalidate(key);
        removed++;
      }
    }
    return removed;
  }

  list(): FileCacheEntry[] {
    return [...this.entries.values()];
  }

  private async evictIfNeeded(): Promise<void> {
    while (this._totalTokens > this.totalTokenLimit || this.entries.size > this.maxEntries) {
      const lru = [...this.lastUsed.entries()].sort((a, b) => a[1] - b[1]);
      if (lru.length === 0) break;
      await this.invalidate(lru[0][0]);
    }
  }

  async reset(): Promise<void> {
    this.entries.clear();
    this.lastUsed.clear();
    this._totalTokens = 0;
  }
}
