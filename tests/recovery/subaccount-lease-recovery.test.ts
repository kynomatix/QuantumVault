import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';

// Mock the storage + crypto modules the recovery job depends on. The adapter is
// injected into processExpiredReservation directly, so it stays a plain stub.
// vi.mock factories are hoisted, so the mock objects must live in vi.hoisted().
const { storageMock, getUmkForWebhook, decryptRetainedSubaccountKeyV3 } = vi.hoisted(() => ({
  storageMock: {
    findExpiredReservations: vi.fn(),
    markSubaccountVerifiedEmpty: vi.fn(async () => {}),
    releaseReservationToSpare: vi.fn(async () => true),
    deleteReservedSubaccount: vi.fn(async () => true),
    markSubaccountStuckFunds: vi.fn(async () => {}),
    getWallet: vi.fn(async () => ({ address: 'wallet', agentPublicKey: 'AgentPubkey-1' })),
    getTradingBots: vi.fn(async () => []),
    getAiTraderBotsByWallet: vi.fn(async () => []),
    finalizeReusedSubaccount: vi.fn(async () => true),
  },
  getUmkForWebhook: vi.fn(),
  decryptRetainedSubaccountKeyV3: vi.fn(),
}));

vi.mock('../../server/storage.js', () => ({ storage: storageMock }));
vi.mock('../../server/session-v3.js', () => ({
  getUmkForWebhook: (...a: any[]) => getUmkForWebhook(...a),
  decryptRetainedSubaccountKeyV3: (...a: any[]) => decryptRetainedSubaccountKeyV3(...a),
}));
vi.mock('../../server/protocol/adapter-registry.js', () => ({
  getDefaultAdapter: () => adapter,
  // CHANGED (stale-test fix, 2026-07-18): commit 295ad338 ("Fix subaccount recovery and
  // cleanup to ensure protocol safety") changed runLeaseRecoveryOnce from getDefaultAdapter()
  // to getAdapter(row.protocol) for correct per-protocol routing. The mock only stubbed
  // getDefaultAdapter, so getAdapter returned undefined → try/catch skipped every row.
  getAdapter: (protocol: string) => {
    if (protocol === adapter?.protocolName) return adapter;
    throw new Error(`[test] no adapter for protocol "${protocol}"`);
  },
}));

import { processExpiredReservation, runLeaseRecoveryOnce } from '../../server/subaccount-lease-recovery.js';

const SUB = 'SubAccountId-1';
const AGENT = 'AgentPubkey-1';

let adapter: any;

function makeAdapter(overrides: Partial<any> = {}) {
  return {
    protocolName: 'pacifica',
    minTransferAmount: 1,
    subaccountCaps: { recyclable: true },
    verifySubaccountEmpty: vi.fn(async () => true),
    getAccountInfo: vi.fn(async () => ({ equity: 0 })),
    transferBetweenSubaccounts: vi.fn(async () => ({ success: true })),
    ...overrides,
  };
}

function makeFlashAdapter(overrides: Partial<any> = {}) {
  return {
    protocolName: 'flash',
    subaccountCaps: { recyclable: false },
    getWalletCollateralBalanceStrict: vi.fn(async () => 0),
    getWalletSolBalance: vi.fn(async () => 0),
    sweepBotWallet: vi.fn(async () => ({ usdcSwept: 5, solReclaimed: 0.01 })),
    ...overrides,
  };
}

function makeRow(overrides: Partial<any> = {}) {
  return {
    id: 1,
    walletAddress: 'wallet',
    protocol: 'pacifica',
    protocolSubaccountId: SUB,
    agentPublicKey: AGENT,
    status: 'reserving',
    claimToken: 'tok-1',
    subaccountKeyEncryptedV3: 'ENC',
    aadVersion: 2,
    botId: null,
    ...overrides,
  };
}

beforeAll(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  storageMock.findExpiredReservations.mockReset();
  storageMock.markSubaccountVerifiedEmpty.mockClear();
  storageMock.releaseReservationToSpare.mockClear().mockResolvedValue(true);
  storageMock.deleteReservedSubaccount.mockClear().mockResolvedValue(true);
  storageMock.markSubaccountStuckFunds.mockClear();
  storageMock.getWallet.mockClear().mockResolvedValue({ address: 'wallet', agentPublicKey: AGENT });
  storageMock.getTradingBots.mockClear().mockResolvedValue([]);
  storageMock.getAiTraderBotsByWallet.mockClear().mockResolvedValue([]);
  storageMock.finalizeReusedSubaccount.mockClear().mockResolvedValue(true);
  getUmkForWebhook.mockReset();
  decryptRetainedSubaccountKeyV3.mockReset();
  adapter = makeAdapter();
});

