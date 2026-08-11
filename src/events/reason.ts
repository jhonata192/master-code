interface TaskStateLike {
  pending: string[];
  nextStep: string | null;
}

export interface ReasonSource {
  getTaskState(): TaskStateLike | null;
}

function operationBase(tool: string, args: Record<string, unknown>): string {
  switch (tool) {
    case 'read_file':
      return `analisar ${args.path ?? ''}`;
    case 'write_file':
      return `gravar ${args.path ?? ''}`;
    case 'edit_file':
      return `editar ${args.path ?? ''}`;
    case 'list_dir':
      return `listar ${args.path ?? '.'}`;
    case 'search_text':
      return `localizar "${args.pattern ?? ''}"`;
    case 'run_command':
      return `executar ${String(args.command ?? '').slice(0, 80)}`;
    default:
      return tool;
  }
}

export function deriveToolReason(
  tool: string,
  args: Record<string, unknown>,
  ctx?: ReasonSource
): string {
  const base = operationBase(tool, args);
  const ts = ctx?.getTaskState?.() ?? null;
  const step = ts?.nextStep ?? ts?.pending?.[0];
  const reason = step ? `${base} (etapa: ${String(step).slice(0, 60)})` : base;
  return reason.slice(0, 200);
}

export function canonicalArgs(args: Record<string, unknown>): string {
  try {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(args).sort()) sorted[k] = args[k];
    return JSON.stringify(sorted);
  } catch {
    return JSON.stringify(args);
  }
}

export function truncate(text: string, max: number): string {
  if (!text || text.length <= max) return text ?? '';
  return text.slice(0, max) + '…';
}
