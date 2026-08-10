import type { TokenCounter } from './types.js';

export class HeuristicTokenCounter implements TokenCounter {
  constructor(private charsPerToken = 4) {}

  count(text: string): number {
    if (!text) return 0;
    return Math.ceil(text.length / this.charsPerToken);
  }
}
