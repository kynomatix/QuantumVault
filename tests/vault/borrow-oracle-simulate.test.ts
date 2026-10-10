import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PublicKey, TransactionMessage } from "@solana/web3.js";
import { JupiterLendBorrowRoute, type BorrowVaultConfig } from "../../server/vault/jupiter-lend-borrow-route";

const mocks = vi.hoisted(() => ({
  readOraclePrice: vi.fn(),
  connection: { getAccountInfo: vi.fn(), simulateTransaction: vi.fn() },
}));
vi.mock("../../server/agent-wallet", () => ({ getServerConnection: () => mocks.connection }));
vi.mock("@jup-ag/lend/borrow", () => ({ readOraclePrice: mocks.readOraclePrice }));

const PROGRAM = new PublicKey("jupnw4B6Eqs7ft6rxpzYLJZYSnrpRgPcr589n5Kv4oc");
const ORACLE = new PublicKey(new Uint8Array(32).fill(3));
const SOURCES = [1, 2].map(byte => new PublicKey(new Uint8Array(32).fill(byte)));
const LIVE_RAW = 1455668506692552n;

function accountData() {
  // Two InfPool sources, plus bump and zero-filled allocation padding.
  const data = Buffer.alloc(279);
  Buffer.from([139, 194, 131, 179, 140, 179, 229, 244]).copy(data);
  data.writeUInt16LE(101, 8);
  data.writeUInt32LE(2, 10);
  SOURCES.forEach((source, i) => {
    const offset = 14 + i * 66;
    source.toBuffer().copy(data, offset);
    data.writeBigUInt64LE(1n, offset + 33);
    data.writeBigUInt64LE(1n, offset + 49);
    data[offset + 65] = 11; // InfPool, absent from the old SDK IDL
  });
  data[146] = 255;
  return data;
}

function returned(raw = LIVE_RAW) {
  const bytes = Buffer.alloc(16);
  bytes.writeBigUInt64LE(raw & ((1n << 64n) - 1n));
  bytes.writeBigUInt64LE(raw >> 64n, 8);
  return { programId: PROGRAM.toBase58(), data: [bytes.toString("base64"), "base64"] };
}

let route: JupiterLendBorrowRoute;
beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  route = new JupiterLendBorrowRoute();
  vi.spyOn(route, "getVaultConfig").mockResolvedValue({ oracleAddress: ORACLE.toBase58() } as BorrowVaultConfig);
  mocks.readOraclePrice.mockRejectedValue(new Error("Cannot read properties of null (reading 'property')"));
  mocks.connection.getAccountInfo.mockResolvedValue({ owner: PROGRAM, executable: false, data: accountData() });
  mocks.connection.simulateTransaction.mockResolvedValue({ value: { err: null, returnData: returned() } });
});
afterEach(() => vi.restoreAllMocks());
const read = () => route.readOraclePriceUsd("EXAMPLE_COLLATERAL");

