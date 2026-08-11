import './helpers/setupConfigDir.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {
  renderMarkdown,
  plainText,
  extractBulletPoints,
  summarizeNotes,
  truncateNotesLines,
} from '../src/update/markdown.js';
import { getCachedNotes, putNotes, clearNotesCache, notesCachePath } from '../src/update/notesCache.js';
import { GitHubApiError } from '../src/update/githubRelease.js';
import type { GitHubClientLike } from '../src/update/githubRelease.js';
import { UpdateService } from '../src/update/updateService.js';
import { setUpdateSettings } from '../src/config.js';
import type { GitHubRelease, UpdateChannel } from '../src/update/types.js';

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

function makeRelease(tag: string, opts: { prerelease?: boolean; body?: string; id?: number } = {}): GitHubRelease {
  return {
    id: opts.id ?? Math.abs(hash(tag)),
    tag_name: tag,
    name: tag,
    body: opts.body ?? null,
    html_url: `https://example.com/releases/${tag}`,
    published_at: '2026-08-10T12:00:00.000Z',
    draft: false,
    prerelease: opts.prerelease ?? false,
    assets: [],
  };
}

class NotesClient implements GitHubClientLike {
  latest: GitHubRelease | null = null;
  byTag: GitHubRelease | null = null;
  latestCalls = 0;
  byTagCalls = 0;
  failLatest = false;
  failByTag = false;
  async getLatestForChannel(): Promise<GitHubRelease | null> {
    this.latestCalls++;
    if (this.failLatest) throw new GitHubApiError('Sem conexao com o GitHub.', 0, true);
    return this.latest;
  }
  async getByTag(): Promise<GitHubRelease | null> {
    this.byTagCalls++;
    if (this.failByTag) throw new GitHubApiError('Erro do GitHub (HTTP 500).', 500);
    return this.byTag;
  }
  async fetchText(): Promise<string> {
    return '';
  }
}

async function reset(): Promise<void> {
  await clearNotesCache();
  await setUpdateSettings({
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
  });
}

// ---------- Markdown ----------

test('1. renderMarkdown: titulos', () => {
  const out = renderMarkdown('# Titulo\n## Subtitulo\n### Sub\n');
  assert.ok(out.includes('Titulo'));
  assert.ok(out.includes('Subtitulo'));
  assert.ok(out.includes('Sub'));
  assert.ok(!out.includes('# Titulo'), 'marker de titulo removido');
  assert.ok(!out.includes('## Subtitulo'));
});

test('2. renderMarkdown: listas, negrito, codigo e links', () => {
  const out = renderMarkdown(
    '* item negrito **forte**\n- outro item\n1. ordenado\n\n`codigo` e [link](https://exemplo.com)'
  );
  assert.ok(out.includes('•'), 'bullet renderizado');
  assert.ok(out.includes('forte'), 'negrito renderizado');
  assert.ok(!out.includes('**forte**'), 'marker de negrito removido');
  assert.ok(out.includes('ordenado'), 'lista ordenada');
  assert.ok(out.includes('codigo'), 'codigo inline');
  assert.ok(!out.includes('`codigo`'), 'backticks removidos');
  assert.ok(out.includes('link') && out.includes('https://exemplo.com'), 'link com url');
});

test('3. renderMarkdown: bloco de codigo, citação e separador', () => {
  const out = renderMarkdown('```\nconst a = 1;\n```\n\n> citacao\n\n---');
  assert.ok(out.includes('const a = 1;'), 'bloco de codigo preservado');
  assert.ok(out.includes('citacao'), 'citacao renderizada');
  assert.ok(out.includes('─'), 'separador renderizado');
});

test('4. renderMarkdown: body vazio', () => {
  assert.equal(renderMarkdown(''), '');
  assert.equal(renderMarkdown(null as unknown as string), '');
});

test('5. plainText remove marcadores', () => {
  assert.equal(plainText('**a** e `b` e [c](https://x)'), 'a e b e c');
});

