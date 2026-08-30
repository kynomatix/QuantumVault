import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveTradePriceDisplay } from "../../client/src/components/TradeHistoryModal";
import { formatCapitalAmount } from "../../client/src/components/DepositWithdraw";

describe("accounting-incomplete client surfaces", () => {
  it("never presents an observation-context price as a venue fill", () => {
    expect(resolveTradePriceDisplay({
      price: "101.25",
      webhookPayload: {
        priceRole: "observation_context_only",
        closeAccounting: { kind: "unavailable" },
      },
    })).toEqual({
      value: null,
      label: "--",
      exportValue: "",
      note: "observation only; venue fill unavailable",
    });
    expect(resolveTradePriceDisplay({ price: "101.25", webhookPayload: {} })).toMatchObject({
      value: 101.25,
      exportValue: "101.25",
      note: "",
    });
  });

  it("uses the same unavailable provenance in both UI layouts, clipboard text, and CSV", () => {
    const source = readFileSync("client/src/components/TradeHistoryModal.tsx", "utf8");
    expect(source.match(/resolveTradePriceDisplay\(trade\)/g)).toHaveLength(3);
    expect(source).toContain("price: priceDisplay.exportValue");
    expect(source).toContain("priceNote: priceDisplay.note");
    expect(source).toContain("'Price basis'");
    expect(source).not.toContain('${Number(trade.price).toLocaleString()}');
  });

  it("renders unknown capital as unavailable rather than zero", () => {
    expect(formatCapitalAmount(null)).toBe("--");
    expect(formatCapitalAmount(undefined)).toBe("--");
    expect(formatCapitalAmount(12.5)).toBe("$12.50");
    const source = readFileSync("client/src/components/DepositWithdraw.tsx", "utf8");
    expect(source).toContain("text-capital-accounting-incomplete");
    expect(source).not.toContain("capitalPool?.mainAccountBalance ?? 0");
    expect(source).not.toContain("capitalPool?.allocatedToBot ?? 0");
  });
});
