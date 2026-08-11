import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { mkdirSync, copyFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import { getCurrentVersion } from './version.js';
import type { GitHubAsset, GitHubRelease } from './types.js';

export const INSTALLER_PREFIX = 'master-code-setup';
export const STANDALONE_PREFIX = 'master-code';

export function versionedAssetName(prefix: string, version: string): string {
  return `${prefix}-${version}.exe`;
}

export function isInstallerAsset(name: string): boolean {
  return name.startsWith(INSTALLER_PREFIX) && name.endsWith('.exe');
}

export function isStandaloneAsset(name: string): boolean {
  return name.startsWith(STANDALONE_PREFIX) && name.endsWith('.exe') && !isInstallerAsset(name);
}

export function isChecksumAsset(name: string): boolean {
  return /^SHA256SUMS\.txt$/i.test(name);
}

export function selectAsset(
  release: GitHubRelease | null,
  kind: 'installer' | 'standalone',
  version?: string
): GitHubAsset | null {
  if (!release?.assets?.length) return null;
  const assets = release.assets;
  const versioned = version ? versionedAssetName(INSTALLER_PREFIX, version) : null;

  if (kind === 'installer') {
    const byVersion = version
      ? assets.find((a) => a.name === `${INSTALLER_PREFIX}-${version}.exe`)
      : undefined;
    if (byVersion) return byVersion;
    const byVersionedName = versioned
      ? assets.find((a) => a.name === versioned.replace(INSTALLER_PREFIX, INSTALLER_PREFIX))
      : undefined;
    if (byVersionedName) return byVersionedName;
    return assets.find((a) => isInstallerAsset(a.name)) ?? null;
  }

  return assets.find((a) => isStandaloneAsset(a.name)) ?? null;
}

export function selectInstallerAsset(release: GitHubRelease | null, version?: string): GitHubAsset | null {
  return selectAsset(release, 'installer', version);
}

export function selectStandaloneAsset(release: GitHubRelease | null): GitHubAsset | null {
  return selectAsset(release, 'standalone');
}

export function selectChecksumAsset(release: GitHubRelease | null): GitHubAsset | null {
  if (!release?.assets) return null;
  return release.assets.find((a) => isChecksumAsset(a.name)) ?? null;
}

export interface InstallResult {
  ok: boolean;
  started: boolean;
  error?: string;
}

export function isInstalledExe(): boolean {
  return path.basename(process.execPath).toLowerCase() === 'master-code.exe';
}

function findInstalledExe(): string | null {
  const candidates = [
    path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'master-code', 'master-code.exe'),
    path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'master-code', 'master-code.exe'),
    path.join(process.env.LOCALAPPDATA ?? os.tmpdir(), 'master-code', 'master-code.exe'),
  ];
  return candidates.find((c) => existsSync(c)) ?? null;
}

export interface UpdaterProcess {
  updaterExe: string;
  args: string[];
}

export function buildUpdaterProcess(installerPath: string, restartExe: string): UpdaterProcess {
  const updaterDir = path.join(os.tmpdir(), 'master-code-updater');
  mkdirSync(updaterDir, { recursive: true });
  const updaterExe = path.join(updaterDir, 'master-code-updater.exe');
  const source = isInstalledExe() ? process.execPath : restartExe;
  copyFileSync(source, updaterExe);
  const args = [installerPath, String(process.pid), restartExe, getCurrentVersion()];
  return { updaterExe, args };
}

export function launchUpdater(installerPath: string, restartExe: string): InstallResult {
  let proc: UpdaterProcess;
  try {
    proc = buildUpdaterProcess(installerPath, restartExe);
  } catch (err) {
    return { ok: false, started: false, error: `Nao foi possivel preparar o updater: ${String(err)}` };
  }

  const child = spawn(proc.updaterExe, proc.args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  return { ok: true, started: true };
}

export function runInstallerSilent(installerPath: string): number {
  const r = spawnSync(installerPath, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'], {
    stdio: 'ignore',
    windowsHide: true,
    timeout: 600000,
  });
  return r.status ?? 1;
}
