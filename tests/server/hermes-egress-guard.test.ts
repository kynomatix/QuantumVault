import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  findHermesLiteralFetches,
  findRepoHermesEgressViolations,
} from '../../scripts/check-hermes-egress.mjs';

describe('Hermes literal-fetch egress guard', () => {
  it('rejects a deliberate direct Hermes or Benchmarks fetch', () => {
    const source = [
      'fetch("https://hermes.pyth.network/v2/updates/price/latest")',
      'globalThis.fetch(`https://benchmarks.pyth.network/v1/shims/tradingview/history`)',
    ].join('\n');

    expect(findHermesLiteralFetches(source, 'server/deliberate-violation.ts')).toHaveLength(2);
  });

  it('does not reject a host constant or a call through hermesFetch', () => {
    const source = [
      'const base = "https://hermes.pyth.network";',
      'await hermesFetch(`${base}/v2/updates/price/latest`);',
    ].join('\n');

    expect(findHermesLiteralFetches(source, 'server/permitted.ts')).toEqual([]);
  });

  it('finds no literal-fetch bypass in runtime source', () => {
    const repositoryRoot = path.resolve(import.meta.dirname, '../..');
    expect(findRepoHermesEgressViolations(repositoryRoot)).toEqual([]);
  });
});
