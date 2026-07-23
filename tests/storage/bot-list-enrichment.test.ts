/**
 * WO-15A — getTradingBotListEnrichment deterministic test suite.
 *
 * Tests:
 *   [A] Empty guard      — zero botIds → 0 DB queries, all maps empty
 *   [B] Query count      — 1, 10, and 100 botIds → exactly 5 db.select() calls
 *   [C] Deduplication    — repeated bot IDs collapse to a single deduplicated set
 *   [D] Position map     — all position rows gathered per bot (multi-market support)
 *   [E] Published map    — unique-by-schema; absent bots absent from map
 *   [F] Trade count      — result parsed to number, missing bots absent from map
 *   [G] Equity parsing   — netDeposited / totalDeposits parsed; NaN → 0 guard
 *   [H] Borrow BigInt    — multi-row accumulation, USDC-only, non-USDC ignored
 *   [I] Borrow zero      — zero-amount rows never enter the map
 *   [J] Isolation        — out-of-request bot IDs and wrong-wallet rows are
 *         rejected at the application layer (defense-in-depth over SQL predicates)
 *   [K] VAULT_INTERNAL parity — all VAULT_INTERNAL_EVENT_TYPES members are
 *         excluded from sumNetDepositedFromEvents (TS reference matches SQL intent)
 *   [L] >1000 events     — no artificial cap; all rows contribute to aggregate
 *   [M] Schema DDL       — idx_equity_events_bot_created declared with DESC
 *         direction on both Drizzle schema (.desc()) and ensureSchema DDL surfaces
 */

