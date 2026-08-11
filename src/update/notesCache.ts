import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { configDir } from '../config.js';
import type { NotesEntry } from './types.js';

const NOTES_FILE_NAME = 'release-notes.json';

let cache: Record<string, NotesEntry> | null = null;

export function notesCachePath(): string {
  return path.join(configDir(), NOTES_FILE_NAME);
}

async function load(): Promise<Record<string, NotesEntry>> {
  if (cache) return cache;
  try {
    const raw = await readFile(notesCachePath(), 'utf8');
    cache = JSON.parse(raw) as Record<string, NotesEntry>;
  } catch {
    cache = {};
  }
  return cache;
}

async function save(): Promise<void> {
  await mkdir(configDir(), { recursive: true });
  await writeFile(notesCachePath(), JSON.stringify(cache ?? {}, null, 2), 'utf8');
}

export async function getCachedNotes(version: string): Promise<NotesEntry | null> {
  const map = await load();
  return map[version] ?? null;
}

export async function putNotes(entry: NotesEntry): Promise<void> {
  const map = await load();
  map[entry.version] = entry;
  await save();
}

export async function clearNotesCache(): Promise<void> {
  cache = {};
  await save();
}

export async function listCachedNotes(): Promise<NotesEntry[]> {
  const map = await load();
  return Object.values(map).sort((a, b) => (a.publishedAt ?? '').localeCompare(b.publishedAt ?? ''));
}
