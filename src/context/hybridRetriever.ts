import type { HybridHit, HybridRetrieverLike, HybridSearchRecord } from './types.js';

export interface HybridWeights {
  keyword: number;
  tags: number;
  priority: number;
  recency: number;
  fileRelation: number;
}

export interface HybridOptions {
  activeFiles?: string[];
  intentWeights?: Record<string, number>;
  weights?: HybridWeights;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_.\-/]+/)
    .filter((t) => t.length >= 2);
}

function recencyFactor(ts: number): number {
  const ageHours = Math.max(0, (Date.now() - ts) / 3600000);
  return Math.max(0, 1 - ageHours / 48);
}

export class HybridRetriever implements HybridRetrieverLike {
  private weights: HybridWeights;

  constructor(private opts: HybridOptions = {}) {
    this.weights = opts.weights ?? {
      keyword: 1.0,
      tags: 0.8,
      priority: 0.6,
      recency: 0.4,
      fileRelation: 0.9,
    };
  }

  search(records: HybridSearchRecord[], query: string, k: number): HybridHit[] {
    const terms = tokenize(query);
    const activeFiles = this.opts.activeFiles ?? [];
    const intentWeights = this.opts.intentWeights ?? {};

    const hits: HybridHit[] = [];
    for (let i = 0; i < records.length; i++) {
      const rec = records[i];
      const haystack = `${rec.text} ${rec.tags.join(' ')}`.toLowerCase();
      const reasons: string[] = [];
      let score = 0;

      let kw = 0;
      let matched = 0;
      for (const term of terms) {
        if (haystack.includes(term)) {
          kw += 1;
          matched++;
        }
      }
      if (kw > 0) {
        score += kw * this.weights.keyword;
        reasons.push(`keyword(${kw})`);
      }

      let tg = 0;
      for (const term of terms) {
        if (rec.tags.some((t) => t.toLowerCase().includes(term))) {
          tg += 1;
          reasons.push('tag');
        }
      }
      score += tg * this.weights.tags;

      score += (rec.priority ?? 0) * this.weights.priority;
      score += recencyFactor(rec.ts) * this.weights.recency;

      let fr = 0;
      for (const f of rec.relatedFiles ?? []) {
        if (activeFiles.includes(f)) {
          fr += 2;
          reasons.push('arquivo ativo');
        }
      }
      score += fr * this.weights.fileRelation;

      const matchedRatio = terms.length > 0 ? matched / terms.length : 0;
      if (matchedRatio >= 0.8) reasons.push('forte correspondencia');
      else if (matchedRatio >= 0.5) reasons.push('correspondencia parcial');

      for (const [k2, w] of Object.entries(intentWeights)) {
        if (rec.tags.includes(k2) || haystack.includes(k2)) {
          score += (w ?? 0) * 0.5;
          reasons.push(`intent:${k2}`);
        }
      }

      if (score > 0) hits.push({ index: i, score, reasons: reasons.slice(0, 4) });
    }

    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, k);
  }

  withContext(opts: HybridOptions): HybridRetriever {
    return new HybridRetriever({
      ...this.opts,
      ...opts,
      weights: opts.weights ?? this.weights,
    });
  }
}

export class CompositeHybridRetriever implements HybridRetrieverLike {
  constructor(private retrievers: HybridRetrieverLike[]) {}

  search(records: HybridSearchRecord[], query: string, k: number): HybridHit[] {
    const merged = new Map<number, { score: number; reasons: string[] }>();
    for (const r of this.retrievers) {
      for (const hit of r.search(records, query, k * 3)) {
        const cur = merged.get(hit.index) ?? { score: 0, reasons: [] };
        cur.score += hit.score;
        cur.reasons.push(...hit.reasons);
        merged.set(hit.index, cur);
      }
    }
    return [...merged.entries()]
      .map(([index, v]) => ({ index, score: v.score, reasons: v.reasons.slice(0, 4) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }
}

/**
 * Abstração futura para embeddings/vector/BM25.
 * Para adicionar: implemente HybridRetrieverLike e registre no CompositeHybridRetriever.
 */
export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
}

export class EmbeddingAwareRetriever {
  constructor(private provider: EmbeddingProvider) {}

  async search(records: HybridSearchRecord[], query: string, k: number): Promise<HybridHit[]> {
    const qv = await this.provider.embed(query);
    const scored: Array<{ index: number; score: number; reasons: string[] }> = [];
    for (let i = 0; i < records.length; i++) {
      const rv = await this.provider.embed(records[i].text);
      const sim = cosine(qv, rv);
      if (sim > 0) scored.push({ index: i, score: sim, reasons: ['embedding'] });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, k);
  }
}

function cosine(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const den = Math.sqrt(na) * Math.sqrt(nb);
  return den === 0 ? 0 : dot / den;
}