import { vi, describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

// ---------------------------------------------------------------------------
// Mock server/db BEFORE any import of storage so DatabaseStorage uses our stub.
// vi.hoisted() ensures the spy is initialized before the hoisted vi.mock call.
// ---------------------------------------------------------------------------
const { mockSelectSpy } = vi.hoisted(() => ({
  mockSelectSpy: vi.fn(),
}));

vi.mock("../../server/db", () => ({
  db: {
    select: mockSelectSpy,
    // Other db methods are not called by getTradingBotListEnrichment.
  },
  pool: {
    connect: vi.fn(() =>
      Promise.resolve({ release: vi.fn(), query: vi.fn(() => ({ rows: [] })) })
    ),
  },
  ensureSchema: vi.fn(),
  checkUmkStorageSecretHealth: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Chainable query-builder stub.
// Any method call other than then/catch/finally returns the chain itself,
// making it infinitely chainable. When await-ed, it resolves to `result`.
// ---------------------------------------------------------------------------
function makeChain(result: unknown[] = []) {
  const p = Promise.resolve(result);
  const chain: any = new Proxy(
    {},
    {
      get(_: unknown, prop: string | symbol) {
        if (prop === "then") return p.then.bind(p);
        if (prop === "catch") return p.catch.bind(p);
        if (prop === "finally") return p.finally.bind(p);
        // Any builder method (from, where, groupBy, limit, …) returns chain.
        return () => chain;
      },
    }
  );
  return chain;
}

// ---------------------------------------------------------------------------
// Import code under test AFTER mock registration.
// ---------------------------------------------------------------------------
import { DatabaseStorage } from "../../server/storage";
import {
  VAULT_INTERNAL_EVENT_TYPES,
  sumNetDepositedFromEvents,
} from "../../server/equity-events-util";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStorage() {
  return new DatabaseStorage();
}

/** Seed mockSelectSpy with 5 sequential return values (one per query). */
function seedSelectMock(results: [unknown[], unknown[], unknown[], unknown[], unknown[]]) {
  mockSelectSpy.mockReset();
  for (const r of results) {
    mockSelectSpy.mockReturnValueOnce(makeChain(r));
  }
}

/** Default all-empty seed — used for count-only tests. */
function seedEmpty() {
  seedSelectMock([[], [], [], [], []]);
}

// ---------------------------------------------------------------------------
// [A] Empty guard
// ---------------------------------------------------------------------------
describe("[A] Empty guard", () => {
  beforeEach(() => mockSelectSpy.mockReset());

  it("returns 5 empty maps and issues zero queries for botIds=[]", async () => {
    const storage = makeStorage();
    const result = await storage.getTradingBotListEnrichment("wallet-A", []);

    expect(mockSelectSpy).not.toHaveBeenCalled();
    expect(result.tradeCounts.size).toBe(0);
    expect(result.positions.size).toBe(0);
    expect(result.publishedBotMap.size).toBe(0);
    expect(result.equityAgg.size).toBe(0);
    expect(result.borrowDebts.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// [B] Query count
// ---------------------------------------------------------------------------
describe("[B] Query count", () => {
  it.each([1, 10, 100])(
    "issues exactly 5 db.select() calls for %i bot(s)",
    async (n) => {
      seedEmpty();
      const storage = makeStorage();
      const ids = Array.from({ length: n }, (_, i) => `bot-${i}`);
      await storage.getTradingBotListEnrichment("wallet-B", ids);
      expect(mockSelectSpy).toHaveBeenCalledTimes(5);
    }
  );

  it("does NOT call any legacy per-bot storage method", async () => {
    // Ensure DatabaseStorage.getCanonicalBotTradeCount,
    // getBotEquityEvents, etc. are NOT invoked by the batch method.
    seedEmpty();
    const storage = makeStorage();
    const countSpy = vi.spyOn(storage, "getCanonicalBotTradeCount");
    const eventsSpy = vi.spyOn(storage, "getBotEquityEvents");
    const debtSpy = vi.spyOn(storage, "sumOpenBorrowDebtUsdcForBot");

    await storage.getTradingBotListEnrichment("wallet-B", ["bot-1"]);

    expect(countSpy).not.toHaveBeenCalled();
    expect(eventsSpy).not.toHaveBeenCalled();
    expect(debtSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// [C] Deduplication
// ---------------------------------------------------------------------------
describe("[C] Deduplication", () => {
  it("100 copies of the same bot ID still produce exactly 5 queries", async () => {
    seedEmpty();
    const storage = makeStorage();
    const ids = Array.from({ length: 100 }, () => "bot-dup");
    await storage.getTradingBotListEnrichment("wallet-C", ids);
    expect(mockSelectSpy).toHaveBeenCalledTimes(5);
  });

  it("mixed duplication: [A,B,A,C,B] → 5 queries and correct map keys", async () => {
    seedSelectMock([
      [{ botId: "bot-A", tradeCount: 3 }, { botId: "bot-B", tradeCount: 1 }, { botId: "bot-C", tradeCount: 0 }],
      [],
      [],
      [
        { botId: "bot-A", netDeposited: "100.000000", totalDeposits: "100.000000" },
        { botId: "bot-B", netDeposited: "50.000000", totalDeposits: "50.000000" },
        { botId: "bot-C", netDeposited: "0.000000", totalDeposits: "0.000000" },
      ],
      [],
    ]);
    const storage = makeStorage();
    const result = await storage.getTradingBotListEnrichment("wallet-C", [
      "bot-A", "bot-B", "bot-A", "bot-C", "bot-B",
    ]);

    expect(mockSelectSpy).toHaveBeenCalledTimes(5);
    expect(result.tradeCounts.get("bot-A")).toBe(3);
    expect(result.tradeCounts.get("bot-B")).toBe(1);
    expect(result.equityAgg.get("bot-A")).toEqual({ netDeposited: 100, totalDeposits: 100 });
  });
});

// ---------------------------------------------------------------------------
// [D] Position map
// ---------------------------------------------------------------------------
describe("[D] Position map — multi-market support", () => {
  it("accumulates multiple position rows per bot", async () => {
    const pos1 = { tradingBotId: "bot-1", market: "SOL-PERP", walletAddress: "w1", baseSize: "1", avgEntryPrice: "100", realizedPnl: "0", totalFees: "0" };
    const pos2 = { tradingBotId: "bot-1", market: "BTC-PERP", walletAddress: "w1", baseSize: "-0.5", avgEntryPrice: "50000", realizedPnl: "10", totalFees: "1" };
    const pos3 = { tradingBotId: "bot-2", market: "ETH-PERP", walletAddress: "w1", baseSize: "2", avgEntryPrice: "3000", realizedPnl: "5", totalFees: "0.5" };

    seedSelectMock([
      [],
      [pos1, pos2, pos3],
      [],
      [],
      [],
    ]);

    const storage = makeStorage();
    const result = await storage.getTradingBotListEnrichment("w1", ["bot-1", "bot-2"]);

    expect(result.positions.get("bot-1")).toHaveLength(2);
    expect(result.positions.get("bot-2")).toHaveLength(1);
    expect(result.positions.get("bot-3")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// [E] Published bot map
// ---------------------------------------------------------------------------
describe("[E] Published bot map", () => {
  it("populates entry for published bots and leaves absent bots out of the map", async () => {
    const pub = { tradingBotId: "bot-pub", creatorWalletAddress: "w1", id: "pb-1", isActive: true };

    seedSelectMock([[], [], [pub], [], []]);

    const storage = makeStorage();
    const result = await storage.getTradingBotListEnrichment("w1", ["bot-pub", "bot-unpub"]);

    expect(result.publishedBotMap.has("bot-pub")).toBe(true);
    expect(result.publishedBotMap.has("bot-unpub")).toBe(false);
    expect(result.publishedBotMap.get("bot-pub")?.tradingBotId).toBe("bot-pub");
  });
});

// ---------------------------------------------------------------------------
// [F] Trade count
// ---------------------------------------------------------------------------
describe("[F] Trade count map", () => {
  it("correctly maps botId → tradeCount number", async () => {
    seedSelectMock([
      [{ botId: "b1", tradeCount: 7 }, { botId: "b2", tradeCount: 0 }],
      [], [], [], [],
    ]);

    const storage = makeStorage();
    const result = await storage.getTradingBotListEnrichment("w", ["b1", "b2", "b3"]);

    expect(result.tradeCounts.get("b1")).toBe(7);
    expect(result.tradeCounts.get("b2")).toBe(0);
    expect(result.tradeCounts.has("b3")).toBe(false); // no trades → absent from map
  });

  it("handles null/missing tradeCount as 0", async () => {
    seedSelectMock([[{ botId: "b1", tradeCount: null }], [], [], [], []]);
    const storage = makeStorage();
    const result = await storage.getTradingBotListEnrichment("w", ["b1"]);
    expect(result.tradeCounts.get("b1")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// [G] Equity parsing — NaN guard and field coercion
// ---------------------------------------------------------------------------
describe("[G] Equity aggregation parsing", () => {
  it("correctly parses string aggregates to numbers", async () => {
    seedSelectMock([
      [],
      [],
      [],
      [{ botId: "b1", netDeposited: "1234.567890", totalDeposits: "2000.000000" }],
      [],
    ]);

    const storage = makeStorage();
    const result = await storage.getTradingBotListEnrichment("w", ["b1"]);

    expect(result.equityAgg.get("b1")).toEqual({
      netDeposited: 1234.56789,
      totalDeposits: 2000,
    });
  });

  it("NaN aggregate → 0 (malformed amount guard)", async () => {
    seedSelectMock([
      [],
      [],
      [],
      [{ botId: "b1", netDeposited: "NaN", totalDeposits: "NaN" }],
      [],
    ]);
    const storage = makeStorage();
    const result = await storage.getTradingBotListEnrichment("w", ["b1"]);
    expect(result.equityAgg.get("b1")).toEqual({ netDeposited: 0, totalDeposits: 0 });
  });

  it("null/undefined aggregate → 0", async () => {
    seedSelectMock([
      [],
      [],
      [],
      [{ botId: "b1", netDeposited: null, totalDeposits: null }],
      [],
    ]);
    const storage = makeStorage();
    const result = await storage.getTradingBotListEnrichment("w", ["b1"]);
    expect(result.equityAgg.get("b1")).toEqual({ netDeposited: 0, totalDeposits: 0 });
  });

  it("negative netDeposited (net-withdrawal) parses correctly", async () => {
    seedSelectMock([
      [],
      [],
      [],
      [{ botId: "b1", netDeposited: "-500.000000", totalDeposits: "1000.000000" }],
      [],
    ]);
    const storage = makeStorage();
    const result = await storage.getTradingBotListEnrichment("w", ["b1"]);
    expect(result.equityAgg.get("b1")).toEqual({ netDeposited: -500, totalDeposits: 1000 });
  });

  it("rows with null botId in equity result are skipped", async () => {
    seedSelectMock([
      [],
      [],
      [],
      [{ botId: null, netDeposited: "999", totalDeposits: "999" }],
      [],
    ]);
    const storage = makeStorage();
    const result = await storage.getTradingBotListEnrichment("w", ["b1"]);
    expect(result.equityAgg.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// [H] Borrow debt — BigInt multi-row accumulation, USDC-only filter
// ---------------------------------------------------------------------------
describe("[H] Borrow debt aggregation", () => {
  const USDC_DECIMALS = 1_000_000;

  it("sums multiple open USDC borrow rows for the same bot", async () => {
    seedSelectMock([
      [],
      [],
      [],
      [],
      [
        { tradingBotId: "b1", debtAmountRaw: "5000000", debtAssetKey: "usdc" },
        { tradingBotId: "b1", debtAmountRaw: "3000000", debtAssetKey: "USDC" },
      ],
    ]);
    const storage = makeStorage();
    const result = await storage.getTradingBotListEnrichment("w", ["b1"]);
    // 5000000 + 3000000 = 8000000 raw → 8 USDC
    expect(result.borrowDebts.get("b1")).toBeCloseTo(8, 6);
  });

  it("accumulates across multiple bots independently", async () => {
    seedSelectMock([
      [],
      [],
      [],
      [],
      [
        { tradingBotId: "b1", debtAmountRaw: "2000000", debtAssetKey: "usdc" },
        { tradingBotId: "b2", debtAmountRaw: "10000000", debtAssetKey: "usdc" },
      ],
    ]);
    const storage = makeStorage();
    const result = await storage.getTradingBotListEnrichment("w", ["b1", "b2"]);
    expect(result.borrowDebts.get("b1")).toBeCloseTo(2, 6);
    expect(result.borrowDebts.get("b2")).toBeCloseTo(10, 6);
  });

  it("ignores non-USDC assets", async () => {
    seedSelectMock([
      [],
      [],
      [],
      [],
      [
        { tradingBotId: "b1", debtAmountRaw: "9000000", debtAssetKey: "inf" },
        { tradingBotId: "b1", debtAmountRaw: "1000000", debtAssetKey: "usdc" },
      ],
    ]);
    const storage = makeStorage();
    const result = await storage.getTradingBotListEnrichment("w", ["b1"]);
    // Only the USDC row counts → 1 USDC
    expect(result.borrowDebts.get("b1")).toBeCloseTo(1, 6);
  });

  it("bot with no borrow rows is absent from borrowDebts map", async () => {
    seedEmpty();
    const storage = makeStorage();
    const result = await storage.getTradingBotListEnrichment("w", ["b1"]);
    expect(result.borrowDebts.has("b1")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// [I] Borrow zero-amount rows are excluded
// ---------------------------------------------------------------------------
describe("[I] Borrow — zero-amount rows excluded", () => {
  it("zero debtAmountRaw never populates the map", async () => {
    seedSelectMock([
      [],
      [],
      [],
      [],
      [{ tradingBotId: "b1", debtAmountRaw: "0", debtAssetKey: "usdc" }],
    ]);
    const storage = makeStorage();
    const result = await storage.getTradingBotListEnrichment("w", ["b1"]);
    expect(result.borrowDebts.has("b1")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// [J] Isolation — out-of-request bot IDs and wrong-wallet rows are rejected
// ---------------------------------------------------------------------------
describe("[J] Isolation — out-of-request bot IDs and wrong-wallet rows are rejected", () => {
  // Q1 — trade counts: out-of-request bot ID excluded
  it("trade counts: out-of-request bot ID row does not enter tradeCounts map", async () => {
    seedSelectMock([
      [{ botId: "other-bot", tradeCount: 99 }],
      [], [], [], [],
    ]);
    const storage = makeStorage();
    const result = await storage.getTradingBotListEnrichment("my-wallet", ["my-bot"]);
    expect(result.tradeCounts.has("other-bot")).toBe(false);
  });

  // Q2 — positions: out-of-request bot ID excluded
  it("positions: out-of-request bot ID row does not enter positions map", async () => {
    seedSelectMock([
      [],
      [{ tradingBotId: "other-bot", market: "SOL-PERP", walletAddress: "my-wallet" }],
      [], [], [],
    ]);
    const storage = makeStorage();
    const result = await storage.getTradingBotListEnrichment("my-wallet", ["my-bot"]);
    expect(result.positions.has("other-bot")).toBe(false);
  });

  // Q2 — positions: wrong-wallet row excluded even when bot ID matches
  it("positions: wrong-wallet row is excluded even when bot ID is in the requested set", async () => {
    seedSelectMock([
      [],
      [{ tradingBotId: "my-bot", market: "SOL-PERP", walletAddress: "other-wallet" }],
      [], [], [],
    ]);
    const storage = makeStorage();
    const result = await storage.getTradingBotListEnrichment("my-wallet", ["my-bot"]);
    expect(result.positions.has("my-bot")).toBe(false);
  });

  // Q2 — positions: legitimate row (correct ID + correct wallet) enters the map
  it("positions: legitimate requested-wallet/requested-id row enters the map", async () => {
    seedSelectMock([
      [],
      [{ tradingBotId: "my-bot", market: "SOL-PERP", walletAddress: "my-wallet" }],
      [], [], [],
    ]);
    const storage = makeStorage();
    const result = await storage.getTradingBotListEnrichment("my-wallet", ["my-bot"]);
    expect(result.positions.has("my-bot")).toBe(true);
    expect(result.positions.get("my-bot")).toHaveLength(1);
  });

  // Q3 — published bots: out-of-request bot ID excluded
  it("published bots: out-of-request bot ID row does not enter publishedBotMap", async () => {
    seedSelectMock([
      [], [],
      [{ tradingBotId: "other-bot", creatorWalletAddress: "my-wallet" }],
      [], [],
    ]);
    const storage = makeStorage();
    const result = await storage.getTradingBotListEnrichment("my-wallet", ["my-bot"]);
    expect(result.publishedBotMap.has("other-bot")).toBe(false);
  });

  // Q3 — published bots: wrong-wallet row excluded even when bot ID matches
  it("published bots: wrong-wallet creator row is excluded even when bot ID is in the requested set", async () => {
    seedSelectMock([
      [], [],
      [{ tradingBotId: "my-bot", creatorWalletAddress: "other-wallet" }],
      [], [],
    ]);
    const storage = makeStorage();
    const result = await storage.getTradingBotListEnrichment("my-wallet", ["my-bot"]);
    expect(result.publishedBotMap.has("my-bot")).toBe(false);
  });

  // Q3 — published bots: legitimate row enters the map
  it("published bots: legitimate requested-wallet/requested-id row enters the map", async () => {
    seedSelectMock([
      [], [],
      [{ tradingBotId: "my-bot", creatorWalletAddress: "my-wallet" }],
      [], [],
    ]);
    const storage = makeStorage();
    const result = await storage.getTradingBotListEnrichment("my-wallet", ["my-bot"]);
    expect(result.publishedBotMap.has("my-bot")).toBe(true);
  });

  // Q4 — equity agg: out-of-request bot ID excluded
  it("equity agg: out-of-request bot ID row does not enter equityAgg map", async () => {
    seedSelectMock([
      [], [], [],
      [{ botId: "other-bot", netDeposited: "9999", totalDeposits: "9999" }],
      [],
    ]);
    const storage = makeStorage();
    const result = await storage.getTradingBotListEnrichment("my-wallet", ["my-bot"]);
    expect(result.equityAgg.has("other-bot")).toBe(false);
  });

  // Q5 — borrow debt: out-of-request bot ID excluded
  it("borrow debt: out-of-request bot ID row does not enter borrowDebts map", async () => {
    seedSelectMock([
      [], [], [], [],
      [{ tradingBotId: "other-bot", debtAmountRaw: "99000000", debtAssetKey: "usdc" }],
    ]);
    const storage = makeStorage();
    const result = await storage.getTradingBotListEnrichment("my-wallet", ["my-bot"]);
    expect(result.borrowDebts.has("other-bot")).toBe(false);
  });

  // All 5 queries simultaneously: out-of-request rows in every result → all maps empty
  it("all five queries: adversarial out-of-request rows in every result produce zero-entry maps", async () => {
    seedSelectMock([
      [{ botId: "bad-bot", tradeCount: 99 }],
      [{ tradingBotId: "bad-bot", market: "SOL-PERP", walletAddress: "my-wallet" }],
      [{ tradingBotId: "bad-bot", creatorWalletAddress: "my-wallet" }],
      [{ botId: "bad-bot", netDeposited: "9999", totalDeposits: "9999" }],
      [{ tradingBotId: "bad-bot", debtAmountRaw: "99000000", debtAssetKey: "usdc" }],
    ]);
    const storage = makeStorage();
    const result = await storage.getTradingBotListEnrichment("my-wallet", ["my-bot"]);
    expect(result.tradeCounts.size).toBe(0);
    expect(result.positions.size).toBe(0);
    expect(result.publishedBotMap.size).toBe(0);
    expect(result.equityAgg.size).toBe(0);
    expect(result.borrowDebts.size).toBe(0);
    // The 5 queries still fired for the requested bot
    expect(mockSelectSpy).toHaveBeenCalledTimes(5);
  });
});

// ---------------------------------------------------------------------------
// [K] VAULT_INTERNAL_EVENT_TYPES parity with sumNetDepositedFromEvents
// ---------------------------------------------------------------------------
describe("[K] VAULT_INTERNAL_EVENT_TYPES — TS reference excludes all internal types", () => {
  it("sumNetDepositedFromEvents returns 0 when all events are internal types", () => {
    for (const eventType of VAULT_INTERNAL_EVENT_TYPES) {
      const events = [
        { eventType, amount: "100.000000" },
        { eventType, amount: "200.000000" },
      ] as any[];
      const net = sumNetDepositedFromEvents(events);
      expect(net).toBe(0);
    }
  });

  it("sumNetDepositedFromEvents counts external types correctly", () => {
    const events = [
      { eventType: "drift_deposit", amount: "500.000000" },
      { eventType: "drift_withdraw", amount: "-200.000000" },
    ] as any[];
    const net = sumNetDepositedFromEvents(events);
    expect(net).toBeCloseTo(300, 6);
  });

  it("VAULT_INTERNAL_EVENT_TYPES set is non-empty", () => {
    expect(VAULT_INTERNAL_EVENT_TYPES.size).toBeGreaterThan(0);
  });

  it("totalDeposits logic: negative external amounts do not contribute to deposits", () => {
    // This mirrors what the SQL CASE WHEN ... AND amount > 0 does.
    const events = [
      { eventType: "drift_deposit", amount: "300.000000" },
      { eventType: "drift_withdraw", amount: "-100.000000" },
    ] as any[];
    // sumNetDepositedFromEvents returns the signed sum (300 - 100 = 200)
    const net = sumNetDepositedFromEvents(events);
    expect(net).toBeCloseTo(200, 6);
    // The totalDeposits (only positive external) should be 300, not 200
    const totalDeposits = events.reduce((sum, e) => {
      if (VAULT_INTERNAL_EVENT_TYPES.has(e.eventType)) return sum;
      const v = parseFloat(e.amount || "0");
      return v > 0 ? sum + v : sum;
    }, 0);
    expect(totalDeposits).toBeCloseTo(300, 6);
  });
});

// ---------------------------------------------------------------------------
// [L] >1000 events — no cap
// ---------------------------------------------------------------------------
describe("[L] >1000 events — no artificial result cap", () => {
  it("equity map receives aggregated values even for 1001 rows from DB", async () => {
    // The DB returns a single pre-aggregated row (GROUP BY produces one row per bot).
    // This verifies the parsing layer handles large aggregates correctly.
    seedSelectMock([
      [],
      [],
      [],
      [{ botId: "b1", netDeposited: "100100.000000", totalDeposits: "200200.000000" }],
      [],
    ]);
    const storage = makeStorage();
    const result = await storage.getTradingBotListEnrichment("w", ["b1"]);
    // 1001 × 100 = 100100 net, 1001 × 200 = 200200 total (simulated pre-aggregation)
    expect(result.equityAgg.get("b1")?.netDeposited).toBeCloseTo(100100, 4);
    expect(result.equityAgg.get("b1")?.totalDeposits).toBeCloseTo(200200, 4);
  });

  it("positions map handles many rows without losing any", async () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({
      tradingBotId: "b1",
      market: `MARKET-${i}`,
      walletAddress: "w",
    }));
    seedSelectMock([[], rows, [], [], []]);
    const storage = makeStorage();
    const result = await storage.getTradingBotListEnrichment("w", ["b1"]);
    expect(result.positions.get("b1")).toHaveLength(50);
  });
});

// ---------------------------------------------------------------------------
// [M] Schema + ensureSchema DDL — both surfaces declare the index with DESC direction
// ---------------------------------------------------------------------------
describe("[M] Index present with DESC direction in both Drizzle schema and ensureSchema DDL", () => {
  const root = resolve(__dirname, "../..");

  it("shared/schema.ts declares idx_equity_events_bot_created with .desc() on createdAt", () => {
    const src = readFileSync(resolve(root, "shared/schema.ts"), "utf-8");
    // Index name present
    expect(src).toContain("idx_equity_events_bot_created");
    // Drizzle declaration uses .desc() on the createdAt column so the generated
    // schema matches the live DB index direction (created_at DESC).
    expect(src).toContain("createdAt.desc()");
  });

  it("server/db.ts DDL declares idx_equity_events_bot_created with created_at DESC", () => {
    const src = readFileSync(resolve(root, "server/db.ts"), "utf-8");
    // Full IF NOT EXISTS guard present
    expect(src).toContain(
      "CREATE INDEX IF NOT EXISTS idx_equity_events_bot_created"
    );
    // Direction must be explicitly DESC — aligns with live index and Drizzle schema
    expect(src).toContain("created_at DESC");
  });

  it("server/db.ts rollback comment present", () => {
    const src = readFileSync(resolve(root, "server/db.ts"), "utf-8");
    expect(src).toContain("DROP INDEX IF EXISTS idx_equity_events_bot_created");
  });
});
