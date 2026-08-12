import { EventBus } from './events/bus.js';
import type { AgentEvent, ToolCall, ToolStatus } from './events/types.js';
import { fmtDuration } from './events/trace.js';
import { truncate } from './events/reason.js';
import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import chalk from 'chalk';

export type RenderMode = 'normal' | 'debug' | 'quiet';

export interface RendererOptions {
  mode?: RenderMode;
  debugJsonPath?: string;
}

export interface CliFlags {
  mode: RenderMode;
  debugJsonPath: string | undefined;
  args: string[];
}

export function parseCliFlags(argv: string[]): CliFlags {
  let mode: RenderMode = 'normal';
  let debugJsonPath: string | undefined;
  const args: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--debug') {
      mode = 'debug';
    } else if (a === '--quiet') {
      mode = 'quiet';
    } else if (a === '--debug-json') {
      const next = argv[i + 1];
      if (next && /\.jsonl?$/i.test(next)) {
        debugJsonPath = path.resolve(next);
        i++;
      } else {
        debugJsonPath = path.join(os.homedir(), '.master-code', 'traces', `agent-${Date.now()}.jsonl`);
      }
    } else {
      args.push(a);
    }
  }
  return { mode, debugJsonPath, args };
}

export function statusIcon(s?: ToolStatus): string {
  if (s === 'ok') return chalk.green('\u2713');
  if (s === 'error') return chalk.red('\u2717');
  return chalk.yellow('\u25d0');
}

export function toolResultSummary(call: ToolCall): string {
  try {
    const j = JSON.parse(call.result ?? '{}') as Record<string, any>;
    switch (call.tool) {
      case 'read_file':
        if (j.error) return j.error.slice(0, 60);
        return `${j.path ?? ''} (${j.lines ?? '?'} linhas)`;
      case 'run_command': {
        const cmd = String(j.command ?? call.args.command ?? '');
        if (j.cancelled) return (cmd ? cmd + ' ' : '') + '(cancelado)';
        return (cmd ? cmd + ' ' : '') + (j.exitCode === 0 ? 'ok' : `exit code: ${j.exitCode}`);
      }
      case 'search_text':
        return `${j.total ?? 0} resultados`;
      case 'list_dir':
        return `${j.entries?.length ?? 0} entradas`;
      case 'write_file':
      case 'edit_file':
        return String(call.args.path ?? '');
      default:
        return '';
    }
  } catch {
    return '';
  }
}

export class AgentRenderer {
  private mode: RenderMode;
  private debugJsonPath?: string;
  private textBuf = '';
  private started = false;
  private lastWasDelta = false;

  constructor(private bus: EventBus, opts: RendererOptions = {}) {
    this.mode = opts.mode ?? 'normal';
    this.debugJsonPath = opts.debugJsonPath;
    bus.onAny((e) => this.handle(e));
  }

  private handle(e: AgentEvent): void {
    if (this.debugJsonPath) {
      appendFile(this.debugJsonPath, JSON.stringify({ ts: Date.now(), ...e }) + '\n', 'utf8').catch(() => {});
    }
    if (!this.started) {
      process.stdout.write('\n');
      this.started = true;
    }
    if (this.mode === 'quiet') this.renderQuiet(e);
    else if (this.mode === 'debug') this.renderDebug(e);
    else this.renderNormal(e);
  }

  private endDelta(): void {
    if (this.lastWasDelta) {
      process.stdout.write('\n');
      this.lastWasDelta = false;
    }
  }

  private renderNormal(e: AgentEvent): void {
    switch (e.type) {
      case 'task_start':
        console.log(chalk.cyan('[task] nova tarefa (' + chalk.gray(e.model) + ')'));
        break;
      case 'plan':
        console.log(chalk.cyan('[plan] ' + truncate(e.summary, 120)));
        break;
      case 'task_step':
        console.log(chalk.cyan('[task] etapa ' + e.index + '/' + e.total + ': ' + e.title));
        break;
      case 'task_step_end':
        console.log(chalk.cyan('[task] etapa ' + e.index + '/' + e.total + ' concluida'));
        break;
      case 'text_delta':
        process.stdout.write(e.text);
        this.lastWasDelta = true;
        break;
      case 'tool_call_start': {
        this.endDelta();
        const reason = e.call.reason ? ' — ' + e.call.reason : '';
        console.log(chalk.gray('[tool] ' + e.call.tool + reason));
        break;
      }
      case 'tool_result': {
        this.endDelta();
        const icon = statusIcon(e.call.status);
        const detail = toolResultSummary(e.call);
        const time = e.call.durationMs != null ? ' ' + chalk.gray('\u00b7 ' + fmtDuration(e.call.durationMs)) : '';
        console.log('  ' + icon + ' ' + chalk.gray(e.call.tool + (detail ? ' ' + detail : '') + time));
        break;
      }
      case 'error':
        this.endDelta();
        console.log(chalk.red('[erro] ' + e.message));
        break;
      case 'warning':
        this.endDelta();
        console.log(chalk.yellow('[aviso] ' + e.message));
        break;
      case 'retry':
        this.endDelta();
        console.log(chalk.gray('[agent] tentando novamente... (tentativa ' + e.attempt + ')' + (e.reason ? ' — ' + truncate(e.reason, 80) : '')));
        break;
      case 'compaction':
        this.endDelta();
        if (e.state === 'start') console.log(chalk.gray('[contexto] compactando historico...'));
        else console.log(chalk.gray('[contexto] compactacao concluida: ' + e.before + ' -> ' + (e.after ?? '?') + ' tokens'));
        break;
      case 'agent':
        this.endDelta();
        console.log(chalk.gray('[agent] ' + e.message));
        break;
      case 'mode_change':
        this.endDelta();
        console.log(chalk.magenta('[mode] ' + e.from + ' -> ' + e.to));
        break;
      case 'tool_gate':
        this.endDelta();
        if (e.allowed) {
          console.log(chalk.gray('[tool-gate] mode=' + e.mode + ' tool=' + e.tool + ' allowed=true'));
        } else {
          console.log(
            chalk.yellow('[tool-gate] mode=' + e.mode + ' tool=' + e.tool + ' allowed=false' + (e.reason ? ' reason=' + e.reason : ''))
          );
        }
        break;
      default:
        break;
    }
  }

  private renderQuiet(e: AgentEvent): void {
    switch (e.type) {
      case 'text_delta':
        this.textBuf += e.text;
        break;
      case 'task_end':
        if (e.text) process.stdout.write(chalk.white(e.text) + '\n');
        else if (this.textBuf.length > 0) process.stdout.write(chalk.white(this.textBuf) + '\n');
        this.textBuf = '';
        break;
      case 'error':
        console.log(chalk.red('[erro] ' + e.message));
        break;
      case 'warning':
        console.log(chalk.yellow('[aviso] ' + e.message));
        break;
      default:
        break;
    }
  }

  private renderDebug(e: AgentEvent): void {
    if (e.type === 'text_delta') {
      process.stdout.write(e.text);
      this.lastWasDelta = true;
      return;
    }
    this.endDelta();
    const ts = new Date().toLocaleTimeString('pt-BR', { hour12: false }) + '.' + String(Date.now() % 1000).padStart(3, '0');
    const payload = JSON.stringify(e).slice(0, 240);
    console.log(chalk.gray('[' + ts + ']') + ' ' + chalk.cyan(e.type) + ' ' + chalk.gray(payload));
  }
}
