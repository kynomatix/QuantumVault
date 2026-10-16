import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Worker } from 'node:worker_threads';
import { build } from 'esbuild';
import { labRows } from '../helpers/lab-provenance';
import { captureLabSnapshot } from '../../server/lab/provenance-snapshot';
it('builds and runs the deployed worker against the existing Lab engine', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lab-provenance-')), outfile = join(dir, 'provenance-worker.cjs');
  let worker: Worker | undefined;
  try {
    await build({ entryPoints: ['server/lab/provenance-worker.ts'], bundle: true, platform: 'node', format: 'cjs', outfile, logLevel: 'silent' });
    const r = labRows(), snapshot = captureLabSnapshot(r.bot, r.strategy, r.run, r.result);
    const candles = Array.from({ length: 350 }, (_, i) => ({ time: Date.parse('2026-10-01') + i * 3600_000, open: 100 + i / 100, high: 102 + i / 100, low: 98 + i / 100, close: 101 + i / 100, volume: 100 }));
    worker = new Worker(outfile, { workerData: { candles, snapshot } });
    const message = await new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('EXAMPLE worker deadline')), 5000);
      worker!.once('message', data => { clearTimeout(timeout); resolve(data); });
      worker!.once('error', error => { clearTimeout(timeout); reject(error); });
    });
    expect(message.error).toBeUndefined(); expect(Array.isArray(message.trades)).toBe(true);
  } finally { await worker?.terminate(); await rm(dir, { recursive: true, force: true }); }
}, 10_000);
