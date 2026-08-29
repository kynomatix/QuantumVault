import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('BotManagementDrawer accounting-incomplete truth', () => {
  const source = readFileSync(resolve(process.cwd(), 'client/src/components/BotManagementDrawer.tsx'), 'utf8');

  it('labels partial totals and never presents observation context as a venue fill', () => {
    expect(source).toContain('performanceAccountingIncompleteCount');
    expect(source).toContain('The displayed total is partial.');
    expect(source).toContain("payload?.closeAccounting?.kind === 'unavailable'");
    expect(source).toContain('@ fill unavailable');
    expect(source).toContain('PnL and fee unavailable');
  });
});
