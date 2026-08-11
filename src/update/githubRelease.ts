import { UPDATE_REPOSITORY_OWNER, UPDATE_REPOSITORY_NAME } from './repository.js';
import type { GitHubRelease, UpdateChannel } from './types.js';

export class GitHubApiError extends Error {
  readonly status: number;
  readonly offline: boolean;
  constructor(message: string, status = 0, offline = false) {
    super(message);
    this.name = 'GitHubApiError';
    this.status = status;
    this.offline = offline;
  }
}

export interface GitHubClientOptions {
  owner?: string;
  repo?: string;
  apiBaseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface GitHubClientLike {
  getLatestForChannel(channel: UpdateChannel): Promise<GitHubRelease | null>;
  getByTag(tag: string): Promise<GitHubRelease | null>;
  fetchText(url: string): Promise<string>;
}

const RELEASE_FIELDS =
  'id,tag_name,name,body,html_url,published_at,draft,prerelease,assets(name,browser_download_url,size,content_type)';

export class GitHubReleaseClient implements GitHubClientLike {
  private owner: string;
  private repo: string;
  private apiBaseUrl: string;
  private timeoutMs: number;
  private fetchImpl: typeof fetch;

  constructor(opts: GitHubClientOptions = {}) {
    this.owner = opts.owner ?? UPDATE_REPOSITORY_OWNER;
    this.repo = opts.repo ?? UPDATE_REPOSITORY_NAME;
    this.apiBaseUrl = opts.apiBaseUrl ?? 'https://api.github.com';
    this.timeoutMs = opts.timeoutMs ?? 8000;
    this.fetchImpl = opts.fetchImpl ?? ((...args) => fetch(...args));
  }

  private async getJson<T>(path: string, timeoutMs?: number): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.apiBaseUrl}${path}`, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'master-code-updater',
        },
        signal: controller.signal,
      });
      if (res.status === 404) {
        throw new GitHubApiError(`Nao encontrado (404): ${path}`, 404);
      }
      if (res.status === 403) {
        throw new GitHubApiError('Limite de taxa do GitHub (403). Tente novamente mais tarde.', 403);
      }
      if (res.status >= 500) {
        throw new GitHubApiError(`Erro do GitHub (HTTP ${res.status}).`, res.status);
      }
      if (!res.ok) {
        throw new GitHubApiError(`Falha HTTP ${res.status}.`, res.status);
      }
      return (await res.json()) as T;
    } catch (err) {
      if (err instanceof GitHubApiError) throw err;
      if ((err as Error).name === 'AbortError') {
        throw new GitHubApiError(`Timeout ao consultar GitHub (${timeoutMs ?? this.timeoutMs}ms).`, 0);
      }
      throw new GitHubApiError('Sem conexao com o GitHub.', 0, true);
    } finally {
      clearTimeout(timer);
    }
  }

  async getLatestForChannel(channel: UpdateChannel): Promise<GitHubRelease | null> {
    if (channel === 'stable') {
      try {
        const release = await this.getJson<GitHubRelease>(
          `/repos/${this.owner}/${this.repo}/releases/latest?per_page=1`
        );
        if (!release.prerelease && !release.draft) return release;
      } catch (err) {
        if (err instanceof GitHubApiError && err.status === 404) return null;
        throw err;
      }
      const list = await this.listReleases();
      return list.find((r) => !r.prerelease && !r.draft) ?? null;
    }

    const list = await this.listReleases();
    if (channel === 'beta') {
      return list.find((r) => r.prerelease && !r.draft) ?? null;
    }
    return list.find((r) => r.prerelease && !r.draft && /alpha/i.test(r.tag_name)) ?? null;
  }

  async getByTag(tag: string): Promise<GitHubRelease | null> {
    const normalized = tag.startsWith('v') ? tag : `v${tag}`;
    try {
      return await this.getJson<GitHubRelease>(`/repos/${this.owner}/${this.repo}/releases/tags/${normalized}`);
    } catch (err) {
      if (err instanceof GitHubApiError && err.status === 404) return null;
      throw err;
    }
  }

  private async listReleases(): Promise<GitHubRelease[]> {
    const data = await this.getJson<GitHubRelease[]>(
      `/repos/${this.owner}/${this.repo}/releases?per_page=30`
    );
    return data ?? [];
  }

  async fetchText(url: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        headers: { 'User-Agent': 'master-code-updater' },
        signal: controller.signal,
      });
      if (!res.ok) throw new GitHubApiError(`Falha ao baixar (HTTP ${res.status}).`, res.status);
      return await res.text();
    } catch (err) {
      if (err instanceof GitHubApiError) throw err;
      if ((err as Error).name === 'AbortError') {
        throw new GitHubApiError(`Timeout ao baixar (${this.timeoutMs}ms).`, 0);
      }
      throw new GitHubApiError('Sem conexao ao baixar arquivo.', 0, true);
    } finally {
      clearTimeout(timer);
    }
  }
}

export { RELEASE_FIELDS };
