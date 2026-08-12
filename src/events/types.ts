export type ToolStatus = 'ok' | 'error' | 'cancelled';

export interface UsageInfo {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface ToolCall {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  argsJson: string;
  reason?: string;
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
  status?: ToolStatus;
  result?: string;
  resultTruncated?: boolean;
  error?: string;
}

export type AgentEvent =
  | { type: 'task_start'; task: string; model: string }
  | {
      type: 'task_end';
      status: 'ok' | 'error' | 'cancelled';
      text?: string;
      model?: string;
      iterations?: number;
      error?: string;
    }
  | { type: 'plan'; steps: number; summary: string }
  | { type: 'task_step'; index: number; total: number; title: string }
  | { type: 'task_step_end'; index: number; total: number; title: string }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call_start'; call: ToolCall }
  | { type: 'tool_call_args'; callId: string; argsDelta: string }
  | { type: 'tool_call_end'; call: ToolCall }
  | { type: 'tool_result'; call: ToolCall }
  | { type: 'error'; message: string; fatal?: boolean }
  | { type: 'warning'; message: string }
  | { type: 'retry'; tool: string; attempt: number; reason?: string }
  | { type: 'usage'; model: string; usage: UsageInfo }
  | { type: 'compaction'; state: 'start' | 'done'; before: number; after?: number }
  | { type: 'context_update'; entries: number; tokens: number; changes: number }
  | { type: 'agent'; message: string }
  | { type: 'mode_change'; from: string; to: string }
  | { type: 'tool_gate'; mode: string; tool: string; allowed: boolean; reason?: string };
