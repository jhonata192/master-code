import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import type OpenAI from 'openai';

type ChatCompletionTool = OpenAI.Chat.Completions.ChatCompletionTool;

export type ConfirmFn = (command: string) => Promise<boolean>;

const execAsync = promisify(exec);

const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+-r(?:f)?\b/i, reason: 'rm -r (remove recursivo)' },
  { pattern: /\brm\s+--recursive\b/i, reason: 'rm --recursive' },
  { pattern: /\bdel\s+\/s\b/i, reason: 'del /s (remove recursivo)' },
  { pattern: /\brmdir\s+\/s\b/i, reason: 'rmdir /s (remove recursivo)' },
  { pattern: /\bRemove-Item\b/i, reason: 'Remove-Item (remove arquivos/pastas)' },
  { pattern: /\bRemove-ChildItem\b/i, reason: 'Remove-ChildItem (remove recursivo)' },
  { pattern: /\bformat\b/i, reason: 'format (formata volume)' },
  { pattern: /\bformat\.exe\b/i, reason: 'format (formata volume)' },
  { pattern: /\bdiskpart\b/i, reason: 'diskpart (altera particoes)' },
  { pattern: /\bmkfs(?:\.\w+)?\b/i, reason: 'mkfs (cria sistema de arquivos)' },
  { pattern: /\bdd\s+if=\S+\s+of=\S+/i, reason: 'dd (copia bruta de disco)' },
  { pattern: /\bfdisk\b/i, reason: 'fdisk (altera particoes)' },
  { pattern: /\bshred\b/i, reason: 'shred (sobrescreve arquivos)' },
  { pattern: /\bgit\s+clean\s+-f/i, reason: 'git clean -f (remove arquivos nao rastreados)' },
  { pattern: /\bgit\s+reset\s+--hard/i, reason: 'git reset --hard (descarta mudancas)' },
  { pattern: /\bgit\s+checkout\s+--\s+\./i, reason: 'git checkout -- . (descarta mudancas)' },
  { pattern: /\bgit\s+reflog\s+delete/i, reason: 'git reflog delete (destroi historico)' },
  { pattern: /\bgit\s+update-ref\s+-d/i, reason: 'git update-ref -d (remove ref)' },
  { pattern: /\bCLEAR\b/i, reason: 'CLEAR (limpa memoria)' },
  { pattern: /\bwipe\b/i, reason: 'wipe (apaga dados)' },
  { pattern: /\breboot\b/i, reason: 'reboot (reinicia a maquina)' },
  { pattern: /\bshutdown\s+\/s\b/i, reason: 'shutdown /s (desliga a maquina)' },
  { pattern: /\bStop-Computer\b/i, reason: 'Stop-Computer (desliga a maquina)' },
  { pattern: /\bRestart-Computer\b/i, reason: 'Restart-Computer (reinicia a maquina)' },
  { pattern: /\breg\s+delete\b/i, reason: 'reg delete (altera o registro do Windows)' },
  { pattern: /\b(?:net\s+user|net\s+localgroup)\b/i, reason: 'net user (altera contas)' },
  { pattern: /\bRemove-ItemProperty\b/i, reason: 'Remove-ItemProperty (remove valor do registro)' },
  { pattern: /\bClear-Content\b/i, reason: 'Clear-Content (esvazia arquivo)' },
  { pattern: /\bRemove\s+-\s*Recurse\b/i, reason: 'Remove -Recurse' },
];

function isDangerousCommand(command: string): string | null {
  for (const { pattern, reason } of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) return reason;
  }
  return null;
}

export const tools: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        'Le o conteudo de um arquivo de texto, com numeros de linha. Use antes de editar qualquer arquivo.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Caminho do arquivo (relativo ou absoluto)' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Cria um arquivo novo ou sobrescreve um existente com o conteudo fornecido.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Caminho do arquivo (relativo ou absoluto)' },
          content: { type: 'string', description: 'Conteudo completo do arquivo' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        'Substitui um trecho exato de texto em um arquivo por um novo texto. O old_string precisa ser unico no arquivo.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Caminho do arquivo' },
          old_string: { type: 'string', description: 'Trecho exato atual a ser substituido' },
          new_string: { type: 'string', description: 'Novo trecho que substituira o antigo' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'Lista o conteudo de um diretorio.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Caminho do diretorio (padrao: .)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_text',
      description:
        'Procura um padrao de texto em todos os arquivos do projeto (ignora node_modules, .git e ocultos).',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Padrao (regex) a procurar' },
          dir: { type: 'string', description: 'Diretorio onde buscar (padrao: .)' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description:
        'Executa um comando no terminal do usuario (PowerShell no Windows). Use para rodar testes, build, git, npm, etc. Comandos destrutivos (rm -r, Remove-Item, format, git reset --hard, etc.) pedem confirmacao do usuario antes de executar.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Comando a executar' },
        },
        required: ['command'],
      },
    },
  },
];

