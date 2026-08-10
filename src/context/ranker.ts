import type { Priority } from './types.js';

export const PRIORITY_WEIGHT: Record<Priority, number> = {
  critical: 100,
  high: 60,
  medium: 30,
  low: 10,
};

export function priorityOf(importance: number): Priority {
  if (importance >= 0.9) return 'critical';
  if (importance >= 0.7) return 'high';
  if (importance >= 0.4) return 'medium';
  return 'low';
}

export function comparePriority(a: Priority, b: Priority): number {
  return PRIORITY_WEIGHT[b] - PRIORITY_WEIGHT[a];
}
