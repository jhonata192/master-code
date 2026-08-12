import readline from 'node:readline';
import { stdin, stdout } from 'node:process';
import chalk from 'chalk';

export interface Suggestion {
  display: string;
  value: string;
}

export type Completer = (input: string) => Suggestion[];

export interface AskOptions {
  enterCompletes?: boolean;
  modeKey?: (dir: 'next' | 'prev') => string;
}

let closed = false;
let fallbackRl: readline.Interface | null = null;
let fallbackQueue: string[] = [];
let fallbackWaiters: Array<(s: string) => void> = [];

export function inputClosed(): boolean {
  return closed;
}

function ensureFallback(): void {
  if (fallbackRl) return;
  fallbackRl = readline.createInterface({ input: stdin, output: stdout });
  fallbackRl.on('line', (line) => {
    const w = fallbackWaiters.shift();
    if (w) w(line);
    else fallbackQueue.push(line);
  });
  fallbackRl.on('close', () => {
    closed = true;
    const ws = fallbackWaiters.splice(0);
    for (const w of ws) w('');
  });
}

function fallbackAsk(prompt: string): Promise<string> {
  ensureFallback();
  stdout.write(prompt);
  const queued = fallbackQueue.shift();
  if (queued !== undefined) return Promise.resolve(queued);
  return new Promise((resolve) => {
    fallbackWaiters.push(resolve);
  });
}

export function askAutocomplete(
  prompt: string,
  completer: Completer,
  options: AskOptions = {}
): Promise<string> {
  if (!stdin.isTTY || !stdout.isTTY) {
    return fallbackAsk(prompt);
  }

  return new Promise((resolve) => {
    readline.emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();

    let buffer = '';
    let suggestions: Suggestion[] = [];
    let currentPrompt = prompt;

    const compute = (): Suggestion[] => {
      try {
        return completer(buffer);
      } catch {
        return [];
      }
    };

    const render = (): void => {
      suggestions = compute();
      const sug = suggestions[0]?.display ?? '';
      const remaining = sug.startsWith(buffer) ? sug.slice(buffer.length) : '';
      const suffix = remaining ? chalk.gray(remaining) : '';
      stdout.write('\r\x1b[K' + currentPrompt + buffer + suffix);
    };

    const cleanup = (): void => {
      stdin.removeListener('keypress', onKey);
      stdin.setRawMode(false);
      stdin.pause();
    };

    const onKey = (str: string | null, key: readline.Key): void => {
      if (key.ctrl && key.name === 'c') {
        stdout.write('\r\x1b[K');
        cleanup();
        process.exit(130);
      }
      if (key.name === 'enter' || key.name === 'return' || str === '\n' || str === '\r') {
        if (
          options.enterCompletes !== false &&
          buffer.trim() &&
          suggestions[0] &&
          buffer !== suggestions[0].value
        ) {
          buffer = suggestions[0].value;
        }
        stdout.write('\r\x1b[K');
        cleanup();
        resolve(buffer);
        return;
      }
      if (key.name === 'backspace') {
        buffer = buffer.slice(0, -1);
        render();
        return;
      }
      if (key.name === 'tab' || (key.name === 'right' && suggestions[0])) {
        if (key.shift) {
          if (options.modeKey) {
            currentPrompt = options.modeKey('prev');
            render();
          }
          return;
        }
        if (suggestions[0]) buffer = suggestions[0].value;
        else if (options.modeKey) {
          currentPrompt = options.modeKey('next');
        }
        render();
        return;
      }
      if (key.ctrl && key.name === 'u') {
        buffer = '';
        render();
        return;
      }
      if (key.name === 'escape') {
        buffer = '';
        render();
        return;
      }
      if (!str) return;
      buffer += str;
      render();
    };

    stdin.on('keypress', onKey);
    render();
  });
}
