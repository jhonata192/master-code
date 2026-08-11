import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  ArchiveRecord,
  ContextEntry,
  ContextManagerOptions,
  ContinuityState,
  DecisionRecord,
  ErrorRecord,
  ChangeRecord,
  MemoryFact,
  Priority,
  SerializedSession,
  StoredMessage,
  TaskState,
  ToolDisposition,
} from './types.js';
import { ProjectMemory } from './projectMemory.js';
import { FileContextCache } from './fileContext.js';
import { ContextCache } from './cache.js';
import { KeywordSemanticRetriever } from './semanticRetriever.js';
import type { SemanticRetriever, SemanticHit } from './semanticRetriever.js';
import { HybridRetriever } from './hybridRetriever.js';
import type { HybridRetrieverLike } from './types.js';
import { TokenBudget } from './budget.js';
import { newTaskState, renderTaskState, detectTaskKind } from './taskState.js';
import { priorityOf } from './ranker.js';
import { detectIntent } from './intent.js';
import type { IntentResult } from './intent.js';
import { ContextScorer } from './scorer.js';
import type { ScoredItem, ScorerInput } from './scorer.js';
import { Reranker } from './reranker.js';
import { FileRelationsIndex } from './fileRelations.js';
import { ContextGraph } from './graph.js';
import { DecisionMemory } from './decisionMemory.js';
import { ErrorMemory } from './errorMemory.js';
import { ChangeMemory } from './changeMemory.js';
import { ObsoleteDetector } from './obsolete.js';
import { LAYER_3_RELEVANT, LAYER_4_HISTORY } from './layers.js';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.nuxt', 'out']);

let idCounter = 0;
function nextId(): string {
  return `e${++idCounter}-${Date.now().toString(36)}`;
}

export interface ContextReport {
  objective: string | null;
  windowTokens: number;
  entryCount: number;
  archiveCount: number;
  memoryCount: number;
  taskState: TaskState | null;
  budget: {
    total: number;
    used: number;
    percent: number;
    parts: Array<{ label: string; tokens: number }>;
  };
}

export class ContextManager {
  entries: ContextEntry[] = [];
  archive: ArchiveRecord[] = [];
  objective: string | null = null;
  taskState: TaskState | null = null;
  continuity: ContinuityState | null = null;
  memory = new ProjectMemory();
  decisions = new DecisionMemory();
  errors = new ErrorMemory();
  changes = new ChangeMemory();
  graph = new ContextGraph();
  fileCache = new FileContextCache();
  contextCache = new ContextCache();
  fileRelations: FileRelationsIndex;
  private semanticRetriever: SemanticRetriever;
  private hybridRetriever: HybridRetrieverLike;
  private scorer = new ContextScorer();
  private reranker = new Reranker();
  private obsoleteDetector: ObsoleteDetector;
  private createdAt: number;
  private updatedAt: number;

  constructor(private opts: ContextManagerOptions) {
    this.createdAt = Date.now();
    this.updatedAt = Date.now();
    this.semanticRetriever = opts.semanticRetriever ?? new KeywordSemanticRetriever();
    this.hybridRetriever = opts.hybridRetriever ?? new HybridRetriever();
    this.fileRelations = new FileRelationsIndex(opts.projectRoot);
    this.obsoleteDetector = new ObsoleteDetector(this.fileCache);
  }

  get projectRoot(): string {
    return this.opts.projectRoot;
  }

  get windowTokens(): number {
    return this.opts.windowTokens;
  }

  get tokenCounter() {
    return this.opts.tokenCounter;
  }

  get totalTokens(): number {
    return this.entries.reduce((sum, e) => sum + e.tokens, 0);
  }

  get entryCount(): number {
    return this.entries.length;
  }

  get archiveCount(): number {
    return this.archive.length;
  }

  get wouldCompact(): boolean {
    return this.totalTokens > Math.floor(this.opts.windowTokens * this.opts.compactRatio);
  }

  get decisionCount(): number {
    return this.decisions.size;
  }

  get errorCount(): number {
    return this.errors.size;
  }

  get changeCount(): number {
    return this.changes.size;
  }

  private touch(): void {
    this.updatedAt = Date.now();
  }

  private pushEntry(e: ContextEntry): void {
    this.entries.push(e);
    this.touch();
  }

  setObjective(objective: string | null): void {
    this.objective = objective;
    this.touch();
  }

  startTask(objective: string): TaskState {
    this.objective = objective;
    this.taskState = newTaskState(objective);
    this.continuity = null;
    this.touch();
    return this.taskState;
  }

  getTaskState(): TaskState | null {
    return this.taskState;
  }

