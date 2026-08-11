import './helpers/setupConfigDir.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import {
  selectInstallerAsset,
  selectStandaloneAsset,
  selectChecksumAsset,
  versionedAssetName,
  isInstallerAsset,
  isStandaloneAsset,
  isChecksumAsset,
} from '../src/update/installer.js';
import { sha256Hex, sha256File, parseSha256Sums } from '../src/update/checksum.js';
import { GitHubReleaseClient, GitHubApiError } from '../src/update/githubRelease.js';
import type { GitHubClientLike } from '../src/update/githubRelease.js';
import { UpdateService } from '../src/update/updateService.js';
import { setUpdateSettings } from '../src/config.js';
import type { GitHubRelease, UpdateChannel } from '../src/update/types.js';

function makeRelease(tag: string, prerelease: boolean, assets: Array<{ name: string; size?: number }>): GitHubRelease {
  return {
    id: Math.abs(hashCode(tag)),
    tag_name: tag,
    name: tag,
    body: null,
    html_url: `https://example.com/releases/${tag}`,
    published_at: new Date().toISOString(),
    draft: false,
    prerelease,
    assets: assets.map((a) => ({
      name: a.name,
      browser_download_url: `https://example.com/download/${a.name}`,
      size: a.size ?? 100,
    })),
  };
}

function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

async function resetConfig(): Promise<void> {
  await setUpdateSettings({
    enabled: true,
    autoCheck: true,
    autoUpdate: false,
    channel: 'stable',
    lastUpdateCheck: null,
    lastKnownVersion: null,
    downloadedVersion: null,
    downloadedFileName: null,
    downloadedPath: null,
    downloadedChecksum: null,
  });
}

test('1. selecao de assets do instalador', () => {
  const release = makeRelease('v0.2.0', false, [
    { name: 'SHA256SUMS.txt' },
    { name: 'master-code-setup-0.2.0.exe', size: 500 },
    { name: 'master-code-0.2.0.exe', size: 300 },
  ]);
  const inst = selectInstallerAsset(release, '0.2.0');
  assert.ok(inst);
  assert.equal(inst!.name, 'master-code-setup-0.2.0.exe');
  assert.equal(selectStandaloneAsset(release)!.name, 'master-code-0.2.0.exe');
  assert.equal(selectChecksumAsset(release)!.name, 'SHA256SUMS.txt');
});

test('2. selecao cai para prefixo sem versao exata', () => {
  const release = makeRelease('v0.2.0', false, [
    { name: 'master-code-setup-0.1.0.exe' },
    { name: 'master-code-setup-0.2.0.exe' },
  ]);
  const inst = selectInstallerAsset(release, '0.2.0');
  assert.equal(inst!.name, 'master-code-setup-0.2.0.exe');
});

test('3. selecao retorna null quando nao ha asset', () => {
  assert.equal(selectInstallerAsset(null, '1.0.0'), null);
  assert.equal(selectInstallerAsset(makeRelease('v1.0.0', false, []), '1.0.0'), null);
  assert.equal(selectStandaloneAsset(makeRelease('v1.0.0', false, [{ name: 'master-code-setup-1.0.0.exe' }])), null);
});

test('4. helpers de nome de asset', () => {
  assert.ok(isInstallerAsset('master-code-setup-1.0.0.exe'));
  assert.ok(!isInstallerAsset('master-code-1.0.0.exe'));
  assert.ok(isStandaloneAsset('master-code-1.0.0.exe'));
  assert.ok(!isStandaloneAsset('master-code-setup-1.0.0.exe'));
  assert.ok(isChecksumAsset('SHA256SUMS.txt'));
  assert.ok(isChecksumAsset('sha256sums.txt'));
  assert.equal(versionedAssetName('master-code-setup', '1.2.3'), 'master-code-setup-1.2.3.exe');
});

