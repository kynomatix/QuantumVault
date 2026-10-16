import { beforeEach, describe, expect, it, vi } from 'vitest';
import { labRows, labTrade } from '../helpers/lab-provenance';
const state = vi.hoisted(() => ({ rows: [] as any[][], locks: [] as string[], inserts: [] as any[], updates: [] as any[], transactions: 0, rerun: vi.fn() }));
vi.mock('../../server/db', () => {
  const db: any = {
    transaction: async (fn: (tx: any) => unknown) => { state.transactions++; return fn(db); }, execute: vi.fn(async () => []),
    select: () => {
      const rows = state.rows.shift() ?? [];
      const q: any = { then: (yes: any, no: any) => Promise.resolve(rows).then(yes, no) };
      for (const key of ['from', 'where', 'orderBy', 'innerJoin', 'limit']) q[key] = () => q;
      q.for = (lock: string) => { state.locks.push(lock); return q; }; return q;
    },
    insert: () => ({ values: (v: any) => { state.inserts.push(v); return { returning: async () => [v] }; } }),
    update: () => ({ set: (v: any) => { state.updates.push(v); return { where: () => ({ returning: async () => [v] }) }; } }),
  }; return { db };
});
vi.mock('../../server/lab/provenance-rerun', () => ({ rerunLabWindow: (...args: any[]) => state.rerun(...args) }));
beforeEach(() => { state.rows = []; state.locks = []; state.inserts = []; state.updates = []; state.transactions = 0; state.rerun.mockReset(); vi.resetModules(); });
function signals() { return [{ payload: { action: 'buy', time: labTrade.entryTime, price: 100 }, receivedAt: new Date(labTrade.entryTime) }]; }

