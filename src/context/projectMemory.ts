import type { MemoryFact, Priority } from './types.js';

let factCounter = 0;
function nextFactId(): string {
  return `f${++factCounter}-${Date.now().toString(36)}`;
}

export class ProjectMemory {
  facts: MemoryFact[] = [];

  get size(): number {
    return this.facts.length;
  }

  get totalTokens(): number {
    return this.facts.reduce((s, f) => s + f.content.length, 0);
  }

  add(
    category: string,
    content: string,
    opts: { tags?: string[]; priority?: Priority } = {}
  ): MemoryFact {
    const fact: MemoryFact = {
      id: nextFactId(),
      category,
      content,
      tags: opts.tags ?? [],
      priority: opts.priority ?? 'medium',
      ts: Date.now(),
    };
    this.facts.push(fact);
    return fact;
  }

  /** Remove fatos duplicados/equivalentes ao adicionar (invalida informacao antiga). */
  addReplacing(
    category: string,
    content: string,
    opts: { tags?: string[]; priority?: Priority } = {}
  ): MemoryFact {
    const tags = opts.tags ?? [];
    const overlap = this.facts.filter(
      (f) =>
        f.category === category &&
        (tags.length === 0 ||
          f.tags.some((t) => tags.includes(t)) ||
          f.content.includes(tags[0] ?? '\u0000'))
    );
    for (const f of overlap) {
      this.facts = this.facts.filter((x) => x.id !== f.id);
    }
    return this.add(category, content, opts);
  }

  /** Fatos por categoria, prioridade e recente. */
  all(): MemoryFact[] {
    const order: Record<Priority, number> = { critical: 0, high: 1, medium: 2, low: 3 };
    return [...this.facts].sort((a, b) => order[a.priority] - order[b.priority] || b.ts - a.ts);
  }

  byCategory(category: string): MemoryFact[] {
    return this.facts.filter((f) => f.category === category);
  }
}