test('5. sha256Hex vetor conhecido', () => {
  assert.equal(
    sha256Hex('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
  );
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('6. sha256File de arquivo temporario', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mc-sha-'));
  const file = path.join(dir, 'blob.bin');
  await fs.writeFile(file, 'conteudo de teste');
  const hex = await sha256File(file);
  assert.equal(hex, sha256Hex('conteudo de teste'));
});

test('7. parseSha256Sums', () => {
  const h1 = 'a'.repeat(64);
  const h2 = 'b'.repeat(64);
  const text = `${h1}  file1.exe\n${h2} *file2.exe\nlinha invalida\n\n`;
  const sums = parseSha256Sums(text);
  assert.equal(sums.size, 2);
  assert.equal(sums.get('file1.exe'), h1);
  assert.equal(sums.get('file2.exe'), h2);
  assert.equal(sums.has('invalida'), false);
});

test('8. stable: /releases/latest retorna release estavel', async () => {
  const stable = makeRelease('v0.2.0', false, []);
  const fetchImpl = async (url: string): Promise<never> => {
    assert.ok(url.includes('/releases/latest'));
    return jsonRes(200, stable) as never;
  };
  const client = new GitHubReleaseClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
  const rel = await client.getLatestForChannel('stable');
  assert.equal(rel?.tag_name, 'v0.2.0');
});

test('9. stable: 404 vira null', async () => {
  const fetchImpl = async (): Promise<never> => jsonRes(404, {}) as never;
  const client = new GitHubReleaseClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
  assert.equal(await client.getLatestForChannel('stable'), null);
});

test('10. erros HTTP sao propagados', async () => {
  const client403 = new GitHubReleaseClient({ fetchImpl: (async () => jsonRes(403, {})) as unknown as typeof fetch });
  await assert.rejects(() => client403.getLatestForChannel('stable'), (err: unknown) => {
    assert.ok(err instanceof GitHubApiError);
    assert.equal((err as GitHubApiError).status, 403);
    return true;
  });

  const client500 = new GitHubReleaseClient({ fetchImpl: (async () => jsonRes(500, {})) as unknown as typeof fetch });
  await assert.rejects(() => client500.getLatestForChannel('stable'), (err: unknown) => {
    assert.equal((err as GitHubApiError).status, 500);
    return true;
  });
});

test('11. timeout gera erro de timeout', async () => {
  const fetchImpl = async (): Promise<never> => {
    throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
  };
  const client = new GitHubReleaseClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
  await assert.rejects(() => client.getLatestForChannel('stable'), (err: unknown) => {
    assert.ok((err as GitHubApiError).message.includes('Timeout'));
    return true;
  });
});

test('12. offline (fetch rejeita) marca offline', async () => {
  const fetchImpl = async (): Promise<never> => {
    throw new TypeError('fetch failed');
  };
  const client = new GitHubReleaseClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
  await assert.rejects(() => client.getLatestForChannel('stable'), (err: unknown) => {
    assert.equal((err as GitHubApiError).offline, true);
    return true;
  });
});

test('13. beta seleciona prerelease', async () => {
  const pre = makeRelease('v0.3.0-beta.1', true, []);
  const stable = makeRelease('v0.2.0', false, []);
  const fetchImpl = async (url: string): Promise<never> => {
    if (url.includes('/releases/latest')) return jsonRes(200, pre) as never;
    return jsonRes(200, [pre, stable]) as never;
  };
  const client = new GitHubReleaseClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
  const rel = await client.getLatestForChannel('beta');
  assert.equal(rel?.tag_name, 'v0.3.0-beta.1');
});

test('14. alpha seleciona prerelease alpha', async () => {
  const alpha = makeRelease('v0.4.0-alpha.1', true, []);
  const beta = makeRelease('v0.3.0-beta.1', true, []);
  const stable = makeRelease('v0.2.0', false, []);
  const fetchImpl = async (): Promise<never> => jsonRes(200, [alpha, beta, stable]) as never;
  const client = new GitHubReleaseClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
  const rel = await client.getLatestForChannel('alpha');
  assert.equal(rel?.tag_name, 'v0.4.0-alpha.1');
});

function jsonRes(status: number, body: unknown): { status: number; ok: boolean; json: () => Promise<unknown> } {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

class CountingClient implements GitHubClientLike {
  calls = 0;
  tagCalls = 0;
  release: GitHubRelease | null = null;
  async getLatestForChannel(): Promise<GitHubRelease | null> {
    this.calls++;
    return this.release;
  }
  async getByTag(): Promise<GitHubRelease | null> {
    this.tagCalls++;
    return this.release;
  }
  async fetchText(): Promise<string> {
    return '';
  }
}

test('15. cache de verificacao evita nova chamada', async () => {
  await resetConfig();
  const client = new CountingClient();
  client.release = makeRelease('v9.9.9', false, []);
  const svc = new UpdateService({ client, checkIntervalMs: 60 * 60 * 1000 });

  const first = await svc.check(false);
  assert.equal(first.ok, true);
  assert.equal(first.updateAvailable, true);
  assert.equal(client.calls, 1);

  const second = await svc.check(false);
  assert.equal(second.fromCache, true);
  assert.equal(second.updateAvailable, true);
  assert.equal(client.calls, 1, 'cache evita segunda chamada');

  const forced = await svc.check(true);
  assert.equal(forced.fromCache, false);
  assert.equal(client.calls, 2, 'force ignora cache');
});

test('16. cache e ignorado apos intervalo', async () => {
  await resetConfig();
  await setUpdateSettings({ checkIntervalHours: 0 });
  const client = new CountingClient();
  client.release = makeRelease('v9.9.9', false, []);
  const svc = new UpdateService({ client, checkIntervalMs: 1 });
  await svc.check(false);
  await new Promise((r) => setTimeout(r, 5));
  const res = await svc.check(false);
  assert.equal(res.fromCache, false);
  assert.equal(client.calls, 2);
});

test('17. update desabilitado retorna erro', async () => {
  await resetConfig();
  await setUpdateSettings({ enabled: false });
  const svc = new UpdateService({ client: new CountingClient() });
  const res = await svc.check(false);
  assert.equal(res.ok, false);
  assert.ok((res.error ?? '').toLowerCase().includes('desabilitad'));
});

test('18. tag de release invalida retorna erro', async () => {
  await resetConfig();
  const client = new CountingClient();
  client.release = makeRelease('nao-semver', false, []);
  const svc = new UpdateService({ client });
  const res = await svc.check(true);
  assert.equal(res.ok, false);
  assert.ok((res.error ?? '').includes('invalida'));
});

test('19. offline no check marca offline', async () => {
  await resetConfig();
  const client = {
    async getLatestForChannel(): Promise<never> {
      throw new GitHubApiError('Sem conexao com o GitHub.', 0, true);
    },
    async getByTag(): Promise<never> {
      throw new GitHubApiError('Sem conexao com o GitHub.', 0, true);
    },
    async fetchText(): Promise<string> {
      return '';
    },
  };
  const svc = new UpdateService({ client });
  const res = await svc.check(true);
  assert.equal(res.ok, false);
  assert.equal(res.offline, true);
});

test('20. status reflete config e versao atual', async () => {
  await resetConfig();
  const st = await new UpdateService({ client: new CountingClient() }).status();
  assert.equal(st.enabled, true);
  assert.equal(st.autoCheck, true);
  assert.equal(st.autoUpdate, false);
  assert.equal(st.channel, 'stable');
  assert.equal(st.lastKnownVersion, null);
  assert.equal(st.downloaded, null);
  assert.equal(st.updateAvailable, false);
  assert.ok(st.currentVersion.length > 0);
});

test('21. canal nao-estavel respeita config', async () => {
  await resetConfig();
  await setUpdateSettings({ channel: 'beta' as UpdateChannel });
  const st = await new UpdateService({ client: new CountingClient() }).status();
  assert.equal(st.channel, 'beta');
});