// ---------- Resumo / truncamento ----------

test('6. extractBulletPoints extrai itens reais das notas', () => {
  const body = '### Added\n* Feature A\n* Feature B\n\n### Fixed\n- Bugfix C\n- Bugfix D';
  assert.deepEqual(extractBulletPoints(body, 8), ['Feature A', 'Feature B', 'Bugfix C', 'Bugfix D']);
  assert.deepEqual(extractBulletPoints(body, 2), ['Feature A', 'Feature B']);
});

test('7. summarizeNotes nao inventa e usa fallback sem lista', () => {
  const body = '### Added\n* Novo sistema de memoria\n* Melhorias no contexto';
  assert.deepEqual(summarizeNotes(body, 8), ['Novo sistema de memoria', 'Melhorias no contexto']);
  assert.deepEqual(summarizeNotes('Apenas um paragrafo\n\nOutra linha sem lista.', 2), [
    'Apenas um paragrafo',
    'Outra linha sem lista.',
  ]);
  assert.deepEqual(summarizeNotes('', 5), []);
  assert.deepEqual(summarizeNotes(null as unknown as string, 5), []);
});

test('8. truncateNotesLines corta notas grandes', () => {
  const body = Array.from({ length: 12 }, (_, i) => `linha ${i + 1}`).join('\n');
  const r = truncateNotesLines(body, 5);
  assert.equal(r.truncated, true);
  assert.equal(r.lines.length, 5);
  assert.equal(r.remaining, 7);
  const small = truncateNotesLines(body, 50);
  assert.equal(small.truncated, false);
  assert.equal(small.remaining, 0);
});

// ---------- Cache de notas ----------

test('9. notesCache: put/get/overwrite/clear', async () => {
  await clearNotesCache();
  assert.equal(await getCachedNotes('0.2.0'), null);

  await putNotes({ id: 1, version: '0.2.0', tagName: 'v0.2.0', name: 'v0.2.0', publishedAt: '2026-08-10', htmlUrl: 'u', body: 'v1', fetchedAt: new Date().toISOString() });
  const entry = await getCachedNotes('0.2.0');
  assert.ok(entry);
  assert.equal(entry!.body, 'v1');

  await putNotes({ id: 2, version: '0.2.0', tagName: 'v0.2.0', name: 'v0.2.0', publishedAt: '2026-08-10', htmlUrl: 'u', body: 'v2', fetchedAt: new Date().toISOString() });
  const updated = await getCachedNotes('0.2.0');
  assert.equal(updated!.id, 2, 'release mudou, cache sobrescrito');

  await clearNotesCache();
  assert.equal(await getCachedNotes('0.2.0'), null);
});

test('10. notesCache persiste no disco', async () => {
  await clearNotesCache();
  await putNotes({ id: 7, version: '0.3.0', tagName: 'v0.3.0', name: 'v0.3.0', publishedAt: '2026-08-10', htmlUrl: 'u', body: 'persistida', fetchedAt: new Date().toISOString() });
  const raw = await fs.readFile(notesCachePath(), 'utf8');
  assert.ok(raw.includes('persistida'));
  assert.ok(raw.includes('"0.3.0"'));
});

// ---------- UpdateService.getReleaseNotes ----------

test('11. getReleaseNotes por versao: fresh depois cache', async () => {
  await reset();
  const release = makeRelease('v0.2.0', { body: 'Corpo 0.2.0' });
  const client = new NotesClient();
  client.byTag = release;
  const svc = new UpdateService({ client });

  const first = await svc.getReleaseNotes({ version: '0.2.0' });
  assert.equal(first.ok, true);
  assert.equal(first.fromCache, false);
  assert.equal(first.entry!.body, 'Corpo 0.2.0');
  assert.equal(client.byTagCalls, 1);

  const second = await svc.getReleaseNotes({ version: '0.2.0' });
  assert.equal(second.ok, true);
  assert.equal(second.fromCache, true);
  assert.equal(client.byTagCalls, 1, 'cache evita nova chamada');
});

