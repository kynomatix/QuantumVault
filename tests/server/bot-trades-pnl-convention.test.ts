import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  classifyLegacyBotTradePnlConvention,
  resolveBotTradeNetPnl,
} from "../../server/trading/bot-trade-pnl-convention";

describe("bot_trades PnL convention", () => {
  it("normalizes net and gross rows exactly once", () => {
    expect(resolveBotTradeNetPnl({
      pnl: "12.50",
      fee: "1.25",
      pnlConvention: "net_of_close_fee",
    })).toBe(12.5);
    expect(resolveBotTradeNetPnl({
      pnl: "12.50",
      fee: "1.25",
      pnlConvention: "gross_before_close_fee",
    })).toBe(11.25);
    expect(resolveBotTradeNetPnl({
      pnl: "0",
      fee: "0",
      pnlConvention: "gross_before_close_fee",
    })).toBe(0);
  });

  it("omits unavailable or malformed values instead of inventing zero", () => {
    expect(resolveBotTradeNetPnl({
      pnl: null,
      fee: "1",
      pnlConvention: "net_of_close_fee",
    })).toBeNull();
    expect(resolveBotTradeNetPnl({
      pnl: "not-a-number",
      fee: "1",
      pnlConvention: "net_of_close_fee",
    })).toBeNull();
    expect(resolveBotTradeNetPnl({
      pnl: "2",
      fee: null,
      pnlConvention: "gross_before_close_fee",
    })).toBeNull();
    expect(resolveBotTradeNetPnl({
      pnl: "2",
      fee: "1",
      pnlConvention: "unknown",
    })).toBeNull();
  });

  it("classifies both reconciled full-close shapes as gross and excludes partial closes", () => {
    for (const closeReason of ["external_close", "tpsl", "liquidation"]) {
      expect(classifyLegacyBotTradePnlConvention({
        executionMethod: "on-chain-detected",
        reconciled: true,
        closeReason,
      })).toBe("gross_before_close_fee");
    }
    for (const closeReason of ["partial_tp", "partial_sl"]) {
      expect(classifyLegacyBotTradePnlConvention({
        executionMethod: "on-chain-detected",
        reconciled: true,
        closeReason,
      })).toBe("net_of_close_fee");
    }
    expect(classifyLegacyBotTradePnlConvention({
      executionMethod: "legacy",
      reconciled: true,
      closeReason: "external_close",
    })).toBe("net_of_close_fee");
  });

  it("stamps both reconciler full-close writers net-valued and net-convention", () => {
    const source = readFileSync("server/reconciliation-service.ts", "utf8");
    expect(source.match(/const closePnl = \(closeDetection\.pnl \?\? 0\) - closeFee;/g)).toHaveLength(2);
    expect(source.match(/pnlConvention: 'net_of_close_fee'/g)).toHaveLength(2);
    expect(source.match(/feeTruthStatus: 'current_pipeline'/g)).toHaveLength(2);
  });

  it("binds every reader to the shared resolver and the migration to durable provenance", () => {
    const storage = readFileSync("server/storage.ts", "utf8");
    const routes = readFileSync("server/routes.ts", "utf8");
    const db = readFileSync("server/db.ts", "utf8");
    const migration = db.slice(
      db.indexOf("// --- Pin bot_trades.pnl convention"),
      db.indexOf("] as const;", db.indexOf("// --- Pin bot_trades.pnl convention")),
    );

    expect(storage.match(/resolveBotTradeNetPnl/g)?.length).toBeGreaterThanOrEqual(4);
    expect(routes.match(/resolveBotTradeNetPnl/g)?.length).toBeGreaterThanOrEqual(4);
    expect(migration).toContain("webhook_payload->>'reconciled' = 'true'");
    expect(migration).toContain("webhook_payload->>'closeReason' IN ('external_close', 'tpsl', 'liquidation')");
    expect(migration).not.toMatch(/closeReason' IN \([^)]*partial_(?:tp|sl)/);
    expect(migration).toContain("'d1d024a2-05b2-4d4b-8648-2ee445534716'");
    expect(migration).toContain("'e31fba28-bba3-4be1-85a0-b5b5c96d6825'");
    expect(migration).toContain("'b35049e2-44d2-4137-9259-6bbd1a7a75d0'");
    expect(migration).not.toMatch(/UPDATE bot_trades[\s\S]*SET\s+(?:pnl|fee)\s*=/);
  });
});
