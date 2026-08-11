import path from 'node:path';
import { mkdir, stat, rm } from 'node:fs/promises';
import { loadConfig, setUpdateSettings, configDir } from '../config.js';
import { getCurrentVersion } from './version.js';
import { isNewerVersion, isValidVersion } from './semver.js';
import { GitHubReleaseClient } from './githubRelease.js';
import type { GitHubClientLike } from './githubRelease.js';
import { downloadToFile } from './download.js';
import { sha256File, parseSha256Sums } from './checksum.js';
import { selectInstallerAsset, selectStandaloneAsset, selectChecksumAsset, launchUpdater, isInstalledExe } from './installer.js';
import type { InstallResult } from './installer.js';
import { appendLog } from './updateLog.js';
import { getCachedNotes, putNotes } from './notesCache.js';
import type { CheckResult, DownloadResult, GitHubRelease, NotesEntry, ReleaseNotesResult, UpdateChannel, UpdateStatus } from './types.js';

export interface UpdateServiceOptions {
  client?: GitHubClientLike;
  checkIntervalMs?: number;
  checkTimeoutMs?: number;
  downloadTimeoutMs?: number;
  notesCacheTtlMs?: number;
}

const DEFAULT_NOTES_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export class UpdateService {
  private client: GitHubClientLike;
  private checkIntervalMs: number;
  private checkTimeoutMs: number;
  private downloadTimeoutMs: number;
  private notesCacheTtlMs: number;

  constructor(opts: UpdateServiceOptions = {}) {
    this.client = opts.client ?? new GitHubReleaseClient();
    this.checkIntervalMs = opts.checkIntervalMs ?? 24 * 60 * 60 * 1000;
    this.checkTimeoutMs = opts.checkTimeoutMs ?? 8000;
    this.downloadTimeoutMs = opts.downloadTimeoutMs ?? 120000;
    this.notesCacheTtlMs = opts.notesCacheTtlMs ?? DEFAULT_NOTES_CACHE_TTL_MS;
  }

  async check(force = false): Promise<CheckResult> {
    const cfg = await loadConfig();
    const current = getCurrentVersion();
    const base: CheckResult = {
      ok: true,
      currentVersion: current,
      latestVersion: null,
      updateAvailable: false,
      release: null,
      checkedAt: new Date().toISOString(),
      fromCache: false,
    };

    if (!cfg.update.enabled) {
      return { ...base, ok: false, error: 'Atualizacoes desabilitadas na configuracao.' };
    }

    if (!force) {
      const cached = await this.cachedResult();
      if (cached) return cached;
    }

    try {
      const release = await this.client.getLatestForChannel(cfg.update.channel);
      if (!release) {
        await this.saveCheck(null);
        return base;
      }
      const tag = release.tag_name.replace(/^v/, '');
      if (!isValidVersion(tag)) {
        await this.saveCheck(null);
        return { ...base, ok: false, error: `Versao invalida na release: ${release.tag_name}` };
      }
      await this.putNotesFromRelease(release);
      await this.saveCheck(tag);
      return {
        ...base,
        latestVersion: tag,
        updateAvailable: isNewerVersion(tag, current),
        release,
      };
    } catch (err) {
      const offline = (err as { offline?: boolean }).offline === true;
      return {
        ...base,
        ok: false,
        offline,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async cachedResult(): Promise<CheckResult | null> {
    const cfg = await loadConfig();
    if (!cfg.update.lastKnownVersion || !cfg.update.lastUpdateCheck) return null;
    const last = new Date(cfg.update.lastUpdateCheck).getTime();
    if (Number.isNaN(last)) return null;
    const intervalMs =
      cfg.update.checkIntervalHours > 0
        ? cfg.update.checkIntervalHours * 60 * 60 * 1000
        : this.checkIntervalMs;
    if (Date.now() - last >= intervalMs) return null;
    const current = getCurrentVersion();
    return {
      ok: true,
      currentVersion: current,
      latestVersion: cfg.update.lastKnownVersion,
      updateAvailable: isNewerVersion(cfg.update.lastKnownVersion, current),
      release: null,
      checkedAt: cfg.update.lastUpdateCheck,
      fromCache: true,
    };
  }

  private async saveCheck(latest: string | null): Promise<void> {
    await setUpdateSettings({
      lastUpdateCheck: new Date().toISOString(),
      lastKnownVersion: latest,
    });
  }

  async latestRelease(channel?: UpdateChannel): Promise<GitHubRelease | null> {
    const cfg = await loadConfig();
    return this.client.getLatestForChannel(channel ?? cfg.update.channel);
  }

  private notesEntryFromRelease(release: GitHubRelease): NotesEntry {
    return {
      id: release.id,
      version: release.tag_name.replace(/^v/, ''),
      tagName: release.tag_name,
      name: release.name,
      publishedAt: release.published_at,
      htmlUrl: release.html_url,
      body: release.body,
      fetchedAt: new Date().toISOString(),
    };
  }

  private async putNotesFromRelease(release: GitHubRelease): Promise<void> {
    try {
      await putNotes(this.notesEntryFromRelease(release));
    } catch {
      /* cache nunca deve derrubar o fluxo */
    }
  }

  private isNotesCacheFresh(entry: NotesEntry): boolean {
    const fetched = new Date(entry.fetchedAt).getTime();
    if (Number.isNaN(fetched)) return false;
    return Date.now() - fetched < this.notesCacheTtlMs;
  }

  async getReleaseNotes(opts: { version?: string; useCache?: boolean } = {}): Promise<ReleaseNotesResult> {
    const version = opts.version ? opts.version.replace(/^v/, '').trim() : null;
    const cfg = await loadConfig();

    if (version) {
      const cached = await getCachedNotes(version);
      if (cached && opts.useCache !== false && this.isNotesCacheFresh(cached)) {
        return { ok: true, entry: cached, fromCache: true };
      }
      let release: GitHubRelease | null;
      try {
        release = await this.client.getByTag(version);
      } catch (err) {
        return { ok: false, entry: null, fromCache: false, error: err instanceof Error ? err.message : String(err) };
      }
      if (!release) {
        return { ok: false, entry: null, fromCache: false, error: `Release ${version} nao encontrada.` };
      }
      const entry = this.notesEntryFromRelease(release);
      await this.putNotesFromRelease(release);
      return { ok: true, entry, fromCache: false };
    }

    if (opts.useCache !== false && cfg.update.lastKnownVersion) {
      const cached = await getCachedNotes(cfg.update.lastKnownVersion);
      if (cached && this.isNotesCacheFresh(cached)) {
        return { ok: true, entry: cached, fromCache: true };
      }
    }

    let release: GitHubRelease | null;
    try {
      release = await this.client.getLatestForChannel(cfg.update.channel);
    } catch (err) {
      return { ok: false, entry: null, fromCache: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (!release) {
      return { ok: false, entry: null, fromCache: false, error: 'Nenhuma release encontrada no GitHub.' };
    }
    const entry = this.notesEntryFromRelease(release);
    await this.putNotesFromRelease(release);
    return { ok: true, entry, fromCache: false };
  }

  async download(opts: { onProgress?: (p: { received: number; total: number }) => void } = {}): Promise<DownloadResult> {
    const cfg = await loadConfig();
    const current = getCurrentVersion();
    const fail = (error: string, extra: Partial<DownloadResult> = {}): DownloadResult => ({
      ok: false,
      version: null,
      filePath: null,
      fileName: null,
      size: 0,
      checksum: null,
      error,
      ...extra,
    });

    let release: GitHubRelease | null;
    try {
      release = await this.client.getLatestForChannel(cfg.update.channel);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
    if (!release) return fail('Nenhuma release encontrada no GitHub.');

    const tag = release.tag_name.replace(/^v/, '');
    if (!isValidVersion(tag)) return fail(`Versao invalida na release: ${release.tag_name}`);
    if (!isNewerVersion(tag, current)) {
      return fail(`Versao ${current} ja e a mais recente.`, { version: tag });
    }

    const installer = selectInstallerAsset(release, tag) ?? selectStandaloneAsset(release);
    if (!installer) return fail('A release nao possui instalador nem executavel standalone.');

    const checksumAsset = selectChecksumAsset(release);
    const updatesDir = path.join(configDir(), 'updates');
    await mkdir(updatesDir, { recursive: true });
    const destPath = path.join(updatesDir, installer.name);

    try {
      if (checksumAsset) {
        const sumsText = await this.client.fetchText(checksumAsset.browser_download_url);
        const sums = parseSha256Sums(sumsText);
        const expected = sums.get(installer.name);
        if (!expected) {
          await appendLog('download', { state: 'abortado', reason: 'checksum ausente', asset: installer.name });
          return fail(`Nao foi possivel verificar a integridade da atualizacao: checksum nao encontrado para ${installer.name}.`);
        }
        await downloadToFile(installer.browser_download_url, destPath, {
          timeoutMs: this.downloadTimeoutMs,
          onProgress: opts.onProgress,
        });
        const actual = await sha256File(destPath);
        if (actual.toLowerCase() !== expected.toLowerCase()) {
          await appendLog('download', { state: 'checksum-invalido', asset: installer.name, esperado: expected, obtido: actual });
          await rm(destPath, { force: true }).catch(() => {});
          return fail('Falha na verificacao de integridade (SHA-256) do arquivo baixado.');
        }
        const size = (await stat(destPath)).size;
        await setUpdateSettings({
          downloadedVersion: tag,
          downloadedFileName: installer.name,
          downloadedPath: destPath,
          downloadedChecksum: actual.toLowerCase(),
        });
        await appendLog('download', { state: 'ok', asset: installer.name, version: tag, size: String(size) });
        return {
          ok: true,
          version: tag,
          filePath: destPath,
          fileName: installer.name,
          size,
          checksum: actual.toLowerCase(),
        };
      }

      const standalone = selectStandaloneAsset(release);
      if (!standalone) {
        return fail('Nao foi possivel verificar a integridade da atualizacao (checksum ausente na release).');
      }
      await downloadToFile(standalone.browser_download_url, destPath, {
        timeoutMs: this.downloadTimeoutMs,
        onProgress: opts.onProgress,
      });
      const size = (await stat(destPath)).size;
      await setUpdateSettings({
        downloadedVersion: tag,
        downloadedFileName: standalone.name,
        downloadedPath: destPath,
        downloadedChecksum: '',
      });
      await appendLog('download', { state: 'ok-sem-checksum', asset: standalone.name, version: tag, size: String(size) });
      return {
        ok: true,
        version: tag,
        filePath: destPath,
        fileName: standalone.name,
        size,
        checksum: null,
      };
    } catch (err) {
      const offline = (err as { offline?: boolean }).offline === true;
      await rm(destPath, { force: true }).catch(() => {});
      return fail(err instanceof Error ? err.message : String(err), { offline });
    }
  }

  async install(): Promise<InstallResult> {
    const cfg = await loadConfig();
    if (!cfg.update.downloadedPath || !cfg.update.downloadedVersion) {
      return { ok: false, started: false, error: 'Nenhuma atualizacao baixada. Use /update download primeiro.' };
    }

    const destPath = cfg.update.downloadedPath;
    const expected = cfg.update.downloadedChecksum;
    const downloadedVersion = cfg.update.downloadedVersion;

    try {
      const exists = await stat(destPath).then(() => true).catch(() => false);
      if (!exists) {
        return { ok: false, started: false, error: `Arquivo baixado nao existe: ${destPath}` };
      }

      if (expected) {
        const actual = await sha256File(destPath);
        if (actual.toLowerCase() !== expected.toLowerCase()) {
          await appendLog('install', { state: 'abortado', reason: 'checksum-invalido', asset: destPath });
          return { ok: false, started: false, error: 'Checksum do arquivo baixado nao confere. Baixe novamente.' };
        }
      }

      if (!isInstalledExe()) {
        return {
          ok: false,
          started: false,
          error: 'Este processo nao e a versao instalada (master-code.exe). Use npm run build:exe + install:exe antes de atualizar.',
        };
      }

      const result = launchUpdater(destPath, process.execPath);
      if (!result.ok) return result;
      await appendLog('install', { state: 'iniciado', asset: destPath, version: downloadedVersion, updater: 'master-code-updater.exe' });
      return result;
    } catch (err) {
      return { ok: false, started: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async status(): Promise<UpdateStatus> {
    const cfg = await loadConfig();
    const current = getCurrentVersion();
    let downloaded = null;
    if (cfg.update.downloadedPath) {
      downloaded = {
        version: cfg.update.downloadedVersion ?? '',
        fileName: cfg.update.downloadedFileName ?? '',
        path: cfg.update.downloadedPath,
        checksum: cfg.update.downloadedChecksum ?? '',
      };
    }
    return {
      currentVersion: current,
      channel: cfg.update.channel,
      enabled: cfg.update.enabled,
      autoCheck: cfg.update.autoCheck,
      autoUpdate: cfg.update.autoUpdate,
      lastUpdateCheck: cfg.update.lastUpdateCheck,
      lastKnownVersion: cfg.update.lastKnownVersion,
      updateAvailable: cfg.update.lastKnownVersion ? isNewerVersion(cfg.update.lastKnownVersion, current) : false,
      downloaded,
    };
  }
}
