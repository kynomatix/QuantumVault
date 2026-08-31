/**
 * tests/server/agent-wallet-strict.test.ts
 *
 * WO-15B.2.2 item 6: getAgentUsdcBalanceStrict — connection-seam contract.
 *
 * Contract:
 *  - getAccountInfo() returns null (absent / uninitialised ATA) → 0, never throws.
 *  - getAccountInfo() throws (RPC transport error) → propagates (fail closed).
 *  - ATA exists, getTokenAccountBalance() returns 0 → 0 (legitimate empty balance).
 *  - ATA exists, getTokenAccountBalance() returns positive → that value.
 *  - ATA exists, getTokenAccountBalance() throws → propagates (fail closed).
 *
 * Why getServerConnection() works as the mock seam:
 *   getAgentUsdcBalanceStrict calls the internal getConnection() singleton.
 *   getServerConnection() returns that exact same instance, so spies applied
 *   to the returned Connection object are visible to the function under test.
 */

import { Keypair, VersionedTransaction } from '@solana/web3.js';
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import {
  AgentDepositPreflightError,
  agentDepositPreflightHttpResponse,
  buildTransferToAgentTransaction,
  getAgentUsdcBalanceStrict,
  getServerConnection,
} from '../../server/agent-wallet';

// A valid base58-encoded 32-byte public key (System Program / all-zero pubkey).
// Used as a placeholder agent address — the RPC methods are mocked so no
// real network calls are made and the key's on-chain state is irrelevant.
const TEST_AGENT_KEY = '11111111111111111111111111111111';

