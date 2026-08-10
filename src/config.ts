import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
}

export interface AppConfig {
  provider: ProviderConfig;
  model: string;
  autoModel: boolean;
  modelPool: string[];
  maxIterations: number;
  contextWindow: number;
}

export const CONFIG_DIR = path.join(os.homedir(), '.master-code');
export const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

export const DEFAULT_MODEL = 'meta/llama-3.3-70b-instruct';

const DEFAULTS: AppConfig = {
  provider: {
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    apiKey: '',
  },
  model: DEFAULT_MODEL,
  autoModel: false,
  modelPool: [],
  maxIterations: 40,
  contextWindow: 16000,
};

let cache: AppConfig | null = null;

export async function loadConfig(): Promise<AppConfig> {
  if (cache) return cache;
  try {
    const raw = await readFile(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<AppConfig>;
    cache = {
      ...DEFAULTS,
      ...parsed,
      provider: { ...DEFAULTS.provider, ...(parsed.provider ?? {}) },
      modelPool: parsed.modelPool ?? [],
    };
  } catch {
    cache = { ...DEFAULTS, provider: { ...DEFAULTS.provider }, modelPool: [] };
  }
  return cache;
}

async function saveConfig(): Promise<void> {
  if (!cache) cache = { ...DEFAULTS, provider: { ...DEFAULTS.provider }, modelPool: [] };
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(cache, null, 2), 'utf8');
}

export async function setProvider(apiKey: string, baseUrl: string): Promise<AppConfig> {
  const c = await loadConfig();
  c.provider.apiKey = apiKey;
  c.provider.baseUrl = baseUrl;
  await saveConfig();
  return c;
}

export async function setModel(model: string): Promise<AppConfig> {
  const c = await loadConfig();
  c.model = model;
  c.autoModel = false;
  await saveConfig();
  return c;
}

export async function setAutoModel(pool: string[]): Promise<AppConfig> {
  const c = await loadConfig();
  c.autoModel = true;
  c.modelPool = pool;
  await saveConfig();
  return c;
}

export function maskKey(key: string): string {
  if (!key) return 'nao configurada';
  if (key.length <= 8) return '****';
  return key.slice(0, 4) + '...' + key.slice(-4);
}
