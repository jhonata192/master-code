import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import path from 'node:path';

export interface DownloadProgress {
  received: number;
  total: number;
}

export interface DownloadOptions {
  timeoutMs?: number;
  onProgress?: (p: DownloadProgress) => void;
  fetchImpl?: typeof fetch;
}

export class DownloadError extends Error {
  readonly offline: boolean;
  constructor(message: string, offline = false) {
    super(message);
    this.name = 'DownloadError';
    this.offline = offline;
  }
}

export async function downloadToFile(
  url: string,
  destPath: string,
  opts: DownloadOptions = {}
): Promise<DownloadProgress> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 120000);
  const fetchImpl = opts.fetchImpl ?? ((...args) => fetch(...args));
  const tmpPath = destPath + '.part';

  try {
    const res = await fetchImpl(url, {
      headers: { 'User-Agent': 'master-code-updater' },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new DownloadError(`Falha ao baixar (HTTP ${res.status}).`);
    }
    if (!res.body) {
      throw new DownloadError('Resposta sem corpo (stream).');
    }

    const total = Number(res.headers.get('content-length') ?? 0);
    let received = 0;
    await mkdir(path.dirname(tmpPath), { recursive: true });

    const counter = new Transform({
      transform(chunk, _enc, cb) {
        received += chunk.length;
        if (opts.onProgress) opts.onProgress({ received, total });
        cb(null, chunk);
      },
    });

    await pipeline(Readable.fromWeb(res.body as never), counter, createWriteStream(tmpPath));
    await import('node:fs/promises').then((fs) => fs.rename(tmpPath, destPath));

    return { received, total };
  } catch (err) {
    await rm(tmpPath, { force: true }).catch(() => {});
    if (err instanceof DownloadError) throw err;
    if ((err as Error).name === 'AbortError') {
      throw new DownloadError(`Timeout ao baixar (${opts.timeoutMs ?? 120000}ms).`);
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new DownloadError(msg, /fetch failed/i.test(msg));
  } finally {
    clearTimeout(timer);
  }
}