describe('processExpiredReservation — decision matrix (§5.1.4)', () => {
  it('a tokenless reservation is malformed and cannot be pooled or quarantined by identity alone', async () => {
    await processExpiredReservation(adapter, makeRow({ claimToken: null }) as any);

    expect(adapter.verifySubaccountEmpty).not.toHaveBeenCalled();
    expect(storageMock.markSubaccountVerifiedEmpty).not.toHaveBeenCalled();
    expect(storageMock.releaseReservationToSpare).not.toHaveBeenCalled();
    expect(storageMock.markSubaccountStuckFunds).not.toHaveBeenCalled();
  });

  it('EMPTY: returns an empty reservation to the spare pool, never quarantines', async () => {
    adapter.verifySubaccountEmpty.mockResolvedValue(true);
    await processExpiredReservation(adapter, makeRow() as any);

    expect(adapter.transferBetweenSubaccounts).not.toHaveBeenCalled();
    expect(storageMock.markSubaccountVerifiedEmpty).toHaveBeenCalledWith('pacifica', SUB);
    expect(storageMock.releaseReservationToSpare).toHaveBeenCalledWith({
      protocol: 'pacifica', protocolSubaccountId: SUB, claimToken: 'tok-1',
    });
    expect(storageMock.markSubaccountStuckFunds).not.toHaveBeenCalled();
  });

  it('FUNDED → swept-and-reclaimed: transfers to main, re-verifies empty, then pools (NOT quarantined)', async () => {
    vi.useFakeTimers();
    try {
      // Funded on the first read, empty after the sweep + indexing wait.
      adapter.verifySubaccountEmpty
        .mockResolvedValueOnce(false) // initial check
        .mockResolvedValue(true);     // post-sweep poll
      adapter.getAccountInfo.mockResolvedValue({ equity: 25 });
      getUmkForWebhook.mockResolvedValue({ umk: Buffer.alloc(32), cleanup: vi.fn() });
      decryptRetainedSubaccountKeyV3.mockReturnValue({ secretKey: new Uint8Array(64), cleanup: vi.fn() });

      const p = processExpiredReservation(adapter, makeRow() as any);
      // Drive the §7.1 indexing-wait poll (first backoff is 5s).
      await vi.advanceTimersByTimeAsync(5_000);
      await p;

      expect(adapter.transferBetweenSubaccounts).toHaveBeenCalledTimes(1);
      const arg = adapter.transferBetweenSubaccounts.mock.calls[0][0];
      expect(arg.fromSubaccountId).toBe(SUB);
      expect(arg.toSubaccountId).toBe(AGENT);
      expect(arg.amount).toBe(25);
      expect(storageMock.releaseReservationToSpare).toHaveBeenCalledTimes(1);
      expect(storageMock.markSubaccountStuckFunds).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('FUNDED + transfer fails: quarantines as stuck_funds (funds stay safe in the subaccount)', async () => {
    adapter.verifySubaccountEmpty.mockResolvedValue(false);
    adapter.getAccountInfo.mockResolvedValue({ equity: 25 });
    adapter.transferBetweenSubaccounts.mockResolvedValue({ success: false, error: 'rate limited' });
    getUmkForWebhook.mockResolvedValue({ umk: Buffer.alloc(32), cleanup: vi.fn() });
    decryptRetainedSubaccountKeyV3.mockReturnValue({ secretKey: new Uint8Array(64), cleanup: vi.fn() });

    await processExpiredReservation(adapter, makeRow() as any);

    expect(storageMock.markSubaccountStuckFunds).toHaveBeenCalledTimes(1);
    // §5.1.4: quarantine MUST be CAS-guarded on our claim token so a slot finalized
    // by another owner mid-flight is never clobbered.
    expect(storageMock.markSubaccountStuckFunds.mock.calls[0][0]).toMatchObject({ claimToken: 'tok-1' });
    expect(storageMock.releaseReservationToSpare).not.toHaveBeenCalled();
  });

  it('FUNDED + no retained key: quarantines without attempting a transfer', async () => {
    adapter.verifySubaccountEmpty.mockResolvedValue(false);
    await processExpiredReservation(adapter, makeRow({ subaccountKeyEncryptedV3: null }) as any);

    expect(adapter.transferBetweenSubaccounts).not.toHaveBeenCalled();
    expect(storageMock.markSubaccountStuckFunds).toHaveBeenCalledTimes(1);
  });

  it('FUNDED + sub-min dust: cannot sweep, quarantines', async () => {
    adapter.verifySubaccountEmpty.mockResolvedValue(false);
    adapter.getAccountInfo.mockResolvedValue({ equity: 0.5 }); // below minTransferAmount=1
    getUmkForWebhook.mockResolvedValue({ umk: Buffer.alloc(32), cleanup: vi.fn() });
    decryptRetainedSubaccountKeyV3.mockReturnValue({ secretKey: new Uint8Array(64), cleanup: vi.fn() });

    await processExpiredReservation(adapter, makeRow() as any);

    expect(adapter.transferBetweenSubaccounts).not.toHaveBeenCalled();
    expect(storageMock.markSubaccountStuckFunds).toHaveBeenCalledTimes(1);
    expect(storageMock.releaseReservationToSpare).not.toHaveBeenCalled();
  });

  it('FUNDED + no UMK available: DEFERS (leaves reserving) rather than quarantining', async () => {
    adapter.verifySubaccountEmpty.mockResolvedValue(false);
    getUmkForWebhook.mockResolvedValue(null);

    await processExpiredReservation(adapter, makeRow() as any);

    expect(adapter.transferBetweenSubaccounts).not.toHaveBeenCalled();
    expect(storageMock.markSubaccountStuckFunds).not.toHaveBeenCalled();
    expect(storageMock.releaseReservationToSpare).not.toHaveBeenCalled();
  });

  it('verify-empty read throws: leaves the reservation untouched (retry next cycle)', async () => {
    adapter.verifySubaccountEmpty.mockRejectedValue(new Error('RPC down'));
    await processExpiredReservation(adapter, makeRow() as any);

    expect(storageMock.markSubaccountStuckFunds).not.toHaveBeenCalled();
    expect(storageMock.releaseReservationToSpare).not.toHaveBeenCalled();
    expect(storageMock.markSubaccountVerifiedEmpty).not.toHaveBeenCalled();
  });

  it('wrong protocol for the active adapter: skips silently', async () => {
    await processExpiredReservation(adapter, makeRow({ protocol: 'drift' }) as any);
    expect(adapter.verifySubaccountEmpty).not.toHaveBeenCalled();
    expect(storageMock.releaseReservationToSpare).not.toHaveBeenCalled();
  });

  it('FUNDED + malformed balance: defers without transferring or pooling', async () => {
    adapter.verifySubaccountEmpty.mockResolvedValue(false);
    adapter.getAccountInfo.mockResolvedValue({ equity: Number.NaN });
    getUmkForWebhook.mockResolvedValue({ umk: Buffer.alloc(32), cleanup: vi.fn() });
    decryptRetainedSubaccountKeyV3.mockReturnValue({ secretKey: new Uint8Array(64), cleanup: vi.fn() });

    await processExpiredReservation(adapter, makeRow() as any);

    expect(adapter.transferBetweenSubaccounts).not.toHaveBeenCalled();
    expect(storageMock.releaseReservationToSpare).not.toHaveBeenCalled();
    expect(storageMock.markSubaccountStuckFunds).not.toHaveBeenCalled();
  });

  it('retired agent generation is quarantined without using it as a sweep destination', async () => {
    storageMock.getWallet.mockResolvedValueOnce({ address: 'wallet', agentPublicKey: 'new-agent' });

    await processExpiredReservation(adapter, makeRow() as any);

    expect(adapter.verifySubaccountEmpty).not.toHaveBeenCalled();
    expect(adapter.transferBetweenSubaccounts).not.toHaveBeenCalled();
    expect(storageMock.markSubaccountStuckFunds).toHaveBeenCalledWith(expect.objectContaining({
      claimToken: 'tok-1',
      agentPublicKey: AGENT,
    }));
  });

  it('reconciles a uniquely linked, durably-keyed trading bot instead of recycling its account', async () => {
    storageMock.getTradingBots.mockResolvedValue([{
      id: 'bot-1',
      activeProtocol: 'pacifica',
      protocolSubaccountId: SUB,
      subaccountAuthMode: 'external_key',
      botSubaccountKeyEncryptedV3: 'BOT_V3',
    }]);

    await processExpiredReservation(adapter, makeRow() as any);

    expect(storageMock.finalizeReusedSubaccount).toHaveBeenCalledWith({
      protocol: 'pacifica', protocolSubaccountId: SUB, claimToken: 'tok-1', botId: 'bot-1',
      terminalSubaccountStatus: 'error',
    });
    expect(adapter.verifySubaccountEmpty).not.toHaveBeenCalled();
    expect(storageMock.releaseReservationToSpare).not.toHaveBeenCalled();
  });

  it('leaves a uniquely linked, keyed paper AI reservation for idempotent go-live resume', async () => {
    storageMock.getAiTraderBotsByWallet.mockResolvedValue([{
      id: 'ai-1',
      protocol: 'pacifica',
      protocolSubaccountId: SUB,
      botSubaccountKeyEncryptedV3: 'AI_V3',
      paperMode: true,
    }]);

    await processExpiredReservation(adapter, makeRow() as any);

    expect(adapter.verifySubaccountEmpty).not.toHaveBeenCalled();
    expect(storageMock.releaseReservationToSpare).not.toHaveBeenCalled();
    expect(storageMock.markSubaccountStuckFunds).not.toHaveBeenCalled();
  });

  it('quarantines a linked but keyless bot rather than assigning the account twice', async () => {
    storageMock.getTradingBots.mockResolvedValue([{
      id: 'bot-1',
      activeProtocol: 'pacifica',
      protocolSubaccountId: SUB,
      subaccountAuthMode: 'external_key',
      botSubaccountKeyEncryptedV3: null,
    }]);

    await processExpiredReservation(adapter, makeRow() as any);

    expect(storageMock.markSubaccountStuckFunds).toHaveBeenCalledWith(expect.objectContaining({
      protocolSubaccountId: SUB,
      claimToken: 'tok-1',
      botId: 'bot-1',
    }));
    expect(adapter.verifySubaccountEmpty).not.toHaveBeenCalled();
  });
});

describe('Flash expired reservation recovery', () => {
  function flashRow(overrides: Partial<any> = {}) {
    return makeRow({ protocol: 'flash', ...overrides });
  }

  it('deletes an already-empty Flash reservation without decrypting or sweeping', async () => {
    adapter = makeFlashAdapter();
    storageMock.findExpiredReservations.mockResolvedValue([flashRow()]);

    await runLeaseRecoveryOnce();

    expect(adapter.sweepBotWallet).not.toHaveBeenCalled();
    expect(decryptRetainedSubaccountKeyV3).not.toHaveBeenCalled();
    expect(storageMock.deleteReservedSubaccount).toHaveBeenCalledWith({
      protocol: 'flash', protocolSubaccountId: SUB, claimToken: 'tok-1',
    });
  });

  it('sweeps a funded Flash wallet to the still-current agent and deletes only after strict empty verification', async () => {
    adapter = makeFlashAdapter();
    adapter.getWalletCollateralBalanceStrict
      .mockResolvedValueOnce(5)
      .mockResolvedValueOnce(0);
    adapter.getWalletSolBalance
      .mockResolvedValueOnce(0.02)
      .mockResolvedValueOnce(0.001);
    const umkCleanup = vi.fn();
    const keyCleanup = vi.fn();
    getUmkForWebhook.mockResolvedValue({ umk: Buffer.alloc(32), cleanup: umkCleanup });
    decryptRetainedSubaccountKeyV3.mockReturnValue({ secretKey: new Uint8Array(64), cleanup: keyCleanup });
    storageMock.findExpiredReservations.mockResolvedValue([flashRow()]);

    await runLeaseRecoveryOnce();

    expect(adapter.sweepBotWallet).toHaveBeenCalledWith({
      subSecretKey: expect.any(Uint8Array),
      destWalletAddress: AGENT,
    });
    expect(storageMock.deleteReservedSubaccount).toHaveBeenCalledTimes(1);
    expect(storageMock.markSubaccountStuckFunds).not.toHaveBeenCalled();
    expect(keyCleanup).toHaveBeenCalledTimes(1);
    expect(umkCleanup).toHaveBeenCalledTimes(1);
  });

  it('defers unreadable Flash state without deleting or quarantining', async () => {
    adapter = makeFlashAdapter({
      getWalletCollateralBalanceStrict: vi.fn(async () => { throw new Error('rpc unavailable'); }),
    });
    storageMock.findExpiredReservations.mockResolvedValue([flashRow()]);

    await runLeaseRecoveryOnce();

    expect(adapter.sweepBotWallet).not.toHaveBeenCalled();
    expect(storageMock.deleteReservedSubaccount).not.toHaveBeenCalled();
    expect(storageMock.markSubaccountStuckFunds).not.toHaveBeenCalled();
  });

  it('treats malformed Flash balances as unreadable and leaves the lease intact', async () => {
    adapter = makeFlashAdapter({
      getWalletCollateralBalanceStrict: vi.fn(async () => Number.NaN),
    });
    storageMock.findExpiredReservations.mockResolvedValue([flashRow()]);

    await runLeaseRecoveryOnce();

    expect(adapter.sweepBotWallet).not.toHaveBeenCalled();
    expect(storageMock.deleteReservedSubaccount).not.toHaveBeenCalled();
    expect(storageMock.markSubaccountStuckFunds).not.toHaveBeenCalled();
  });

  it('quarantines definitive Flash sweep failure and retains the pooled key trail', async () => {
    adapter = makeFlashAdapter({
      getWalletCollateralBalanceStrict: vi.fn(async () => 5),
      getWalletSolBalance: vi.fn(async () => 0.02),
      sweepBotWallet: vi.fn(async () => ({ error: 'definitive failure', usdcSwept: 0, solReclaimed: 0 })),
    });
    getUmkForWebhook.mockResolvedValue({ umk: Buffer.alloc(32), cleanup: vi.fn() });
    decryptRetainedSubaccountKeyV3.mockReturnValue({ secretKey: new Uint8Array(64), cleanup: vi.fn() });
    storageMock.findExpiredReservations.mockResolvedValue([flashRow()]);

    await runLeaseRecoveryOnce();

    expect(storageMock.markSubaccountStuckFunds).toHaveBeenCalledWith(expect.objectContaining({
      protocol: 'flash',
      claimToken: 'tok-1',
    }));
    expect(storageMock.deleteReservedSubaccount).not.toHaveBeenCalled();
  });

  it('never sweeps a Flash reservation to a retired agent generation', async () => {
    adapter = makeFlashAdapter({
      getWalletCollateralBalanceStrict: vi.fn(async () => 5),
      getWalletSolBalance: vi.fn(async () => 0.02),
    });
    storageMock.getWallet.mockResolvedValueOnce({ address: 'wallet', agentPublicKey: 'new-agent' });
    storageMock.findExpiredReservations.mockResolvedValue([flashRow()]);

    await runLeaseRecoveryOnce();

    expect(adapter.sweepBotWallet).not.toHaveBeenCalled();
    expect(storageMock.markSubaccountStuckFunds).toHaveBeenCalledTimes(1);
  });
});

describe('runLeaseRecoveryOnce', () => {
  it('no expired reservations: does nothing (no adapter work)', async () => {
    storageMock.findExpiredReservations.mockResolvedValue([]);
    await runLeaseRecoveryOnce();
    expect(adapter.verifySubaccountEmpty).not.toHaveBeenCalled();
  });

  it('processes each expired reservation', async () => {
    storageMock.findExpiredReservations.mockResolvedValue([makeRow(), makeRow({ id: 2, protocolSubaccountId: 'SubAccountId-2' })]);
    adapter.verifySubaccountEmpty.mockResolvedValue(true);
    await runLeaseRecoveryOnce();
    expect(storageMock.releaseReservationToSpare).toHaveBeenCalledTimes(2);
  });

  it('non-recyclable active adapter: skips even with expired rows present', async () => {
    storageMock.findExpiredReservations.mockResolvedValue([makeRow()]);
    adapter = makeAdapter({ subaccountCaps: { recyclable: false } });
    await runLeaseRecoveryOnce();
    expect(adapter.verifySubaccountEmpty).not.toHaveBeenCalled();
    expect(storageMock.releaseReservationToSpare).not.toHaveBeenCalled();
  });
});
