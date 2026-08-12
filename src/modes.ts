import type { AgentMode } from './context/types.js';

export type { AgentMode } from './context/types.js';

export const MODE_LABEL: Record<AgentMode, string> = {
  build: 'BUILD',
  plan: 'PLAN',
};

const MODE_ORDER: AgentMode[] = ['build', 'plan'];

export function isAgentMode(v: unknown): v is AgentMode {
  return v === 'build' || v === 'plan';
}

export function parseDefaultMode(v: unknown): AgentMode {
  return v === 'plan' ? 'plan' : 'build';
}

export function switchModeForward(mode: AgentMode): AgentMode {
  const i = MODE_ORDER.indexOf(mode);
  return MODE_ORDER[(i + 1) % MODE_ORDER.length];
}

export function switchModeReverse(mode: AgentMode): AgentMode {
  const i = MODE_ORDER.indexOf(mode);
  return MODE_ORDER[(i - 1 + MODE_ORDER.length) % MODE_ORDER.length];
}

/**
 * Tools sempre permitidas no modo PLAN (somente leitura).
 */
const PLAN_READ_TOOLS = new Set(['read_file', 'list_dir', 'search_text']);

/**
 * Tools de modificacao do projeto.
 */
const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'patch_file', 'delete_file', 'move_file', 'rename_file']);

/**
 * Comandos git de somente leitura permitidos no modo PLAN via run_command.
 */
const GIT_READ_CMD = /^git\s+(status|diff|log|show|blame|branch|ls-files|rev-parse|remote|submodule|config|tag|stash\s+list)\b/i;

export interface AuthorizationResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Politica central de ferramentas por modo.
 *
 * BUILD: permite tudo (a autorizacao adicional continua valida no executor).
 * PLAN: somente leitura + git read via run_command; nunca modifica o projeto.
 */
export function authorizeTool(mode: AgentMode, tool: string, args?: Record<string, unknown>): AuthorizationResult {
  if (mode === 'build') return { allowed: true };

  if (PLAN_READ_TOOLS.has(tool)) return { allowed: true };

  if (tool === 'run_command') {
    const command = typeof args?.command === 'string' ? args.command.trim() : '';
    if (GIT_READ_CMD.test(command)) return { allowed: true };
    return { allowed: false, reason: `${tool} is unavailable in PLAN mode` };
  }

  if (WRITE_TOOLS.has(tool)) {
    return { allowed: false, reason: `${tool} is unavailable in PLAN mode` };
  }

  return { allowed: false, reason: `${tool} is unavailable in PLAN mode` };
}

/**
 * Filtra o registro de tools de acordo com o modo.
 * PLAN expoe somente tools de leitura + run_command (git read).
 */
export function toolsForMode<T extends { type: string; function: { name?: string } }>(
  mode: AgentMode,
  all: T[]
): T[] {
  if (mode === 'build') return all;
  return all.filter((t) => {
    const name = t.function?.name ?? '';
    return PLAN_READ_TOOLS.has(name) || name === 'run_command';
  });
}

export function modeSystemPrompt(mode: AgentMode): string {
  if (mode === 'plan') {
    return `current_mode=PLAN
[modo PLAN]
Voce esta no modo PLAN.

Voce e o agente de analise e planejamento.

Seu objetivo e compreender o problema e produzir um plano de implementacao.

Voce pode ler e analisar o projeto utilizando as ferramentas de leitura disponiveis (ler arquivos, listar diretorios, pesquisar texto, git status/diff/log).

Voce NAO deve modificar arquivos do projeto.
Voce NAO deve executar comandos arbitrarios.
Voce NAO deve utilizar write, edit, patch, delete ou bash.

Quando tiver informacoes suficientes, produza um plano claro e executavel.

Nao invente informacoes sobre o projeto.`;
  }
  return `current_mode=BUILD
[modo BUILD]
Voce esta no modo BUILD.

Voce e o agente de implementacao.

Voce pode modificar o projeto utilizando as ferramentas disponiveis.

Antes de modificar arquivos:
- compreenda a solicitacao;
- inspecione o codigo relevante quando necessario;
- faca alteracoes coerentes;
- valide as alteracoes;
- execute testes quando apropriado.

Nao execute ferramentas sem necessidade.
Nao invente estado do projeto.
Nao assuma que uma tarefa anterior ainda esta ativa sem evidencia.`;
}
