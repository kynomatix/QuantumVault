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

import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { getAgentUsdcBalanceStrict, getServerConnection } from '../../server/agent-wallet';

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
