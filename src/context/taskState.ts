import type { TaskKind, TaskState } from './types.js';

export function detectTaskKind(text: string): TaskKind {
  const t = (text ?? '').toLowerCase();
  if (/(corrig|bug|erro|falha|não funciona|nao funciona|quebr|crashed|exception|fix)/i.test(t)) return 'bugfix';
  if (/(explique|explicar|o que é|o que e|como funciona|entender|entenda|resumir)/i.test(t)) return 'explain';
  if (/(refator|melhor|simplif|limp|reorganiz)/i.test(t)) return 'refactor';
  if (/(teste|test)/i.test(t)) return 'test';
  if (/(crie|criar|implemente|implementar|adicionar|adiciona|nova funcionalidade|feature|requisito)/i.test(t)) return 'feature';
  return 'general';
}

export function newTaskState(objective: string): TaskState {
  const kind = detectTaskKind(objective);
  return {
    objective,
    kind,
    subtasks: [],
    completed: [],
    pending: [objective],
    files: [],
    changes: [],
    testsRun: [],
    errors: [],
    decisions: [],
    nextStep: null,
  };
}

export function renderTaskState(s: TaskState): string {
  const lines = ['[Estado da tarefa]'];
  if (s.objective) lines.push(`Objetivo: ${s.objective}`);
  lines.push(`Tipo: ${s.kind}`);
  if (s.subtasks.length) lines.push(`Subtarefas: ${s.subtasks.join(' | ')}`);
  if (s.completed.length) lines.push(`Concluido: ${s.completed.join(' | ')}`);
  if (s.pending.length) lines.push(`Pendente: ${s.pending.join(' | ')}`);
  if (s.files.length) lines.push(`Arquivos: ${s.files.join(', ')}`);
  if (s.changes.length) lines.push(`Alteracoes: ${s.changes.join(' | ')}`);
  if (s.testsRun.length) lines.push(`Testes: ${s.testsRun.join(' | ')}`);
  if (s.errors.length) lines.push(`Erros: ${s.errors.join(' | ')}`);
  if (s.decisions.length) lines.push(`Decisoes: ${s.decisions.join(' | ')}`);
  if (s.nextStep) lines.push(`Proximo passo: ${s.nextStep}`);
  return lines.join('\n');
}