  updateTask(patch: Partial<TaskState>): void {
    if (!this.taskState) return;
    if (patch.completed) {
      const set = new Set(patch.completed);
      this.taskState.pending = this.taskState.pending.filter((p) => !set.has(p));
    }
    Object.assign(this.taskState, patch);
    this.touch();
  }

  completeSubtask(label: string): void {
    if (!this.taskState) return;
    this.taskState.completed.push(label);
    this.taskState.pending = this.taskState.pending.filter((p) => p !== label);
    if (this.taskState.nextStep === label) this.taskState.nextStep = null;
    this.touch();
  }

  noteFile(filePath: string): void {
    if (!this.taskState) return;
    if (!this.taskState.files.includes(filePath)) this.taskState.files.push(filePath);
    this.touch();
  }

  noteError(msg: string): void {
    if (!this.taskState) return;
    this.taskState.errors.push(msg);
    this.touch();
  }

  noteDecision(msg: string): void {
    if (!this.taskState) return;
    this.taskState.decisions.push(msg);
    this.touch();
  }

  remember(category: string, content: string, opts: { tags?: string[]; priority?: Priority } = {}): MemoryFact {
    return this.memory.addReplacing(category, content, opts);
  }

  recordDecision(opts: {
    decision: string;
    reason: string;
    context: string;
    files?: string[];
    topic?: string;
    tags?: string[];
    priority?: Priority;
  }): DecisionRecord {
    let rec: DecisionRecord;
    if (opts.topic) {
      rec = this.decisions.addReplacingByTopic({
        decision: opts.decision,
        reason: opts.reason,
        context: opts.context,
        topic: opts.topic,
        files: opts.files,
        tags: opts.tags,
      });
    } else {
      rec = this.decisions.add({
        decision: opts.decision,
        reason: opts.reason,
        context: opts.context,
        files: opts.files,
        tags: opts.tags,
        priority: opts.priority,
      });
    }
    const taskNode = this.graph.upsertNode('task', this.objective ?? 'tarefa');
    const decNode = this.graph.upsertNode('decision', rec.decision);
    this.graph.addEdge(taskNode, decNode, 'relates_to');
    for (const f of rec.files) {
      const fileNode = this.graph.upsertNode('file', f);
      this.graph.addEdge(fileNode, decNode, 'affects');
    }
    this.touch();
    return rec;
  }

  recordError(opts: {
    message: string;
    context: string;
    file?: string | null;
    solution?: string | null;
    tags?: string[];
  }): ErrorRecord {
    const rec = this.errors.record(opts);
    const errNode = this.graph.upsertNode('error', rec.message);
    if (rec.file) {
      const fileNode = this.graph.upsertNode('file', rec.file);
      this.graph.addEdge(fileNode, errNode, 'related_error');
    }
    if (this.taskState) {
      this.taskState.errors.push(rec.message);
    }
    this.touch();
    return rec;
  }

  recordChange(opts: {
    file: string;
    operation: ChangeRecord['operation'];
    reason: string;
    summary: string;
    task?: string | null;
    tags?: string[];
  }): ChangeRecord {
    const rec = this.changes.add(
      {
        file: opts.file,
        operation: opts.operation,
        reason: opts.reason,
        summary: opts.summary,
        task: opts.task ?? this.objective,
        tags: opts.tags,
      },
      (s) => this.opts.tokenCounter.count(s)
    );
    const fileNode = this.graph.upsertNode('file', rec.file);
    const changeNode = this.graph.upsertNode('change', `${rec.operation}:${rec.file}`);
    this.graph.addEdge(fileNode, changeNode, 'related_change');
    this.fileRelations.invalidate(rec.file);
    this.fileCache.invalidate(rec.file).catch(() => {});
    this.touch();
    return rec;
  }

  addMessage(msg: StoredMessage, type: ContextEntry['type'], importance: number, tags: string[] = [], extra: Partial<ContextEntry> = {}): ContextEntry {
    const tokens = this.opts.tokenCounter.count(msg.content ?? '');
    const entry: ContextEntry = {
      id: nextId(),
      message: msg,
      type,
      scope: 'task',
      importance,
      priority: priorityOf(importance),
      tokens,
      ts: Date.now(),
      tags,
      ...extra,
    };
    this.pushEntry(entry);
    return entry;
  }

  addUserMessage(content: string, tags: string[] = []): ContextEntry {
    return this.addMessage({ role: 'user', content }, 'message', 0.9, tags, { source: 'explicit' });
  }

