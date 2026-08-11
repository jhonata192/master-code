import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

declare const __APP_VERSION__: string | undefined;

let cached: string | null = null;

function isValidVersionString(v: unknown): v is string {
  return typeof v === 'string' && /^\d+\.\d+\.\d+/.test(v);
}

export function getCurrentVersion(): string {
  if (cached) return cached;

  const embedded = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : undefined;
  if (isValidVersionString(embedded)) {
    cached = embedded;
    return embedded;
  }

  const importUrl = typeof import.meta?.url === 'string' ? import.meta.url : path.join(process.cwd(), 'noop.js');
  const require = createRequire(importUrl);
  const candidates = [
    path.join(process.cwd(), 'package.json'),
    require.resolve('../../package.json'),
  ];
  for (const file of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown };
      if (isValidVersionString(pkg.version)) {
        cached = pkg.version;
        return cached;
      }
    } catch {
      /* tenta proximo candidato */
    }
  }

  cached = '0.0.0';
  return cached;
}
