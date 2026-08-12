export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export type AgentMode = 'build' | 'plan';

export type EntryScope = 'task' | 'project';

export type EntrySource = 'explicit' | 'implicit';

export type IntentKind =
  | 'casual'
  | 'question'
  | 'bugfix'
  | 'feature'
  | 'refactor'
  | 'investigate'
  | 'test'
  | 'explain'
  | 'setup'
  | 'search'
  | 'config'
  | 'general';

export type ToolDisposition = 'discard' | 'temporary' | 'relevant' | 'important' | 'critical';

export type GraphNodeKind =
  | 'file'
  | 'symbol'
  | 'task'
  | 'decision'
  | 'error'
  | 'memory'
  | 'change'
  | 'tool'
  | 'requirement';

export type GraphEdgeKind =
  | 'imports'
  | 'imported_by'
  | 'defines'
  | 'affects'
  | 'relates_to'
  | 'used_by'
  | 'tests'
  | 'supersedes'
  | 'related_change'
  | 'related_error'
  | 'in_task';

export type EntryType =
  | 'message'
  | 'summary'
  | 'objective'
  | 'knowledge'
  | 'file'
  | 'command'
  | 'note'
  | 'continuity'
  | 'decision'
  | 'requirement';

export type Priority = 'critical' | 'high' | 'medium' | 'low';

export type TaskKind = 'bugfix' | 'feature' | 'explain' | 'refactor' | 'test' | 'general';

export interface StoredMessage {
  role: MessageRole;
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}

export interface ContextEntry {
  id: string;
  message: StoredMessage;
  type: EntryType;
  scope: EntryScope;
  importance: number;
  priority: Priority;
  tokens: number;
  ts: number;
  tags: string[];
  source?: EntrySource;
  obsolete?: boolean;
  disposition?: ToolDisposition;
  relatedFiles?: string[];
}

export interface ArchiveRecord {
  id: string;
  summary: string;
  raw: string;
  ts: number;
  tags: string[];
}

export interface TokenCounter {
  count(text: string): number;
}

export interface Summarizer {
  summarize(entries: ContextEntry[], objective: string, budget: number): Promise<string>;
}

export interface SearchRecord {
  text: string;
  tags: string[];
}

export interface SearchHit {
  index: number;
  score: number;
}

export interface Retriever {
  search(records: SearchRecord[], query: string, k: number): SearchHit[];
}

export interface SemanticHit {
  index: number;
  score: number;
  reason: string;
}

export interface SemanticRetrieverLike {
  search(records: SearchRecord[], query: string, k: number): SemanticHit[];
}

export interface SerializedSession {
  id: string;
  createdAt: number;
  updatedAt: number;
  mode?: AgentMode;
  objective: string | null;
  entries: ContextEntry[];
  archive: ArchiveRecord[];
  taskState?: TaskState | null;
  continuity?: ContinuityState | null;
  facts?: MemoryFact[];
  decisions?: DecisionRecord[];
  errors?: ErrorRecord[];
  changes?: ChangeRecord[];
  graph?: SerializedGraph;
}

export interface SessionStorage {
  load(): Promise<SerializedSession | null>;
  save(session: SerializedSession): Promise<void>;
}

export interface ContextManagerOptions {
  sessionId: string;
  tokenCounter: TokenCounter;
  summarizer: Summarizer;
  retriever: Retriever;
  storage: SessionStorage;
  projectRoot: string;
  windowTokens: number;
  compactRatio: number;
  mode?: AgentMode;
  semanticRetriever?: SemanticRetrieverLike;
  hybridRetriever?: HybridRetrieverLike;
}

export interface TaskState {
  objective: string;
  kind: TaskKind;
  subtasks: string[];
  completed: string[];
  pending: string[];
  files: string[];
  changes: string[];
  testsRun: string[];
  errors: string[];
  decisions: string[];
  nextStep: string | null;
}

export interface MemoryFact {
  id: string;
  category: string;
  content: string;
  tags: string[];
  priority: Priority;
  ts: number;
}

export interface ContinuityState {
  objective: string;
  kind: TaskKind;
  summary: string;
  completed: string[];
  pending: string[];
  files: string[];
  decisions: string[];
  errors: string[];
  nextStep: string | null;
  ts: number;
  situation: string;
  investigated: string[];
  discovered: string[];
  hypothesesRejected: string[];
  blockers: string[];
  doNotForget: string[];
  testsRun: string[];
}

export interface BudgetReport {
  total: number;
  used: number;
  percent: number;
  parts: Array<{ label: string; tokens: number }>;
}

export interface DecisionRecord {
  id: string;
  decision: string;
  reason: string;
  context: string;
  ts: number;
  files: string[];
  supersedes: string | null;
  supersededBy: string | null;
  tags: string[];
  priority: Priority;
}

export interface ErrorRecord {
  id: string;
  message: string;
  context: string;
  file: string | null;
  solution: string | null;
  result: string | null;
  resolved: boolean;
  count: number;
  ts: number;
  lastSeen: number;
  tags: string[];
}

export interface ChangeRecord {
  id: string;
  file: string;
  operation: 'create' | 'edit' | 'delete';
  reason: string;
  summary: string;
  task: string | null;
  ts: number;
  tokens: number;
  tags: string[];
}

export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  label: string;
  ts: number;
  data?: Record<string, unknown>;
}

export interface GraphEdge {
  source: string;
  target: string;
  kind: GraphEdgeKind;
  ts: number;
  weight: number;
}

export interface SerializedGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface HybridHit {
  index: number;
  score: number;
  reasons: string[];
}

export interface HybridRetrieverLike {
  search(records: HybridSearchRecord[], query: string, k: number): HybridHit[];
}

export interface HybridSearchRecord {
  text: string;
  tags: string[];
  priority: number;
  ts: number;
  relatedFiles: string[];
}
