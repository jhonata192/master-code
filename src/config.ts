import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
}

export type UpdateChannel = 'stable' | 'beta' | 'alpha';

export interface UpdateConfig {
  enabled: boolean;
  autoCheck: boolean;
  autoUpdate: boolean;
  channel: UpdateChannel;
  checkIntervalHours: number;
  lastUpdateCheck: string | null;
  lastKnownVersion: string | null;
  downloadedVersion: string | null;
  downloadedFileName: string | null;
  downloadedPath: string | null;
  downloadedChecksum: string | null;
}

export interface AppConfig {
  provider: ProviderConfig;
  model: string;
  autoModel: boolean;
  modelPool: string[];
  maxIterations: number;
  contextWindow: number;
  update: UpdateConfig;
}

export function configDir(): string {
  const override = process.env.MASTER_CODE_CONFIG_DIR;
  return override ? path.resolve(override) : path.join(os.homedir(), '.master-code');
}

export const CONFIG_DIR = configDir();
export const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

export const DEFAULT_MODEL = 'meta/llama-3.3-70b-instruct';

const UPDATE_DEFAULTS: UpdateConfig = {
  enabled: true,
  autoCheck: true,
  autoUpdate: false,
  channel: 'stable',
  checkIntervalHours: 24,
  lastUpdateCheck: null,
  lastKnownVersion: null,
  downloadedVersion: null,
  downloadedFileName: null,
  downloadedPath: null,
  downloadedChecksum: null,
};

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
  update: { ...UPDATE_DEFAULTS },
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
      update: { ...UPDATE_DEFAULTS, ...(parsed.update ?? {}) },
    };
  } catch {
    cache = { ...DEFAULTS, provider: { ...DEFAULTS.provider }, modelPool: [], update: { ...UPDATE_DEFAULTS } };
  }
  return cache;
}

async function saveConfig(): Promise<void> {
  if (!cache) cache = { ...DEFAULTS, provider: { ...DEFAULTS.provider }, modelPool: [], update: { ...UPDATE_DEFAULTS } };
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

export async function setUpdateSettings(patch: Partial<UpdateConfig>): Promise<AppConfig> {
  const c = await loadConfig();
  c.update = { ...c.update, ...patch };
  await saveConfig();
  return c;
}

export function maskKey(key: string): string {
  if (!key) return 'nao configurada';
  if (key.length <= 8) return '****';
  return key.slice(0, 4) + '...' + key.slice(-4);
}
