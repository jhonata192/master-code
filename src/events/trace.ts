import { EventBus } from './bus.js';
import type { AgentEvent, ToolCall, UsageInfo } from './types.js';
import { canonicalArgs } from './reason.js';

export interface TraceSummary {
  totalCalls: number;
  uniqueTools: number;
  duplicateCount: number;
  totalDurationMs: number;
  usageCount: number;
  usageTotal: UsageInfo;
  duplicateWarnings: string[];
}

export class TraceStore {
  private calls: ToolCall[] = [];
  private usageCount = 0;
  private usageTotal: UsageInfo = {};
  private duplicateWarnings: string[] = [];
  private seenKeys = new Map<string, number>();
  private bus: EventBus | null = null;
  private unsubscribe: Array<() => void> = [];

  attach(bus: EventBus): void {
    this.detach();
    this.bus = bus;
    this.unsubscribe.push(
      bus.on('tool_call_start', (e) => this.upsert(e.call)),
      bus.on('tool_call_end', (e) => this.upsert(e.call)),
      bus.on('tool_result', (e) => {
        this.upsert(e.call);
        this.checkDuplicate(e.call);
      }),
      bus.on('usage', (e) => {
        this.usageCount++;
        this.usageTotal.promptTokens =
          (this.usageTotal.promptTokens ?? 0) + (e.usage.promptTokens ?? 0);
        this.usageTotal.completionTokens =
          (this.usageTotal.completionTokens ?? 0) + (e.usage.completionTokens ?? 0);
        this.usageTotal.totalTokens =
          (this.usageTotal.totalTokens ?? 0) + (e.usage.totalTokens ?? 0);
      })
    );
  }

  detach(): void {
    for (const fn of this.unsubscribe) fn();
    this.unsubscribe = [];
    this.bus = null;
  }

  reset(): void {
    this.calls = [];
    this.usageCount = 0;
    this.usageTotal = {};
    this.duplicateWarnings = [];
    this.seenKeys.clear();
  }

  private upsert(call: ToolCall): void {
    const idx = this.calls.findIndex((c) => c.id === call.id);
    if (idx >= 0) this.calls[idx] = { ...this.calls[idx], ...call };
    else this.calls.push({ ...call });
  }

  private checkDuplicate(call: ToolCall): void {
    const key = `${call.tool}::${canonicalArgs(call.args)}`;
    const n = (this.seenKeys.get(key) ?? 0) + 1;
    this.seenKeys.set(key, n);
    if (n === 2) {
      const msg = `${call.tool} ${JSON.stringify(call.args).slice(0, 80)} (repetida ${n}x)`;
      this.duplicateWarnings.push(msg);
      this.bus?.emit({ type: 'warning', message: `chamada duplicada detectada: ${msg}` });
    }
  }

  list(): ToolCall[] {
    return [...this.calls];
  }

  countByTool(): Map<string, number> {
    const m = new Map<string, number>();
    for (const c of this.calls) m.set(c.tool, (m.get(c.tool) ?? 0) + 1);
    return m;
  }

  duplicates(): ToolCall[] {
    return this.calls.filter((c) => (this.seenKeys.get(`${c.tool}::${canonicalArgs(c.args)}`) ?? 0) > 1);
  }

  summary(): TraceSummary {
    let total = 0;
    for (const c of this.calls) total += c.durationMs ?? 0;
    return {
      totalCalls: this.calls.length,
      uniqueTools: this.countByTool().size,
      duplicateCount: this.seenKeys.size > 0 ? this.duplicates().length : 0,
      totalDurationMs: total,
      usageCount: this.usageCount,
      usageTotal: { ...this.usageTotal },
      duplicateWarnings: [...this.duplicateWarnings],
    };
  }

  render(): string {
    const s = this.summary();
    const lines: string[] = [];
    lines.push('Rastro da sessao');
    lines.push(
      `  Chamadas de ferramentas: ${s.totalCalls} | ${s.uniqueTools} usadas | ${s.duplicateCount} duplicadas`
    );
    lines.push(
      `  Uso do modelo: ${s.usageCount} respostas | prompt ${s.usageTotal.promptTokens ?? 0} | completion ${s.usageTotal.completionTokens ?? 0} | total ${s.usageTotal.totalTokens ?? 0} tokens`
    );
    lines.push(`  Tempo total em ferramentas: ${fmtDuration(s.totalDurationMs)}`);
    if (s.duplicateWarnings.length) {
      lines.push('');
      lines.push('Chamadas duplicadas:');
      for (const w of s.duplicateWarnings) lines.push('  - ' + w);
      lines.push('  (monitore: pode indicar loop)');
    }
    const calls = this.calls;
    if (calls.length) {
      lines.push('');
      lines.push('Ultimas chamadas:');
      for (const c of calls.slice(-10)) {
        const icon = c.status === 'ok' ? 'ok' : c.status === 'error' ? 'erro' : 'cancelado';
        const what = (c.reason ?? '').slice(0, 60);
        lines.push(
          `  [${c.tool}] ${icon} ${fmtDuration(c.durationMs)} ${what}`
        );
      }
    } else {
      lines.push('');
      lines.push('(nenhuma chamada ainda)');
    }
    return lines.join('\n');
  }
}

export function fmtDuration(ms?: number): string {
  if (ms == null || Number.isNaN(ms)) return '-';
  return ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : ms + 'ms';
}

export function eventsToJsonl(e: AgentEvent): string {
  return JSON.stringify({ ts: Date.now(), ...e });
}
