import type { ChangeRecord } from './types.js';

let changeCounter = 0;
function nextId(): string {
  return `chg${++changeCounter}-${Date.now().toString(36)}`;
}

export class ChangeMemory {
  changes: ChangeRecord[] = [];

  get size(): number {
    return this.changes.length;
  }

  get totalTokens(): number {
    return this.changes.reduce((s, c) => s + c.tokens, 0);
  }

  add(opts: {
    file: string;
    operation: ChangeRecord['operation'];
    reason: string;
    summary: string;
    task?: string | null;
    tags?: string[];
  }, tokenCount: (s: string) => number): ChangeRecord {
    const record: ChangeRecord = {
      id: nextId(),
      file: opts.file,
      operation: opts.operation,
      reason: opts.reason,
      summary: opts.summary,
      task: opts.task ?? null,
      ts: Date.now(),
      tokens: tokenCount(opts.summary),
      tags: opts.tags ?? [],
    };
    this.changes.push(record);
    if (this.changes.length > 200) {
      this.changes = this.changes.slice(-200);
    }
    return record;
  }

  forFile(file: string): ChangeRecord[] {
    return this.changes
      .filter((c) => c.file === file)
      .sort((a, b) => b.ts - a.ts);
  }

  recent(limit = 10): ChangeRecord[] {
    return [...this.changes].sort((a, b) => b.ts - a.ts).slice(0, limit);
  }

  render(c: ChangeRecord): string {
    return [
      `[alteracao:${c.operation}] ${c.file}`,
      c.reason ? `Motivo: ${c.reason}` : '',
      `Resumo: ${c.summary}`,
      c.task ? `Tarefa: ${c.task}` : '',
      `Quando: ${new Date(c.ts).toLocaleString()}`,
    ]
      .filter(Boolean)
      .join('\n');
  }
}