  addAssistantMessage(content: string, tags: string[] = []): ContextEntry {
    return this.addMessage({ role: 'assistant', content }, 'message', 0.7, tags);
  }

  addToolMessage(name: string, content: string, tags: string[] = [], disposition?: ToolDisposition): ContextEntry {
    const importance = dispositionToImportance(disposition ?? classifyToolResult(name, content));
    return this.addMessage(
      { role: 'tool', content, tool_call_id: name },
      name === 'run_command' ? 'command' : 'message',
      importance,
      tags,
      { disposition: disposition ?? classifyToolResult(name, content) }
    );
  }

  addKnowledge(content: string, importance: number, tags: string[] = []): ContextEntry {
    const tokens = this.opts.tokenCounter.count(content);
    const entry: ContextEntry = {
      id: nextId(),
      message: { role: 'system', content },
      type: 'knowledge',
      scope: 'project',
      importance,
      priority: priorityOf(importance),
      tokens,
      ts: Date.now(),
      tags,
      source: 'implicit',
    };
    this.pushEntry(entry);
    return entry;
  }

  addSummaryEntry(content: string): ContextEntry {
    const tokens = this.opts.tokenCounter.count(content);
    const entry: ContextEntry = {
      id: nextId(),
      message: { role: 'system', content },
      type: 'summary',
      scope: 'task',
      importance: 1,
      priority: 'critical',
      tokens,
      ts: Date.now(),
      tags: ['resumo'],
    };
    this.pushEntry(entry);
    return entry;
  }

  activeFiles(): string[] {
    const set = new Set<string>();
    if (this.taskState) for (const f of this.taskState.files) set.add(f);
    const recent = [...this.entries].slice(-20);
    for (const e of recent) {
      for (const t of e.tags) if (t.startsWith('file:')) set.add(t.slice(5));
    }
    return [...set];
  }

  noteActiveFile(filePath: string): void {
    this.noteFile(filePath);
    this.graph.upsertNode('file', filePath);
    this.touch();
  }

  async buildMessages(query?: string): Promise<StoredMessage[]> {
    await this.compactIfNeeded();

    const q = query ?? '';
    const intent = detectIntent(q || this.objective || '');
    const activeFiles = this.activeFiles();

    await this.refreshRelatedFiles(activeFiles);

    this.runObsoleteDetection();

    const budget = new TokenBudget(this.opts.tokenCounter, {
      windowTokens: this.opts.windowTokens,
      reserveResponseRatio: 0.15,
    });
    const out: StoredMessage[] = [];

    const systemPrompt = this.buildSystemPrompt();
    budget.add('system', systemPrompt);
    out.push({ role: 'system', content: systemPrompt });

    const safetyBlock = this.buildSafetyBlock();
    budget.add('seguranca', safetyBlock);
    out.push({ role: 'system', content: safetyBlock });

    const currentRequest = this.lastUserMessage();
    if (currentRequest) {
      budget.addTokens('solicitacao', currentRequest.tokens);
      out.push(currentRequest.message);
    }

    if (this.objective) {
      const text = `Objetivo da tarefa: ${this.objective}`;
      budget.add('objetivo', text);
      out.push({ role: 'system', content: text });
    }

    if (this.taskState) {
      const text = renderTaskState(this.taskState);
      budget.add('estado da tarefa', text);
      out.push({ role: 'system', content: text });
    }

    if (this.continuity) {
      const text = this.renderContinuity(this.continuity);
      budget.add('continuidade', text);
      out.push({ role: 'system', content: text });
    }

    const activeFilesBlock = this.renderActiveFiles(activeFiles);
    if (activeFilesBlock) {
      budget.add('arquivos ativos', activeFilesBlock);
      out.push({ role: 'system', content: activeFilesBlock });
    }

    const summaryEntries = this.entries.filter((e) => e.type === 'summary').slice(-3);
    for (const s of summaryEntries) {
      if (!budget.fits(s.tokens)) break;
      budget.addTokens('resumo', s.tokens);
      out.push(s.message);
    }

    const recentErrors = this.errors.active().slice(0, 3);
    for (const e of recentErrors) {
      const text = this.errors.render(e);
      const t = budget.count(text);
      if (!budget.fits(t)) break;
      budget.add('erros', text);
      out.push({ role: 'system', content: text });
    }

    const recentChanges = this.changes.recent(3);
    for (const c of recentChanges) {
      const text = this.changes.render(c);
      const t = budget.count(text);
      if (!budget.fits(t)) break;
      budget.add('alteracoes', text);
      out.push({ role: 'system', content: text });
    }

    const candidates = await this.gatherCandidates(intent, activeFiles);
    const scorerInput: ScorerInput = {
      query: q,
      intent,
      activeFiles,
      taskObjective: this.objective,
      tokenBudgetRemaining: budget.availableForContext - budget.used,
      graphRelated: (f) => this.graph.filesRelatedTo(f),
    };
    const scored = this.scorer.score(candidates, scorerInput);
    const reranked = this.reranker.rerank(scored, {
      activeFiles,
      intent: intent.intent,
      query: q,
      graphRelated: (f) => this.graph.filesRelatedTo(f),
    });

    const ordered = [...reranked].sort((a, b) => a.layer - b.layer || b.score - a.score);

    for (const item of ordered) {
      if (item.entry.obsolete) continue;
      const tokens = item.entry.tokens || budget.count(item.entry.message.content ?? '');
      if (!budget.fits(tokens)) continue;
      budget.addTokens(item.layer === LAYER_4_HISTORY ? 'historico' : item.layer === LAYER_3_RELEVANT ? 'relevante' : 'contexto', tokens);
      out.push({ role: 'system', content: item.entry.message.content ?? '' });
    }

    const taskEntries = this.entries.filter((e) => e.scope === 'task' && e.type !== 'summary' && e.message.role !== 'user');
    for (let i = taskEntries.length - 1; i >= 0; i--) {
      const e = taskEntries[i];
      if (budget.fits(e.tokens) || out.length <= 4) {
        budget.addTokens('historico', e.tokens);
        out.push(e.message);
      } else {
        break;
      }
    }

    return out;
  }