test('12. getReleaseNotes aceita tag com v', async () => {
  await reset();
  const release = makeRelease('v0.2.0', { body: 'com v' });
  const client = new NotesClient();
  client.byTag = release;
  const svc = new UpdateService({ client });
  const res = await svc.getReleaseNotes({ version: 'v0.2.0' });
  assert.equal(res.ok, true);
  assert.equal(res.entry!.version, '0.2.0');
});

test('13. versao inexistente retorna erro', async () => {
  await reset();
  const client = new NotesClient();
  client.byTag = null;
  const svc = new UpdateService({ client });
  const res = await svc.getReleaseNotes({ version: '0.2.0' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'Release 0.2.0 nao encontrada.');
});

test('14. check() popula cache e notes sem versao usa cache', async () => {
  await reset();
  const release = makeRelease('v0.3.0', { body: 'Notas do check' });
  const client = new NotesClient();
  client.latest = release;
  const svc = new UpdateService({ client });

  const check = await svc.check(true);
  assert.equal(check.ok, true);
  assert.equal(check.updateAvailable, true);
  assert.equal(client.latestCalls, 1);

  const notes = await svc.getReleaseNotes();
  assert.equal(notes.ok, true);
  assert.equal(notes.fromCache, true);
  assert.equal(notes.entry!.body, 'Notas do check');
  assert.equal(client.latestCalls, 1, 'sem nova chamada ao GitHub');
});

test('15. cache expirado refaz a consulta', async () => {
  await reset();
  const release = makeRelease('v0.2.0', { body: 'notas' });
  const client = new NotesClient();
  client.latest = release;
  const svc = new UpdateService({ client, notesCacheTtlMs: 10 });

  await svc.check(true);
  await new Promise((r) => setTimeout(r, 30));
  const notes = await svc.getReleaseNotes();
  assert.equal(notes.fromCache, false, 'cache vencido refaz a consulta');
  assert.equal(client.latestCalls, 2);
});

test('16. erro da API propaga', async () => {
  await reset();
  const client = new NotesClient();
  client.failByTag = true;
  const svc = new UpdateService({ client });
  const res = await svc.getReleaseNotes({ version: '0.2.0' });
  assert.equal(res.ok, false);
  assert.ok((res.error ?? '').includes('500'));
});

test('17. offline no getReleaseNotes', async () => {
  await reset();
  const client = new NotesClient();
  client.failLatest = true;
  const svc = new UpdateService({ client });
  const res = await svc.getReleaseNotes();
  assert.equal(res.ok, false);
  assert.ok((res.error ?? '').includes('Sem conexao'));
});

test('18. canal beta apresenta notas da prerelease', async () => {
  await reset();
  await setUpdateSettings({ channel: 'beta' as UpdateChannel });
  const beta = makeRelease('v0.3.0-beta.1', { prerelease: true, body: 'Notas da beta' });
  const client = new NotesClient();
  client.latest = beta;
  const svc = new UpdateService({ client });

  const check = await svc.check(true);
  assert.equal(check.ok, true);
  assert.equal(check.latestVersion, '0.3.0-beta.1');
  assert.equal(check.updateAvailable, true);

  const notes = await svc.getReleaseNotes();
  assert.equal(notes.ok, true);
  assert.equal(notes.entry!.tagName, 'v0.3.0-beta.1');
  assert.equal(notes.entry!.body, 'Notas da beta');
});

test('19. consulta explicita de versao prerelease respeita a versao pedida', async () => {
  await reset();
  const pre = makeRelease('v0.4.0-rc.1', { prerelease: true, body: 'Notas do rc' });
  const client = new NotesClient();
  client.byTag = pre;
  const svc = new UpdateService({ client });
  const res = await svc.getReleaseNotes({ version: '0.4.0-rc.1' });
  assert.equal(res.ok, true);
  assert.equal(res.entry!.version, '0.4.0-rc.1');
  assert.equal(res.entry!.body, 'Notas do rc');
});
