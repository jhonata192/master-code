import os from 'node:os';
import path from 'node:path';
import { loadConfig } from './config.js';
import { ContextManager } from './context/index.js';
import { HeuristicTokenCounter } from './context/index.js';
import { JsonSessionStorage } from './context/index.js';
import { LLMSummarizer } from './context/index.js';
import { KeywordRetriever } from './context/index.js';
import { KeywordSemanticRetriever } from './context/index.js';
import { HybridRetriever } from './context/index.js';

export const SESSION_DIR = path.join(os.homedir(), '.master-code', 'sessions');

let manager: ContextManager | null = null;

function hashProject(root: string): string {
  let h = 5381;
  for (let i = 0; i < root.length; i++) h = (h * 33) ^ root.charCodeAt(i);
  return (h >>> 0).toString(36);
}

export function sessionIdFor(root: string): string {
  return hashProject(root);
}

export async function getContextManager(): Promise<ContextManager> {
  if (manager) return manager;

  const c = await loadConfig();
  const root = process.cwd();
  const windowTokens = c.contextWindow ?? 16000;

  manager = new ContextManager({
    sessionId: sessionIdFor(root),
    tokenCounter: new HeuristicTokenCounter(4),
    summarizer: new LLMSummarizer(() => c.model),
    retriever: new KeywordRetriever(),
    semanticRetriever: new KeywordSemanticRetriever(),
    hybridRetriever: new HybridRetriever(),
    storage: new JsonSessionStorage(path.join(SESSION_DIR, `${sessionIdFor(root)}.json`)),
    projectRoot: root,
    windowTokens,
    compactRatio: 0.75,
  });

  await manager.load();
  await manager.hydrateProjectKnowledge();
  return manager;
}

export function resetContextManager(): void {
  manager = null;
}
