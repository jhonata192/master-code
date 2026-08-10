import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

export interface FileInfo {
  path: string;
  imports: string[];
  symbols: string[];
  mtimeMs: number;
}

export interface FileRelationsOptions {
  maxImportsPerFile?: number;
  maxDepth?: number;
  testSuffixes?: RegExp;
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.nuxt', 'out']);

const IMPORT_RE = /(?:import\s+[^'"`]*(?:from\s*)?|\brequire\(|\bimport\()\s*['"`]([^'"`]+)['"`]/g;
const SYMBOL_RE = /\b(?:function|class|const|let|var|interface|type|export)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;

const KNOWN_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

function resolveModulePath(base: string, from: string): string | null {
  let candidate = base;
  if (base.endsWith('/') || base.endsWith('\\')) {
    candidate = base.slice(0, -1);
  }
  const indexCandidates = [path.join(candidate, 'index')];
  const tryPaths = [...KNOWN_EXTENSIONS.map((ext) => candidate + ext), candidate, ...KNOWN_EXTENSIONS.map((ext) => path.join(candidate, 'index') + ext)];
  for (const p of tryPaths) {
    if (existsSync(p)) return path.normalize(p);
  }
  void indexCandidates;
  return path.normalize(candidate);
}

export class FileRelationsIndex {
  private index = new Map<string, FileInfo>();
  private ready = false;

  constructor(private root: string, private opts: FileRelationsOptions = {}) {
    this.opts.maxImportsPerFile = this.opts.maxImportsPerFile ?? 40;
    this.opts.maxDepth = this.opts.maxDepth ?? 3;
    this.opts.testSuffixes = this.opts.testSuffixes ?? /(\.test\.|\.spec\.|\.cy\.)/;
  }

  get isReady(): boolean {
    return this.ready;
  }

  private cleanImport(spec: string, from: string): string {
    let base = spec;
    if (base.startsWith('./') || base.startsWith('../')) {
      base = path.resolve(path.dirname(from), base);
      return resolveModulePath(base, from) ?? path.normalize(base);
    } else if (base.startsWith('@/')) {
      base = path.resolve(this.root, base.slice(2));
      return resolveModulePath(base, from) ?? path.normalize(base);
    }
    return '';
  }

  private async parseFile(file: string): Promise<FileInfo | null> {
    try {
      const st = await stat(file);
      if (!st.isFile()) return null;
      const content = await readFile(file, 'utf8');
      const imports = new Set<string>();
      let m: RegExpExecArray | null;
      IMPORT_RE.lastIndex = 0;
      while ((m = IMPORT_RE.exec(content)) !== null) {
        const cleaned = this.cleanImport(m[1], file);
        if (cleaned) imports.add(cleaned);
        if (imports.size >= this.opts.maxImportsPerFile!) break;
      }
      const symbols = new Set<string>();
      SYMBOL_RE.lastIndex = 0;
      while ((m = SYMBOL_RE.exec(content)) !== null) {
        symbols.add(m[1]);
        if (symbols.size >= 60) break;
      }
      return { path: path.normalize(file), imports: [...imports], symbols: [...symbols], mtimeMs: st.mtimeMs };
    } catch {
      return null;
    }
  }

  private async walk(dir: string, maxFiles: number): Promise<string[]> {
    const out: string[] = [];
    async function rec(d: string) {
      if (out.length >= maxFiles) return;
      let entries;
      try {
        entries = await readdir(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (out.length >= maxFiles) return;
        if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
        const full = path.join(d, e.name);
        if (e.isDirectory()) await rec(full);
        else if (/\.[jt]sx?$|\.css$|\.scss$|\.vue$|\.py$|\.go$|\.rs$|\.java$|\.cs$/i.test(e.name)) {
          out.push(full);
        }
      }
    }
    await rec(dir);
    return out;
  }

  async ensureBuilt(): Promise<void> {
    if (this.ready) return;
    const files = await this.walk(this.root, 2000);
    for (const f of files) {
      const info = await this.parseFile(f);
      if (info) this.index.set(info.path, info);
    }
    this.ready = true;
  }

  async refresh(file: string): Promise<void> {
    const norm = path.normalize(file);
    const info = await this.parseFile(norm);
    if (info) this.index.set(norm, info);
  }

  invalidate(file: string): void {
    this.index.delete(path.normalize(file));
  }

  /** Dependencias diretas (arquivos importados) que existem no indice ou que podem ser resolvidas. */
  directDeps(file: string): string[] {
    const info = this.index.get(path.normalize(file));
    if (!info) return [];
    const out: string[] = [];
    for (const dep of info.imports) {
      if (this.index.has(dep) || existsSync(dep)) out.push(dep);
    }
    return out;
  }

  /** Arquivos que importam este arquivo. */
  importersOf(file: string): string[] {
    const norm = path.normalize(file);
    const out: string[] = [];
    for (const [f, info] of this.index) {
      if (info.imports.includes(norm)) out.push(f);
    }
    return out;
  }

  /** Testes relacionados: arquivos com sufixo de teste na mesma pasta ou que importam o arquivo. */
  relatedTests(file: string): string[] {
    const norm = path.normalize(file);
    const base = norm.replace(/\.(ts|tsx|js|jsx)$/i, '');
    const dir = path.dirname(norm);
    const out = new Set<string>();
    for (const f of this.index.keys()) {
      if (this.opts.testSuffixes!.test(f) && f.startsWith(base)) out.add(f);
      const info = this.index.get(f);
      if (info && info.imports.includes(norm) && this.opts.testSuffixes!.test(f)) out.add(f);
    }
    void dir;
    return [...out];
  }

  /** Simbolos definidos em um arquivo. */
  symbolsOf(file: string): string[] {
    return this.index.get(path.normalize(file))?.symbols ?? [];
  }

  /** Modulos da mesma funcionalidade: mesmo diretorio (mesma pasta). */
  sameModule(file: string): string[] {
    const norm = path.normalize(file);
    const dir = path.dirname(norm);
    const out: string[] = [];
    for (const f of this.index.keys()) {
      if (f !== norm && path.dirname(f) === dir && !this.opts.testSuffixes!.test(f)) out.push(f);
    }
    return out.slice(0, 10);
  }

  /**
   * Contexto progressivo: [arquivo principal] -> [deps diretas] -> [deps relevantes]
   * -> [dependentes/testes/modulo]. Nunca le o projeto inteiro.
   */
  progressiveContext(file: string, maxFiles = 6): string[] {
    const norm = path.normalize(file);
    const out: string[] = [];
    const seen = new Set<string>();
    const push = (f: string) => {
      const n = path.normalize(f);
      if (seen.has(n) || out.length >= maxFiles) return;
      seen.add(n);
      out.push(n);
    };

    push(norm);
    for (const d of this.directDeps(norm)) push(d);
    for (const dep of this.directDeps(norm)) {
      for (const d2 of this.directDeps(dep)) push(d2);
    }
    for (const imp of this.importersOf(norm)) push(imp);
    for (const t of this.relatedTests(norm)) push(t);
    for (const s of this.sameModule(norm)) push(s);

    return out.slice(0, maxFiles);
  }

  async ensureFile(file: string): Promise<void> {
    if (this.index.has(path.normalize(file))) return;
    const info = await this.parseFile(file);
    if (info) this.index.set(info.path, info);
  }

  reset(): void {
    this.index.clear();
    this.ready = false;
  }
}
