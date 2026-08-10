import type { ContextEntry, Priority } from './types.js';
import type { IntentResult } from './intent.js';
import { PRIORITY_WEIGHT } from './ranker.js';

export interface ScoredItem {
  entry: ContextEntry;
  score: number;
  breakdown: Record<string, number>;
  layer: number;
}

export interface ScorerInput {
  query?: string;
  intent: IntentResult;
  activeFiles: string[];
  taskObjective?: string | null;
  tokenBudgetRemaining: number;
  graphRelated: (file: string) => string[];
}

export class ContextScorer {
  score(entries: ContextEntry[], input: ScorerInput): ScoredItem[] {
    const q = (input.query ?? '').toLowerCase();
    const qTerms = q
      .split(/[^a-z0-9_.\-/]+/)
      .filter((t) => t.length >= 2);

    const scored: ScoredItem[] = entries.map((e) => {
      const breakdown: Record<string, number> = {};
      const content = (e.message.content ?? '').toLowerCase();
      const haystack = `${content} ${e.tags.join(' ')}`.toLowerCase();

      let relevance = 0;
      if (qTerms.length > 0) {
        for (const t of qTerms) {
          if (haystack.includes(t)) {
            relevance += 1;
            if (e.tags.some((tag) => tag.toLowerCase().includes(t))) relevance += 2;
          }
        }
        relevance = Math.min(3, relevance);
      }
      breakdown.relevance = relevance;

      const priorityScore = PRIORITY_WEIGHT[e.priority] / 100;
      breakdown.priority = priorityScore;

      const ageHours = Math.max(0, (Date.now() - e.ts) / 3600000);
      const recency = Math.max(0, 1 - ageHours / 24);
      breakdown.recency = recency;

      let fileRel = 0;
      const entryFiles = new Set<string>();
      for (const t of e.tags) if (t.startsWith('file:')) entryFiles.add(t.slice(5));
      if (e.relatedFiles) for (const f of e.relatedFiles) entryFiles.add(f);
      for (const f of entryFiles) {
        if (input.activeFiles.includes(f)) {
          fileRel += 2;
        } else {
          const related = input.graphRelated(f);
          if (related.some((r) => input.activeFiles.includes(r))) fileRel += 1;
        }
      }
      breakdown.fileRel = Math.min(2, fileRel);

      let taskRel = 0;
      if (input.taskObjective) {
        const t = input.taskObjective.toLowerCase();
        if (t && qTerms.length > 0) {
          const shared = qTerms.filter((term) => t.includes(term)).length;
          taskRel = Math.min(1, shared / Math.max(1, qTerms.length));
        }
        if (e.tags.includes('objetivo') || e.type === 'objective') taskRel = Math.max(taskRel, 1);
      }
      breakdown.taskRel = taskRel;

      let kind = 0;
      if (e.type === 'decision') kind = 0.8;
      else if (e.type === 'requirement') kind = 0.9;
      breakdown.kind = kind;

      let explicit = 0;
      if (e.source === 'explicit') explicit = 0.7;
      breakdown.explicit = explicit;

      let obsoletePenalty = 0;
      if (e.obsolete) obsoletePenalty = 1.5;
      breakdown.obsoletePenalty = -obsoletePenalty;

      let cost = 0;
      if (e.tokens > 0) cost = Math.min(1, e.tokens / 4000);
      breakdown.cost = -cost * 0.3;

      const intentBoost =
        (input.intent.weights.file ?? 0) * Math.min(1, fileRel) +
        (input.intent.weights.decision ?? 0) * (e.type === 'decision' ? 1 : 0) +
        (input.intent.weights.error ?? 0) * (e.tags.includes('erro') ? 1 : 0) +
        (input.intent.weights.requirement ?? 0) * (e.type === 'requirement' ? 1 : 0) +
        (input.intent.weights.recent ?? 0) * recency;
      breakdown.intent = Math.min(2, intentBoost);

      const score =
        relevance * 1.2 +
        priorityScore * 0.8 +
        recency * 0.5 +
        fileRel * 1.3 +
        taskRel * 1.0 +
        kind * 0.6 +
        explicit * 0.5 +
        intentBoost * 0.8 -
        obsoletePenalty -
        cost;

      const layer = e.obsolete ? 4 : e.type === 'knowledge' ? 3 : 2;

      return { entry: e, score, breakdown, layer };
    });

    return scored.sort((a, b) => b.score - a.score);
  }
}

export function priorityRank(p: Priority): number {
  return PRIORITY_WEIGHT[p];
}
