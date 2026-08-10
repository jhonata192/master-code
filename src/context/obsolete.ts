import type { ContextEntry, DecisionRecord, ErrorRecord } from './types.js';
import type { FileContextCache } from './fileContext.js';

export interface ObsoleteResult {
  entriesMarked: string[];
  decisionsMarked: string[];
  errorsMarked: string[];
}

/**
 * Detecta informacoes potencialmente desatualizadas:
 * - arquivo foi alterado (entradas de conhecimento com file: tag)
 * - decisao substituida
 * - erro resolvido
 * - tarefa concluida (resumos de tarefas antigas com objetivo diferente)
 */
export class ObsoleteDetector {
  constructor(private fileCache: FileContextCache) {}

  detect(opts: {
    entries: ContextEntry[];
    decisions?: DecisionRecord[];
    errors?: ErrorRecord[];
    currentObjective?: string | null;
  }): ObsoleteResult {
    const result: ObsoleteResult = { entriesMarked: [], decisionsMarked: [], errorsMarked: [] };

    for (const e of opts.entries) {
      if (e.type === 'knowledge' && e.tags.some((t) => t.startsWith('file:'))) {
        const fileTags = e.tags.filter((t) => t.startsWith('file:'));
        for (const ft of fileTags) {
          const file = ft.slice(5);
          if (this.fileCache.isModifiedSinceCache(file)) {
            if (!e.obsolete) {
              e.obsolete = true;
              result.entriesMarked.push(e.id);
            }
          }
        }
      }
    }

    for (const d of opts.decisions ?? []) {
      if (d.supersededBy && !opts.entries.some((e) => e.id === d.id)) {
        result.decisionsMarked.push(d.id);
      }
    }

    for (const err of opts.errors ?? []) {
      if (err.resolved) {
        result.errorsMarked.push(err.id);
      }
    }

    return result;
  }

  apply(entries: ContextEntry[]): ContextEntry[] {
    return entries.filter((e) => !e.obsolete);
  }
}
