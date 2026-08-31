import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolvePerformanceSharingAuthority } from '../../client/src/components/BotManagementDrawer';

describe('BotManagementDrawer accounting-incomplete truth', () => {
  const source = readFileSync(resolve(process.cwd(), 'client/src/components/BotManagementDrawer.tsx'), 'utf8');

  it('labels partial totals and never presents observation context as a venue fill', () => {
    expect(source).toContain('performanceAccountingIncompleteCount');
    expect(source).toContain('The displayed total is partial.');
    expect(source).toContain("payload?.closeAccounting?.kind === 'unavailable'");
    expect(source).toContain('@ fill unavailable');
    expect(source).toContain('PnL and fee unavailable');
  });

  it('refuses to share performance whenever any displayed accounting is incomplete', () => {
    expect(resolvePerformanceSharingAuthority(null, 0)).toEqual({
      allowed: false,
      reason: 'Performance sharing unavailable while accounting is incomplete',
    });
    expect(resolvePerformanceSharingAuthority(125.5, 1)).toEqual({
      allowed: false,
      reason: 'Performance sharing unavailable while the displayed total is partial',
    });
    expect(resolvePerformanceSharingAuthority(125.5, 0)).toEqual({ allowed: true, reason: null });
  });
});
