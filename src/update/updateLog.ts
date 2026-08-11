import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { configDir } from '../config.js';

export function updateLogPath(): string {
  return path.join(configDir(), 'update.log');
}

export async function appendLog(event: string, fields: Record<string, string | number> = {}): Promise<void> {
  try {
    await mkdir(configDir(), { recursive: true });
    const parts = [new Date().toISOString(), event];
    for (const [k, v] of Object.entries(fields)) parts.push(`${k}=${v}`);
    await appendFile(updateLogPath(), parts.join(' | ') + '\n', 'utf8');
  } catch {
    /* log nunca deve derrubar o app */
  }
}
