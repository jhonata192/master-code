import type { ErrorRecord } from './types.js';

let errorCounter = 0;
function nextId(): string {
  return `err${++errorCounter}-${Date.now().toString(36)}`;
}

export class ErrorMemory {
  errors: ErrorRecord[] = [];

  get size(): number {
    return this.errors.length;
  }

  record(opts: {
    message: string;
    context: string;
    file?: string | null;
    solution?: string | null;
    tags?: string[];
  }): ErrorRecord {
    const existing = this.errors.find(
      (e) =>
        (e.message.trim().toLowerCase() === opts.message.trim().toLowerCase() || e.context.includes(opts.message)) &&
        !e.resolved
    );
    if (existing) {
      existing.count += 1;
      existing.lastSeen = Date.now();
      if (opts.solution) existing.solution = opts.solution;
      return existing;
    }
    const record: ErrorRecord = {
      id: nextId(),
      message: opts.message,
      context: opts.context,
      file: opts.file ?? null,
      solution: opts.solution ?? null,
      result: null,
      resolved: false,
      count: 1,
      ts: Date.now(),
      lastSeen: Date.now(),
      tags: opts.tags ?? [],
    };
    this.errors.push(record);
    return record;
  }

  markSolved(id: string, solution: string, result?: string): void {
    const e = this.errors.find((x) => x.id === id);
    if (!e) return;
    e.resolved = true;
    e.solution = solution;
    e.result = result ?? null;
  }

  markResolvedByMessage(message: string, solution: string): void {
    const e = this.errors.find(
      (x) => x.message.includes(message) || message.includes(x.message)
    );
    if (e) this.markSolved(e.id, solution);
  }

  active(): ErrorRecord[] {
    return this.errors
      .filter((e) => !e.resolved)
      .sort((a, b) => b.count - a.count || b.lastSeen - a.lastSeen);
  }

  forFile(file: string): ErrorRecord[] {
    return this.active().filter((e) => e.file === file);
  }

  render(e: ErrorRecord): string {
    const parts = [
      `[erro] ${e.message}`,
      e.context ? `Contexto: ${e.context}` : '',
      e.file ? `Arquivo: ${e.file}` : '',
      e.solution ? `Solucao aplicada: ${e.solution}` : '',
      e.result ? `Resultado: ${e.result}` : '',
      e.count > 1 ? `Ocorrencias: ${e.count}` : '',
      `Visto em: ${new Date(e.lastSeen).toLocaleString()}`,
    ];
    return parts.filter(Boolean).join('\n');
  }
}
