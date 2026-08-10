import type { Retriever, SearchRecord } from './types.js';

export interface MatchReason {
  kind: 'keyword' | 'file' | 'category' | 'recent' | 'priority';
  detail: string;
}

export interface SemanticHit {
  index: number;
  score: number;
  reason: string;
}

export interface SemanticRetriever {
  search(records: SearchRecord[], query: string, k: number): SemanticHit[];
}

export class KeywordSemanticRetriever implements SemanticRetriever {
  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .split(/[^a-z0-9_.\-/]+/)
      .filter((t) => t.length >= 2);
  }

  search(records: SearchRecord[], query: string, k: number): SemanticHit[] {
    const terms = this.tokenize(query);
    if (terms.length === 0) return [];

    const hits: SemanticHit[] = [];
    for (let i = 0; i < records.length; i++) {
      const rec = records[i];
      const haystack = `${rec.text} ${rec.tags.join(' ')}`.toLowerCase();
      let score = 0;
      let matchedTerms = 0;
      for (const term of terms) {
        if (haystack.includes(term)) {
          score += 1;
          matchedTerms++;
          if (rec.tags.some((t) => t.toLowerCase().includes(term))) score += 2;
        }
      }
      if (score > 0) {
        const ratio = matchedTerms / Math.max(1, terms.length);
        const reason =
          ratio >= 0.8
            ? `forte correspondencia com a consulta`
            : ratio >= 0.5
              ? `correspondencia parcial com a consulta`
              : `correspondencia fraca com a consulta`;
        hits.push({ index: i, score: score * (0.5 + ratio * 0.5), reason });
      }
    }

    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, k);
  }
}

export class CompositeSemanticRetriever implements SemanticRetriever {
  constructor(private primary: SemanticRetriever) {}

  search(records: SearchRecord[], query: string, k: number): SemanticHit[] {
    return this.primary.search(records, query, k);
  }
}
