import type { Retriever } from './types.js';

export class KeywordRetriever implements Retriever {
  search(
    records: Array<{ text: string; tags: string[] }>,
    query: string,
    k: number
  ): Array<{ index: number; score: number }> {
    const terms = query
      .toLowerCase()
      .split(/[^a-z0-9_.\-/]+/)
      .filter((t) => t.length >= 2);

    if (terms.length === 0) return [];

    const scored = records.map((rec, index) => {
      const haystack = `${rec.text} ${rec.tags.join(' ')}`.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (haystack.includes(term)) score += 1;
        if (rec.tags.some((t) => t.toLowerCase().includes(term))) score += 2;
      }
      return { index, score };
    });

    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }
}