describe("on-chain oracle SDK compatibility fallback", () => {
  it.each([
    [{ oraclePriceLiquidate: "2000000000000000", oraclePriceOperate: "3000000000000000" }, 2],
    [{ oraclePriceOperate: "3000000000000000" }, 3],
    [{ oraclePriceLiquidate: "0", oraclePriceOperate: "3000000000000000" }, null],
    [{ oraclePriceOperate: "-1" }, null],
    [{ oraclePriceOperate: "NaN" }, null],
  ])("preserves SDK price selection and decoding for %j", async (reading, expected) => {
    mocks.readOraclePrice.mockResolvedValue(reading);
    expect(await read()).toBe(expected);
    expect(mocks.readOraclePrice).toHaveBeenCalledWith({ connection: mocks.connection, oracle: ORACLE });
    expect(mocks.connection.getAccountInfo).not.toHaveBeenCalled();
    expect(mocks.connection.simulateTransaction).not.toHaveBeenCalled();
  });

  it("uses the simulated value after SDK throws; preserves nonce/source order without signing", async () => {
    expect(await read()).toBe(Number(LIVE_RAW) / 1e15);
    expect(mocks.connection.getAccountInfo).toHaveBeenCalledWith(ORACLE, "confirmed");
    const [tx, options] = mocks.connection.simulateTransaction.mock.calls[0];
    expect(options).toEqual({ sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" });
    expect(tx.signatures.every((signature: Uint8Array) => signature.every(byte => byte === 0))).toBe(true);
    const message = TransactionMessage.decompile(tx.message);
    expect(message.instructions).toHaveLength(1);
    const ix = message.instructions[0];
    expect(ix.programId.equals(PROGRAM)).toBe(true);
    expect([...ix.data]).toEqual([174, 166, 126, 10, 122, 153, 94, 203, 101, 0]);
    expect(ix.keys).toEqual([ORACLE, ...SOURCES].map(pubkey => ({ pubkey, isSigner: false, isWritable: false })));
  });

  it.each([undefined, null, {}, { oraclePriceLiquidate: null, oraclePriceOperate: null }])(
    "simulates when SDK returns no price: %j", async reading => {
      mocks.readOraclePrice.mockResolvedValue(reading);
      expect(await read()).toBe(Number(LIVE_RAW) / 1e15);
    },
  );

  it("decodes both halves of a positive u128 within the sizing range", async () => {
    const raw = (1n << 64n) + LIVE_RAW;
    mocks.connection.simulateTransaction.mockResolvedValue({ value: { err: null, returnData: returned(raw) } });
    expect(await read()).toBe(Number(raw) / 1e15);
  });

  it("logs successful fallback only once per oracle across route instances", async () => {
    const address = new PublicKey(new Uint8Array(32).fill(4)).toBase58();
    vi.mocked(route.getVaultConfig).mockResolvedValue({ oracleAddress: address } as BorrowVaultConfig);
    await read();
    await read();
    const other = new JupiterLendBorrowRoute();
    vi.spyOn(other, "getVaultConfig").mockResolvedValue({ oracleAddress: address } as BorrowVaultConfig);
    await other.readOraclePriceUsd("EXAMPLE_COLLATERAL");
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(address));
  });

  it.each(["getAccountInfo", "simulateTransaction"] as const)("fails closed when %s throws", async method => {
    mocks.connection[method].mockRejectedValue(new Error("RPC unavailable"));
    expect(await read()).toBeNull();
  });

  it.each([
    ["missing account", null],
    ["wrong owner", { owner: PublicKey.default, data: accountData() }],
    ["executable", { owner: PROGRAM, executable: true, data: accountData() }],
  ])("rejects %s", async (_name, account) => {
    mocks.connection.getAccountInfo.mockResolvedValue(account);
    expect(await read()).toBeNull();
    expect(mocks.connection.simulateTransaction).not.toHaveBeenCalled();
  });

  it.each([
    ["truncated header", (data: Buffer) => data.subarray(0, 14)],
    ["wrong discriminator", (data: Buffer) => { data[0] = 0; return data; }],
    ["empty sources", (data: Buffer) => { data.writeUInt32LE(0, 10); return data; }],
    ["truncated sources", (data: Buffer) => data.subarray(0, 100)],
    ["oversized source count", (data: Buffer) => { data.writeUInt32LE(0xffffffff, 10); return data; }],
    ["unknown variant", (data: Buffer) => { data[79] = 12; return data; }],
    ["invalid bool", (data: Buffer) => { data[46] = 2; return data; }],
    ["nonzero trailing bytes", (data: Buffer) => { data[278] = 1; return data; }],
  ] as const)("rejects %s before simulation", async (_name, mutate) => {
    mocks.connection.getAccountInfo.mockResolvedValue({ owner: PROGRAM, data: mutate(accountData()) });
    expect(await read()).toBeNull();
    expect(mocks.connection.simulateTransaction).not.toHaveBeenCalled();
  });

  it.each([
    ["simulation error despite return data", { err: { InstructionError: [0, "InvalidAccountData"] }, returnData: returned() }],
    ["missing return", { err: null }],
    ["missing error status", { returnData: returned() }],
    ["wrong returning program", { err: null, returnData: { ...returned(), programId: PublicKey.default.toBase58() } }],
    ["wrong encoding", { err: null, returnData: { ...returned(), data: ["EXAMPLE", "base58"] } }],
    ["wrong length", { err: null, returnData: { ...returned(), data: [Buffer.alloc(15).toString("base64"), "base64"] } }],
    ["malformed base64", { err: null, returnData: { ...returned(), data: [returned().data[0] + "!", "base64"] } }],
    ["zero price", { err: null, returnData: returned(0n) }],
    ["out-of-range price", { err: null, returnData: returned((1n << 128n) - 1n) }],
  ])("fails closed for %s", async (_name, value) => {
    mocks.connection.simulateTransaction.mockResolvedValue({ value });
    expect(await read()).toBeNull();
  });
});
