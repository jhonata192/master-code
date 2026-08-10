import type { ContextEntry } from './types.js';
import type { ScoredItem } from './scorer.js';

export interface RerankContext {
  activeFiles: string[];
  intent: string;
  query: string;
  graphRelated?: (file: string) => string[];
  tokenCount?: (text: string) => number;
}

/**
 * Segundo estagio de ranking. Entra com os candidatos ja pontuados pelo
 * ContextScorer e aplica refinamentos: penalidade por obsoletos, boost por
 * arquivos ativos, boost por intencao e deduplicacao por similaridade.
 * O corte por orcamento de tokens e feito pelo buildMessages por camada.
 */
export class Reranker {
  rerank(scored: ScoredItem[], ctx: RerankContext): Array<{ entry: ContextEntry; score: number; layer: number }> {
    const graphRelated = ctx.graphRelated ?? (() => []);

    const refined = scored.map((s) => {
      let score = s.score;

      if (s.entry.obsolete) score -= 2;

      const related = new Set<string>();
      for (const t of s.entry.tags) if (t.startsWith('file:')) related.add(t.slice(5));
      for (const f of s.entry.relatedFiles ?? []) related.add(f);
      for (const f of related) {
        for (const active of ctx.activeFiles) {
          if (f === active) score += 1.5;
          else if (graphRelated(f).includes(active)) score += 0.75;
        }
      }

      if (ctx.intent === 'bugfix' && s.entry.tags.includes('erro')) score += 0.6;
      if (ctx.intent === 'explain' && (s.entry.type === 'decision' || s.entry.type === 'requirement')) score += 0.5;

      return { entry: s.entry, score, layer: s.layer };
    });

    refined.sort((a, b) => b.score - a.score);

    const out: Array<{ entry: ContextEntry; score: number; layer: number }> = [];
    const seen = new Set<string>();
    for (const item of refined) {
      const content = item.entry.message.content ?? '';
      const sig = content.slice(0, 200).toLowerCase();
      if (seen.has(sig)) continue;
      seen.add(sig);
      out.push(item);
    }
    return out;
  }
}
