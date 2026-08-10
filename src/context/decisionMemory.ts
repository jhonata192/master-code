import type { DecisionRecord, Priority } from './types.js';

let decisionCounter = 0;
function nextId(): string {
  return `d${++decisionCounter}-${Date.now().toString(36)}`;
}

export class DecisionMemory {
  decisions: DecisionRecord[] = [];

  get size(): number {
    return this.decisions.length;
  }

  add(opts: {
    decision: string;
    reason: string;
    context: string;
    files?: string[];
    supersedes?: string | null;
    tags?: string[];
    priority?: Priority;
  }): DecisionRecord {
    const record: DecisionRecord = {
      id: nextId(),
      decision: opts.decision,
      reason: opts.reason,
      context: opts.context,
      ts: Date.now(),
      files: opts.files ?? [],
      supersedes: opts.supersedes ?? null,
      supersededBy: null,
      tags: opts.tags ?? [],
      priority: opts.priority ?? 'medium',
    };

    if (record.supersedes) {
      const prev = this.decisions.find((d) => d.id === record.supersedes);
      if (prev) prev.supersededBy = record.id;
    }

    this.decisions.push(record);
    this.cleanupSuperseded();
    return record;
  }

  /** Substituicao automatica por equivalencia (mesmo topico/nicho). */
  addReplacingByTopic(opts: {
    decision: string;
    reason: string;
    context: string;
    topic: string;
    files?: string[];
    tags?: string[];
  }): DecisionRecord {
    const existing = this.decisions
      .filter((d) => !d.supersededBy)
      .find((d) => d.tags.includes(opts.topic) || d.context.toLowerCase().includes(opts.topic.toLowerCase()));
    const record = this.add({
      ...opts,
      files: opts.files,
      tags: [...(opts.tags ?? []), opts.topic],
      supersedes: existing ? existing.id : null,
    });
    return record;
  }

  private cleanupSuperseded(): void {
    for (const d of this.decisions) {
      if (d.supersededBy) {
        d.priority = 'low';
      }
    }
  }

  active(): DecisionRecord[] {
    return this.decisions
      .filter((d) => !d.supersededBy)
      .sort((a, b) => pri(a.priority) - pri(b.priority) || b.ts - a.ts);
  }

  superseded(): DecisionRecord[] {
    return this.decisions.filter((d) => d.supersededBy);
  }

  forFile(file: string): DecisionRecord[] {
    return this.active().filter((d) => d.files.includes(file));
  }

  render(d: DecisionRecord): string {
    const parts = [
      `[decisao] ${d.decision}`,
      `Motivo: ${d.reason}`,
      d.context ? `Contexto: ${d.context}` : '',
      d.files.length ? `Arquivos afetados: ${d.files.join(', ')}` : '',
      d.supersedes ? `Substitui: ${this.decisions.find((x) => x.id === d.supersedes)?.decision ?? d.supersedes}` : '',
      d.supersededBy ? `Substituida por: ${this.decisions.find((x) => x.id === d.supersededBy)?.decision ?? d.supersededBy}` : '',
      `Data: ${new Date(d.ts).toISOString()}`,
    ];
    return parts.filter(Boolean).join('\n');
  }
}

function pri(p: Priority): number {
  return { critical: 0, high: 1, medium: 2, low: 3 }[p];
}
