import type { ContextEntry, StoredMessage } from './types.js';

export const LAYER_0_MANDATORY = 0;
export const LAYER_1_STATE = 1;
export const LAYER_2_RECENT = 2;
export const LAYER_3_RELEVANT = 3;
export const LAYER_4_HISTORY = 4;

export interface LayerLabel {
  layer: number;
  label: string;
}

export function layerOfEntry(e: ContextEntry): number {
  if (e.type === 'summary' || e.type === 'continuity' || e.type === 'objective') return LAYER_1_STATE;
  if (e.scope === 'project' && e.type === 'knowledge') return LAYER_3_RELEVANT;
  if (e.scope === 'task' && (e.type === 'decision' || e.type === 'requirement')) return LAYER_3_RELEVANT;
  return LAYER_2_RECENT;
}

export function layerOfMessage(m: StoredMessage): number {
  if (m.role === 'system') return LAYER_3_RELEVANT;
  return LAYER_2_RECENT;
}

export const LAYER_NAMES: Record<number, string> = {
  [LAYER_0_MANDATORY]: 'obrigatoria',
  [LAYER_1_STATE]: 'estado atual',
  [LAYER_2_RECENT]: 'recente',
  [LAYER_3_RELEVANT]: 'relevante',
  [LAYER_4_HISTORY]: 'historico',
};

export function formatLayerHeader(layer: number): string {
  return `[camada ${layer}: ${LAYER_NAMES[layer] ?? '?'}]`;
}