describe('owned transactional Lab creation and explicit confirmation', () => {
  it('permits a result selector, rejects all client evidence, and leaves manual creation unlinked', async () => {
    const { labSelection } = await import('../../server/lab/provenance');
    expect(labSelection({ name: 'EXAMPLE' })).toBeUndefined(); expect(labSelection({ labResultId: 3 })).toBe(3);
    for (const field of ['labStrategyId', 'labRunId', 'labDeploySnapshot', 'labLinkState', 'labLinkedAt', 'lab_strategy_id', 'lab_run_id', 'lab_result_id', 'lab_deploy_snapshot', 'lab_link_state', 'lab_linked_at']) {
      expect(() => labSelection({ [field]: null })).toThrow('LAB_CLIENT_EVIDENCE_REJECTED');
    }
    for (const labResultId of ['3', 0, -1, 1.5, null]) expect(() => labSelection({ labResultId })).toThrow('LAB_RESULT_REQUIRED');
  });
  it('locks the complete result/run/strategy chain before one bot insert, rejecting foreign owners', async () => {
    const { createLabLinkedBot } = await import('../../server/lab/provenance'); const r = labRows();
    state.rows.push([r.result], [r.run], [r.strategy]);
    const bot = await createLabLinkedBot(r.bot as any, 3);
    expect(state.transactions).toBe(1); expect(state.locks).toEqual(['share', 'share', 'share']); expect(state.inserts).toHaveLength(1);
    expect(bot).toMatchObject({ labLinkState: 'linked', labStrategyId: 1, labRunId: 2, labResultId: 3, labDeploySnapshot: { botId: bot.id, ownerWallet: 'EXAMPLE', resultId: 3 } });
    state.rows.push([r.result], [r.run], [{ ...r.strategy, userId: 'REDACTED' }]);
    await expect(createLabLinkedBot(r.bot as any, 3)).rejects.toThrow('LAB_SOURCE_NOT_OWNED_OR_COMPLETE');
    expect(state.inserts).toHaveLength(1);
    await expect(createLabLinkedBot({ ...r.bot, botType: 'ai' } as any, 3)).rejects.toThrow('LAB_SIGNAL_BOT_REQUIRED');
  });
  it('ranks and caches matches without writing, requires an owner tap, then refuses re-linking', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-16T00:00:00Z'));
    try {
      const api = await import('../../server/lab/provenance'), r = labRows();
      state.rows.push([r.bot], signals(), [{ strategy: r.strategy, run: r.run, result: r.result }]);
      const matches = await api.findLabSources('EXAMPLE', 'EXAMPLE');
      expect(matches.candidates[0]).toMatchObject({ resultId: 3, percent: 100, matched: 1, signals: 1 });
      expect(state.updates).toEqual([]); expect(state.inserts).toEqual([]); expect(state.rerun).not.toHaveBeenCalled();
      state.rows.push([r.bot]); expect(await api.findLabSources('EXAMPLE', 'EXAMPLE')).toEqual(matches);
      await expect(api.confirmLabSource('REDACTED', 'EXAMPLE', 3)).rejects.toThrow('LAB_FIND_SOURCE_AGAIN');
      state.rows.push([r.bot], [r.result], [r.run], [r.strategy]);
      expect(await api.confirmLabSource('EXAMPLE', 'EXAMPLE', 3)).toEqual({ state: 'owner_confirmed' });
      expect(state.locks).toEqual(['update', 'share', 'share', 'share']);
      expect(state.updates[0]).toMatchObject({ labResultId: 3, labLinkState: 'owner_confirmed' });
      await expect(api.confirmLabSource('EXAMPLE', 'EXAMPLE', 3)).rejects.toThrow('LAB_FIND_SOURCE_AGAIN');
    } finally { vi.restoreAllMocks(); }
  });
  it('refuses a changed result at confirmation and keeps an unmatched bot unlinked', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-16T00:00:00Z'));
    try {
      const api = await import('../../server/lab/provenance'), r = labRows();
      state.rows.push([r.bot], signals(), [{ strategy: r.strategy, run: r.run, result: r.result }]); await api.findLabSources('EXAMPLE', 'EXAMPLE');
      state.rows.push([r.bot], [{ ...r.result, params: { length: 99 } }], [r.run], [r.strategy]);
      await expect(api.confirmLabSource('EXAMPLE', 'EXAMPLE', 3)).rejects.toThrow('LAB_SOURCE_CHANGED_FIND_AGAIN'); expect(state.updates).toEqual([]);
      state.rows.push([{ ...r.bot, id: 'REDACTED' }], signals(), []);
      expect((await api.findLabSources('EXAMPLE', 'REDACTED')).candidates).toEqual([]);
      expect(state.updates).toEqual([]);
    } finally { vi.restoreAllMocks(); }
  });
  it('uses bounded current-engine reruns outside stored windows, and never writes triage', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-16T00:00:00Z'));
    try {
      const api = await import('../../server/lab/provenance'), r = labRows();
      r.run.endDate = '2026-10-14T00:00:00Z'; state.rerun.mockResolvedValue([labTrade]);
      state.rows.push([r.bot], signals(), [{ strategy: r.strategy, run: r.run, result: r.result }]);
      expect((await api.findLabSources('EXAMPLE', 'EXAMPLE')).candidates[0].basis).toContain('Current-engine');
      expect(state.rerun.mock.calls[0][3] - Date.now()).toBe(12_000);
      const { captureLabSnapshot } = await import('../../server/lab/provenance-snapshot');
      const snapshot = captureLabSnapshot(r.bot, r.strategy, r.run, r.result);
      state.rows.push([{ ...r.bot, labLinkState: 'linked', labDeploySnapshot: snapshot }], signals(), []);
      const triage = await api.triageLabBot('EXAMPLE', 'EXAMPLE');
      expect(triage.live.funding).toBe('unknown'); expect(triage.entries?.percent).toBe(100);
      expect(state.updates).toEqual([]); expect(state.inserts).toEqual([]);
    } finally { vi.restoreAllMocks(); }
  });
  it('reruns missing history, keeps a failed rerun unknown, and never relinks a saved snapshot', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-16T00:00:00Z'));
    try {
      const api = await import('../../server/lab/provenance'), r = labRows();
      r.result.trades = null; state.rerun.mockResolvedValue([labTrade]);
      state.rows.push([r.bot], signals(), [{ strategy: r.strategy, run: r.run, result: r.result }]);
      expect((await api.findLabSources('EXAMPLE', 'EXAMPLE')).candidates[0].basis).toContain('Current-engine');
      const { captureLabSnapshot } = await import('../../server/lab/provenance-snapshot');
      const linked = { ...r.bot, labLinkState: 'linked', labDeploySnapshot: captureLabSnapshot(r.bot, r.strategy, r.run, r.result) };
      state.rerun.mockRejectedValue(new Error('LAB_RERUN_TIMEOUT'));
      state.rows.push([linked], signals(), []);
      const triage = await api.triageLabBot('EXAMPLE', 'EXAMPLE');
      expect(triage.entries).toBeNull(); expect(triage.backtest.pnlDollar).toBeNull();
      expect(triage.basis).toContain('unavailable');
      state.rows.push([linked]); await expect(api.findLabSources('EXAMPLE', 'EXAMPLE')).rejects.toThrow('LAB_ALREADY_LINKED');
      expect(state.updates).toEqual([]); expect(state.inserts).toEqual([]);
    } finally { vi.restoreAllMocks(); }
  });
});
