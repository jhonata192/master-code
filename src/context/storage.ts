import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { SerializedSession, SessionStorage } from './types.js';

export class JsonSessionStorage implements SessionStorage {
  constructor(private file: string) {}

  async load(): Promise<SerializedSession | null> {
    try {
      const raw = await readFile(this.file, 'utf8');
      return JSON.parse(raw) as SerializedSession;
    } catch {
      return null;
    }
  }

  async save(session: SerializedSession): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(session, null, 2), 'utf8');
  }
}

export class InMemorySessionStorage implements SessionStorage {
  private data: SerializedSession | null = null;

  async load(): Promise<SerializedSession | null> {
    return this.data ? JSON.parse(JSON.stringify(this.data)) : null;
  }

  async save(session: SerializedSession): Promise<void> {
    this.data = JSON.parse(JSON.stringify(session));
  }
}