describe('getAgentUsdcBalanceStrict — connection seam contract (item 6)', () => {
  // Grab the singleton connection ONCE. All tests spy on the same instance so
  // that spies intercept the calls getAgentUsdcBalanceStrict actually makes.
  let conn: ReturnType<typeof getServerConnection>;

  beforeAll(() => {
    conn = getServerConnection();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('getAccountInfo returns null (absent ATA) → returns 0, does not throw', async () => {
    vi.spyOn(conn, 'getAccountInfo').mockResolvedValueOnce(null as any);

    const result = await getAgentUsdcBalanceStrict(TEST_AGENT_KEY);

    // null ATA → 0, no throw. getTokenAccountBalance is not called (early return).
    expect(result).toBe(0);
  });

  it('getAccountInfo throws (RPC transport error) → error propagates (fail closed)', async () => {
    vi.spyOn(conn, 'getAccountInfo').mockRejectedValueOnce(
      new Error('getAccountInfo failed: network error'),
    );

    await expect(getAgentUsdcBalanceStrict(TEST_AGENT_KEY)).rejects.toThrow(
      'getAccountInfo failed: network error',
    );
  });

  it('ATA exists with zero token balance → returns 0 (legitimate empty, not an error)', async () => {
    vi.spyOn(conn, 'getAccountInfo').mockResolvedValueOnce({ data: Buffer.alloc(165) } as any);
    vi.spyOn(conn, 'getTokenAccountBalance').mockResolvedValueOnce({
      value: { uiAmount: 0, amount: '0', decimals: 6 },
    } as any);

    const result = await getAgentUsdcBalanceStrict(TEST_AGENT_KEY);

    // Zero is a valid balance (wallet has ATA but holds no USDC yet).
    expect(result).toBe(0);
  });

  it('ATA exists with positive balance → returns that balance', async () => {
    vi.spyOn(conn, 'getAccountInfo').mockResolvedValueOnce({ data: Buffer.alloc(165) } as any);
    vi.spyOn(conn, 'getTokenAccountBalance').mockResolvedValueOnce({
      value: { uiAmount: 500.25, amount: '500250000', decimals: 6 },
    } as any);

    const result = await getAgentUsdcBalanceStrict(TEST_AGENT_KEY);

    expect(result).toBe(500.25);
  });

  it('getTokenAccountBalance throws (RPC error on existing ATA) → error propagates (fail closed)', async () => {
    vi.spyOn(conn, 'getAccountInfo').mockResolvedValueOnce({ data: Buffer.alloc(165) } as any);
    vi.spyOn(conn, 'getTokenAccountBalance').mockRejectedValueOnce(
      new Error('getTokenAccountBalance failed: connection timeout'),
    );

    await expect(getAgentUsdcBalanceStrict(TEST_AGENT_KEY)).rejects.toThrow(
      'getTokenAccountBalance failed: connection timeout',
    );
  });

  it('uiAmount is null (token account has non-standard data) → falls back to 0', async () => {
    // Some token accounts can return uiAmount=null (e.g. fractional amounts below
    // UI precision). The || 0 fallback in the implementation handles this safely.
    vi.spyOn(conn, 'getAccountInfo').mockResolvedValueOnce({ data: Buffer.alloc(165) } as any);
    vi.spyOn(conn, 'getTokenAccountBalance').mockResolvedValueOnce({
      value: { uiAmount: null, amount: '0', decimals: 6 },
    } as any);

    const result = await getAgentUsdcBalanceStrict(TEST_AGENT_KEY);

    expect(result).toBe(0);
  });
});

describe('buildTransferToAgentTransaction - fail-before-wallet preflight', () => {
  let conn: ReturnType<typeof getServerConnection>;
  const userWallet = Keypair.generate().publicKey.toBase58();
  const agentWallet = Keypair.generate().publicKey.toBase58();
  const accountInfo = { data: Buffer.alloc(165), executable: false, lamports: 2_039_280, owner: Keypair.generate().publicKey } as any;

  beforeAll(() => {
    conn = getServerConnection();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function tokenBalance(amount: string) {
    return {
      context: { slot: 1 },
      value: { amount, decimals: 6, uiAmount: Number(amount) / 1_000_000, uiAmountString: (Number(amount) / 1_000_000).toString() },
    } as any;
  }

  function blockhash() {
    return { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 123 };
  }

  it('refuses a missing source USDC account before blockhash or simulation', async () => {
    vi.spyOn(conn, 'getAccountInfo').mockResolvedValueOnce(null);
    const blockhashSpy = vi.spyOn(conn, 'getLatestBlockhash');
    const simulationSpy = vi.spyOn(conn, 'simulateTransaction');

    await expect(buildTransferToAgentTransaction(userWallet, agentWallet, 10)).rejects.toMatchObject({
      name: 'AgentDepositPreflightError',
      code: 'source_usdc_account_missing',
      httpStatus: 422,
    });
    expect(blockhashSpy).not.toHaveBeenCalled();
    expect(simulationSpy).not.toHaveBeenCalled();
  });

  it('compares exact raw USDC and refuses an insufficient source before building', async () => {
    vi.spyOn(conn, 'getAccountInfo').mockResolvedValueOnce(accountInfo);
    vi.spyOn(conn, 'getTokenAccountBalance').mockResolvedValueOnce(tokenBalance('9999999'));
    const blockhashSpy = vi.spyOn(conn, 'getLatestBlockhash');

    await expect(buildTransferToAgentTransaction(userWallet, agentWallet, 10)).rejects.toMatchObject({
      code: 'insufficient_source_usdc',
      httpStatus: 422,
    });
    expect(blockhashSpy).not.toHaveBeenCalled();
  });

  it('includes exact destination ATA rent and message fee in the payer SOL refusal', async () => {
    vi.spyOn(conn, 'getAccountInfo')
      .mockResolvedValueOnce(accountInfo)
      .mockResolvedValueOnce(null);
    vi.spyOn(conn, 'getTokenAccountBalance').mockResolvedValueOnce(tokenBalance('10000000'));
    vi.spyOn(conn, 'getLatestBlockhash').mockResolvedValueOnce(blockhash());
    vi.spyOn(conn, 'getFeeForMessage').mockResolvedValueOnce({ context: { slot: 1 }, value: 5000 });
    vi.spyOn(conn, 'getBalance').mockResolvedValueOnce(2_040_000);
    vi.spyOn(conn, 'getMinimumBalanceForRentExemption').mockResolvedValueOnce(2_039_280);
    const simulationSpy = vi.spyOn(conn, 'simulateTransaction');

    await expect(buildTransferToAgentTransaction(userWallet, agentWallet, 10)).rejects.toMatchObject({
      code: 'insufficient_fee_sol',
      httpStatus: 422,
    });
    expect(conn.getMinimumBalanceForRentExemption).toHaveBeenCalledWith(165);
    expect(simulationSpy).not.toHaveBeenCalled();
  });

  it('simulates the exact unsigned outbound bytes with signature verification disabled', async () => {
    vi.spyOn(conn, 'getAccountInfo')
      .mockResolvedValueOnce(accountInfo)
      .mockResolvedValueOnce(accountInfo);
    vi.spyOn(conn, 'getTokenAccountBalance').mockResolvedValueOnce(tokenBalance('25000000'));
    vi.spyOn(conn, 'getLatestBlockhash').mockResolvedValueOnce(blockhash());
    vi.spyOn(conn, 'getFeeForMessage').mockResolvedValueOnce({ context: { slot: 1 }, value: 5000 });
    vi.spyOn(conn, 'getBalance').mockResolvedValueOnce(1_000_000_000);
    let simulatedBytes = '';
    vi.spyOn(conn, 'simulateTransaction').mockImplementationOnce((async (transaction: VersionedTransaction, config: any) => {
      simulatedBytes = Buffer.from(transaction.serialize()).toString('base64');
      expect(config).toMatchObject({ commitment: 'confirmed', sigVerify: false });
      return { context: { slot: 1 }, value: { err: null, logs: [], unitsConsumed: 2100 } } as any;
    }) as any);

    const result = await buildTransferToAgentTransaction(userWallet, agentWallet, 10);

    expect(result.transaction).toBe(simulatedBytes);
    expect(result.blockhash).toBeTruthy();
    expect(result.lastValidBlockHeight).toBe(123);
  });

  it('refuses a non-null simulation error and never returns transaction bytes', async () => {
    vi.spyOn(conn, 'getAccountInfo')
      .mockResolvedValueOnce(accountInfo)
      .mockResolvedValueOnce(accountInfo);
    vi.spyOn(conn, 'getTokenAccountBalance').mockResolvedValueOnce(tokenBalance('25000000'));
    vi.spyOn(conn, 'getLatestBlockhash').mockResolvedValueOnce(blockhash());
    vi.spyOn(conn, 'getFeeForMessage').mockResolvedValueOnce({ context: { slot: 1 }, value: 5000 });
    vi.spyOn(conn, 'getBalance').mockResolvedValueOnce(1_000_000_000);
    vi.spyOn(conn, 'simulateTransaction').mockResolvedValueOnce({
      context: { slot: 1 },
      value: { err: { InstructionError: [0, 'Custom'] }, logs: ['private provider detail'] },
    } as any);

    await expect(buildTransferToAgentTransaction(userWallet, agentWallet, 10)).rejects.toMatchObject({
      code: 'simulation_rejected',
      httpStatus: 422,
      message: expect.not.stringContaining('private provider detail'),
    });
  });

  it('classifies RPC inability separately from deterministic user shortfalls', async () => {
    vi.spyOn(conn, 'getAccountInfo').mockRejectedValueOnce(new Error('provider-secret-detail'));

    await expect(buildTransferToAgentTransaction(userWallet, agentWallet, 10)).rejects.toMatchObject({
      code: 'preflight_unavailable',
      httpStatus: 503,
      message: expect.not.stringContaining('provider-secret-detail'),
    });
  });

  it('maps only typed refusals to bounded HTTP responses', () => {
    expect(agentDepositPreflightHttpResponse(new AgentDepositPreflightError(
      'insufficient_source_usdc',
      422,
      'safe message',
    ))).toEqual({
      status: 422,
      body: { error: 'safe message', code: 'agent_deposit_insufficient_source_usdc' },
    });
    expect(agentDepositPreflightHttpResponse(new Error('unknown'))).toBeNull();
  });
});