  private lastUserMessage(): ContextEntry | null {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i].message.role === 'user') return this.entries[i];
    }
    return null;
  }

  private renderActiveFiles(files: string[]): string {
    if (files.length === 0) return '';
    return `[arquivos ativos]\n${files.join('\n')}`;
  }

  private async refreshRelatedFiles(activeFiles: string[]): Promise<void> {
    for (const f of activeFiles) {
      await this.fileRelations.ensureFile(f);
    }
  }

  private runObsoleteDetection(): void {
    const res = this.obsoleteDetector.detect({
      entries: this.entries,
      decisions: this.decisions.decisions,
      errors: this.errors.errors,
      currentObjective: this.objective,
    });
    if (res.decisionsMarked.length) {
      this.decisions.decisions.forEach((d) => {
        if (d.supersededBy) d.priority = 'low';
      });
    }
    void res;
  }

  private async gatherCandidates(intent: IntentResult, activeFiles: string[]): Promise<ContextEntry[]> {
    const candidates: ContextEntry[] = [];

    const knowledge = this.entries.filter((e) => e.scope === 'project' && e.type === 'knowledge' && !e.obsolete);
    for (const k of knowledge) candidates.push(k);

    for (const d of this.decisions.active().slice(0, 8)) {
      candidates.push(this.makeCandidate(this.decisions.render(d), 'decision', 0.8, priorityOf(0.8), d.tags, { ts: d.ts, relatedFiles: d.files }));
    }

    for (const err of this.errors.active().slice(0, 5)) {
      candidates.push(this.makeCandidate(this.errors.render(err), 'note', 0.9, priorityOf(0.9), ['erro', ...(err.tags ?? [])], { ts: err.lastSeen, relatedFiles: err.file ? [err.file] : [] }));
    }

    for (const c of this.changes.recent(5)) {
      candidates.push(this.makeCandidate(this.changes.render(c), 'note', 0.7, priorityOf(0.7), ['alteracao', ...(c.tags ?? [])], { ts: c.ts, relatedFiles: [c.file] }));
    }

    for (const f of this.memory.all().slice(0, 10)) {
      candidates.push(this.makeCandidate(`[memoria:${f.category}]\n${f.content}`, 'knowledge', factImportance(f.priority), priorityOf(factImportance(f.priority)), [...f.tags, f.category], { ts: f.ts, relatedFiles: [] }));
    }

    for (const f of activeFiles) {
      await this.fileRelations.ensureFile(f);
      const related = this.fileRelations.progressiveContext(f, 5);
      for (const rel of related) {
        const cached = await this.fileCache.getOrRead(rel, this.opts.tokenCounter);
        if (cached) {
          candidates.push(this.makeCandidate(`Arquivo ${rel}:\n${cached.content}`, 'file', 0.8, 'high', ['file', rel], { relatedFiles: [rel] }));
        }
      }
    }

    const hybridRecords = this.buildHybridRecords();
    const hits = this.hybridRetriever.search(hybridRecords.records, intent && (intent.terms.join(' ') || '') ? `${intent.terms.join(' ')}` : '', 8);
    const seen = new Set<string>();
    for (const h of hits) {
      const rec = hybridRecords.records[h.index];
      const content = rec.text.slice(0, 1500);
      if (seen.has(content)) continue;
      seen.add(content);
      candidates.push(
        this.makeCandidate(`[contexto recuperado:${rec.source}]\n${content}`, 'note', 0.6, 'medium', ['recuperado', ...rec.tags], {
          relatedFiles: rec.relatedFiles,
        })
      );
    }

    return candidates;
  }

  private buildHybridRecords(): {
    records: Array<{ text: string; tags: string[]; priority: number; ts: number; relatedFiles: string[]; source: string }>;
  } {
    const records: Array<{ text: string; tags: string[]; priority: number; ts: number; relatedFiles: string[]; source: string }> = [];
    for (const f of this.memory.all().slice(0, 15)) {
      records.push({
        text: `[${f.category}] ${f.content}`,
        tags: [...f.tags, f.category],
        priority: factPriorityNum(f.priority),
        ts: f.ts,
        relatedFiles: [],
        source: 'memoria',
      });
    }
    for (const d of this.decisions.active().slice(0, 10)) {
      records.push({
        text: `[decisao] ${d.decision} | Motivo: ${d.reason} | ${d.context}`,
        tags: [...d.tags, 'decisao'],
        priority: factPriorityNum(d.priority),
        ts: d.ts,
        relatedFiles: d.files,
        source: 'decisao',
      });
    }
    for (const err of this.errors.active().slice(0, 8)) {
      records.push({
        text: `[erro] ${err.message} | ${err.context} | Solucao: ${err.solution ?? ''}`,
        tags: ['erro', ...(err.tags ?? [])],
        priority: 0.9,
        ts: err.lastSeen,
        relatedFiles: err.file ? [err.file] : [],
        source: 'erro',
      });
    }
    for (const c of this.changes.recent(10)) {
      records.push({
        text: `[alteracao:${c.operation}] ${c.file} | ${c.summary}`,
        tags: ['alteracao', ...(c.tags ?? [])],
        priority: 0.6,
        ts: c.ts,
        relatedFiles: [c.file],
        source: 'alteracao',
      });
    }
    for (const k of this.entries.filter((e) => e.scope === 'project' && e.type === 'knowledge' && !e.obsolete)) {
      records.push({
        text: k.message.content ?? '',
        tags: k.tags,
        priority: factPriorityNum(k.priority),
        ts: k.ts,
        relatedFiles: k.tags.filter((t) => t.startsWith('file:')).map((t) => t.slice(5)),
        source: 'conhecimento',
      });
    }
    for (const a of this.archive.slice(-10)) {
      records.push({
        text: `${a.summary}\n${a.raw.slice(0, 1500)}`,
        tags: a.tags,
        priority: 0.4,
        ts: a.ts,
        relatedFiles: [],
        source: 'arquivo',
      });
    }
    return { records };
  }

  private makeCandidate(content: string, type: ContextEntry['type'], importance: number, priority: Priority, tags: string[], extra: Partial<ContextEntry> = {}): ContextEntry {
    const tokens = this.opts.tokenCounter.count(content);
    return {
      id: nextId(),
      message: { role: 'system', content },
      type,
      scope: 'project',
      importance,
      priority,
      tokens,
      ts: extra.ts ?? Date.now(),
      tags,
      ...extra,
    };
  }

  private renderContinuity(c: ContinuityState): string {
    const lines = ['[continuidade da tarefa]'];
    if (c.objective) lines.push(`Objetivo: ${c.objective}`);
    lines.push(`Tipo: ${c.kind}`);
    if (c.situation) lines.push(`Situacao: ${c.situation}`);
    if (c.investigated.length) lines.push(`Investigado: ${c.investigated.join(' | ')}`);
    if (c.discovered.length) lines.push(`Descoberto: ${c.discovered.join(' | ')}`);
    if (c.completed.length) lines.push(`Concluido: ${c.completed.join(' | ')}`);
    if (c.pending.length) lines.push(`Pendente: ${c.pending.join(' | ')}`);
    if (c.files.length) lines.push(`Arquivos: ${c.files.join(', ')}`);
    if (c.decisions.length) lines.push(`Decisoes: ${c.decisions.join(' | ')}`);
    if (c.errors.length) lines.push(`Erros: ${c.errors.join(' | ')}`);
    if (c.testsRun.length) lines.push(`Testes: ${c.testsRun.join(' | ')}`);
    if (c.hypothesesRejected.length) lines.push(`Hipoteses descartadas: ${c.hypothesesRejected.join(' | ')}`);
    if (c.blockers.length) lines.push(`Bloqueios: ${c.blockers.join(' | ')}`);
    if (c.doNotForget.length) lines.push(`NAO esquecer: ${c.doNotForget.join(' | ')}`);
    if (c.nextStep) lines.push(`Proximo passo: ${c.nextStep}`);
    lines.push(`Resumo: ${c.summary}`);
    return lines.join('\n');
  }

  private buildSafetyBlock(): string {
    return `[instrucoes de seguranca]
- Nunca execute comandos destrutivos sem confirmacao explicita do usuario.
- Nunca exponha chaves, tokens ou segredos.
- Sempre leia um arquivo antes de edita-lo.
- Se um comando foi bloqueado por ser potencialmente destrutivo, proponha uma alternativa segura.`;
  }

  private buildSystemPrompt(): string {
    return `Voce e "master-code", um agente de engenharia de software que trabalha dentro de um terminal, como o Claude Code ou o opencode.

Voce ajuda o usuario a criar, modificar, entender e testar codigo.

Diretrizes:
- Use as ferramentas disponiveis para ler, criar e editar arquivos, listar diretorios, pesquisar texto e rodar comandos no terminal.
- Sempre leia um arquivo antes de edita-lo.
- Use edit_file com um trecho exato e unico do conteudo atual. Se der erro, leia o arquivo novamente e corrija.
- Ao concluir uma mudanca, rode o build/teste com run_command para verificar se esta correto.
- Trabalhe no diretorio atual do projeto.
- Responda em portugues do Brasil, de forma clara e objetiva.
- Ao final, resuma brevemente o que foi feito.

Partes marcadas como "Objetivo da tarefa", "estado da tarefa", "[continuidade da tarefa]", "[resumo]", "[memoria]", "[contexto recuperado]", "[decisao]", "[erro]", "[alteracao]", "[arquivos ativos]" e "[instrucoes de seguranca]" sao contexto preservado de iteracoes anteriores. Use-os para manter continuidade, mesmo apos o historico ser compactado. Contexto marcado como obsoleto ou irrelevante deve ser ignorado.`;
  }

  async compactIfNeeded(): Promise<boolean> {
    const threshold = Math.floor(this.opts.windowTokens * this.opts.compactRatio);
    if (this.totalTokens <= threshold) return false;

    const taskEntries = this.entries
      .filter((e) => e.scope === 'task' && e.type !== 'summary')
      .sort((a, b) => a.ts - b.ts);

    const keepRecent = taskEntries.slice(-8);
    const keepRecentIds = new Set(keepRecent.map((e) => e.id));

    const candidates = taskEntries
      .filter((e) => !keepRecentIds.has(e.id) && e.importance < 1)
      .sort((a, b) => a.importance - b.importance || a.ts - b.ts);

    const toCompact: ContextEntry[] = [];
    let removedTokens = 0;
    for (const e of candidates) {
      if (this.totalTokens - removedTokens <= threshold) break;
      toCompact.push(e);
      removedTokens += e.tokens;
    }

    if (toCompact.length === 0) return false;

    const summaryText = await this.opts.summarizer.summarize(
      toCompact,
      this.objective ?? '',
      this.opts.windowTokens
    );

    const tags = new Set<string>();
    for (const e of toCompact) for (const t of e.tags) tags.add(t);

    this.archive.push({
      id: nextId(),
      summary: summaryText,
      raw: toCompact.map((e) => e.message.content ?? '').join('\n'),
      ts: Date.now(),
      tags: [...tags],
    });

    const removeIds = new Set(toCompact.map((e) => e.id));
    this.entries = this.entries.filter((e) => !removeIds.has(e.id));

    this.addSummaryEntry(`[resumo]\n${summaryText}`);

    const errorsNow = this.errors.active().map((e) => e.message);
    if (this.taskState) {
      const ts = this.taskState;
      this.continuity = {
        objective: this.objective ?? '',
        kind: detectTaskKind(this.objective ?? ts.objective),
        summary: summaryText,
        completed: [...ts.completed],
        pending: [...ts.pending],
        files: [...ts.files],
        decisions: [...ts.decisions],
        errors: errorsNow.length ? errorsNow : [...ts.errors],
        nextStep: ts.nextStep,
        ts: Date.now(),
        situation: ts.errors.length ? `Havia ${ts.errors.length} erro(s) pendente(s).` : 'Progredindo sem erros pendentes.',
        investigated: [...ts.files],
        discovered: [],
        hypothesesRejected: [],
        blockers: errorsNow,
        doNotForget: ts.decisions.slice(-3),
        testsRun: [...ts.testsRun],
      };
    } else {
      this.continuity = {
        objective: this.objective ?? '',
        kind: detectTaskKind(this.objective ?? ''),
        summary: summaryText,
        completed: [],
        pending: this.objective ? [this.objective] : [],
        files: [],
        decisions: [],
        errors: errorsNow,
        nextStep: null,
        ts: Date.now(),
        situation: 'Sem estado de tarefa registrado.',
        investigated: [],
        discovered: [],
        hypothesesRejected: [],
        blockers: errorsNow,
        doNotForget: [],
        testsRun: [],
      };
    }
    this.touch();
    return true;
  }

  async retrieve(query: string, k = 5): Promise<Array<{ text: string; score: number; source: 'archive' | 'entry' }>> {
    const records: Array<{ text: string; tags: string[]; source: 'archive' | 'entry'; index: number }> = [];
    let idx = 0;
    for (const a of this.archive) {
      records.push({ text: `${a.summary}\n${a.raw}`, tags: a.tags, source: 'archive', index: idx++ });
    }
    for (const e of this.entries) {
      if (e.type === 'knowledge') {
        records.push({ text: e.message.content ?? '', tags: e.tags, source: 'entry', index: idx++ });
      }
    }

    const results = this.opts.retriever.search(records, query, k);
    return results.map((r) => {
      const rec = records[r.index];
      return {
        text: rec.source === 'archive' ? rec.text.slice(0, 3000) : rec.text,
        score: r.score,
        source: rec.source,
      };
    });
  }

  async recall(
    query: string,
    k = 4
  ): Promise<Array<{ text: string; score: number; reason?: string; source: 'memoria' | 'arquivo' | 'conhecimento' }>> {
    const records: Array<{ text: string; tags: string[]; source: 'memoria' | 'arquivo' | 'conhecimento' }> = [];
    for (const f of this.memory.all()) {
      records.push({ text: `[${f.category}] ${f.content}`, tags: [...f.tags, f.category], source: 'memoria' });
    }
    for (const e of this.entries) {
      if (e.type === 'knowledge') {
        records.push({ text: e.message.content ?? '', tags: e.tags, source: 'conhecimento' });
      }
    }
    for (const f of this.fileCache.list()) {
      records.push({ text: `Arquivo ${f.path}:\n${f.content}`, tags: ['file', f.path], source: 'arquivo' });
    }

    const hits: SemanticHit[] = this.semanticRetriever.search(records, query, k);
    return hits.map((h) => ({
      text: records[h.index].text.slice(0, 2000),
      score: h.score,
      source: records[h.index].source,
      reason: h.reason,
    }));
  }

  contextReport(): ContextReport {
    const budget = new TokenBudget(this.opts.tokenCounter, {
      windowTokens: this.opts.windowTokens,
      reserveResponseRatio: 0.15,
    });
    const parts: Array<{ label: string; tokens: number }> = [];
    let used = 0;
    const add = (label: string, tokens: number) => {
      used += tokens;
      parts.push({ label, tokens });
    };
    add('objetivo', this.objective ? this.opts.tokenCounter.count(`Objetivo da tarefa: ${this.objective}`) : 0);
    add('estado da tarefa', this.taskState ? this.opts.tokenCounter.count(renderTaskState(this.taskState)) : 0);
    add('continuidade', this.continuity ? this.opts.tokenCounter.count(this.renderContinuity(this.continuity)) : 0);
    const sumT = this.entries.filter((e) => e.type === 'summary').reduce((s, e) => s + e.tokens, 0);
    const knowT = this.entries
      .filter((e) => e.scope === 'project' && e.type === 'knowledge')
      .reduce((s, e) => s + e.tokens, 0);
    const memT = this.memory.facts.reduce((s, f) => s + this.opts.tokenCounter.count(f.content), 0);
    const decT = this.decisions.decisions.reduce((s, d) => s + this.opts.tokenCounter.count(d.decision), 0);
    const errT = this.errors.errors.reduce((s, e) => s + this.opts.tokenCounter.count(e.message), 0);
    add('resumos', sumT);
    add('conhecimento', knowT);
    add('memoria', memT);
    add('decisoes', decT);
    add('erros', errT);
    add('historico', this.totalTokens - sumT - knowT);

    const total = budget.availableForContext;
    const percent = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;

    return {
      objective: this.objective,
      windowTokens: this.opts.windowTokens,
      entryCount: this.entryCount,
      archiveCount: this.archiveCount,
      memoryCount: this.memory.size,
      taskState: this.taskState,
      budget: { total, used, percent, parts },
    };
  }

  async hydrateProjectKnowledge(): Promise<number> {
    const hasKnowledge = this.entries.some((e) => e.scope === 'project' && e.type === 'knowledge');
    if (hasKnowledge) return 0;

    const root = this.opts.projectRoot;
    let added = 0;

    const structure = await this.buildTree(root, 2, 40);
    if (structure.length > 0) {
      this.addKnowledge(`Estrutura do projeto:\n${structure.join('\n')}`, 0.5, ['estrutura', 'projeto']);
      added++;
    }

    return added;
  }

  private async buildTree(dir: string, depth: number, maxItems: number): Promise<string[]> {
    const out: string[] = [];
    async function rec(d: string, level: number) {
      if (out.length >= maxItems || level > depth) return;
      let entries;
      try {
        entries = await readdir(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (out.length >= maxItems) return;
        if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
        const indent = '  '.repeat(level);
        out.push(`${indent}${e.isDirectory() ? e.name + '/' : e.name}`);
        if (e.isDirectory()) await rec(path.join(d, e.name), level + 1);
      }
    }
    await rec(dir, 0);
    return out;
  }

  async persist(): Promise<void> {
    const session: SerializedSession = {
      id: this.opts.sessionId,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      objective: this.objective,
      entries: this.entries,
      archive: this.archive,
      taskState: this.taskState,
      continuity: this.continuity,
      facts: this.memory.facts,
      decisions: this.decisions.decisions,
      errors: this.errors.errors,
      changes: this.changes.changes,
      graph: this.graph.serialize(),
    };
    await this.opts.storage.save(session);
  }

  async load(): Promise<void> {
    const s = await this.opts.storage.load();
    if (!s) return;
    this.entries = s.entries ?? [];
    this.archive = s.archive ?? [];
    this.objective = s.objective ?? null;
    this.taskState = s.taskState ?? null;
    this.continuity = s.continuity ?? null;
    this.memory = new ProjectMemory();
    if (s.facts) this.memory.facts = s.facts;
    this.decisions = new DecisionMemory();
    if (s.decisions) this.decisions.decisions = s.decisions;
    this.errors = new ErrorMemory();
    if (s.errors) this.errors.errors = s.errors;
    this.changes = new ChangeMemory();
    if (s.changes) this.changes.changes = s.changes;
    if (s.graph) this.graph = ContextGraph.deserialize(s.graph);
    this.createdAt = s.createdAt ?? Date.now();
    this.updatedAt = s.updatedAt ?? Date.now();
  }

  async reset(): Promise<void> {
    this.entries = [];
    this.archive = [];
    this.objective = null;
    this.taskState = null;
    this.continuity = null;
    this.memory = new ProjectMemory();
    this.decisions = new DecisionMemory();
    this.errors = new ErrorMemory();
    this.changes = new ChangeMemory();
    this.graph = new ContextGraph();
    this.fileCache = new FileContextCache();
    this.contextCache = new ContextCache();
    this.fileRelations = new FileRelationsIndex(this.opts.projectRoot);
    this.createdAt = Date.now();
    this.updatedAt = Date.now();
    await this.persist();
  }
}

