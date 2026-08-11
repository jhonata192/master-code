import chalk from 'chalk';

export function inline(text: string): string {
  let out = text;
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, t, url) => `${t} (${chalk.gray(url)})`);
  out = out.replace(/\*\*([^*]+)\*\*/g, (_m, t) => chalk.bold(t));
  out = out.replace(/`([^`]+)`/g, (_m, t) => chalk.inverse(t));
  out = out.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, (_m, t) => chalk.italic(t));
  return out;
}

export function plainText(text: string): string {
  let out = text;
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, t) => t);
  out = out.replace(/\*\*([^*]+)\*\*/g, (_m, t) => t);
  out = out.replace(/`([^`]+)`/g, (_m, t) => t);
  out = out.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, (_m, t) => t);
  return out.trim();
}

export function renderMarkdown(body: string): string {
  const lines = (body ?? '').split(/\r?\n/);
  const out: string[] = [];
  let inCode = false;

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    const fence = /^\s*```/.test(line);
    if (fence) {
      if (!inCode) {
        out.push(chalk.gray('```'));
      } else {
        out.push(chalk.gray('```'));
      }
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      out.push(chalk.gray(line));
      continue;
    }
    if (!line.trim()) {
      out.push('');
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const content = inline(heading[2].trim());
      out.push(level <= 2 ? chalk.bold.cyan(content) : chalk.bold(content));
      continue;
    }
    const hr = /^-{3,}$/.test(line.trim());
    if (hr) {
      out.push(chalk.gray('─'.repeat(48)));
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      out.push(chalk.gray('│ ' + inline(quote[1])));
      continue;
    }
    const ordered = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (ordered) {
      const indent = /^(\s*)/.exec(line)![1].length;
      out.push('  '.repeat(Math.min(2, Math.floor(indent / 2))) + chalk.gray('-') + ' ' + inline(ordered[1]));
      continue;
    }
    const bullet = /^\s*([-*+])\s+(.*)$/.exec(line);
    if (bullet) {
      const indent = /^(\s*)/.exec(line)![1].length;
      out.push('  '.repeat(Math.min(2, Math.floor(indent / 2))) + chalk.gray('•') + ' ' + inline(bullet[2]));
      continue;
    }
    out.push(inline(line));
  }

  return out.join('\n');
}

export function splitNotesLines(body: string): string[] {
  return (body ?? '').split(/\r?\n/);
}

export function extractBulletPoints(body: string, maxItems = 8): string[] {
  const items: string[] = [];
  for (const raw of (body ?? '').split(/\r?\n/)) {
    if (items.length >= maxItems) break;
    const line = raw.replace(/\s+$/, '');
    const m = /^\s{0,2}[-*+]\s+(.*)$/.exec(line) || /^\s{0,2}\d+\.\s+(.*)$/.exec(line);
    if (!m) continue;
    const t = plainText(m[1]);
    if (t) items.push(t);
  }
  return items;
}

export function summarizeNotes(body: string, maxItems = 8): string[] {
  const bullets = extractBulletPoints(body, maxItems);
  if (bullets.length > 0) return bullets;
  const fallback: string[] = [];
  for (const raw of (body ?? '').split(/\r?\n/)) {
    if (fallback.length >= maxItems) break;
    const line = raw.trim();
    if (!line || /^(#{1,6})\s|^```/.test(line) || /^-{3,}$/.test(line)) continue;
    const t = plainText(line);
    if (t) fallback.push(t);
  }
  return fallback;
}

export function truncateNotesLines(body: string, maxLines: number): {
  lines: string[];
  truncated: boolean;
  remaining: number;
} {
  const lines = splitNotesLines(body);
  if (lines.length <= maxLines) return { lines, truncated: false, remaining: 0 };
  return { lines: lines.slice(0, maxLines), truncated: true, remaining: lines.length - maxLines };
}
