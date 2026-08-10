import type { BudgetReport } from './types.js';
import type { TokenCounter } from './types.js';

export interface TokenBudgetOptions {
  windowTokens: number;
  reserveResponseRatio: number;
  reserveToolTokens: number;
}

export class TokenBudget {
  private parts: Array<{ label: string; tokens: number }> = [];
  private _used = 0;
  readonly opts: TokenBudgetOptions;

  constructor(private counter: TokenCounter, opts: Partial<TokenBudgetOptions> = {}) {
    this.opts = {
      windowTokens: opts.windowTokens ?? 16000,
      reserveResponseRatio: opts.reserveResponseRatio ?? 0.15,
      reserveToolTokens: opts.reserveToolTokens ?? 0,
    };
  }

  get windowTokens(): number {
    return this.opts.windowTokens;
  }

  get reserveResponse(): number {
    return Math.floor(this.opts.windowTokens * this.opts.reserveResponseRatio);
  }

  get reserveTools(): number {
    return this.opts.reserveToolTokens;
  }

  /** Tokens disponíveis para o contexto útil (janela - reserva de resposta - reserva de ferramentas). */
  get availableForContext(): number {
    return Math.max(0, this.opts.windowTokens - this.reserveResponse - this.reserveTools);
  }

  get used(): number {
    return this._used;
  }

  count(text: string): number {
    return this.counter.count(text);
  }

  add(label: string, text: string): number {
    const t = this.counter.count(text);
    this._used += t;
    this.parts.push({ label, tokens: t });
    return t;
  }

  addTokens(label: string, tokens: number): void {
    this._used += tokens;
    this.parts.push({ label, tokens });
  }

  fits(tokens: number): boolean {
    return this._used + tokens <= this.availableForContext;
  }

  reset(): void {
    this._used = 0;
    this.parts = [];
  }

  report(): BudgetReport {
    const total = this.availableForContext;
    const percent = total > 0 ? Math.min(100, Math.round((this._used / total) * 100)) : 0;
    return { total, used: this._used, percent, parts: this.parts };
  }

  formatBudget(): string {
    const total = this.availableForContext;
    const percent = total > 0 ? Math.min(100, Math.round((this._used / total) * 100)) : 0;
    const lines = [`Context budget: ${percent}% (${this._used}/${total} tokens)`];
    const totalUsed = Math.max(1, this._used);
    for (const p of this.parts) {
      const pct = Math.round((p.tokens / totalUsed) * 100);
      lines.push(`  ${p.label}: ${pct}% (${p.tokens})`);
    }
    return lines.join('\n');
  }
}
