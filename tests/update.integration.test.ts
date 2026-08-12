import './helpers/setupConfigDir.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import { GitHubReleaseClient } from '../src/update/githubRelease.js';
import { UpdateService } from '../src/update/updateService.js';
import { clearNotesCache } from '../src/update/notesCache.js';
import { sha256Hex } from '../src/update/checksum.js';
import { configDir, setUpdateSettings } from '../src/config.js';
import type { GitHubAsset, GitHubRelease } from '../src/update/types.js';

interface Server {
  url: string;
  requestCount: () => number;
  close: () => Promise<void>;
}

function buildRelease(version: string, assets: GitHubAsset[], body = 'release de teste'): GitHubRelease {
  return {
    id: Math.abs(hash(version)),
    tag_name: `v${version}`,
    name: `v${version}`,
    body,
    html_url: `http://127.0.0.1/release/v${version}`,
    published_at: '2026-08-10T12:00:00.000Z',
    draft: false,
    prerelease: false,
    assets,
  };
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

async function makeServer(opts: {
  version: string;
  installerContent: Buffer;
  checksumLine?: string | null;
  body?: string;
}): Promise<Server> {
  const installerName = `master-code-setup-${opts.version}.exe`;
  const standaloneName = `master-code-${opts.version}.exe`;
  let release: GitHubRelease | null = null;
  let requests = 0;

  const server = http.createServer((req, res) => {
    requests++;
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (pathname.endsWith('/releases/latest')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(release));
      return;
    }
    if (pathname.endsWith('/releases')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([release]));
      return;
    }
    const tagsMatch = /\/releases\/tags\/(.+)$/.exec(pathname);
    if (tagsMatch) {
      const tag = decodeURIComponent(tagsMatch[1]);
      if (release && tag === release.tag_name) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(release));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'Not Found' }));
      }
      return;
    }
    if (pathname === `/download/${installerName}`) {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(opts.installerContent.length) });
      res.end(opts.installerContent);
      return;
    }
    if (pathname === '/download/SHA256SUMS.txt') {
      const line =
        opts.checksumLine ?? `${sha256Hex(opts.installerContent)}  ${installerName}`;
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(line + '\n');
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  release = buildRelease(
    opts.version,
    [
      { name: installerName, browser_download_url: `${base}/download/${installerName}`, size: opts.installerContent.length },
      { name: standaloneName, browser_download_url: `${base}/download/${standaloneName}`, size: 42 },
      { name: 'SHA256SUMS.txt', browser_download_url: `${base}/download/SHA256SUMS.txt`, size: 100 },
    ],
    opts.body
  );

  return {
    url: base,
    requestCount: () => requests,
    close: () => new Promise((done) => server.close(() => done())),
  };
}

function makeClient(url: string): GitHubReleaseClient {
  return new GitHubReleaseClient({ apiBaseUrl: url, timeoutMs: 5000 });
}

