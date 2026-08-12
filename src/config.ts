import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parseDefaultMode } from './modes.js';
import type { AgentMode } from './modes.js';

export type ProviderId = 'nvidia' | 'openrouter';

export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
}

export interface ProviderMeta {
  label: string;
  baseUrl: string;
}

export const PROVIDER_IDS: ProviderId[] = ['nvidia', 'openrouter'];

export const PROVIDER_META: Record<ProviderId, ProviderMeta> = {
  nvidia: {
    label: 'NVIDIA NIM',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
  },
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
  },
};

export function providerLabel(id: ProviderId): string {
  return PROVIDER_META[id]?.label ?? id;
}

export function providerDefaults(id: ProviderId): ProviderConfig {
  return { baseUrl: PROVIDER_META[id].baseUrl, apiKey: '' };
}

export function activeProviderId(c: AppConfig): ProviderId {
  return c.activeProvider === 'openrouter' ? 'openrouter' : 'nvidia';
}

export function getActiveProvider(c: AppConfig): ProviderConfig {
  const id = activeProviderId(c);
  return c.providers?.[id] ?? c.provider ?? providerDefaults(id);
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

export interface AgentConfig {
  defaultMode: AgentMode;
}

export interface AppConfig {
  provider: ProviderConfig;
  activeProvider?: ProviderId;
  providers?: Partial<Record<ProviderId, ProviderConfig>>;
  model: string;
  autoModel: boolean;
  modelPool: string[];
  maxIterations: number;
  contextWindow: number;
  update: UpdateConfig;
  agent: AgentConfig;
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
  provider: providerDefaults('nvidia'),
  activeProvider: 'nvidia',
  providers: {
    nvidia: providerDefaults('nvidia'),
    openrouter: providerDefaults('openrouter'),
  },
  model: DEFAULT_MODEL,
  autoModel: false,
  modelPool: [],
  maxIterations: 40,
  contextWindow: 16000,
  update: { ...UPDATE_DEFAULTS },
  agent: { defaultMode: 'build' },
};

let cache: AppConfig | null = null;

export async function loadConfig(): Promise<AppConfig> {
  if (cache) return cache;
  try {
    const raw = await readFile(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<AppConfig>;
    const agentRaw = (parsed as { agent?: Partial<AgentConfig> }).agent ?? {};

    const active: ProviderId = parsed.activeProvider === 'openrouter' ? 'openrouter' : 'nvidia';

    const providers: Partial<Record<ProviderId, ProviderConfig>> = {};
    for (const id of PROVIDER_IDS) {
      providers[id] = { ...providerDefaults(id), ...(parsed.providers?.[id] ?? {}) };
    }
    if (!parsed.providers) {
      providers.nvidia = { ...providerDefaults('nvidia'), ...(parsed.provider ?? {}) };
    }
    if (!providers[active]) providers[active] = providerDefaults(active);

    cache = {
      ...DEFAULTS,
      ...parsed,
      provider: providers[active]!,
      activeProvider: active,
      providers,
      modelPool: parsed.modelPool ?? [],
      update: { ...UPDATE_DEFAULTS, ...(parsed.update ?? {}) },
      agent: { ...DEFAULTS.agent, ...agentRaw, defaultMode: parseDefaultMode(agentRaw.defaultMode) },
    };
  } catch {
    cache = { ...DEFAULTS, provider: { ...DEFAULTS.provider }, modelPool: [], update: { ...UPDATE_DEFAULTS }, agent: { defaultMode: 'build' } };
  }
  return cache;
}

async function saveConfig(): Promise<void> {
  if (!cache) cache = { ...DEFAULTS, provider: { ...DEFAULTS.provider }, modelPool: [], update: { ...UPDATE_DEFAULTS }, agent: { defaultMode: 'build' } };
  const active = activeProviderId(cache);
  cache.provider = cache.providers?.[active] ?? cache.provider;
  cache.activeProvider = active;
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(cache, null, 2), 'utf8');
}

export async function setProvider(
  providerId: ProviderId,
  apiKey: string,
  baseUrl: string
): Promise<AppConfig> {
  const c = await loadConfig();
  const config: ProviderConfig = { baseUrl, apiKey };
  c.providers = { ...(c.providers ?? {}), [providerId]: config };
  c.activeProvider = providerId;
  c.provider = config;
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

export async function setDefaultMode(mode: AgentMode): Promise<AppConfig> {
  const c = await loadConfig();
  c.agent = { ...c.agent, defaultMode: mode };
  await saveConfig();
  return c;
}

export function maskKey(key: string): string {
  if (!key) return 'nao configurada';
  if (key.length <= 8) return '****';
  return key.slice(0, 4) + '...' + key.slice(-4);
}
