import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Money-safety unit tests for getAgentTokenBalanceRawStrict, the STRICT balance
 * reader used as the on-chain baseline (outBefore) by executeAgentInstructions and
 * executeAgentSwap. The credited amount is (after - outBefore), so the baseline
 * MUST be a real on-chain figure: a genuinely-absent ATA is a truthful 0, but an
 * RPC/parse failure must THROW (fail closed) rather than collapse to 0 and let a
 * pre-existing balance masquerade as a positive delta.
 *
 * We mock only the @solana/web3.js Connection (PublicKey stays real so the ATA
 * derivation is exercised) and the swap seam (avoid heavy import side effects).
 */

const getTokenAccountBalanceMock = vi.fn();
const getAccountInfoMock = vi.fn();
const getBalanceMock = vi.fn();

vi.mock("@solana/web3.js", async (importActual) => {
  const actual = await importActual<typeof import("@solana/web3.js")>();
  return {
    ...actual,
    Connection: class {
      getTokenAccountBalance = getTokenAccountBalanceMock;
      getAccountInfo = getAccountInfoMock;
      getBalance = getBalanceMock;
    },
  };
});

vi.mock("../../server/swap/index.js", () => ({
  getBestQuote: vi.fn(),
  getProviderByName: vi.fn(),
}));

import { getAgentTokenBalanceRawStrict } from "../../server/agent-wallet";

// Any valid base58 pubkeys; the connection is mocked so identity does not matter.
const AGENT = "D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59";
const KUSDC = "B8V6WVjPxW1UGwVDfxH2d2r8SyT4cqn7dQRK6XneVa7D";

beforeEach(() => {
  getTokenAccountBalanceMock.mockReset();
  getAccountInfoMock.mockReset();
  getBalanceMock.mockReset();
});

describe("getAgentTokenBalanceRawStrict (money-path baseline, fail closed)", () => {
  it("returns the real balance on the happy path", async () => {
    getTokenAccountBalanceMock.mockResolvedValue({ value: { amount: "500", decimals: 6, uiAmount: 0.0005 } });
    const r = await getAgentTokenBalanceRawStrict(AGENT, KUSDC);
    expect(r.amountRaw).toBe("500");
    expect(r.decimals).toBe(6);
    expect(getAccountInfoMock).not.toHaveBeenCalled();
  });

  it("returns 0 ONLY when the ATA genuinely does not exist", async () => {
    getTokenAccountBalanceMock.mockRejectedValue(new Error("could not find account"));
    getAccountInfoMock.mockResolvedValue(null); // account truly absent
    const r = await getAgentTokenBalanceRawStrict(AGENT, KUSDC);
    expect(r.amountRaw).toBe("0");
  });

  it("THROWS when the balance read fails but the account exists (RPC/parse error)", async () => {
    getTokenAccountBalanceMock.mockRejectedValue(new Error("rpc parse error"));
    getAccountInfoMock.mockResolvedValue({ owner: { equals: () => true }, data: Buffer.alloc(8) });
    await expect(getAgentTokenBalanceRawStrict(AGENT, KUSDC)).rejects.toThrow();
  });

  it("THROWS when even the disambiguating account read fails (no silent 0)", async () => {
    getTokenAccountBalanceMock.mockRejectedValue(new Error("rpc down"));
    getAccountInfoMock.mockRejectedValue(new Error("rpc down"));
    await expect(getAgentTokenBalanceRawStrict(AGENT, KUSDC)).rejects.toThrow();
  });
});