export function classifyToolResult(name: string, content: string): ToolDisposition {
  const lower = name.toLowerCase();
  const text = (content ?? '').toLowerCase();
  if (lower === 'list_dir') {
    if (text.includes('error')) return 'relevant';
    return 'discard';
  }
  if (lower === 'search_text') return 'relevant';
  if (lower === 'read_file') {
    if (text.includes('error')) return 'relevant';
    return 'temporary';
  }
  if (lower === 'run_command') {
    if (/error|fail|fatal|exception|teste.*falh|falhou|não encontrad/i.test(text)) return 'critical';
    if (text.includes('error')) return 'important';
    return 'relevant';
  }
  if (lower === 'write_file' || lower === 'edit_file') return 'important';
  return 'relevant';
}

function dispositionToImportance(d: ToolDisposition): number {
  switch (d) {
    case 'critical':
      return 1;
    case 'important':
      return 0.9;
    case 'relevant':
      return 0.7;
    case 'temporary':
      return 0.4;
    default:
      return 0.2;
  }
}

function factImportance(p: Priority): number {
  switch (p) {
    case 'critical':
      return 1;
    case 'high':
      return 0.85;
    case 'medium':
      return 0.6;
    default:
      return 0.35;
  }
}

function factPriorityNum(p: Priority): number {
  switch (p) {
    case 'critical':
      return 1;
    case 'high':
      return 0.8;
    case 'medium':
      return 0.5;
    default:
      return 0.2;
  }
}