async function readFileTool(args: { path: string }): Promise<unknown> {
  const p = path.resolve(args.path);
  const content = await readFile(p, 'utf8');
  const lines = content.split('\n');
  const numbered = lines.map((l, i) => `${i + 1}: ${l}`).join('\n');
  return { path: p, lines: lines.length, content: numbered.slice(0, 30000) };
}

async function writeFileTool(args: { path: string; content: string }): Promise<unknown> {
  const p = path.resolve(args.path);
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, args.content, 'utf8');
  return { ok: true, path: p, bytes: Buffer.byteLength(args.content) };
}

async function editFileTool(args: {
  path: string;
  old_string: string;
  new_string: string;
}): Promise<unknown> {
  const p = path.resolve(args.path);
  const content = await readFile(p, 'utf8');
  const occurrences = content.split(args.old_string).length - 1;
  if (occurrences === 0) {
    return { error: `old_string nao encontrado no arquivo ${p}` };
  }
  if (occurrences > 1) {
    return { error: `old_string encontrado ${occurrences} vezes; forneca um trecho mais unico` };
  }
  const updated = content.replace(args.old_string, args.new_string);
  await writeFile(p, updated, 'utf8');
  return { ok: true, path: p, replacements: 1 };
}

async function listDirTool(args: { path?: string }): Promise<unknown> {
  const p = path.resolve(args.path ?? '.');
  const entries = await readdir(p, { withFileTypes: true });
  const items = entries
    .map((e) => (e.isDirectory() ? e.name + '/' : e.name))
    .filter((n) => !n.startsWith('.'))
    .sort();
  return { path: p, entries: items.slice(0, 500) };
}

async function walk(dir: string, maxFiles: number): Promise<string[]> {
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
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'dist') continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) await rec(full);
      else out.push(full);
    }
  }
  await rec(dir);
  return out;
}

async function searchTextTool(args: { pattern: string; dir?: string }): Promise<unknown> {
  const root = path.resolve(args.dir ?? '.');
  const rx = new RegExp(args.pattern);
  const matches: string[] = [];
  const files = await walk(root, 2000);
  for (const f of files) {
    if (matches.length >= 100) break;
    try {
      const content = await readFile(f, 'utf8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (rx.test(lines[i])) {
          matches.push(`${f}:${i + 1}: ${lines[i].slice(0, 200)}`);
        }
      }
    } catch {
      // ignora arquivos ilegiveis (binarios, etc.)
    }
  }
  return { path: root, matches: matches.slice(0, 100), total: matches.length };
}

async function runCommandTool(
  args: { command: string },
  signal?: AbortSignal,
  confirm?: ConfirmFn
): Promise<unknown> {
  const reason = isDangerousCommand(args.command);
  if (reason) {
    let ok = false;
    if (confirm) {
      try {
        ok = await confirm(args.command);
      } catch {
        ok = false;
      }
    }
    if (!ok) {
      return {
        cancelled: true,
        message: `Comando potencialmente destrutivo nao executado (${reason}).`,
        command: args.command,
      };
    }
  }
  try {
    const { stdout, stderr } = await execAsync(args.command, {
      timeout: 120000,
      maxBuffer: 10 * 1024 * 1024,
      signal,
    });
    return {
      exitCode: 0,
      stdout: stdout.slice(0, 20000),
      stderr: stderr.slice(0, 20000),
    };
  } catch (err: unknown) {
    if (signal?.aborted) return { cancelled: true };
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return {
      exitCode: e.code ?? 1,
      stdout: (e.stdout ?? '').slice(0, 20000),
      stderr: (e.stderr ?? String(err)).slice(0, 20000),
    };
  }
}

const handlers: Record<
  string,
  (args: Record<string, unknown>, signal?: AbortSignal, confirm?: ConfirmFn) => Promise<unknown>
> = {
  read_file: (a) => readFileTool(a as { path: string }),
  write_file: (a) => writeFileTool(a as { path: string; content: string }),
  edit_file: (a) =>
    editFileTool(a as { path: string; old_string: string; new_string: string }),
  list_dir: (a) => listDirTool(a as { path?: string }),
  search_text: (a) => searchTextTool(a as { pattern: string; dir?: string }),
  run_command: (a, s, confirm) => runCommandTool(a as { command: string }, s, confirm),
};

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
  confirm?: ConfirmFn
): Promise<string> {
  const handler = handlers[name];
  if (!handler) {
    return JSON.stringify({ error: `Ferramenta desconhecida: ${name}` });
  }
  try {
    if (signal?.aborted) return JSON.stringify({ cancelled: true });
    const result = await handler(args, signal, confirm);
    return JSON.stringify(result, null, 2);
  } catch (err: unknown) {
    if (signal?.aborted) return JSON.stringify({ cancelled: true });
    return JSON.stringify({ error: String(err) });
  }
}