async function resetConfig(): Promise<void> {
  await clearNotesCache();
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

test('1. check contra servidor local descobre versao nova', async () => {
  await resetConfig();
  const content = Buffer.from('exe-content-1');
  const srv = await makeServer({ version: '9.9.9', installerContent: content });
  try {
    const svc = new UpdateService({ client: makeClient(srv.url) });
    const res = await svc.check(true);
    assert.equal(res.ok, true);
    assert.equal(res.latestVersion, '9.9.9');
    assert.equal(res.updateAvailable, true);
    assert.ok(res.release);
  } finally {
    await srv.close();
  }
});

test('2. download baixa, valida checksum e persiste', async () => {
  await resetConfig();
  const content = Buffer.from('exe-content-2'.repeat(50));
  const srv = await makeServer({ version: '9.9.9', installerContent: content });
  try {
    const svc = new UpdateService({ client: makeClient(srv.url) });
    const res = await svc.download();
    assert.equal(res.ok, true, res.error);
    assert.equal(res.version, '9.9.9');
    assert.equal(res.fileName, 'master-code-setup-9.9.9.exe');
    assert.equal(res.size, content.length);
    assert.equal(res.checksum, sha256Hex(content));

    const filePath = res.filePath!;
    assert.deepEqual(await fs.readFile(filePath), content);

    const cfg = await import('../src/config.js');
    assert.equal(cfg.configDir(), configDir());
    const expected = path.join(configDir(), 'updates', 'master-code-setup-9.9.9.exe');
    assert.equal(filePath, expected);
    assert.equal(await fs.stat(filePath).then((s) => s.size), content.length);

    const st = await svc.status();
    assert.ok(st.downloaded);
    assert.equal(st.downloaded!.version, '9.9.9');
    assert.equal(st.downloaded!.fileName, 'master-code-setup-9.9.9.exe');
  } finally {
    await srv.close();
  }
});

test('3. checksum invalido aborta e remove o arquivo', async () => {
  await resetConfig();
  const content = Buffer.from('exe-content-3');
  const badHash = 'f'.repeat(64);
  const srv = await makeServer({ version: '9.9.9', installerContent: content, checksumLine: `${badHash}  master-code-setup-9.9.9.exe` });
  try {
    const svc = new UpdateService({ client: makeClient(srv.url) });
    const res = await svc.download();
    assert.equal(res.ok, false);
    assert.ok((res.error ?? '').toLowerCase().includes('integridade'));

    const target = path.join(configDir(), 'updates', 'master-code-setup-9.9.9.exe');
    await assert.rejects(fs.stat(target), 'arquivo removido apos checksum invalido');
  } finally {
    await srv.close();
  }
});

test('4. checksum ausente do sums aborta com mensagem de integridade', async () => {
  await resetConfig();
  const content = Buffer.from('exe-content-4');
  const srv = await makeServer({ version: '9.9.9', installerContent: content, checksumLine: `${sha256Hex(content)}  outro-arquivo.exe` });
  try {
    const svc = new UpdateService({ client: makeClient(srv.url) });
    const res = await svc.download();
    assert.equal(res.ok, false);
    assert.ok((res.error ?? '').toLowerCase().includes('checksum'));
  } finally {
    await srv.close();
  }
});

test('5. ja na ultima versao nao baixa', async () => {
  await resetConfig();
  const content = Buffer.from('exe-content-5');
  const srv = await makeServer({ version: '0.1.0', installerContent: content });
  try {
    const svc = new UpdateService({ client: makeClient(srv.url) });
    const res = await svc.download();
    assert.equal(res.ok, false);
    assert.ok((res.error ?? '').includes('mais recente'));
  } finally {
    await srv.close();
  }
});

test('6. check usa cache entre chamadas', async () => {
  await resetConfig();
  const content = Buffer.from('exe-content-6');
  const srv = await makeServer({ version: '9.9.9', installerContent: content });
  try {
    const svc = new UpdateService({ client: makeClient(srv.url), checkIntervalMs: 60 * 60 * 1000 });
    const first = await svc.check(false);
    assert.equal(first.ok, true);
    assert.equal(first.updateAvailable, true);
    const second = await svc.check(false);
    assert.equal(second.fromCache, true);
    assert.equal(second.latestVersion, '9.9.9');
  } finally {
    await srv.close();
  }
});

test('7. check armazena as notas e /update notes usa cache sem nova chamada', async () => {
  await resetConfig();
  const content = Buffer.from('exe-content-7');
  const body = '### Added\n* Novo sistema de notas\n* Comando /update notes\n\n### Fixed\n* Correcao de bug';
  const srv = await makeServer({ version: '0.2.0', installerContent: content, body });
  try {
    const svc = new UpdateService({ client: makeClient(srv.url) });
    const check = await svc.check(true);
    assert.equal(check.ok, true);

    const notes = await svc.getReleaseNotes();
    assert.equal(notes.ok, true);
    assert.equal(notes.fromCache, true, 'notas vêm do cache populado pelo check');
    assert.ok(notes.entry);
    assert.equal(notes.entry!.version, '0.2.0');
    assert.equal(notes.entry!.body, body);
    assert.equal(notes.entry!.publishedAt, '2026-08-10T12:00:00.000Z');
    assert.ok(notes.entry!.htmlUrl);
    assert.equal(notes.entry!.id, hash('0.2.0'));
  } finally {
    await srv.close();
  }
});

test('8. /update notes <versao> retorna notas daquela release', async () => {
  await resetConfig();
  const content = Buffer.from('exe-content-8');
  const body = 'Notas especificas da 0.2.0';
  const srv = await makeServer({ version: '0.2.0', installerContent: content, body });
  try {
    const svc = new UpdateService({ client: makeClient(srv.url) });
    const notes = await svc.getReleaseNotes({ version: '0.2.0' });
    assert.equal(notes.ok, true);
    assert.equal(notes.fromCache, false);
    assert.equal(notes.entry!.version, '0.2.0');
    assert.equal(notes.entry!.body, body);

    const again = await svc.getReleaseNotes({ version: '0.2.0' });
    assert.equal(again.fromCache, true, 'segunda leitura vem do cache');
  } finally {
    await srv.close();
  }
});

test('9. /update notes de versao inexistente retorna erro', async () => {
  await resetConfig();
  const content = Buffer.from('exe-content-9');
  const srv = await makeServer({ version: '0.2.0', installerContent: content });
  try {
    const svc = new UpdateService({ client: makeClient(srv.url) });
    const notes = await svc.getReleaseNotes({ version: '9.9.9' });
    assert.equal(notes.ok, false);
    assert.equal(notes.error, 'Release 9.9.9 nao encontrada.');
  } finally {
    await srv.close();
  }
});

test('10. release sem notas tem body nulo e nao quebra', async () => {
  await resetConfig();
  const content = Buffer.from('exe-content-10');
  const srv = await makeServer({ version: '0.2.0', installerContent: content, body: '' });
  try {
    const svc = new UpdateService({ client: makeClient(srv.url) });
    await svc.check(true);
    const notes = await svc.getReleaseNotes();
    assert.equal(notes.ok, true);
    assert.equal(notes.entry!.body, '');
  } finally {
    await srv.close();
  }
});

test('11. useCache=false refaz a consulta ao GitHub', async () => {
  await resetConfig();
  const content = Buffer.from('exe-content-11');
  const srv = await makeServer({ version: '0.2.0', installerContent: content });
  try {
    const svc = new UpdateService({ client: makeClient(srv.url) });
    await svc.check(true);
    const before = srv.requestCount();
    const notes = await svc.getReleaseNotes();
    assert.equal(notes.fromCache, true);
    const afterCache = srv.requestCount();
    assert.equal(afterCache, before, 'cache não gera chamada de rede');

    const fresh = await svc.getReleaseNotes({ useCache: false });
    assert.equal(fresh.fromCache, false);
    assert.equal(srv.requestCount(), afterCache + 1, 'useCache=false consulta o GitHub novamente');
  } finally {
    await srv.close();
  }
});
